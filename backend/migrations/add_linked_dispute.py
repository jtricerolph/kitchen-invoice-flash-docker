"""
Migration: Add linked_dispute_id column to invoices table

This allows credit notes to track which dispute they resolved.
"""
import logging
from sqlalchemy import text
from database import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def run_migration():
    """Add linked_dispute_id column to invoices table"""
    async with AsyncSessionLocal() as db:
        try:
            # Add linked_dispute_id column with foreign key to invoice_disputes
            await db.execute(text("""
                ALTER TABLE invoices
                ADD COLUMN IF NOT EXISTS linked_dispute_id INTEGER REFERENCES invoice_disputes(id) ON DELETE SET NULL
            """))

            # Create index for faster lookups
            await db.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_invoices_linked_dispute_id ON invoices(linked_dispute_id)
            """))

            await db.commit()
            logger.info("Linked dispute migration completed successfully")
        except Exception as e:
            logger.warning(f"Linked dispute migration warning: {e}")
            await db.rollback()
