"""
Migration: Add menus, menu_divisions, and menu_items tables for the Menus feature.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Menus table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS menus (
                id SERIAL PRIMARY KEY,
                kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                name VARCHAR(255) NOT NULL,
                description TEXT,
                notes TEXT,
                is_active BOOLEAN DEFAULT true,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_menus_kitchen_name UNIQUE (kitchen_id, name)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_menus_kitchen_id ON menus(kitchen_id)"
        ))

        # Menu divisions table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS menu_divisions (
                id SERIAL PRIMARY KEY,
                menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                sort_order INTEGER DEFAULT 0,
                CONSTRAINT uq_menu_divisions_menu_name UNIQUE (menu_id, name)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_menu_divisions_menu_id ON menu_divisions(menu_id)"
        ))

        # Menu items table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
                division_id INTEGER NOT NULL REFERENCES menu_divisions(id) ON DELETE CASCADE,
                recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
                display_name VARCHAR(255) NOT NULL,
                description TEXT,
                price NUMERIC(10, 2),
                sort_order INTEGER DEFAULT 0,
                snapshot_json JSONB,
                confirmed_by_user_id INTEGER REFERENCES users(id),
                confirmed_by_name VARCHAR(100),
                published_at TIMESTAMP DEFAULT NOW(),
                image_path VARCHAR(500),
                uploaded_by INTEGER REFERENCES users(id),
                CONSTRAINT uq_menu_items_menu_recipe UNIQUE (menu_id, recipe_id)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_menu_items_menu_id ON menu_items(menu_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_menu_items_division_id ON menu_items(division_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_menu_items_recipe_id ON menu_items(recipe_id)"
        ))
        print("+ Created menus, menu_divisions, and menu_items tables")


if __name__ == "__main__":
    print("Running migration: add_menus")
    asyncio.run(migrate())
    print("Migration complete!")
