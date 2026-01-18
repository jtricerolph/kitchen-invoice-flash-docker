"""
Migration script to add Newbook PMS integration tables and settings:
- Newbook credential fields on kitchen_settings
- newbook_gl_accounts table
- newbook_daily_revenue table
- newbook_daily_occupancy table
- newbook_sync_log table

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add Newbook integration tables and settings columns."""
    logger.info("Running Newbook integration migrations...")

    # Add Newbook columns to kitchen_settings table
    settings_columns = [
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_api_username VARCHAR(255)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_api_password VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_api_key VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_api_region VARCHAR(10)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_instance_id VARCHAR(100)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_last_sync TIMESTAMP",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_auto_sync_enabled BOOLEAN DEFAULT FALSE",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_breakfast_gl_codes VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN newbook_dinner_gl_codes VARCHAR(500)",
    ]

    for sql in settings_columns:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
                col_name = sql.split("ADD COLUMN")[1].split()[0]
                logger.info(f"Added column: {col_name}")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                logger.info(f"Column already exists, skipping")
            else:
                logger.warning(f"Column migration warning: {e}")

    # Create newbook_gl_accounts table
    create_gl_accounts = """
    CREATE TABLE IF NOT EXISTS newbook_gl_accounts (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        gl_account_id VARCHAR(50) NOT NULL,
        gl_code VARCHAR(50),
        gl_name VARCHAR(255) NOT NULL,
        gl_type VARCHAR(100),
        is_tracked BOOLEAN DEFAULT FALSE,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_newbook_gl_account UNIQUE(kitchen_id, gl_account_id)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_gl_accounts))
            logger.info("Created newbook_gl_accounts table")
    except Exception as e:
        logger.warning(f"newbook_gl_accounts table: {e}")

    # Create newbook_daily_revenue table
    create_daily_revenue = """
    CREATE TABLE IF NOT EXISTS newbook_daily_revenue (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        gl_account_id INTEGER NOT NULL REFERENCES newbook_gl_accounts(id),
        date DATE NOT NULL,
        amount_net NUMERIC(12, 2) NOT NULL,
        amount_gross NUMERIC(12, 2),
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_newbook_revenue_per_day UNIQUE(kitchen_id, gl_account_id, date)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_daily_revenue))
            logger.info("Created newbook_daily_revenue table")
    except Exception as e:
        logger.warning(f"newbook_daily_revenue table: {e}")

    # Create newbook_daily_occupancy table
    create_daily_occupancy = """
    CREATE TABLE IF NOT EXISTS newbook_daily_occupancy (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        date DATE NOT NULL,
        total_rooms INTEGER,
        occupied_rooms INTEGER,
        occupancy_percentage NUMERIC(5, 2),
        total_guests INTEGER,
        breakfast_allocation_qty INTEGER,
        breakfast_allocation_netvalue NUMERIC(12, 2),
        dinner_allocation_qty INTEGER,
        dinner_allocation_netvalue NUMERIC(12, 2),
        is_forecast BOOLEAN DEFAULT FALSE,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_newbook_occupancy_per_day UNIQUE(kitchen_id, date)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_daily_occupancy))
            logger.info("Created newbook_daily_occupancy table")
    except Exception as e:
        logger.warning(f"newbook_daily_occupancy table: {e}")

    # Create newbook_sync_log table
    create_sync_log = """
    CREATE TABLE IF NOT EXISTS newbook_sync_log (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        sync_type VARCHAR(50) NOT NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'running',
        records_fetched INTEGER DEFAULT 0,
        error_message TEXT,
        date_from DATE,
        date_to DATE
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_sync_log))
            logger.info("Created newbook_sync_log table")
    except Exception as e:
        logger.warning(f"newbook_sync_log table: {e}")

    # Create newbook_room_categories table
    create_room_categories = """
    CREATE TABLE IF NOT EXISTS newbook_room_categories (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        site_id VARCHAR(50) NOT NULL,
        site_name VARCHAR(255) NOT NULL,
        site_type VARCHAR(100),
        room_count INTEGER DEFAULT 0,
        is_included BOOLEAN DEFAULT TRUE,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_newbook_room_category UNIQUE(kitchen_id, site_id)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_room_categories))
            logger.info("Created newbook_room_categories table")
    except Exception as e:
        logger.warning(f"newbook_room_categories table: {e}")

    # Add room_count column if it doesn't exist
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE newbook_room_categories ADD COLUMN room_count INTEGER DEFAULT 0"))
            logger.info("Added room_count column to newbook_room_categories")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("room_count column already exists, skipping")
        else:
            logger.warning(f"room_count column: {e}")

    # Create indexes
    indexes = [
        "CREATE INDEX IF NOT EXISTS ix_newbook_gl_accounts_kitchen_id ON newbook_gl_accounts(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_revenue_date ON newbook_daily_revenue(date)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_revenue_kitchen_id ON newbook_daily_revenue(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_occupancy_date ON newbook_daily_occupancy(date)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_occupancy_kitchen_id ON newbook_daily_occupancy(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_sync_log_kitchen_id ON newbook_sync_log(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_newbook_room_categories_kitchen_id ON newbook_room_categories(kitchen_id)",
    ]

    for sql in indexes:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
        except Exception as e:
            logger.warning(f"Index: {e}")

    logger.info("Newbook migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
