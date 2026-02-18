"""
Migration: Add ingredient_flag_dismissals table for tracking dismissed allergen suggestions.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS ingredient_flag_dismissals (
                id SERIAL PRIMARY KEY,
                ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                dismissed_by_name VARCHAR(100) NOT NULL,
                reason TEXT,
                matched_keyword VARCHAR(200),
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_ingredient_flag_dismissals_ing_flag UNIQUE (ingredient_id, food_flag_id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_ingredient_flag_dismissals_ing ON ingredient_flag_dismissals(ingredient_id)"
        ))
        print("+ Created ingredient_flag_dismissals table")


if __name__ == "__main__":
    print("Running migration: add_ingredient_flag_dismissals")
    asyncio.run(migrate())
    print("Migration complete!")
