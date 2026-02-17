"""
Migration: Add 'required' to food_flag_categories, 'flags_assessed' to ingredients,
and 'ingredient_flag_nones' table for per-category "None apply" tracking.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Add 'required' boolean to food_flag_categories (default false)
        await conn.execute(text(
            "ALTER TABLE food_flag_categories ADD COLUMN IF NOT EXISTS required BOOLEAN DEFAULT false"
        ))

        # Auto-set 'contains' categories as required (allergens should be assessed)
        await conn.execute(text(
            "UPDATE food_flag_categories SET required = true WHERE propagation_type = 'contains'"
        ))

        # Add 'flags_assessed' boolean to ingredients (kept for compat, not actively used)
        await conn.execute(text(
            "ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS flags_assessed BOOLEAN DEFAULT false"
        ))

        # Create ingredient_flag_nones table (per-category "None apply" tracking)
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS ingredient_flag_nones (
                id SERIAL PRIMARY KEY,
                ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                category_id INTEGER NOT NULL REFERENCES food_flag_categories(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_ingredient_flag_nones_ing_cat UNIQUE (ingredient_id, category_id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_ingredient_flag_nones_ing ON ingredient_flag_nones(ingredient_id)"
        ))

    print("+ Added food_flag_categories.required, ingredient_flag_nones table")


if __name__ == "__main__":
    asyncio.run(migrate())
