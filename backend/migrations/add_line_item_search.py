"""
Migration script to add line item search capabilities:
- Enable pg_trgm extension for fuzzy text matching
- Create GIN index on line_items.description for trigram similarity

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add pg_trgm extension and trigram index for line item search."""
    logger.info("Running line item search migration...")

    # Enable pg_trgm extension for fuzzy text matching
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            logger.info("Enabled pg_trgm extension")
    except Exception as e:
        logger.warning(f"pg_trgm extension: {e}")

    # Create GIN index for trigram similarity on description
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_line_items_description_trgm "
                "ON line_items USING gin (description gin_trgm_ops)"
            ))
            logger.info("Created trigram index on line_items.description")
    except Exception as e:
        logger.warning(f"Trigram index: {e}")

    logger.info("Line item search migration completed!")


if __name__ == "__main__":
    asyncio.run(run_migration())
