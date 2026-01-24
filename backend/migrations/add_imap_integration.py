"""
Migration script to add IMAP email inbox integration:
- IMAP configuration fields on kitchen_settings
- source and source_reference fields on invoices
- email_processing_log table
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add IMAP email inbox integration tables and columns"""

    # Add IMAP columns to kitchen_settings (execute each separately for asyncpg)
    imap_settings_statements = [
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_host VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_port INTEGER DEFAULT 993",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_use_ssl BOOLEAN DEFAULT TRUE",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_username VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_password VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_folder VARCHAR(255) DEFAULT 'INBOX'",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_poll_interval INTEGER DEFAULT 15",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_enabled BOOLEAN DEFAULT FALSE",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_confidence_threshold NUMERIC(3,2) DEFAULT 0.50",
        "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS imap_last_sync TIMESTAMP",
    ]

    # Add source columns to invoices
    invoice_source_statements = [
        "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'upload'",
        "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_reference VARCHAR(255)",
    ]

    # Create email_processing_log table
    create_table = """
    CREATE TABLE IF NOT EXISTS email_processing_log (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        message_id VARCHAR(500) NOT NULL,
        email_subject VARCHAR(500),
        email_from VARCHAR(255),
        email_date TIMESTAMP,
        attachments_count INTEGER DEFAULT 0,
        invoices_created INTEGER DEFAULT 0,
        confident_invoices INTEGER DEFAULT 0,
        marked_as_read BOOLEAN DEFAULT FALSE,
        processing_status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        invoice_ids JSONB,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(kitchen_id, message_id)
    )
    """

    index_statements = [
        "CREATE INDEX IF NOT EXISTS idx_email_log_kitchen ON email_processing_log(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS idx_email_log_message_id ON email_processing_log(message_id)",
        "CREATE INDEX IF NOT EXISTS idx_email_log_processed_at ON email_processing_log(processed_at)",
    ]

    try:
        async with engine.begin() as conn:
            # Add IMAP columns to kitchen_settings
            for sql in imap_settings_statements:
                await conn.execute(text(sql))
            logger.info("Added IMAP columns to kitchen_settings")

            # Add source columns to invoices
            for sql in invoice_source_statements:
                await conn.execute(text(sql))
            logger.info("Added source columns to invoices")

            # Create email_processing_log table
            await conn.execute(text(create_table))
            logger.info("Created email_processing_log table")

            # Create indexes
            for sql in index_statements:
                await conn.execute(text(sql))
            logger.info("Created indexes on email_processing_log")

            logger.info("IMAP integration migration completed")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"IMAP migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
