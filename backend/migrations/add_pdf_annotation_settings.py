"""
Migration: Add PDF annotation settings columns to kitchen_settings table
- dext_include_annotations: Include PDF annotations when sending to Dext
- pdf_annotations_enabled: Enable adding annotations to PDFs
- pdf_preview_show_annotations: Show annotations in PDF preview
"""
import logging
from sqlalchemy import text
from database import AsyncSessionLocal

logger = logging.getLogger(__name__)


async def run_migration():
    """Add PDF annotation settings columns to kitchen_settings"""
    async with AsyncSessionLocal() as db:
        try:
            # Add dext_include_annotations column
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS dext_include_annotations BOOLEAN DEFAULT TRUE
            """))

            # Add pdf_annotations_enabled column
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS pdf_annotations_enabled BOOLEAN DEFAULT TRUE
            """))

            # Add pdf_preview_show_annotations column
            await db.execute(text("""
                ALTER TABLE kitchen_settings
                ADD COLUMN IF NOT EXISTS pdf_preview_show_annotations BOOLEAN DEFAULT TRUE
            """))

            await db.commit()
            logger.info("PDF annotation settings migration completed successfully")
        except Exception as e:
            logger.warning(f"PDF annotation settings migration warning: {e}")
            await db.rollback()
