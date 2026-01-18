"""
Service for managing invoice file archival to Nextcloud.

Handles:
- Automatic archival after invoice confirmation + Dext send
- File retrieval from Nextcloud for re-processing
- Deleted file handling
"""
import os
import hashlib
import logging
from datetime import datetime
from typing import Tuple, Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from models.invoice import Invoice, InvoiceStatus
from models.settings import KitchenSettings
from models.supplier import Supplier
from services.nextcloud_service import NextcloudService

logger = logging.getLogger(__name__)


class FileArchivalService:
    """Service for managing invoice file archival"""

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def get_settings(self) -> Optional[KitchenSettings]:
        """Get kitchen settings"""
        result = await self.db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
        )
        return result.scalar_one_or_none()

    async def is_ready_for_archival(self, invoice: Invoice) -> bool:
        """
        Check if invoice is ready to be archived to Nextcloud.

        Conditions:
        - Status is CONFIRMED
        - If Dext is enabled and auto-send is on, must have been sent
        - File is still local
        """
        if invoice.status != InvoiceStatus.CONFIRMED:
            return False

        if invoice.file_storage_location != "local":
            return False

        settings = await self.get_settings()
        if not settings or not settings.nextcloud_enabled:
            return False

        # Check Dext requirement - only if auto-send is enabled
        if settings.dext_email and settings.dext_auto_send_enabled:
            if not invoice.dext_sent_at:
                return False

        return True

    async def archive_invoice_file(self, invoice: Invoice) -> Tuple[bool, str]:
        """
        Archive invoice file to Nextcloud.

        Args:
            invoice: Invoice to archive

        Returns:
            (success, message or path)
        """
        settings = await self.get_settings()
        if not settings or not settings.nextcloud_enabled:
            return (False, "Nextcloud not enabled")

        if not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
            return (False, "Nextcloud not configured")

        if invoice.file_storage_location != "local":
            return (False, "File already archived")

        if not os.path.exists(invoice.image_path):
            return (False, "Local file not found")

        try:
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
            with open(invoice.image_path, 'rb') as f:
                file_content = f.read()

            # Generate hash from file content
            file_hash = hashlib.md5(file_content).hexdigest()

            # Initialize Nextcloud service
            nc = NextcloudService(
                settings.nextcloud_host,
                settings.nextcloud_username,
                settings.nextcloud_password,
                settings.nextcloud_base_path
            )

            # Generate path and filename
            dir_path = nc.generate_path(supplier_name, invoice.invoice_date)
            filename = nc.generate_filename(
                invoice.invoice_date,
                supplier_name,
                invoice.invoice_number,
                float(invoice.total) if invoice.total else 0,
                os.path.basename(invoice.image_path),
                file_hash
            )

            # Upload to Nextcloud
            success, result = await nc.upload_file(file_content, dir_path, filename)
            await nc.close()

            if not success:
                return (False, f"Upload failed: {result}")

            # Update invoice record
            invoice.original_local_path = invoice.image_path
            invoice.nextcloud_path = result
            invoice.file_storage_location = "nextcloud"
            invoice.archived_at = datetime.utcnow()

            await self.db.commit()

            logger.info(f"Archived invoice {invoice.id} to Nextcloud: {result}")

            # Delete local file if setting enabled
            if settings.nextcloud_delete_local and os.path.exists(invoice.image_path):
                try:
                    os.remove(invoice.image_path)
                    logger.info(f"Deleted local file for invoice {invoice.id}: {invoice.image_path}")
                except Exception as e:
                    logger.warning(f"Failed to delete local file {invoice.image_path}: {e}")

            return (True, result)

        except Exception as e:
            logger.error(f"Archival failed for invoice {invoice.id}: {e}")
            return (False, str(e))

    async def get_file_content(self, invoice: Invoice) -> Tuple[bool, bytes | str]:
        """
        Get file content, downloading from Nextcloud if needed.

        Used for OCR re-processing or file serving.

        Args:
            invoice: Invoice to get file for

        Returns:
            (success, file_bytes or error_message)
        """
        # Try local file first (image_path)
        if os.path.exists(invoice.image_path):
            with open(invoice.image_path, 'rb') as f:
                return (True, f.read())

        # Try original local path (if file was archived but local copy exists)
        if invoice.original_local_path and os.path.exists(invoice.original_local_path):
            with open(invoice.original_local_path, 'rb') as f:
                return (True, f.read())

        # Download from Nextcloud
        if invoice.file_storage_location == "nextcloud" and invoice.nextcloud_path:
            settings = await self.get_settings()
            if not settings or not settings.nextcloud_enabled:
                return (False, "Nextcloud not configured")

            if not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
                return (False, "Nextcloud credentials not set")

            nc = NextcloudService(
                settings.nextcloud_host,
                settings.nextcloud_username,
                settings.nextcloud_password,
                ""  # Path already includes base
            )

            success, result = await nc.download_file(invoice.nextcloud_path)
            await nc.close()

            if success and isinstance(result, bytes):
                # Cache locally for future use
                try:
                    os.makedirs(os.path.dirname(invoice.image_path), exist_ok=True)
                    with open(invoice.image_path, 'wb') as f:
                        f.write(result)
                except Exception as e:
                    logger.warning(f"Failed to cache file locally: {e}")

            return (success, result)

        return (False, "File not found")

    async def handle_invoice_deletion(self, invoice: Invoice) -> Tuple[bool, str]:
        """
        Handle file when invoice is being deleted.

        If on Nextcloud, copy to deleted folder.

        Args:
            invoice: Invoice being deleted

        Returns:
            (success, message)
        """
        if invoice.file_storage_location == "nextcloud" and invoice.nextcloud_path:
            settings = await self.get_settings()
            if settings and settings.nextcloud_enabled:
                try:
                    # Get supplier name for deleted folder
                    supplier_name = "Unknown"
                    if invoice.supplier_id:
                        result = await self.db.execute(
                            select(Supplier).where(Supplier.id == invoice.supplier_id)
                        )
                        supplier = result.scalar_one_or_none()
                        if supplier:
                            supplier_name = supplier.name

                    nc = NextcloudService(
                        settings.nextcloud_host,
                        settings.nextcloud_username,
                        settings.nextcloud_password,
                        settings.nextcloud_base_path
                    )

                    # Copy to deleted folder
                    original_filename = os.path.basename(invoice.nextcloud_path)
                    success, msg = await nc.copy_to_deleted(
                        invoice.nextcloud_path,
                        supplier_name,
                        original_filename
                    )
                    await nc.close()

                    if not success:
                        logger.warning(f"Failed to copy to deleted folder: {msg}")

                    return (True, "File moved to deleted folder")

                except Exception as e:
                    logger.error(f"Error handling file deletion: {e}")

        # Local file deletion
        if invoice.image_path and os.path.exists(invoice.image_path):
            try:
                os.remove(invoice.image_path)
            except Exception as e:
                logger.warning(f"Failed to delete local file: {e}")

        # Also try to delete original local path if different
        if invoice.original_local_path and invoice.original_local_path != invoice.image_path:
            if os.path.exists(invoice.original_local_path):
                try:
                    os.remove(invoice.original_local_path)
                except Exception as e:
                    logger.warning(f"Failed to delete original local file: {e}")

        return (True, "Local file deleted")

    async def get_archive_stats(self) -> dict:
        """
        Get archival statistics for this kitchen.

        Returns:
            dict with pending_count, archived_count, etc.
        """
        settings = await self.get_settings()

        # Count invoices ready for archival (confirmed + local)
        pending_query = select(func.count(Invoice.id)).where(
            Invoice.kitchen_id == self.kitchen_id,
            Invoice.status == InvoiceStatus.CONFIRMED,
            Invoice.file_storage_location == "local"
        )
        pending_result = await self.db.execute(pending_query)
        pending_count = pending_result.scalar() or 0

        # Count already archived invoices
        archived_query = select(func.count(Invoice.id)).where(
            Invoice.kitchen_id == self.kitchen_id,
            Invoice.file_storage_location == "nextcloud"
        )
        archived_result = await self.db.execute(archived_query)
        archived_count = archived_result.scalar() or 0

        # Count all invoices with local files (any status)
        local_query = select(func.count(Invoice.id)).where(
            Invoice.kitchen_id == self.kitchen_id,
            Invoice.file_storage_location == "local"
        )
        local_result = await self.db.execute(local_query)
        local_count = local_result.scalar() or 0

        return {
            "pending_count": pending_count,
            "archived_count": archived_count,
            "local_count": local_count,
            "nextcloud_enabled": settings.nextcloud_enabled if settings else False,
            "nextcloud_configured": bool(
                settings and settings.nextcloud_host and
                settings.nextcloud_username and settings.nextcloud_password
            ) if settings else False
        }

    async def archive_all_pending(self) -> Tuple[int, int, list]:
        """
        Archive all pending invoices to Nextcloud.

        Returns:
            (success_count, failed_count, error_messages)
        """
        settings = await self.get_settings()
        if not settings or not settings.nextcloud_enabled:
            return (0, 0, ["Nextcloud not enabled"])

        if not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
            return (0, 0, ["Nextcloud not configured"])

        # Get all invoices ready for archival
        query = select(Invoice).where(
            Invoice.kitchen_id == self.kitchen_id,
            Invoice.status == InvoiceStatus.CONFIRMED,
            Invoice.file_storage_location == "local"
        )
        result = await self.db.execute(query)
        invoices = result.scalars().all()

        success_count = 0
        failed_count = 0
        errors = []

        for invoice in invoices:
            if await self.is_ready_for_archival(invoice):
                try:
                    success, msg = await self.archive_invoice_file(invoice)
                    if success:
                        success_count += 1
                    else:
                        failed_count += 1
                        errors.append(f"Invoice {invoice.id}: {msg}")
                except Exception as e:
                    failed_count += 1
                    errors.append(f"Invoice {invoice.id}: {str(e)}")

        return (success_count, failed_count, errors)
