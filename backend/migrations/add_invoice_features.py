"""
Migration script to add new invoice features:
- document_type, order_number columns on invoices
- duplicate_status, duplicate_of_id, related_document_id columns on invoices
- line_items table

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add new columns and tables for invoice features."""
    # Always run all migrations - each has its own try/except to handle existing columns
    logger.info("Running database migrations...")

    # Run each migration in its own transaction
    migrations = [
        "ALTER TABLE invoices ADD COLUMN document_type VARCHAR(50) DEFAULT 'invoice'",
        "ALTER TABLE invoices ADD COLUMN order_number VARCHAR(100)",
        "ALTER TABLE invoices ADD COLUMN duplicate_status VARCHAR(50)",
        "ALTER TABLE invoices ADD COLUMN duplicate_of_id INTEGER REFERENCES invoices(id)",
        "ALTER TABLE invoices ADD COLUMN related_document_id INTEGER REFERENCES invoices(id)",
    ]

    for sql in migrations:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
                logger.info(f"Executed: {sql[:60]}...")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"Column already exists, skipping")
            else:
                logger.warning(f"Migration warning: {e}")

    # Create line_items table
    create_line_items = """
    CREATE TABLE IF NOT EXISTS line_items (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        description TEXT,
        quantity NUMERIC(10, 3),
        unit_price NUMERIC(10, 2),
        amount NUMERIC(10, 2),
        product_code VARCHAR(100),
        line_number INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_line_items))
            logger.info("Created line_items table")
    except Exception as e:
        logger.warning(f"line_items table: {e}")

    # Create index
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_line_items_invoice_id ON line_items(invoice_id)"
            ))
            logger.info("Created index on line_items.invoice_id")
    except Exception as e:
        logger.warning(f"Index: {e}")

    # Add aliases column to suppliers table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE suppliers ADD COLUMN aliases JSON DEFAULT '[]'"
            ))
            logger.info("Added aliases column to suppliers")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("aliases column already exists")
        else:
            logger.warning(f"aliases column: {e}")

    # Add net_total column to invoices table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN net_total NUMERIC(10, 2)"
            ))
            logger.info("Added net_total column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("net_total column already exists")
        else:
            logger.warning(f"net_total column: {e}")

    # Add is_non_stock column to line_items table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE line_items ADD COLUMN is_non_stock BOOLEAN DEFAULT FALSE"
            ))
            logger.info("Added is_non_stock column to line_items")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("is_non_stock column already exists")
        else:
            logger.warning(f"is_non_stock column: {e}")

    # Add vendor_name column to invoices table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN vendor_name VARCHAR(255)"
            ))
            logger.info("Added vendor_name column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("vendor_name column already exists")
        else:
            logger.warning(f"vendor_name column: {e}")

    # Add ocr_raw_json column to invoices table (for storing full Azure response)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN ocr_raw_json TEXT"
            ))
            logger.info("Added ocr_raw_json column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("ocr_raw_json column already exists")
        else:
            logger.warning(f"ocr_raw_json column: {e}")

    # Create field_mappings table
    create_field_mappings = """
    CREATE TABLE IF NOT EXISTS field_mappings (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        supplier_id INTEGER REFERENCES suppliers(id),
        source_field VARCHAR(100) NOT NULL,
        target_field VARCHAR(100) NOT NULL,
        field_type VARCHAR(20) DEFAULT 'invoice',
        transform VARCHAR(50) DEFAULT 'direct',
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_field_mappings))
            logger.info("Created field_mappings table")
    except Exception as e:
        logger.warning(f"field_mappings table: {e}")

    # Create index on field_mappings
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_field_mappings_kitchen_id ON field_mappings(kitchen_id)"
            ))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_field_mappings_supplier_id ON field_mappings(supplier_id)"
            ))
            logger.info("Created indexes on field_mappings")
    except Exception as e:
        logger.warning(f"field_mappings indexes: {e}")

    logger.info("Migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
