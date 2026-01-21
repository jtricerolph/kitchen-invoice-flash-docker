import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add calendar_events table"""

    create_table = """
    CREATE TABLE IF NOT EXISTS calendar_events (
        id SERIAL PRIMARY KEY,
        kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
        event_date DATE NOT NULL,
        event_type VARCHAR(20) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """

    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_calendar_events_kitchen_date ON calendar_events(kitchen_id, event_date)",
        "CREATE INDEX IF NOT EXISTS idx_calendar_events_date_range ON calendar_events(event_date)",
    ]

    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_table))
            logger.info("Created calendar_events table")

            for sql in indexes:
                await conn.execute(text(sql))
            logger.info("Created calendar_events indexes")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Calendar events migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
