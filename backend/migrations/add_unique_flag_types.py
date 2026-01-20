"""
Migration script to add unique_flag_types column to resos_daily_stats table
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
    """Add unique_flag_types column to resos_daily_stats"""
    logger.info("Adding unique_flag_types column to resos_daily_stats...")

    sql = "ALTER TABLE resos_daily_stats ADD COLUMN IF NOT EXISTS unique_flag_types JSONB"

    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
            logger.info("Added unique_flag_types column successfully")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("Column already exists, skipping")
        else:
            logger.error(f"Migration failed: {e}")
            raise

    logger.info("Migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
