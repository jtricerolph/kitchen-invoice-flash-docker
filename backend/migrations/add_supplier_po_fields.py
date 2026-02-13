"""
Migration: Add order_email and account_number columns to suppliers table.
Used for Purchase Order email sending and supplier identification.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Add order_email column
        try:
            await conn.execute(text(
                "ALTER TABLE suppliers ADD COLUMN order_email VARCHAR(255)"
            ))
            print("+ Added order_email column to suppliers")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- order_email column already exists, skipping")
            else:
                raise

        # Add account_number column
        try:
            await conn.execute(text(
                "ALTER TABLE suppliers ADD COLUMN account_number VARCHAR(100)"
            ))
            print("+ Added account_number column to suppliers")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- account_number column already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_supplier_po_fields")
    asyncio.run(migrate())
    print("Migration complete!")
