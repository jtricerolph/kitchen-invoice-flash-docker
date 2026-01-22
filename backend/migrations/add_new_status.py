"""
Migration to add NEW status and update OPEN disputes to NEW.
"""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add NEW status and migrate OPEN disputes"""
    # First transaction: Add NEW enum value
    async with engine.begin() as conn:
        # Check if NEW enum value already exists
        result = await conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM pg_enum
                WHERE enumlabel = 'NEW'
                AND enumtypid = (
                    SELECT oid FROM pg_type WHERE typname = 'disputestatus'
                )
            );
        """))
        exists = result.scalar()

        if not exists:
            logger.info("Adding 'NEW' to disputestatus enum")
            await conn.execute(text("""
                ALTER TYPE disputestatus ADD VALUE 'NEW';
            """))
            logger.info("Successfully added 'NEW' to disputestatus enum")
        else:
            logger.info("'NEW' already exists in disputestatus enum")

    # Second transaction: Update existing OPEN disputes to NEW (requires commit after enum addition)
    async with engine.begin() as conn:
        # Check if there are any OPEN disputes that need migration
        result = await conn.execute(text("""
            SELECT COUNT(*) FROM invoice_disputes WHERE status = 'OPEN';
        """))
        open_count = result.scalar()

        if open_count > 0:
            logger.info(f"Updating {open_count} existing OPEN disputes to NEW")
            await conn.execute(text("""
                UPDATE invoice_disputes SET status = 'NEW' WHERE status = 'OPEN';
            """))
            logger.info("Successfully migrated OPEN disputes to NEW")
        else:
            logger.info("No OPEN disputes to migrate")
