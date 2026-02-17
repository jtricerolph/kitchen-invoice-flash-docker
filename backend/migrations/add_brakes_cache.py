"""
Migration: Add brakes_product_cache table for caching Brakes website product lookups.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS brakes_product_cache (
                id SERIAL PRIMARY KEY,
                product_code VARCHAR(50) NOT NULL UNIQUE,
                product_name VARCHAR(500),
                ingredients_text TEXT,
                contains_allergens TEXT,
                fetched_at TIMESTAMP DEFAULT NOW(),
                not_found BOOLEAN DEFAULT FALSE
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_brakes_cache_code ON brakes_product_cache(product_code)"
        ))
        print("+ Created brakes_product_cache table")


if __name__ == "__main__":
    print("Running migration: add_brakes_cache")
    asyncio.run(migrate())
    print("Migration complete!")
