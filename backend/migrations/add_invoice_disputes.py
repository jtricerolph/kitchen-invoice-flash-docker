"""
Migration script to add invoice dispute tracking tables and indexes.

Tables created automatically by SQLAlchemy from models:
- invoice_disputes
- dispute_line_items
- dispute_attachments
- dispute_activity
- credit_notes

This migration adds performance indexes.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add indexes for invoice dispute tables."""
    logger.info("Running invoice disputes migration...")

    # Create indexes for performance
    indexes = [
        # Invoice disputes indexes
        "CREATE INDEX IF NOT EXISTS idx_disputes_kitchen_status ON invoice_disputes(kitchen_id, status, opened_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_disputes_invoice ON invoice_disputes(invoice_id)",
        "CREATE INDEX IF NOT EXISTS idx_disputes_type ON invoice_disputes(dispute_type)",
        "CREATE INDEX IF NOT EXISTS idx_disputes_opened_at ON invoice_disputes(opened_at DESC)",

        # Credit notes indexes
        "CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id)",
        "CREATE INDEX IF NOT EXISTS idx_credit_notes_kitchen ON credit_notes(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS idx_credit_notes_date ON credit_notes(credit_date DESC)",

        # Dispute attachments indexes
        "CREATE INDEX IF NOT EXISTS idx_dispute_attachments_dispute ON dispute_attachments(dispute_id)",
        "CREATE INDEX IF NOT EXISTS idx_dispute_attachments_kitchen ON dispute_attachments(kitchen_id)",

        # Dispute activity indexes
        "CREATE INDEX IF NOT EXISTS idx_dispute_activity_dispute ON dispute_activity(dispute_id)",
        "CREATE INDEX IF NOT EXISTS idx_dispute_activity_created_at ON dispute_activity(created_at DESC)",

        # Dispute line items indexes
        "CREATE INDEX IF NOT EXISTS idx_dispute_line_items_dispute ON dispute_line_items(dispute_id)",
    ]

    for sql in indexes:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
                logger.info(f"Created index: {sql[35:80]}...")
        except Exception as e:
            if "already exists" in str(e).lower():
                logger.info(f"Index already exists, skipping")
            else:
                logger.warning(f"Index creation warning: {e}")

    logger.info("Invoice disputes migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
