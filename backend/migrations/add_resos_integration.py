"""
Migration script to add Resos restaurant booking integration:
- Resos credential and configuration fields on kitchen_settings
- resos_bookings table
- resos_daily_stats table
- resos_opening_hours table
- resos_sync_log table

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add Resos integration tables and settings columns."""
    logger.info("Running Resos integration migrations...")

    # Add Resos columns to kitchen_settings table
    settings_columns = [
        "ALTER TABLE kitchen_settings ADD COLUMN resos_api_key VARCHAR(500)",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_last_sync TIMESTAMP",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_auto_sync_enabled BOOLEAN DEFAULT FALSE",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_large_group_threshold INTEGER DEFAULT 8",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_note_keywords TEXT",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_allergy_keywords TEXT",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_custom_field_mapping JSONB",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_opening_hours_mapping JSONB",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_restaurant_table_entities TEXT",
        "ALTER TABLE kitchen_settings ADD COLUMN resos_flag_icon_mapping JSONB",
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

    # Create resos_bookings table
    create_resos_bookings = """
    CREATE TABLE IF NOT EXISTS resos_bookings (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        resos_booking_id VARCHAR(255) NOT NULL,
        booking_date DATE NOT NULL,
        booking_time TIME NOT NULL,
        people INTEGER NOT NULL,
        status VARCHAR(50) NOT NULL,
        seating_area VARCHAR(255),
        hotel_booking_number VARCHAR(100),
        is_hotel_guest BOOLEAN,
        is_dbb BOOLEAN,
        is_package BOOLEAN,
        exclude_flag VARCHAR(500),
        allergies TEXT,
        notes TEXT,
        booked_at TIMESTAMP,
        opening_hour_id VARCHAR(255),
        opening_hour_name VARCHAR(255),
        is_flagged BOOLEAN DEFAULT FALSE,
        flag_reasons TEXT,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_forecast BOOLEAN DEFAULT FALSE,
        CONSTRAINT uq_resos_booking UNIQUE(kitchen_id, resos_booking_id)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_resos_bookings))
            logger.info("Created resos_bookings table")
    except Exception as e:
        logger.warning(f"resos_bookings table: {e}")

    # Create resos_daily_stats table
    create_resos_daily_stats = """
    CREATE TABLE IF NOT EXISTS resos_daily_stats (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        date DATE NOT NULL,
        total_bookings INTEGER NOT NULL DEFAULT 0,
        total_covers INTEGER NOT NULL DEFAULT 0,
        service_breakdown JSONB,
        flagged_booking_count INTEGER DEFAULT 0,
        unique_flag_types JSONB,
        bookings_summary JSONB,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_forecast BOOLEAN DEFAULT FALSE,
        CONSTRAINT uq_resos_daily_stat UNIQUE(kitchen_id, date)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_resos_daily_stats))
            logger.info("Created resos_daily_stats table")
    except Exception as e:
        logger.warning(f"resos_daily_stats table: {e}")

    # Create resos_opening_hours table
    create_resos_opening_hours = """
    CREATE TABLE IF NOT EXISTS resos_opening_hours (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        resos_opening_hour_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        start_time TIME,
        end_time TIME,
        days_of_week VARCHAR(100),
        is_special BOOLEAN DEFAULT FALSE,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_resos_opening_hour UNIQUE(kitchen_id, resos_opening_hour_id)
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_resos_opening_hours))
            logger.info("Created resos_opening_hours table")
    except Exception as e:
        logger.warning(f"resos_opening_hours table: {e}")

    # Create resos_sync_log table
    create_resos_sync_log = """
    CREATE TABLE IF NOT EXISTS resos_sync_log (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        sync_type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL,
        date_from DATE,
        date_to DATE,
        bookings_fetched INTEGER DEFAULT 0,
        bookings_flagged INTEGER DEFAULT 0,
        error_message TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
    )
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_resos_sync_log))
            logger.info("Created resos_sync_log table")
    except Exception as e:
        logger.warning(f"resos_sync_log table: {e}")

    # Add unique_flag_types column to resos_daily_stats if it doesn't exist
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE resos_daily_stats ADD COLUMN unique_flag_types JSONB"))
            logger.info("Added unique_flag_types column to resos_daily_stats")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("unique_flag_types column already exists")
        else:
            logger.warning(f"unique_flag_types column migration: {e}")

    # Add table_name column to resos_bookings (Phase 8.1)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE resos_bookings ADD COLUMN table_name VARCHAR(100)"))
            logger.info("Added table_name column to resos_bookings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("table_name column already exists")
        else:
            logger.warning(f"table_name column migration: {e}")

    # Add GL code columns for food/beverage split (Phase 8.1)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE kitchen_settings ADD COLUMN sambapos_food_gl_codes TEXT"))
            logger.info("Added sambapos_food_gl_codes column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("sambapos_food_gl_codes column already exists")
        else:
            logger.warning(f"sambapos_food_gl_codes column migration: {e}")

    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE kitchen_settings ADD COLUMN sambapos_beverage_gl_codes TEXT"))
            logger.info("Added sambapos_beverage_gl_codes column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("sambapos_beverage_gl_codes column already exists")
        else:
            logger.warning(f"sambapos_beverage_gl_codes column migration: {e}")

    # Create indexes
    indexes = [
        "CREATE INDEX IF NOT EXISTS ix_resos_bookings_date ON resos_bookings(kitchen_id, booking_date)",
        "CREATE INDEX IF NOT EXISTS ix_resos_bookings_flags ON resos_bookings(kitchen_id, is_flagged)",
        "CREATE INDEX IF NOT EXISTS ix_resos_daily_stats_date ON resos_daily_stats(kitchen_id, date)",
        "CREATE INDEX IF NOT EXISTS ix_resos_daily_stats_kitchen_id ON resos_daily_stats(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_resos_opening_hours_kitchen_id ON resos_opening_hours(kitchen_id)",
        "CREATE INDEX IF NOT EXISTS ix_resos_sync_log_kitchen_id ON resos_sync_log(kitchen_id, started_at DESC)",
    ]

    for sql in indexes:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
        except Exception as e:
            logger.warning(f"Index: {e}")

    logger.info("Resos migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
