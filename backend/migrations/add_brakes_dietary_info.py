"""
Migration: Add dietary_info column to brakes_product_cache for vegetarian/vegan suitability.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE brakes_product_cache ADD COLUMN IF NOT EXISTS dietary_info TEXT"
        ))
        print("+ Added brakes_product_cache.dietary_info column")


if __name__ == "__main__":
    print("Running migration: add_brakes_dietary_info")
    asyncio.run(migrate())
    print("Migration complete!")
