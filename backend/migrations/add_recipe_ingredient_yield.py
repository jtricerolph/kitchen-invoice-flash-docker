"""Move yield_percent from ingredients to recipe_ingredients (per-use yield)."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        # Check if column already exists
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipe_ingredients' AND column_name = 'yield_percent'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipe_ingredients.yield_percent already exists, skipping")
            return

        # Add yield_percent to recipe_ingredients with default 100
        await conn.execute(text(
            "ALTER TABLE recipe_ingredients ADD COLUMN yield_percent NUMERIC(5,2) DEFAULT 100.00 NOT NULL"
        ))
        logger.info("Added recipe_ingredients.yield_percent column")

        # Populate from existing ingredient yields
        await conn.execute(text(
            "UPDATE recipe_ingredients ri "
            "SET yield_percent = i.yield_percent "
            "FROM ingredients i "
            "WHERE ri.ingredient_id = i.id AND i.yield_percent != 100.00"
        ))
        logger.info("Populated recipe_ingredients.yield_percent from existing ingredient values")
