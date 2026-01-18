"""
Migration script to add SambaPOS MSSQL connection settings.

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add SambaPOS columns to kitchen_settings table."""
    logger.info("Running SambaPOS settings migration...")

    # Add SambaPOS columns to kitchen_settings table
    settings_columns = [
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_db_host VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_db_port INTEGER DEFAULT 1433",
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_db_name VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_db_username VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_db_password VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN sambapos_tracked_categories VARCHAR(1000)",
    ]

    for sql in settings_columns:
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

    logger.info("SambaPOS migration completed!")


if __name__ == "__main__":
    asyncio.run(run_migration())
