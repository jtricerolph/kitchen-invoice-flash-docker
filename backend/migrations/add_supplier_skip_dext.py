"""
Migration: Add skip_dext column to suppliers table
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Add skip_dext column to suppliers table
        try:
            await conn.execute(text(
                """
                ALTER TABLE suppliers
                ADD COLUMN skip_dext BOOLEAN NOT NULL DEFAULT FALSE
                """
            ))
            print("✓ Added skip_dext column to suppliers table")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- skip_dext column already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_supplier_skip_dext")
    asyncio.run(migrate())
    print("Migration complete!")
