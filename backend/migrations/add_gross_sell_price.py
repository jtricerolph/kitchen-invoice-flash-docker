"""Add gross_sell_price column to recipes table."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipes' AND column_name = 'gross_sell_price'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipes.gross_sell_price already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipes ADD COLUMN gross_sell_price NUMERIC(10,2) DEFAULT NULL"
        ))
        logger.info("Added recipes.gross_sell_price column")
