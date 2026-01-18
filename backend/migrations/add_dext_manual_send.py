"""
Migration: Add dext_manual_send_enabled column to kitchen_settings table
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Add dext_manual_send_enabled column
        try:
            await conn.execute(text(
                """
                ALTER TABLE kitchen_settings
                ADD COLUMN dext_manual_send_enabled BOOLEAN DEFAULT TRUE
                """
            ))
            print("✓ Added dext_manual_send_enabled column")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- dext_manual_send_enabled column already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_dext_manual_send")
    asyncio.run(migrate())
    print("Migration complete!")
