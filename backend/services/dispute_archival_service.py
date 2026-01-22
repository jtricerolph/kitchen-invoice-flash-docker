"""
Service for managing dispute and credit note file archival to Nextcloud.

Handles:
- Dispute attachment storage and archival
- Credit note PDF storage and archival
- File retrieval from Nextcloud
"""
import os
import uuid
import hashlib
import logging
from datetime import datetime
from typing import Tuple, Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from models.dispute import DisputeAttachment, CreditNote, InvoiceDispute
from models.settings import KitchenSettings
from models.supplier import Supplier
from models.invoice import Invoice
from services.nextcloud_service import NextcloudService

logger = logging.getLogger(__name__)

# Storage paths
DISPUTE_ATTACHMENTS_DIR = "/app/data/disputes"
CREDIT_NOTES_DIR = "/app/data/credit_notes"


class DisputeArchivalService:
    """Service for managing dispute and credit note file archival"""

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def get_settings(self) -> Optional[KitchenSettings]:
        """Get kitchen settings"""
        result = await self.db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
        )
        return result.scalar_one_or_none()

    def _sanitize_filename(self, name: str) -> str:
        """Sanitize filename for safe storage"""
        # Remove unsafe characters
        safe = "".join(c if c.isalnum() or c in (' ', '-', '_') else '_' for c in name)
        # Collapse multiple spaces/underscores
        safe = '_'.join(safe.split())
        # Limit length
        return safe[:50]

    def _generate_descriptive_filename(
        self,
        supplier_name: str,
        date: datetime,
        prefix: str,
        original_filename: str
    ) -> str:
        """
        Generate descriptive filename for Nextcloud archival.

        Format: {date}-{supplier}-{prefix}-{hash}.{ext}
        Example: 2026-01-22-Brakes-dispute-5-attachment-a1b2c3d4.jpg
        """
        date_str = date.strftime("%Y-%m-%d")
        supplier_safe = self._sanitize_filename(supplier_name)[:30]

        # Get file extension
        ext = os.path.splitext(original_filename)[1].lower() or ".dat"

        # Generate short hash for uniqueness
        hash_input = f"{supplier_name}{date}{prefix}{original_filename}".encode()
        short_hash = hashlib.md5(hash_input).hexdigest()[:8]

        return f"{date_str}-{supplier_safe}-{prefix}-{short_hash}{ext}"

    async def save_dispute_attachment(
        self,
        dispute: InvoiceDispute,
        file_content: bytes,
        filename: str,
        file_type: str
    ) -> Tuple[bool, str]:
        """
        Save dispute attachment locally.

        Args:
            dispute: The dispute
            file_content: File bytes
            filename: Original filename
            file_type: MIME type

        Returns:
            (success, file_path or error)
        """
        try:
            # Create storage directory
            dispute_dir = os.path.join(DISPUTE_ATTACHMENTS_DIR, str(self.kitchen_id), str(dispute.id))
            os.makedirs(dispute_dir, exist_ok=True)

            # Generate unique filename
            ext = os.path.splitext(filename)[1] or ".dat"
            unique_filename = f"{uuid.uuid4()}{ext}"
            file_path = os.path.join(dispute_dir, unique_filename)

            # Save file
            with open(file_path, 'wb') as f:
                f.write(file_content)

            return (True, file_path)

        except Exception as e:
            logger.error(f"Failed to save dispute attachment: {e}")
            return (False, str(e))

    async def save_credit_note(
        self,
        invoice: Invoice,
        file_content: bytes,
        filename: str
    ) -> Tuple[bool, str]:
        """
        Save credit note PDF locally.

        Args:
            invoice: The invoice
            file_content: PDF bytes
            filename: Original filename

        Returns:
            (success, file_path or error)
        """
        try:
            # Create storage directory
            cn_dir = os.path.join(CREDIT_NOTES_DIR, str(self.kitchen_id))
            os.makedirs(cn_dir, exist_ok=True)

            # Generate unique filename
            ext = os.path.splitext(filename)[1] or ".pdf"
            unique_filename = f"{uuid.uuid4()}{ext}"
            file_path = os.path.join(cn_dir, unique_filename)

            # Save file
            with open(file_path, 'wb') as f:
                f.write(file_content)

            return (True, file_path)

        except Exception as e:
            logger.error(f"Failed to save credit note: {e}")
            return (False, str(e))

    async def archive_dispute_attachment(self, attachment: DisputeAttachment) -> Tuple[bool, str]:
        """
        Archive dispute attachment to Nextcloud.

        Args:
            attachment: Attachment to archive

        Returns:
            (success, nextcloud_path or error)
        """
        settings = await self.get_settings()
        if not settings or not settings.nextcloud_enabled:
            return (False, "Nextcloud not enabled")

        if not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
            return (False, "Nextcloud not configured")

        if attachment.file_storage_location != "local":
            return (False, "Attachment already archived")

        if not os.path.exists(attachment.file_path):
            return (False, "Local file not found")

        try:
            # Get dispute and invoice info
            result = await self.db.execute(
                select(InvoiceDispute).where(InvoiceDispute.id == attachment.dispute_id)
            )
            dispute = result.scalar_one_or_none()
            if not dispute:
                return (False, "Dispute not found")

            result = await self.db.execute(
                select(Invoice).where(Invoice.id == dispute.invoice_id)
            )
            invoice = result.scalar_one_or_none()
            if not invoice:
                return (False, "Invoice not found")

            # Get supplier name
            supplier_name = "Unknown"
            if invoice.supplier_id:
                result = await self.db.execute(
                    select(Supplier).where(Supplier.id == invoice.supplier_id)
                )
                supplier = result.scalar_one_or_none()
                if supplier:
                    supplier_name = supplier.name

            # Read file
            with open(attachment.file_path, 'rb') as f:
                file_content = f.read()

            # Generate descriptive filename
            date = attachment.uploaded_at or datetime.utcnow()
            prefix = f"dispute-{dispute.id}-{attachment.attachment_type}"
            descriptive_filename = self._generate_descriptive_filename(
                supplier_name,
                date,
                prefix,
                attachment.file_name
            )

            # Build Nextcloud path structure
            base_path = (settings.nextcloud_base_path or "/Kitchen Invoices").strip('/')
            year = date.strftime("%Y")
            month = date.strftime("%m")

            nextcloud_path = f"{base_path}/Disputes/{supplier_name}/{year}/{month}"

            # Upload to Nextcloud
            nc = NextcloudService(
                settings.nextcloud_host,
                settings.nextcloud_username,
                settings.nextcloud_password,
                ""  # No base path, we use explicit path
            )

            success, result = await nc.upload_file(
                file_content,
                nextcloud_path,
                descriptive_filename
            )
            await nc.close()

            if not success:
                return (False, f"Nextcloud upload failed: {result}")

            # Update attachment record
            attachment.file_storage_location = "nextcloud"
            attachment.nextcloud_path = result
            attachment.archived_at = datetime.utcnow()

            await self.db.commit()

            # Optionally delete local file
            if settings.nextcloud_delete_local:
                try:
                    os.remove(attachment.file_path)
                    logger.info(f"Deleted local attachment after archival: {attachment.file_path}")
                except Exception as e:
                    logger.warning(f"Could not delete local file: {e}")

            return (True, result)

        except Exception as e:
            logger.error(f"Failed to archive dispute attachment: {e}")
            return (False, str(e))

    async def archive_credit_note(self, credit_note: CreditNote) -> Tuple[bool, str]:
        """
        Archive credit note to Nextcloud.

        Args:
            credit_note: Credit note to archive

        Returns:
            (success, nextcloud_path or error)
        """
        settings = await self.get_settings()
        if not settings or not settings.nextcloud_enabled:
            return (False, "Nextcloud not enabled")

        if not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
            return (False, "Nextcloud not configured")

        if credit_note.file_storage_location != "local":
            return (False, "Credit note already archived")

        if not os.path.exists(credit_note.file_path):
            return (False, "Local file not found")

        try:
            # Get supplier name
            supplier_name = "Unknown"
            if credit_note.supplier_id:
                result = await self.db.execute(
                    select(Supplier).where(Supplier.id == credit_note.supplier_id)
                )
                supplier = result.scalar_one_or_none()
                if supplier:
                    supplier_name = supplier.name

            # Read file
            with open(credit_note.file_path, 'rb') as f:
                file_content = f.read()

            # Generate descriptive filename
            date = credit_note.credit_date
            date_str = date.strftime("%Y-%m-%d")
            supplier_safe = self._sanitize_filename(supplier_name)[:30]
            cn_number_safe = self._sanitize_filename(credit_note.credit_note_number)[:20]
            amount_str = f"£{credit_note.credit_amount:.2f}".replace('.', '_')

            # Short hash for uniqueness
            hash_input = f"{supplier_name}{date}{credit_note.credit_note_number}".encode()
            short_hash = hashlib.md5(hash_input).hexdigest()[:8]

            descriptive_filename = f"{date_str}-{supplier_safe}-CN-{cn_number_safe}-{amount_str}-{short_hash}.pdf"

            # Build Nextcloud path structure
            base_path = (settings.nextcloud_base_path or "/Kitchen Invoices").strip('/')
            year = date.strftime("%Y")
            month = date.strftime("%m")

            nextcloud_path = f"{base_path}/Credit Notes/{supplier_name}/{year}/{month}"

            # Upload to Nextcloud
            nc = NextcloudService(
                settings.nextcloud_host,
                settings.nextcloud_username,
                settings.nextcloud_password,
                ""
            )

            success, result = await nc.upload_file(
                file_content,
                nextcloud_path,
                descriptive_filename
            )
            await nc.close()

            if not success:
                return (False, f"Nextcloud upload failed: {result}")

            # Update credit note record
            credit_note.file_storage_location = "nextcloud"
            credit_note.nextcloud_path = result
            credit_note.original_local_path = credit_note.file_path
            credit_note.archived_at = datetime.utcnow()

            await self.db.commit()

            # Optionally delete local file
            if settings.nextcloud_delete_local:
                try:
                    os.remove(credit_note.file_path)
                    logger.info(f"Deleted local credit note after archival: {credit_note.file_path}")
                except Exception as e:
                    logger.warning(f"Could not delete local file: {e}")

            return (True, result)

        except Exception as e:
            logger.error(f"Failed to archive credit note: {e}")
            return (False, str(e))

    async def get_attachment_content(self, attachment: DisputeAttachment) -> Tuple[bool, bytes]:
        """
        Get attachment file content (from local or Nextcloud).

        Args:
            attachment: Attachment to retrieve

        Returns:
            (success, file_content or error_message)
        """
        try:
            # Try local file first
            if attachment.file_storage_location == "local" and os.path.exists(attachment.file_path):
                with open(attachment.file_path, 'rb') as f:
                    return (True, f.read())

            # Try Nextcloud
            if attachment.file_storage_location == "nextcloud" and attachment.nextcloud_path:
                settings = await self.get_settings()
                if not settings or not settings.nextcloud_enabled:
                    return (False, b"Nextcloud not enabled")

                nc = NextcloudService(
                    settings.nextcloud_host,
                    settings.nextcloud_username,
                    settings.nextcloud_password,
                    ""
                )

                success, content = await nc.download_file(attachment.nextcloud_path)
                await nc.close()

                if success:
                    return (True, content)
                else:
                    return (False, content.encode() if isinstance(content, str) else content)

            return (False, b"File not found")

        except Exception as e:
            logger.error(f"Failed to get attachment content: {e}")
            return (False, str(e).encode())

    async def get_credit_note_content(self, credit_note: CreditNote) -> Tuple[bool, bytes]:
        """
        Get credit note file content (from local or Nextcloud).

        Args:
            credit_note: Credit note to retrieve

        Returns:
            (success, file_content or error_message)
        """
        try:
            # Try local file first
            if credit_note.file_storage_location == "local" and os.path.exists(credit_note.file_path):
                with open(credit_note.file_path, 'rb') as f:
                    return (True, f.read())

            # Try original local path if different
            if credit_note.original_local_path and os.path.exists(credit_note.original_local_path):
                with open(credit_note.original_local_path, 'rb') as f:
                    return (True, f.read())

            # Try Nextcloud
            if credit_note.file_storage_location == "nextcloud" and credit_note.nextcloud_path:
                settings = await self.get_settings()
                if not settings or not settings.nextcloud_enabled:
                    return (False, b"Nextcloud not enabled")

                nc = NextcloudService(
                    settings.nextcloud_host,
                    settings.nextcloud_username,
                    settings.nextcloud_password,
                    ""
                )

                success, content = await nc.download_file(credit_note.nextcloud_path)
                await nc.close()

                if success:
                    return (True, content)
                else:
                    return (False, content.encode() if isinstance(content, str) else content)

            return (False, b"File not found")

        except Exception as e:
            logger.error(f"Failed to get credit note content: {e}")
            return (False, str(e).encode())
