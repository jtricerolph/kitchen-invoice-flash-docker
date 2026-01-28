"""
Migration: Add KDS bookings refresh interval setting.

Adds:
- kds_bookings_refresh_seconds column to kitchen_settings
"""

import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add KDS bookings refresh interval column."""

    alter_statements = [
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_bookings_refresh_seconds INTEGER DEFAULT 60
        """,
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added KDS bookings refresh interval column")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"KDS bookings refresh migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
