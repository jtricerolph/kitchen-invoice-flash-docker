"""
Migration: Add KDS per-order tracking column.

Adds:
- initial_order_ids JSONB column to kds_tickets (captures order IDs at ticket creation
  for detecting +ADDITION orders added later)
"""

import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add KDS order tracking column."""

    alter_statements = [
        """
        ALTER TABLE kds_tickets
        ADD COLUMN IF NOT EXISTS initial_order_ids JSONB
        """,
    ]

    try:
        async with engine.begin() as conn:
            for sql in alter_statements:
                await conn.execute(text(sql))
            logger.info("Added KDS order tracking column (initial_order_ids)")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"KDS order tracking migration: {e}")


if __name__ == "__main__":
    asyncio.run(run_migration())
