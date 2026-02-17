"""
Migration: Add description_aliases JSON column to ingredient_sources table.
Stores alternative descriptions that map to the same ingredient source.
Also backfills missing product codes on existing line items.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        await conn.execute(text("""
            ALTER TABLE ingredient_sources
            ADD COLUMN IF NOT EXISTS description_aliases JSON DEFAULT '[]'
        """))
        print("+ Added description_aliases column to ingredient_sources")

        # Backfill missing product codes on existing line items.
        # For every ingredient_source that has both a product_code and description_pattern,
        # find line items from the same supplier with no product_code where the first-line
        # description matches, and fill in the code + ingredient_id.
        # This is idempotent — re-running updates 0 rows if already backfilled.
        result = await conn.execute(text("""
            UPDATE line_items li
            SET product_code = src.product_code,
                ingredient_id = COALESCE(li.ingredient_id, src.ingredient_id)
            FROM ingredient_sources src, invoices inv
            WHERE inv.id = li.invoice_id
              AND inv.supplier_id = src.supplier_id
              AND inv.kitchen_id = src.kitchen_id
              AND src.product_code IS NOT NULL
              AND src.product_code != ''
              AND src.description_pattern IS NOT NULL
              AND src.description_pattern != ''
              AND (li.product_code IS NULL OR li.product_code = '')
              AND LOWER(TRIM(split_part(li.description, E'\\n', 1)))
                  = LOWER(TRIM(src.description_pattern))
        """))
        count = result.rowcount
        if count > 0:
            print(f"+ Backfilled product_code on {count} line items (from ingredient sources)")
        else:
            print("+ No line items needed product_code backfill (from ingredient sources)")

        # Second pass: backfill from sibling line items.
        # If any line item from a supplier has a product_code, and other line items from
        # the same supplier have the same first-line description but no product_code,
        # copy the code across. This handles the OCR-missed-code case (e.g. Bramleys
        # butter 283) without needing ingredient sources to exist yet.
        result2 = await conn.execute(text("""
            UPDATE line_items li
            SET product_code = known.code
            FROM (
                SELECT DISTINCT ON (inv.supplier_id, LOWER(TRIM(split_part(li2.description, E'\\n', 1))))
                    inv.supplier_id,
                    LOWER(TRIM(split_part(li2.description, E'\\n', 1))) AS norm_desc,
                    li2.product_code AS code
                FROM line_items li2
                JOIN invoices inv ON inv.id = li2.invoice_id
                WHERE li2.product_code IS NOT NULL
                  AND li2.product_code != ''
                ORDER BY inv.supplier_id,
                         LOWER(TRIM(split_part(li2.description, E'\\n', 1))),
                         li2.id DESC
            ) known, invoices inv2
            WHERE inv2.id = li.invoice_id
              AND inv2.supplier_id = known.supplier_id
              AND (li.product_code IS NULL OR li.product_code = '')
              AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = known.norm_desc
        """))
        count2 = result2.rowcount
        if count2 > 0:
            print(f"+ Backfilled product_code on {count2} line items (from sibling line items)")
        else:
            print("+ No line items needed product_code backfill (from siblings)")


if __name__ == "__main__":
    print("Running migration: add_description_aliases")
    asyncio.run(migrate())
    print("Migration complete!")
