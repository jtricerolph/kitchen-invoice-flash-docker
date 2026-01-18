"""
Migration script to add price change detection features.

Adds:
- Price change detection settings to kitchen_settings
- acknowledged_prices table for tracking acknowledged price changes

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add new columns and tables for price change detection features."""
    logger.info("Running price change detection migration...")

    # ===== KITCHEN_SETTINGS - PRICE CHANGE SETTINGS =====
    price_columns = [
        ("price_change_lookback_days", "INTEGER DEFAULT 30"),
        ("price_change_amber_threshold", "INTEGER DEFAULT 10"),
        ("price_change_red_threshold", "INTEGER DEFAULT 20"),
    ]

    for col_name, col_type in price_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
                ))
                logger.info(f"Added {col_name} column to kitchen_settings")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"{col_name} column already exists")
            else:
                logger.warning(f"{col_name} column: {e}")

    # ===== CREATE ACKNOWLEDGED_PRICES TABLE =====
    try:
        async with engine.begin() as conn:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS acknowledged_prices (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
                    product_code VARCHAR(100),
                    description TEXT,
                    acknowledged_price NUMERIC(10, 2) NOT NULL,
                    acknowledged_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    acknowledged_by_user_id INTEGER NOT NULL REFERENCES users(id),
                    source_invoice_id INTEGER REFERENCES invoices(id),
                    source_line_item_id INTEGER REFERENCES line_items(id),
                    CONSTRAINT uix_acknowledged_price UNIQUE (kitchen_id, supplier_id, product_code, description)
                )
            """))
            logger.info("Created acknowledged_prices table")
    except Exception as e:
        if "already exists" in str(e).lower():
            logger.info("acknowledged_prices table already exists")
        else:
            logger.warning(f"acknowledged_prices table: {e}")

    # Create indexes on acknowledged_prices
    indexes = [
        ("idx_acknowledged_prices_kitchen", "acknowledged_prices(kitchen_id)"),
        ("idx_acknowledged_prices_supplier", "acknowledged_prices(supplier_id)"),
        ("idx_acknowledged_prices_lookup", "acknowledged_prices(kitchen_id, supplier_id, product_code, description)"),
    ]

    for idx_name, idx_def in indexes:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {idx_name} ON {idx_def}"
                ))
                logger.info(f"Created index {idx_name}")
        except Exception as e:
            logger.warning(f"Index {idx_name}: {e}")

    logger.info("Price change detection migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
