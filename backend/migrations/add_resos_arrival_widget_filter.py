"""
Migration script to add arrival widget service filter setting:
- resos_arrival_widget_service_filter: Opening hour ID to filter arrivals widget by service type

This allows filtering the dashboard arrivals widget to show only specific service types
(e.g., dinner only) when cross-referencing hotel arrivals with restaurant bookings.

Run this script once after deploying the new code.
"""
import asyncio
import logging
import sys
sys.path.insert(0, '/app')

from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add arrival widget service filter column to kitchen_settings table."""
    logger.info("Running Resos arrival widget filter migration...")

    # Add arrival widget service filter column
    sql = "ALTER TABLE kitchen_settings ADD COLUMN resos_arrival_widget_service_filter VARCHAR(255)"

    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
            logger.info("Added column: resos_arrival_widget_service_filter")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("Column already exists, skipping")
        else:
            logger.warning(f"Column migration warning: {e}")

    logger.info("Resos arrival widget filter migration completed successfully")


if __name__ == "__main__":
    asyncio.run(run_migration())
