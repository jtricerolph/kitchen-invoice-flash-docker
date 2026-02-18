"""
Migration: Add is_free column to ingredients table.
Free items (e.g. water) bypass no-price/manual-price warnings on recipes.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT false"
        ))
        print("+ Added is_free column to ingredients")


if __name__ == "__main__":
    print("Running migration: add_ingredient_is_free")
    asyncio.run(migrate())
    print("Migration complete!")
