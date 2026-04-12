"""
Migration: Add source_invoice_id to recipe_change_log
Links price change entries back to the triggering invoice for traceability.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text(
            "ALTER TABLE recipe_change_log ADD COLUMN IF NOT EXISTS "
            "source_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_recipe_change_log_invoice "
            "ON recipe_change_log(source_invoice_id)"
        ))
    print("+ Added source_invoice_id to recipe_change_log")


if __name__ == "__main__":
    asyncio.run(migrate())
