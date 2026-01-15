"""
Migration script to add new invoice features:
- document_type, order_number columns on invoices
- duplicate_status, duplicate_of_id, related_document_id columns on invoices
- line_items table

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add new columns and tables for invoice features."""

    async with engine.begin() as conn:
        # Check if columns already exist by trying to select them
        try:
            await conn.execute(text("SELECT document_type FROM invoices LIMIT 1"))
            logger.info("Columns already exist, skipping migration")
            return
        except Exception:
            logger.info("Running migration to add new columns...")

        # Add new columns to invoices table
        migrations = [
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_type VARCHAR(50) DEFAULT 'invoice'",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS order_number VARCHAR(100)",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS duplicate_status VARCHAR(50)",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS duplicate_of_id INTEGER REFERENCES invoices(id)",
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS related_document_id INTEGER REFERENCES invoices(id)",
        ]

        for sql in migrations:
            try:
                await conn.execute(text(sql))
                logger.info(f"Executed: {sql[:60]}...")
            except Exception as e:
                logger.warning(f"Column may already exist: {e}")

        # Create line_items table
        create_line_items = """
        CREATE TABLE IF NOT EXISTS line_items (
            id SERIAL PRIMARY KEY,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            description TEXT,
            quantity NUMERIC(10, 3),
            unit_price NUMERIC(10, 2),
            amount NUMERIC(10, 2),
            product_code VARCHAR(100),
            line_number INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
        try:
            await conn.execute(text(create_line_items))
            logger.info("Created line_items table")
        except Exception as e:
            logger.warning(f"line_items table may already exist: {e}")

        # Create index on invoice_id
        try:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_line_items_invoice_id ON line_items(invoice_id)"
            ))
            logger.info("Created index on line_items.invoice_id")
        except Exception as e:
            logger.warning(f"Index may already exist: {e}")

        logger.info("Migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
