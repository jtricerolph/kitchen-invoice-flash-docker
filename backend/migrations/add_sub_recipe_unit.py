"""Add portions_needed_unit to recipe_sub_recipes table."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipe_sub_recipes' AND column_name = 'portions_needed_unit'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipe_sub_recipes.portions_needed_unit already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipe_sub_recipes ADD COLUMN portions_needed_unit VARCHAR(10) DEFAULT NULL"
        ))
        logger.info("Added portions_needed_unit column to recipe_sub_recipes")
