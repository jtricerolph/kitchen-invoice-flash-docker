"""
Migration: Add kitchen detail columns to kitchen_settings table.
Used for Purchase Order letterhead (preview and email).
"""
import asyncio
from sqlalchemy import text
from database import engine


COLUMNS = [
    ("kitchen_display_name", "VARCHAR(255)"),
    ("kitchen_address_line1", "VARCHAR(255)"),
    ("kitchen_address_line2", "VARCHAR(255)"),
    ("kitchen_city", "VARCHAR(100)"),
    ("kitchen_postcode", "VARCHAR(20)"),
    ("kitchen_phone", "VARCHAR(50)"),
    ("kitchen_email", "VARCHAR(255)"),
]


async def migrate():
    async with engine.begin() as conn:
        for col_name, col_type in COLUMNS:
            try:
                await conn.execute(text(
                    f"ALTER TABLE kitchen_settings ADD COLUMN {col_name} {col_type}"
                ))
                print(f"+ Added {col_name} column to kitchen_settings")
            except Exception as e:
                if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                    print(f"- {col_name} column already exists, skipping")
                else:
                    raise


if __name__ == "__main__":
    print("Running migration: add_kitchen_details")
    asyncio.run(migrate())
    print("Migration complete!")
