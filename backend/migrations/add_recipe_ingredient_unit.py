"""Add unit column to recipe_ingredients table for display unit override."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipe_ingredients' AND column_name = 'unit'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipe_ingredients.unit already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipe_ingredients ADD COLUMN unit VARCHAR(10) DEFAULT NULL"
        ))
        logger.info("Added unit column to recipe_ingredients")
