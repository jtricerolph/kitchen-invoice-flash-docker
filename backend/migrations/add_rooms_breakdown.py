import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add rooms_breakdown JSONB column to newbook_daily_occupancy"""

    alter_statement = """
    ALTER TABLE newbook_daily_occupancy
    ADD COLUMN IF NOT EXISTS rooms_breakdown JSONB
    """

    # GIN index for JSONB queries (e.g., filtering by room_number or booking_id)
    index_statement = """
    CREATE INDEX IF NOT EXISTS idx_newbook_occupancy_rooms_breakdown
    ON newbook_daily_occupancy USING GIN (rooms_breakdown)
    """

    try:
        async with engine.begin() as conn:
            await conn.execute(text(alter_statement))
            logger.info("Added rooms_breakdown JSONB column to newbook_daily_occupancy")

            await conn.execute(text(index_statement))
            logger.info("Created GIN index on rooms_breakdown")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Rooms breakdown migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
