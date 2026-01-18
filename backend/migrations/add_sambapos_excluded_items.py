"""
Migration script to add SambaPOS excluded items column.

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add sambapos_excluded_items column to kitchen_settings table."""
    logger.info("Running SambaPOS excluded items migration...")

    # Add column for excluded items (TEXT to allow for many items with long names)
    sql = "ALTER TABLE kitchen_settings ADD COLUMN sambapos_excluded_items TEXT"

    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
            logger.info("Added column: sambapos_excluded_items")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("Column already exists, skipping")
        else:
            logger.warning(f"Column migration warning: {e}")

    logger.info("SambaPOS excluded items migration completed!")


if __name__ == "__main__":
    asyncio.run(run_migration())
