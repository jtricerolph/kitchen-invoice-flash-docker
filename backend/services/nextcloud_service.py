"""
Nextcloud WebDAV service for file operations.

Handles:
- WebDAV authentication and connection testing
- File upload/download/delete operations
- Directory creation and management
- File path generation based on invoice metadata
"""
import httpx
import logging
import re
import hashlib
from datetime import datetime, date
from typing import Tuple, Optional

logger = logging.getLogger(__name__)


class NextcloudService:
    """Service for Nextcloud WebDAV operations"""

    def __init__(self, host: str, username: str, password: str, base_path: str = "/Kitchen Invoices"):
        """
        Initialize Nextcloud service.

        Args:
            host: Nextcloud server URL (e.g., "https://cloud.example.com")
            username: Nextcloud username
            password: Nextcloud password or app password
            base_path: Base directory in Nextcloud for storing files
        """
        self.host = host.rstrip('/') if host else ""
        self.username = username or ""
        self.password = password or ""
        self.base_path = (base_path or "/Kitchen Invoices").strip('/')

        # WebDAV endpoint
        self.webdav_url = f"{self.host}/remote.php/dav/files/{self.username}" if self.host and self.username else ""

        # Create async HTTP client - will be initialized when needed
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the async HTTP client"""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                auth=(self.username, self.password),
                timeout=60.0,
                follow_redirects=True
            )
        return self._client

    async def test_connection(self) -> Tuple[bool, str]:
        """
        Test WebDAV connection and authentication.

        Returns:
            (success, message) tuple
        """
        if not self.host or not self.username or not self.password:
            return (False, "Nextcloud not configured - missing host, username, or password")

        try:
            client = await self._get_client()
            # PROPFIND on root to test auth
            response = await client.request(
                "PROPFIND",
                self.webdav_url,
                headers={"Depth": "0"}
            )

            if response.status_code == 207:  # Multi-Status (success)
                return (True, "Nextcloud connection successful")
            elif response.status_code == 401:
                return (False, "Authentication failed - check username/password")
            elif response.status_code == 404:
                return (False, f"WebDAV endpoint not found - check Nextcloud URL")
            else:
                return (False, f"Unexpected response: HTTP {response.status_code}")

        except httpx.ConnectError:
            return (False, f"Cannot connect to {self.host}")
        except httpx.TimeoutException:
            return (False, f"Connection timed out")
        except Exception as e:
            return (False, f"Connection error: {str(e)}")

    async def ensure_directory(self, path: str) -> bool:
        """
        Create directory and all parent directories if they don't exist.

        Args:
            path: Directory path relative to base_path

        Returns:
            True if directory exists or was created
        """
        full_path = f"{self.base_path}/{path}".strip('/')
        parts = full_path.split('/')

        client = await self._get_client()
        current_path = ""

        for part in parts:
            if not part:
                continue
            current_path = f"{current_path}/{part}" if current_path else part
            url = f"{self.webdav_url}/{current_path}"

            # Check if exists
            try:
                response = await client.request("PROPFIND", url, headers={"Depth": "0"})

                if response.status_code == 404:
                    # Create directory
                    create_response = await client.request("MKCOL", url)
                    if create_response.status_code not in (201, 405):  # 405 = already exists
                        logger.error(f"Failed to create directory {current_path}: HTTP {create_response.status_code}")
                        return False
                    logger.debug(f"Created directory: {current_path}")
            except Exception as e:
                logger.error(f"Error checking/creating directory {current_path}: {e}")
                return False

        return True

    def generate_filename(
        self,
        invoice_date: Optional[date],
        supplier_name: Optional[str],
        invoice_number: Optional[str],
        total: Optional[float],
        original_filename: str,
        upload_hash: Optional[str] = None
    ) -> str:
        """
        Generate human-readable filename for archived invoice.

        Format: {date}-{supplier}-{invoice_number}-{total}-{hash}.{ext}
        Example: 2026-01-15-Brakes-INV001234-£234_50-a1b2c3d4.pdf
        """
        # Sanitize supplier name (remove special chars, limit length)
        safe_supplier = re.sub(r'[^\w\s-]', '', supplier_name or 'Unknown')
        safe_supplier = re.sub(r'\s+', '-', safe_supplier.strip())[:30]

        # Sanitize invoice number
        safe_invoice = re.sub(r'[^\w-]', '', invoice_number or 'NoNumber')[:20]

        # Format total with currency (replace . with _ for filename safety)
        if total is not None:
            total_str = f"£{total:.2f}".replace('.', '_')
        else:
            total_str = "£0_00"

        # Get extension from original filename
        ext = original_filename.split('.')[-1].lower() if original_filename and '.' in original_filename else 'pdf'

        # Format date
        if invoice_date:
            date_str = invoice_date.strftime('%Y-%m-%d') if isinstance(invoice_date, date) else str(invoice_date)[:10]
        else:
            date_str = 'NoDate'

        # Short hash (generate if not provided)
        if upload_hash:
            short_hash = upload_hash[:8]
        else:
            hash_input = f"{invoice_number or ''}{total or ''}{datetime.utcnow().isoformat()}"
            short_hash = hashlib.md5(hash_input.encode()).hexdigest()[:8]

        return f"{date_str}-{safe_supplier}-{safe_invoice}-{total_str}-{short_hash}.{ext}"

    def generate_path(self, supplier_name: Optional[str], invoice_date: Optional[date]) -> str:
        """
        Generate directory path for invoice archive.

        Format: /{supplier}/{year}/{month}/
        Example: /Brakes/2026/01/
        """
        safe_supplier = re.sub(r'[^\w\s-]', '', supplier_name or 'Unknown')
        safe_supplier = re.sub(r'\s+', '-', safe_supplier.strip())

        if invoice_date:
            if isinstance(invoice_date, date):
                return f"{safe_supplier}/{invoice_date.year}/{invoice_date.month:02d}"
            else:
                # Try to parse string date
                try:
                    dt = datetime.strptime(str(invoice_date)[:10], '%Y-%m-%d')
                    return f"{safe_supplier}/{dt.year}/{dt.month:02d}"
                except ValueError:
                    pass

        return f"{safe_supplier}/unknown"

    async def upload_file(
        self,
        file_content: bytes,
        directory_path: str,
        filename: str
    ) -> Tuple[bool, str]:
        """
        Upload file to Nextcloud.

        Args:
            file_content: File bytes
            directory_path: Directory path (relative to base_path)
            filename: Target filename

        Returns:
            (success, full_webdav_path or error_message)
        """
        if not self.host or not self.username:
            return (False, "Nextcloud not configured")

        try:
            # Ensure directory exists
            if not await self.ensure_directory(directory_path):
                return (False, f"Failed to create directory: {directory_path}")

            # Full path
            full_path = f"{self.base_path}/{directory_path}/{filename}".strip('/')
            url = f"{self.webdav_url}/{full_path}"

            # Upload file
            client = await self._get_client()
            response = await client.put(url, content=file_content)

            if response.status_code in (201, 204):  # Created or No Content (overwritten)
                logger.info(f"Uploaded file to Nextcloud: {full_path}")
                return (True, full_path)
            else:
                return (False, f"Upload failed: HTTP {response.status_code}")

        except Exception as e:
            logger.error(f"Nextcloud upload error: {e}")
            return (False, str(e))

    async def download_file(self, path: str) -> Tuple[bool, bytes | str]:
        """
        Download file from Nextcloud.

        Args:
            path: Full WebDAV path (relative to user's files root)

        Returns:
            (success, file_bytes or error_message)
        """
        if not self.host or not self.username:
            return (False, "Nextcloud not configured")

        try:
            url = f"{self.webdav_url}/{path}"
            client = await self._get_client()
            response = await client.get(url)

            if response.status_code == 200:
                return (True, response.content)
            elif response.status_code == 404:
                return (False, "File not found")
            else:
                return (False, f"Download failed: HTTP {response.status_code}")

        except Exception as e:
            return (False, str(e))

    async def copy_to_deleted(
        self,
        source_path: str,
        supplier_name: Optional[str],
        original_filename: str
    ) -> Tuple[bool, str]:
        """
        Copy file to deleted folder before deletion from DB.

        Target: /{base_path}/{supplier}/deleted/[DELETED FROM FLASH] {filename}
        """
        safe_supplier = re.sub(r'[^\w\s-]', '', supplier_name or 'Unknown')
        safe_supplier = re.sub(r'\s+', '-', safe_supplier.strip())

        deleted_dir = f"{safe_supplier}/deleted"
        deleted_filename = f"[DELETED FROM FLASH] {original_filename}"

        # Download original
        success, content = await self.download_file(source_path)
        if not success:
            return (False, f"Failed to download original: {content}")

        # Upload to deleted folder
        return await self.upload_file(content, deleted_dir, deleted_filename)

    async def delete_file(self, path: str) -> Tuple[bool, str]:
        """
        Delete file from Nextcloud.

        Args:
            path: Full WebDAV path

        Returns:
            (success, message)
        """
        if not self.host or not self.username:
            return (False, "Nextcloud not configured")

        try:
            url = f"{self.webdav_url}/{path}"
            client = await self._get_client()
            response = await client.delete(url)

            if response.status_code in (204, 404):  # Deleted or already gone
                return (True, "File deleted")
            else:
                return (False, f"Delete failed: HTTP {response.status_code}")

        except Exception as e:
            return (False, str(e))

    async def close(self):
        """Close HTTP client"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
