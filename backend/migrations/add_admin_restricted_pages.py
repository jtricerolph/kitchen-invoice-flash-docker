"""
Migration script to add admin_restricted_pages column.

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add admin_restricted_pages column to kitchen_settings table."""
    logger.info("Running admin restricted pages migration...")

    sql = "ALTER TABLE kitchen_settings ADD COLUMN admin_restricted_pages TEXT"

    try:
        async with engine.begin() as conn:
            await conn.execute(text(sql))
            logger.info("Added column: admin_restricted_pages")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("Column already exists, skipping")
        else:
            logger.warning(f"Column migration warning: {e}")

    logger.info("Admin restricted pages migration completed!")


if __name__ == "__main__":
    asyncio.run(run_migration())
