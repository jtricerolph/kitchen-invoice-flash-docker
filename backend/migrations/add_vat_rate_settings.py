"""
Migration script to add VAT rate settings and GL group columns.

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add VAT rate columns and GL group columns."""
    logger.info("Running VAT rate and GL group migration...")

    # Add VAT rate columns to kitchen_settings table
    settings_columns = [
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_breakfast_vat_rate NUMERIC(5, 4) DEFAULT 0.10",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_dinner_vat_rate NUMERIC(5, 4) DEFAULT 0.10",
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

    # Add GL group columns to newbook_gl_accounts table (if not present)
    gl_columns = [
        "ALTER TABLE newbook_gl_accounts ADD COLUMN gl_group_id VARCHAR(50)",
        "ALTER TABLE newbook_gl_accounts ADD COLUMN gl_group_name VARCHAR(255)",
    ]

    for sql in gl_columns:
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

    logger.info("Migration completed!")


if __name__ == "__main__":
    asyncio.run(run_migration())
