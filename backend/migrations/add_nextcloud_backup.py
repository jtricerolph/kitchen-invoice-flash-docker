"""
Migration script to add Nextcloud and Backup features.

Adds:
- Nextcloud settings columns to kitchen_settings
- Backup settings columns to kitchen_settings
- File storage tracking columns to invoices
- backup_history table

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add new columns for Nextcloud and Backup features."""
    logger.info("Running Nextcloud/Backup database migrations...")

    # ===== KITCHEN_SETTINGS - NEXTCLOUD COLUMNS =====
    nextcloud_columns = [
        ("nextcloud_host", "VARCHAR(500)"),
        ("nextcloud_username", "VARCHAR(255)"),
        ("nextcloud_password", "VARCHAR(500)"),
        ("nextcloud_base_path", "VARCHAR(500) DEFAULT '/Kitchen Invoices'"),
        ("nextcloud_enabled", "BOOLEAN DEFAULT FALSE"),
        ("nextcloud_delete_local", "BOOLEAN DEFAULT FALSE"),
    ]

    for col_name, col_type in nextcloud_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
                ))
                logger.info(f"Added {col_name} column to kitchen_settings")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"{col_name} column already exists")
            else:
                logger.warning(f"{col_name} column: {e}")

    # ===== KITCHEN_SETTINGS - BACKUP COLUMNS =====
    backup_columns = [
        ("backup_frequency", "VARCHAR(20) DEFAULT 'manual'"),
        ("backup_retention_count", "INTEGER DEFAULT 7"),
        ("backup_destination", "VARCHAR(20) DEFAULT 'local'"),
        ("backup_time", "VARCHAR(5) DEFAULT '03:00'"),
        ("backup_nextcloud_path", "VARCHAR(500) DEFAULT '/Backups'"),
        ("backup_smb_host", "VARCHAR(255)"),
        ("backup_smb_share", "VARCHAR(255)"),
        ("backup_smb_username", "VARCHAR(255)"),
        ("backup_smb_password", "VARCHAR(500)"),
        ("backup_smb_path", "VARCHAR(500) DEFAULT '/backups'"),
        ("backup_last_run_at", "TIMESTAMP"),
        ("backup_last_status", "VARCHAR(50)"),
        ("backup_last_error", "TEXT"),
    ]

    for col_name, col_type in backup_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
                ))
                logger.info(f"Added {col_name} column to kitchen_settings")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"{col_name} column already exists")
            else:
                logger.warning(f"{col_name} column: {e}")

    # ===== INVOICES - FILE STORAGE COLUMNS =====
    invoice_columns = [
        ("file_storage_location", "VARCHAR(20) DEFAULT 'local'"),
        ("nextcloud_path", "VARCHAR(500)"),
        ("archived_at", "TIMESTAMP"),
        ("original_local_path", "VARCHAR(500)"),
    ]

    for col_name, col_type in invoice_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE invoices ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
                ))
                logger.info(f"Added {col_name} column to invoices")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"{col_name} column already exists")
            else:
                logger.warning(f"{col_name} column: {e}")

    # ===== CREATE BACKUP_HISTORY TABLE =====
    try:
        async with engine.begin() as conn:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS backup_history (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    backup_type VARCHAR(20) NOT NULL,
                    destination VARCHAR(20) NOT NULL,
                    status VARCHAR(20) NOT NULL,
                    filename VARCHAR(255) NOT NULL,
                    file_path VARCHAR(500) NOT NULL,
                    file_size_bytes BIGINT,
                    invoice_count INTEGER,
                    file_count INTEGER,
                    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMP,
                    error_message TEXT,
                    triggered_by_user_id INTEGER REFERENCES users(id)
                )
            """))
            logger.info("Created backup_history table")
    except Exception as e:
        if "already exists" in str(e).lower():
            logger.info("backup_history table already exists")
        else:
            logger.warning(f"backup_history table: {e}")

    # Create index on backup_history
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_backup_history_kitchen "
                "ON backup_history(kitchen_id, started_at DESC)"
            ))
            logger.info("Created backup_history index")
    except Exception as e:
        logger.warning(f"backup_history index: {e}")

    logger.info("Nextcloud/Backup migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
