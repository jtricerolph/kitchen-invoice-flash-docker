"""Add sambapos_portion_name column to recipes table."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipes' AND column_name = 'sambapos_portion_name'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipes.sambapos_portion_name already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipes ADD COLUMN sambapos_portion_name VARCHAR(255) DEFAULT NULL"
        ))
        logger.info("Added recipes.sambapos_portion_name column")
