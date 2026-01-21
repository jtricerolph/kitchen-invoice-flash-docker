import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add Resos upcoming sync schedule columns"""

    alter_statements = [
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS resos_upcoming_sync_interval INTEGER DEFAULT 15
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS resos_upcoming_sync_enabled BOOLEAN DEFAULT FALSE
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS resos_last_upcoming_sync TIMESTAMP
        """
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added Resos upcoming sync columns to kitchen_settings")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Resos upcoming sync migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
