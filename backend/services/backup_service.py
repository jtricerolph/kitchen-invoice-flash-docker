"""
Backup service for database and file backups.

Handles:
- Database export creation
- Invoice file archiving
- Backup to local/Nextcloud/SMB destinations
- Retention policy enforcement
- Restore operations
"""
import os
import json
import zipfile
import tempfile
import logging
import shutil
from datetime import datetime
from decimal import Decimal
from typing import Tuple, Optional, List

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from models.backup import BackupHistory
from models.settings import KitchenSettings
from models.invoice import Invoice
from models.line_item import LineItem
from models.supplier import Supplier
from services.nextcloud_service import NextcloudService

logger = logging.getLogger(__name__)

# Local backup directory (inside persisted data volume)
LOCAL_BACKUP_DIR = "/app/data/backups"


class DecimalEncoder(json.JSONEncoder):
    """JSON encoder that handles Decimal types"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        if hasattr(obj, 'isoformat'):  # date objects
            return obj.isoformat()
        return super().default(obj)


class BackupService:
    """Service for managing backups"""

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def get_settings(self) -> Optional[KitchenSettings]:
        """Get kitchen settings"""
        result = await self.db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
        )
        return result.scalar_one_or_none()

    def _generate_backup_filename(self) -> str:
        """Generate unique backup filename"""
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        return f"backup_kitchen{self.kitchen_id}_{timestamp}.zip"

    async def _create_database_export(self, output_path: str) -> bool:
        """
        Create JSON export of kitchen data.

        Exports invoices, line items, suppliers, and settings.
        """
        try:
            logger.info(f"Creating database export for kitchen {self.kitchen_id}")

            # Export invoices with line items
            invoices_result = await self.db.execute(
                select(Invoice).options(
                    selectinload(Invoice.line_items)
                ).where(Invoice.kitchen_id == self.kitchen_id)
            )
            invoices = invoices_result.scalars().all()

            # Export suppliers
            suppliers_result = await self.db.execute(
                select(Supplier).where(Supplier.kitchen_id == self.kitchen_id)
            )
            suppliers = suppliers_result.scalars().all()

            # Export settings
            settings = await self.get_settings()

            export_data = {
                "kitchen_id": self.kitchen_id,
                "exported_at": datetime.utcnow().isoformat(),
                "version": "1.0",
                "invoices": [
                    {
                        "id": inv.id,
                        "invoice_number": inv.invoice_number,
                        "invoice_date": inv.invoice_date,
                        "total": inv.total,
                        "net_total": inv.net_total,
                        "supplier_id": inv.supplier_id,
                        "vendor_name": inv.vendor_name,
                        "supplier_match_type": inv.supplier_match_type,
                        "document_type": inv.document_type,
                        "order_number": inv.order_number,
                        "status": inv.status.value if inv.status else None,
                        "category": inv.category,
                        "image_path": inv.image_path,
                        "file_storage_location": inv.file_storage_location,
                        "nextcloud_path": inv.nextcloud_path,
                        "original_local_path": inv.original_local_path,
                        "ocr_confidence": inv.ocr_confidence,
                        "notes": inv.notes,
                        "dext_sent_at": inv.dext_sent_at,
                        "created_at": inv.created_at,
                        "updated_at": inv.updated_at,
                        "line_items": [
                            {
                                "id": li.id,
                                "product_code": li.product_code,
                                "description": li.description,
                                "unit": li.unit,
                                "quantity": li.quantity,
                                "order_quantity": li.order_quantity,
                                "unit_price": li.unit_price,
                                "tax_rate": li.tax_rate,
                                "tax_amount": li.tax_amount,
                                "amount": li.amount,
                                "line_number": li.line_number,
                                "is_non_stock": li.is_non_stock,
                                "pack_quantity": li.pack_quantity,
                                "unit_size": li.unit_size,
                                "unit_size_type": li.unit_size_type,
                                "portions_per_unit": li.portions_per_unit,
                            }
                            for li in inv.line_items
                        ]
                    }
                    for inv in invoices
                ],
                "suppliers": [
                    {
                        "id": sup.id,
                        "name": sup.name,
                        "aliases": sup.aliases,
                        "category": sup.category,
                        "is_active": sup.is_active,
                    }
                    for sup in suppliers
                ],
                "settings": {
                    "currency_symbol": settings.currency_symbol if settings else "£",
                    "date_format": settings.date_format if settings else "DD/MM/YYYY",
                    "high_quantity_threshold": settings.high_quantity_threshold if settings else 100,
                } if settings else None
            }

            with open(output_path, 'w') as f:
                json.dump(export_data, f, indent=2, cls=DecimalEncoder)

            return True

        except Exception as e:
            logger.error(f"Database export failed: {e}")
            return False

    async def create_backup(
        self,
        user_id: Optional[int] = None,
        backup_type: str = "manual"
    ) -> Tuple[bool, str, Optional[BackupHistory]]:
        """
        Create a full backup (database + files).

        Args:
            user_id: User who triggered backup (None for scheduled)
            backup_type: "manual" or "scheduled"

        Returns:
            (success, message, backup_history_record)
        """
        settings = await self.get_settings()
        destination = settings.backup_destination if settings else "local"

        # Create backup history record
        backup = BackupHistory(
            kitchen_id=self.kitchen_id,
            backup_type=backup_type,
            destination=destination or "local",
            status="running",
            filename=self._generate_backup_filename(),
            file_path="",  # Will be set after upload
            triggered_by_user_id=user_id
        )
        self.db.add(backup)
        await self.db.commit()
        await self.db.refresh(backup)

        try:
            # Create temp directory for backup
            with tempfile.TemporaryDirectory() as temp_dir:
                backup_zip_path = os.path.join(temp_dir, backup.filename)

                # Create ZIP file
                with zipfile.ZipFile(backup_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                    # 1. Database export
                    db_export_path = os.path.join(temp_dir, "database.json")
                    if await self._create_database_export(db_export_path):
                        zf.write(db_export_path, "database.json")

                    # 2. Invoice files (only local ones)
                    result = await self.db.execute(
                        select(Invoice).where(
                            Invoice.kitchen_id == self.kitchen_id,
                            Invoice.file_storage_location == "local"
                        )
                    )
                    invoices = result.scalars().all()

                    file_count = 0
                    for invoice in invoices:
                        if invoice.image_path and os.path.exists(invoice.image_path):
                            # Preserve directory structure relative to /app/data/
                            rel_path = invoice.image_path.replace("/app/data/", "")
                            zf.write(invoice.image_path, f"files/{rel_path}")
                            file_count += 1

                    backup.invoice_count = len(invoices)
                    backup.file_count = file_count

                # Get file size
                backup.file_size_bytes = os.path.getsize(backup_zip_path)

                # Upload to destination
                if destination == "local":
                    # Copy to local backup directory
                    os.makedirs(LOCAL_BACKUP_DIR, exist_ok=True)
                    final_path = os.path.join(LOCAL_BACKUP_DIR, backup.filename)
                    shutil.copy2(backup_zip_path, final_path)
                    backup.file_path = final_path

                elif destination == "nextcloud":
                    # Upload to Nextcloud
                    if not settings or not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
                        raise ValueError("Nextcloud not configured for backup")

                    # Use separate backup path on Nextcloud (not inside invoice archive path)
                    backup_path = settings.backup_nextcloud_path or "/Backups"
                    backup_path = backup_path.strip('/')

                    nc = NextcloudService(
                        settings.nextcloud_host,
                        settings.nextcloud_username,
                        settings.nextcloud_password,
                        ""  # Don't use base_path, use explicit backup_path
                    )

                    with open(backup_zip_path, 'rb') as f:
                        success, result = await nc.upload_file(
                            f.read(),
                            backup_path,
                            backup.filename
                        )
                    await nc.close()

                    if not success:
                        raise ValueError(f"Nextcloud upload failed: {result}")

                    backup.file_path = f"nextcloud:{result}"

                elif destination == "smb":
                    # SMB backup - placeholder for future implementation
                    # Would use smbclient or pysmb library
                    raise NotImplementedError("SMB backup not yet implemented")

                # Update backup record
                backup.status = "success"
                backup.completed_at = datetime.utcnow()

                # Update settings with last backup info
                if settings:
                    settings.backup_last_run_at = datetime.utcnow()
                    settings.backup_last_status = "success"
                    settings.backup_last_error = None

                await self.db.commit()

                # Enforce retention policy
                await self._enforce_retention(settings)

                return (True, f"Backup created: {backup.filename}", backup)

        except Exception as e:
            logger.error(f"Backup failed: {e}")
            backup.status = "failed"
            backup.error_message = str(e)
            backup.completed_at = datetime.utcnow()

            if settings:
                settings.backup_last_status = "failed"
                settings.backup_last_error = str(e)

            await self.db.commit()
            return (False, str(e), backup)

    async def _enforce_retention(self, settings: Optional[KitchenSettings]):
        """Delete old backups beyond retention count"""
        retention = settings.backup_retention_count if settings else 7

        # Get all successful backups, ordered by date
        result = await self.db.execute(
            select(BackupHistory).where(
                BackupHistory.kitchen_id == self.kitchen_id,
                BackupHistory.status == "success"
            ).order_by(BackupHistory.started_at.desc())
        )
        backups = result.scalars().all()

        # Delete backups beyond retention
        for old_backup in list(backups)[retention:]:
            try:
                # Delete file
                if old_backup.file_path.startswith("nextcloud:"):
                    # Delete from Nextcloud
                    if settings and settings.nextcloud_host:
                        nc_path = old_backup.file_path.replace("nextcloud:", "")
                        nc = NextcloudService(
                            settings.nextcloud_host,
                            settings.nextcloud_username,
                            settings.nextcloud_password,
                            ""
                        )
                        await nc.delete_file(nc_path)
                        await nc.close()
                elif old_backup.file_path and os.path.exists(old_backup.file_path):
                    os.remove(old_backup.file_path)

                # Delete record
                await self.db.delete(old_backup)
                logger.info(f"Deleted old backup: {old_backup.filename}")

            except Exception as e:
                logger.warning(f"Failed to delete old backup {old_backup.filename}: {e}")

        await self.db.commit()

    async def list_backups(self, limit: int = 50) -> List[BackupHistory]:
        """List all backups for this kitchen"""
        result = await self.db.execute(
            select(BackupHistory).options(
                selectinload(BackupHistory.triggered_by_user)
            ).where(
                BackupHistory.kitchen_id == self.kitchen_id
            ).order_by(BackupHistory.started_at.desc()).limit(limit)
        )
        return list(result.scalars().all())

    async def get_backup(self, backup_id: int) -> Optional[BackupHistory]:
        """Get a specific backup by ID"""
        result = await self.db.execute(
            select(BackupHistory).where(
                BackupHistory.id == backup_id,
                BackupHistory.kitchen_id == self.kitchen_id
            )
        )
        return result.scalar_one_or_none()

    async def delete_backup(self, backup_id: int) -> Tuple[bool, str]:
        """Delete a backup"""
        backup = await self.get_backup(backup_id)
        if not backup:
            return (False, "Backup not found")

        try:
            # Delete file
            if backup.file_path:
                if backup.file_path.startswith("nextcloud:"):
                    settings = await self.get_settings()
                    if settings and settings.nextcloud_host:
                        nc_path = backup.file_path.replace("nextcloud:", "")
                        nc = NextcloudService(
                            settings.nextcloud_host,
                            settings.nextcloud_username,
                            settings.nextcloud_password,
                            ""
                        )
                        await nc.delete_file(nc_path)
                        await nc.close()
                elif os.path.exists(backup.file_path):
                    os.remove(backup.file_path)

            # Delete record
            await self.db.delete(backup)
            await self.db.commit()

            return (True, "Backup deleted")

        except Exception as e:
            logger.error(f"Failed to delete backup: {e}")
            return (False, str(e))

    async def restore_backup(self, backup_id: int) -> Tuple[bool, str]:
        """
        Restore from a backup.

        WARNING: This is a complex operation. For now, we just extract the files.
        Full database restore would require more careful handling.

        Args:
            backup_id: ID of backup to restore

        Returns:
            (success, message)
        """
        backup = await self.get_backup(backup_id)
        if not backup:
            return (False, "Backup not found")

        if backup.status != "success":
            return (False, "Cannot restore from failed backup")

        try:
            settings = await self.get_settings()

            with tempfile.TemporaryDirectory() as temp_dir:
                backup_path = os.path.join(temp_dir, backup.filename)

                # Download backup file
                if backup.file_path.startswith("nextcloud:"):
                    # Download from Nextcloud
                    if not settings or not settings.nextcloud_host:
                        return (False, "Nextcloud not configured")

                    nc_path = backup.file_path.replace("nextcloud:", "")
                    nc = NextcloudService(
                        settings.nextcloud_host,
                        settings.nextcloud_username,
                        settings.nextcloud_password,
                        ""
                    )
                    success, content = await nc.download_file(nc_path)
                    await nc.close()

                    if not success:
                        return (False, f"Failed to download backup: {content}")

                    with open(backup_path, 'wb') as f:
                        f.write(content)
                else:
                    # Local file
                    if not os.path.exists(backup.file_path):
                        return (False, "Backup file not found")
                    shutil.copy2(backup.file_path, backup_path)

                # Extract backup
                with zipfile.ZipFile(backup_path, 'r') as zf:
                    zf.extractall(temp_dir)

                # Restore files
                files_dir = os.path.join(temp_dir, "files")
                if os.path.exists(files_dir):
                    data_dir = "/app/data"
                    for root, dirs, files in os.walk(files_dir):
                        for file in files:
                            src = os.path.join(root, file)
                            rel_path = os.path.relpath(src, files_dir)
                            dst = os.path.join(data_dir, rel_path)
                            os.makedirs(os.path.dirname(dst), exist_ok=True)
                            if not os.path.exists(dst):  # Don't overwrite existing files
                                shutil.copy2(src, dst)

                # Note: Database restore would be done separately
                # The database.json is available for manual import if needed

                return (True, f"Restored files from backup: {backup.filename}")

        except Exception as e:
            logger.error(f"Restore failed: {e}")
            return (False, str(e))

    async def restore_from_upload(self, file) -> Tuple[bool, str]:
        """
        Restore from an uploaded backup file.

        Args:
            file: UploadFile from FastAPI

        Returns:
            (success, message)
        """
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                # Save uploaded file
                backup_path = os.path.join(temp_dir, file.filename)
                content = await file.read()

                with open(backup_path, 'wb') as f:
                    f.write(content)

                # Verify it's a valid ZIP
                if not zipfile.is_zipfile(backup_path):
                    return (False, "Invalid ZIP file")

                # Extract backup
                with zipfile.ZipFile(backup_path, 'r') as zf:
                    zf.extractall(temp_dir)

                # Check for required database.json
                db_json_path = os.path.join(temp_dir, "database.json")
                if not os.path.exists(db_json_path):
                    return (False, "Invalid backup: missing database.json")

                # Restore files
                files_dir = os.path.join(temp_dir, "files")
                restored_count = 0
                if os.path.exists(files_dir):
                    data_dir = "/app/data"
                    for root, dirs, files_list in os.walk(files_dir):
                        for file_name in files_list:
                            src = os.path.join(root, file_name)
                            rel_path = os.path.relpath(src, files_dir)
                            dst = os.path.join(data_dir, rel_path)
                            os.makedirs(os.path.dirname(dst), exist_ok=True)
                            if not os.path.exists(dst):  # Don't overwrite existing files
                                shutil.copy2(src, dst)
                                restored_count += 1

                return (True, f"Restored {restored_count} files from uploaded backup")

        except zipfile.BadZipFile:
            return (False, "Corrupted ZIP file")
        except Exception as e:
            logger.error(f"Restore from upload failed: {e}")
            return (False, str(e))
