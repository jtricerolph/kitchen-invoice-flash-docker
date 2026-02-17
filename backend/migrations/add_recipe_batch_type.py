"""Add batch_output_type, batch_yield_qty, batch_yield_unit to recipes table."""
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def migrate():
    async with engine.begin() as conn:
        result = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'recipes' AND column_name = 'batch_output_type'"
        ))
        if result.scalar_one_or_none():
            logger.info("recipes.batch_output_type already exists, skipping")
            return

        await conn.execute(text(
            "ALTER TABLE recipes ADD COLUMN batch_output_type VARCHAR(20) NOT NULL DEFAULT 'portions'"
        ))
        await conn.execute(text(
            "ALTER TABLE recipes ADD COLUMN batch_yield_qty NUMERIC(10,3) DEFAULT NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE recipes ADD COLUMN batch_yield_unit VARCHAR(10) DEFAULT NULL"
        ))
        logger.info("Added batch output type columns to recipes")
