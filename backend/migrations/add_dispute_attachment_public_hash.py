"""
Migration to add public_hash column to dispute_attachments table.

This enables public shareable links for dispute attachments, allowing
suppliers to view images/documents via email without authentication.
"""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add public_hash column to dispute_attachments"""
    async with engine.begin() as conn:
        # Check if column already exists
        result = await conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'dispute_attachments'
                AND column_name = 'public_hash'
            );
        """))
        exists = result.scalar()

        if not exists:
            logger.info("Adding 'public_hash' column to dispute_attachments table")
            await conn.execute(text("""
                ALTER TABLE dispute_attachments
                ADD COLUMN public_hash VARCHAR(64) UNIQUE;
            """))

            # Create index for fast lookups
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_dispute_attachments_public_hash
                ON dispute_attachments(public_hash) WHERE public_hash IS NOT NULL;
            """))

            logger.info("Successfully added 'public_hash' column with index")
        else:
            logger.info("'public_hash' column already exists in dispute_attachments")
