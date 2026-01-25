"""
Migration: Add OCR post-processing settings and description_alt field
- ocr_clean_product_codes: Strip section headers (like "CHILL/AMBIENT") from product codes
- ocr_filter_subtotal_rows: Filter subtotal/total rows from line items
- description_alt: Alternative description for Azure content vs value mismatches
"""
import logging
from sqlalchemy import text
from database import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def run_migration():
    """Add OCR post-processing settings to kitchen_settings and description_alt to line_items"""
    async with AsyncSessionLocal() as db:
        try:
            # Add ocr_clean_product_codes column to kitchen_settings
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS ocr_clean_product_codes BOOLEAN DEFAULT FALSE
            """))

            # Add ocr_filter_subtotal_rows column to kitchen_settings
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS ocr_filter_subtotal_rows BOOLEAN DEFAULT FALSE
            """))

            # Add description_alt column to line_items
            await db.execute(text("""
                ALTER TABLE line_items
                ADD COLUMN IF NOT EXISTS description_alt TEXT
            """))

            await db.commit()
            logger.info("OCR post-processing migration completed successfully")
        except Exception as e:
            logger.warning(f"OCR post-processing migration warning: {e}")
            await db.rollback()
