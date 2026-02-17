"""Add title column to recipe_steps table."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        # Check if column already exists
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipe_steps' AND column_name = 'title'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipe_steps.title already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipe_steps ADD COLUMN title VARCHAR(255) DEFAULT NULL"
        ))
        logger.info("Added recipe_steps.title column")
