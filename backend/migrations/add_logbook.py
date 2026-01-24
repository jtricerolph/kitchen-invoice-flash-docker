import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Create logbook tables and enums"""

    # Create enums one at a time (asyncpg doesn't support multiple statements)
    enum_statements = [
        """
        DO $$ BEGIN
            CREATE TYPE entry_type AS ENUM (
                'wastage', 'transfer', 'staff_food', 'manual_adjustment'
            );
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$
        """,
        """
        DO $$ BEGIN
            CREATE TYPE wastage_reason AS ENUM (
                'spoiled', 'damaged', 'expired', 'overproduction', 'quality_issue', 'other'
            );
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$
        """,
        """
        DO $$ BEGIN
            CREATE TYPE transfer_status AS ENUM (
                'pending', 'in_transit', 'received', 'cancelled'
            );
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$
        """
    ]

    try:
        async with engine.begin() as conn:
            for sql in enum_statements:
                await conn.execute(text(sql))
            logger.info("Created logbook enums")

            # Tables will be created by SQLAlchemy Base.metadata.create_all()
            logger.info("Logbook migration completed")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Logbook migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
