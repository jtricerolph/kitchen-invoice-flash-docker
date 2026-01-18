"""
Migration script to add Dext integration features:
- Invoice notes field
- Dext sent tracking (sent_at, sent_by_user_id)
- SMTP configuration in kitchen_settings
- Dext configuration in kitchen_settings

Run this script once after deploying the new code.
"""
import asyncio
import logging
from sqlalchemy import text
from database import engine

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def run_migration():
    """Add new columns and tables for Dext integration."""
    logger.info("Running Dext integration database migrations...")

    # ===== INVOICE TABLE MIGRATIONS =====

    # Add notes column to invoices table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN notes TEXT"
            ))
            logger.info("Added notes column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("notes column already exists")
        else:
            logger.warning(f"notes column: {e}")

    # Add dext_sent_at column to invoices table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN dext_sent_at TIMESTAMP"
            ))
            logger.info("Added dext_sent_at column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_sent_at column already exists")
        else:
            logger.warning(f"dext_sent_at column: {e}")

    # Add dext_sent_by_user_id column to invoices table
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE invoices ADD COLUMN dext_sent_by_user_id INTEGER REFERENCES users(id)"
            ))
            logger.info("Added dext_sent_by_user_id column to invoices")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_sent_by_user_id column already exists")
        else:
            logger.warning(f"dext_sent_by_user_id column: {e}")

    # ===== KITCHEN_SETTINGS TABLE MIGRATIONS - SMTP =====

    # Add smtp_host column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_host VARCHAR(255)"
            ))
            logger.info("Added smtp_host column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_host column already exists")
        else:
            logger.warning(f"smtp_host column: {e}")

    # Add smtp_port column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_port INTEGER DEFAULT 587"
            ))
            logger.info("Added smtp_port column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_port column already exists")
        else:
            logger.warning(f"smtp_port column: {e}")

    # Add smtp_username column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_username VARCHAR(255)"
            ))
            logger.info("Added smtp_username column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_username column already exists")
        else:
            logger.warning(f"smtp_username column: {e}")

    # Add smtp_password column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_password VARCHAR(500)"
            ))
            logger.info("Added smtp_password column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_password column already exists")
        else:
            logger.warning(f"smtp_password column: {e}")

    # Add smtp_use_tls column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_use_tls BOOLEAN DEFAULT TRUE"
            ))
            logger.info("Added smtp_use_tls column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_use_tls column already exists")
        else:
            logger.warning(f"smtp_use_tls column: {e}")

    # Add smtp_from_email column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_from_email VARCHAR(255)"
            ))
            logger.info("Added smtp_from_email column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_from_email column already exists")
        else:
            logger.warning(f"smtp_from_email column: {e}")

    # Add smtp_from_name column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN smtp_from_name VARCHAR(255) DEFAULT 'Kitchen Invoice System'"
            ))
            logger.info("Added smtp_from_name column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("smtp_from_name column already exists")
        else:
            logger.warning(f"smtp_from_name column: {e}")

    # ===== KITCHEN_SETTINGS TABLE MIGRATIONS - DEXT =====

    # Add dext_email column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN dext_email VARCHAR(255)"
            ))
            logger.info("Added dext_email column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_email column already exists")
        else:
            logger.warning(f"dext_email column: {e}")

    # Add dext_include_notes column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN dext_include_notes BOOLEAN DEFAULT TRUE"
            ))
            logger.info("Added dext_include_notes column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_include_notes column already exists")
        else:
            logger.warning(f"dext_include_notes column: {e}")

    # Add dext_include_non_stock column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN dext_include_non_stock BOOLEAN DEFAULT TRUE"
            ))
            logger.info("Added dext_include_non_stock column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_include_non_stock column already exists")
        else:
            logger.warning(f"dext_include_non_stock column: {e}")

    # Add dext_auto_send_enabled column
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN dext_auto_send_enabled BOOLEAN DEFAULT FALSE"
            ))
            logger.info("Added dext_auto_send_enabled column to kitchen_settings")
    except Exception as e:
        if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
            logger.info("dext_auto_send_enabled column already exists")
        else:
            logger.warning(f"dext_auto_send_enabled column: {e}")

    logger.info("Dext integration migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(run_migration())
