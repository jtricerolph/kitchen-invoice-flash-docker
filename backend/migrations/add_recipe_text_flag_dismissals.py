"""
Migration: Add recipe_text_flag_dismissals table for tracking dismissed
allergen keyword suggestions found in recipe-level text fields.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS recipe_text_flag_dismissals (
                id SERIAL PRIMARY KEY,
                recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                dismissed_by_name VARCHAR(100) NOT NULL,
                reason TEXT,
                matched_keyword VARCHAR(200),
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_recipe_text_flag_dismissals_recipe_flag UNIQUE (recipe_id, food_flag_id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_recipe_text_flag_dismissals_recipe ON recipe_text_flag_dismissals(recipe_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_recipe_text_flag_dismissals_flag ON recipe_text_flag_dismissals(food_flag_id)"
        ))
        print("+ Created recipe_text_flag_dismissals table")


if __name__ == "__main__":
    print("Running migration: add_recipe_text_flag_dismissals")
    asyncio.run(migrate())
    print("Migration complete!")
