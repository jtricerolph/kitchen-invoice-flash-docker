"""
Migration: Rename recipe_type 'plated' to 'dish', add section_type to menu_sections.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # 1. Rename recipe_type 'plated' -> 'dish' in recipes table
        result = await conn.execute(text(
            "UPDATE recipes SET recipe_type = 'dish' WHERE recipe_type = 'plated'"
        ))
        print(f"  + Renamed {result.rowcount} recipes from 'plated' to 'dish'")

        # 2. Add section_type column to menu_sections (default 'recipe')
        await conn.execute(text(
            "ALTER TABLE menu_sections ADD COLUMN IF NOT EXISTS section_type VARCHAR(20) NOT NULL DEFAULT 'recipe'"
        ))

        # 3. Drop old unique constraint, create new one including section_type
        try:
            await conn.execute(text(
                "ALTER TABLE menu_sections DROP CONSTRAINT IF EXISTS uq_menu_sections_kitchen_name"
            ))
        except Exception as e:
            print(f"  ! Warning dropping old constraint: {e}")

        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uix_menu_sections_kn_st "
            "ON menu_sections(kitchen_id, name, section_type)"
        ))

    print("+ Added menu_sections.section_type, renamed plated -> dish")


if __name__ == "__main__":
    asyncio.run(migrate())
