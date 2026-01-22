"""
Migration to add AWAITING_REPLACEMENT to DisputeStatus enum.
"""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add AWAITING_REPLACEMENT value to disputestatus enum"""
    async with engine.begin() as conn:
        # Check if the enum value already exists
        result = await conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM pg_enum
                WHERE enumlabel = 'awaiting_replacement'
                AND enumtypid = (
                    SELECT oid FROM pg_type WHERE typname = 'disputestatus'
                )
            );
        """))
        exists = result.scalar()

        if not exists:
            logger.info("Adding 'awaiting_replacement' to disputestatus enum")
            # Add the new enum value (position doesn't matter for enum functionality)
            await conn.execute(text("""
                ALTER TYPE disputestatus ADD VALUE 'awaiting_replacement';
            """))
            logger.info("Successfully added 'awaiting_replacement' to disputestatus enum")
        else:
            logger.info("'awaiting_replacement' already exists in disputestatus enum")
