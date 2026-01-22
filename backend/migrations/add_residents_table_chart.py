import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add room-level fields to newbook_daily_occupancy for residents table chart"""

    alter_statements = [
        """
        ALTER TABLE newbook_daily_occupancy
        ADD COLUMN IF NOT EXISTS room_number VARCHAR(50)
        """,
        """
        ALTER TABLE newbook_daily_occupancy
        ADD COLUMN IF NOT EXISTS booking_id VARCHAR(100)
        """,
        """
        ALTER TABLE newbook_daily_occupancy
        ADD COLUMN IF NOT EXISTS guest_name VARCHAR(255)
        """,
        """
        ALTER TABLE newbook_daily_occupancy
        ADD COLUMN IF NOT EXISTS is_dbb BOOLEAN DEFAULT FALSE
        """,
        """
        ALTER TABLE newbook_daily_occupancy
        ADD COLUMN IF NOT EXISTS is_package BOOLEAN DEFAULT FALSE
        """
    ]

    indexes = [
        """
        CREATE INDEX IF NOT EXISTS idx_newbook_occupancy_room_booking
        ON newbook_daily_occupancy(kitchen_id, room_number, booking_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_newbook_occupancy_date_room
        ON newbook_daily_occupancy(kitchen_id, date, room_number)
        """
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added residents table chart columns to newbook_daily_occupancy")

            for sql in indexes:
                await conn.execute(text(sql))
            logger.info("Created residents table chart indexes")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Residents table chart migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
