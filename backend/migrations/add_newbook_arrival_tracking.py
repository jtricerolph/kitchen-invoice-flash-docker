"""
Migration script to add arrival tracking columns to newbook_daily_occupancy table:
- arrival_count: Integer count of bookings arriving on this date
- arrival_booking_ids: JSONB list of booking IDs arriving
- arrival_booking_details: JSONB list of full arrival details with booking refs

This enables cross-referencing hotel arrivals with restaurant (Resos) table bookings.

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add arrival tracking columns to newbook_daily_occupancy table."""
    logger.info("Running Newbook arrival tracking migration...")

    # Add arrival tracking columns to newbook_daily_occupancy table
    arrival_columns = [
        "ALTER TABLE newbook_daily_occupancy ADD COLUMN arrival_count INTEGER",
        "ALTER TABLE newbook_daily_occupancy ADD COLUMN arrival_booking_ids JSONB",
        "ALTER TABLE newbook_daily_occupancy ADD COLUMN arrival_booking_details JSONB",
    ]

    for sql in arrival_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
                col_name = sql.split("ADD COLUMN")[1].split()[0]
                logger.info(f"Added column: {col_name}")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"Column already exists, skipping")
            else:
                logger.warning(f"Column migration warning: {e}")

    logger.info("Newbook arrival tracking migration completed successfully")


if __name__ == "__main__":
    asyncio.run(run_migration())
