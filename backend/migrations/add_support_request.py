"""
Migration: Add support request feature

Adds:
- support_email column to kitchen_settings table
"""
import logging
from sqlalchemy import text
from database import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def run_migration():
    """Add support_email column to kitchen_settings"""
    async with AsyncSessionLocal() as db:
        try:
            # Add support_email column
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS support_email VARCHAR(255)
            """))
            await db.commit()
            logger.info("Support request migration completed successfully")
        except Exception as e:
            logger.warning(f"Support request migration warning: {e}")
            await db.rollback()
