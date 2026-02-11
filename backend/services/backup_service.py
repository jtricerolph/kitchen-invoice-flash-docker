"""
Backup service for database and file backups.

Handles:
- Full PostgreSQL database dump (pg_dump)
- Application data JSON export
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
import asyncio
from datetime import datetime
from decimal import Decimal
from typing import Tuple, Optional, List
from urllib.parse import urlparse

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

# Database connection settings - parse from DATABASE_URL if available
_db_url = os.getenv("DATABASE_URL", "")
if _db_url:
    _parsed = urlparse(_db_url)
    DB_HOST = _parsed.hostname or "db"
    DB_PORT = str(_parsed.port or 5432)
    DB_NAME = (_parsed.path or "/kitchen_gp").lstrip('/')
    DB_USER = _parsed.username or "kitchen"
    DB_PASSWORD = _parsed.password or "kitchen_secret"
else:
    DB_HOST = os.getenv("DATABASE_HOST", "db")
    DB_PORT = os.getenv("DATABASE_PORT", "5432")
    DB_NAME = os.getenv("DATABASE_NAME", "kitchen_gp")
    DB_USER = os.getenv("DATABASE_USER", "kitchen")
    DB_PASSWORD = os.getenv("DATABASE_PASSWORD", "kitchen_secret")

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
                        "kitchen_id": sup.kitchen_id,
                        "name": sup.name,
                        "aliases": sup.aliases,
                        "template_config": sup.template_config,
                        "identifier_config": sup.identifier_config,
                        "created_at": sup.created_at,
                        "updated_at": sup.updated_at,
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

            logger.info(f"Database JSON export created: {len(invoices)} invoices, {len(suppliers)} suppliers")
            return True

        except Exception as e:
            logger.error(f"Database JSON export failed: {e}", exc_info=True)
            return False

    async def _create_postgres_dump(self, output_path: str) -> bool:
        """
        Create a full PostgreSQL dump using pg_dump.

        This creates a complete SQL backup that can restore the entire database.
        """
        try:
            logger.info(f"Creating PostgreSQL dump for database {DB_NAME}")

            # Build pg_dump command
            # Use custom format (-Fc) for compression and flexible restore
            # But also create a plain SQL for easy viewing
            env = os.environ.copy()
            env['PGPASSWORD'] = DB_PASSWORD

            # Create plain SQL dump (human readable, can be used with psql)
            process = await asyncio.create_subprocess_exec(
                'pg_dump',
                '-h', DB_HOST,
                '-p', DB_PORT,
                '-U', DB_USER,
                '-d', DB_NAME,
                '--no-owner',           # Don't dump ownership
                '--no-privileges',      # Don't dump privileges
                '--clean',              # Add DROP statements
                '--if-exists',          # Add IF EXISTS to DROP
                '-f', output_path,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown error"
                logger.error(f"pg_dump failed with code {process.returncode}: {error_msg}")
                return False

            # Check file was created and has content
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                size_kb = os.path.getsize(output_path) / 1024
                logger.info(f"PostgreSQL dump created: {size_kb:.1f} KB")
                return True
            else:
                logger.error("pg_dump created empty or no file")
                return False

        except FileNotFoundError:
            logger.error("pg_dump command not found - PostgreSQL client tools not installed")
            return False
        except Exception as e:
            logger.error(f"PostgreSQL dump failed: {e}", exc_info=True)
            return False

    async def _restore_postgres_dump(self, sql_path: str) -> bool:
        """
        Restore database from a PostgreSQL SQL dump.

        WARNING: This will DROP and recreate all tables!
        """
        try:
            logger.info(f"Restoring PostgreSQL database from {sql_path}")

            env = os.environ.copy()
            env['PGPASSWORD'] = DB_PASSWORD

            # Use psql to restore the dump
            process = await asyncio.create_subprocess_exec(
                'psql',
                '-h', DB_HOST,
                '-p', DB_PORT,
                '-U', DB_USER,
                '-d', DB_NAME,
                '-f', sql_path,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown error"
                # Some errors are expected (like "table does not exist" for DROP IF EXISTS)
                if "ERROR" in error_msg and "does not exist" not in error_msg:
                    logger.error(f"psql restore failed: {error_msg}")
                    return False

            logger.info("PostgreSQL database restored successfully")
            return True

        except FileNotFoundError:
            logger.error("psql command not found - PostgreSQL client tools not installed")
            return False
        except Exception as e:
            logger.error(f"PostgreSQL restore failed: {e}", exc_info=True)
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
                    # 1. Full PostgreSQL dump (for complete recovery)
                    pg_dump_path = os.path.join(temp_dir, "database.sql")
                    if await self._create_postgres_dump(pg_dump_path):
                        zf.write(pg_dump_path, "database.sql")
                        logger.info("Added database.sql to backup")
                    else:
                        logger.warning("PostgreSQL dump failed - backup will not include full database")

                    # 2. JSON export (for easy viewing/partial restore)
                    db_export_path = os.path.join(temp_dir, "database.json")
                    if await self._create_database_export(db_export_path):
                        zf.write(db_export_path, "database.json")
                        logger.info("Added database.json to backup")
                    else:
                        logger.warning("JSON export failed - backup will not include application data export")

                    # 3. ALL files in /app/data/ (invoices, disputes, credit notes, etc.)
                    # This ensures a complete backup for full recovery/transfer
                    data_dir = "/app/data"
                    file_count = 0
                    skipped_dirs = {'backups'}  # Don't backup the backups directory

                    logger.info(f"Scanning {data_dir} for files to backup...")

                    if os.path.exists(data_dir):
                        for root, dirs, files in os.walk(data_dir):
                            # Skip backups directory to avoid recursive backup
                            dirs[:] = [d for d in dirs if d not in skipped_dirs]

                            for file in files:
                                file_path = os.path.join(root, file)
                                # Get relative path from /app/data/
                                rel_path = os.path.relpath(file_path, data_dir)
                                try:
                                    zf.write(file_path, f"files/{rel_path}")
                                    file_count += 1
                                except Exception as e:
                                    logger.warning(f"Failed to add file {rel_path}: {e}")

                    logger.info(f"Added {file_count} files to backup from {data_dir}")

                    # Also count invoices for metadata
                    result = await self.db.execute(
                        select(Invoice).where(Invoice.kitchen_id == self.kitchen_id)
                    )
                    invoices = result.scalars().all()
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
                        file_content = f.read()
                        size_mb = len(file_content) / (1024 * 1024)
                        # 10 min timeout for backups (large ZIP files)
                        upload_timeout = max(600, size_mb * 10)  # At least 10 min, or 10s per MB
                        logger.info(f"Uploading backup to Nextcloud: {backup.filename} ({size_mb:.1f} MB, timeout={upload_timeout:.0f}s)")
                        success, result = await nc.upload_file(
                            file_content,
                            backup_path,
                            backup.filename,
                            timeout=upload_timeout
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

                # Restore database from SQL dump if present
                db_sql_path = os.path.join(temp_dir, "database.sql")
                db_restored = False
                if os.path.exists(db_sql_path):
                    db_restored = await self._restore_postgres_dump(db_sql_path)
                    if db_restored:
                        logger.info("Database restored from SQL dump")
                    else:
                        logger.warning("Database restore failed - files restored but database unchanged")

                if db_restored:
                    return (True, f"Fully restored from backup: {backup.filename} (database + files)")
                else:
                    return (True, f"Restored files from backup: {backup.filename} (database restore requires manual import)")

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

                # Restore database from SQL dump if present
                db_sql_path = os.path.join(temp_dir, "database.sql")
                db_restored = False
                if os.path.exists(db_sql_path):
                    db_restored = await self._restore_postgres_dump(db_sql_path)
                    if db_restored:
                        logger.info("Database restored from uploaded backup SQL dump")

                if db_restored:
                    return (True, f"Fully restored from uploaded backup: database + {restored_count} files")
                else:
                    return (True, f"Restored {restored_count} files from uploaded backup (database restore requires manual import)")

        except zipfile.BadZipFile:
            return (False, "Corrupted ZIP file")
        except Exception as e:
            logger.error(f"Restore from upload failed: {e}")
            return (False, str(e))
