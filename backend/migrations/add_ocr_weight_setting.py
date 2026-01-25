"""
Migration: Add OCR weight-as-quantity setting
- ocr_use_weight_as_quantity: For KG items, use weight as quantity when it matches total
"""
import logging
from sqlalchemy import text
from database import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def run_migration():
    """Add ocr_use_weight_as_quantity column to kitchen_settings"""
    async with AsyncSessionLocal() as db:
        try:
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS ocr_use_weight_as_quantity BOOLEAN DEFAULT FALSE
            """))
            await db.commit()
            logger.info("OCR weight setting migration completed successfully")
        except Exception as e:
            logger.warning(f"OCR weight setting migration warning: {e}")
            await db.rollback()
