"""
Migration: Add KDS course flow settings (away timer thresholds)
and action column to course bumps audit trail.

Adds:
- kds_away_timer_green/amber/red_seconds to kitchen_settings
- action column to kds_course_bumps
"""

import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add KDS course flow columns."""

    alter_statements = [
        # Away timer thresholds (time since food sent to table)
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_away_timer_green_seconds INTEGER DEFAULT 600
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_away_timer_amber_seconds INTEGER DEFAULT 900
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_away_timer_red_seconds INTEGER DEFAULT 1200
        """,
        # Action column on course bumps audit trail ('away' or 'sent')
        """
        ALTER TABLE kds_course_bumps
        ADD COLUMN IF NOT EXISTS action VARCHAR(20) DEFAULT 'sent'
        """,
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added KDS course flow columns")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"KDS course flow migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
