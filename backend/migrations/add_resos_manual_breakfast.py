"""
Migration script to add manual breakfast configuration settings:
- resos_enable_manual_breakfast: Boolean flag to enable manual breakfast periods
- resos_manual_breakfast_periods: JSONB array of breakfast periods per day of week

This allows defining breakfast periods that are not in Resos (since breakfast bookings
are not taken through Resos) to properly categorize early morning restaurant tickets.

Format: [{"day": 1, "start": "07:00", "end": "11:00"}, ...] where day: 1=Monday, 7=Sunday

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
    """Add manual breakfast configuration columns to kitchen_settings table."""
    logger.info("Running Resos manual breakfast configuration migration...")

    migrations = [
        "ALTER TABLE kitchen_settings ADD COLUMN resos_enable_manual_breakfast BOOLEAN DEFAULT FALSE",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_manual_breakfast_periods JSONB"
    ]

    async with engine.begin() as conn:
        for sql in migrations:
            try:
                await conn.execute(text(sql))
                column_name = sql.split("ADD COLUMN ")[1].split(" ")[0]
                logger.info(f"Added column: {column_name}")
            except Exception as e:
                if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                    logger.info(f"Column already exists, skipping: {sql}")
                else:
                    logger.warning(f"Column migration warning: {e}")

    logger.info("Resos manual breakfast configuration migration completed successfully")


if __name__ == "__main__":
    asyncio.run(run_migration())
