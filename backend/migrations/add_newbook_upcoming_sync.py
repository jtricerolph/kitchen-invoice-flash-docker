import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add Newbook upcoming sync schedule columns"""

    alter_statements = [
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS newbook_upcoming_sync_interval INTEGER DEFAULT 15
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS newbook_upcoming_sync_enabled BOOLEAN DEFAULT FALSE
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS newbook_last_upcoming_sync TIMESTAMP
        """
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added Newbook upcoming sync columns to kitchen_settings")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Newbook upcoming sync migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
