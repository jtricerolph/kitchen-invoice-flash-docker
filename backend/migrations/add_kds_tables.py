"""
Migration: Add KDS (Kitchen Display System) tables and settings

Creates:
- kds_tickets: Local ticket state tracking
- kds_course_bumps: Course bump audit trail
- KDS settings columns in kitchen_settings
"""

import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)


async def run_migration():
    """Add KDS tables and settings columns."""
    migrations = [
        # KDS settings columns in kitchen_settings
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_enabled BOOLEAN DEFAULT FALSE
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_graphql_url VARCHAR(500)
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_graphql_username VARCHAR(255)
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_graphql_password VARCHAR(500)
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_graphql_client_id VARCHAR(255)
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_poll_interval_seconds INTEGER DEFAULT 5
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_timer_green_seconds INTEGER DEFAULT 300
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_timer_amber_seconds INTEGER DEFAULT 600
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_timer_red_seconds INTEGER DEFAULT 900
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_course_order JSONB DEFAULT '["Starters", "Mains", "Desserts"]'::jsonb
        """,
        """
        ALTER TABLE kitchen_settings
        ADD COLUMN IF NOT EXISTS kds_show_completed_for_seconds INTEGER DEFAULT 30
        """,

        # KDS Tickets table
        """
        CREATE TABLE IF NOT EXISTS kds_tickets (
            id SERIAL PRIMARY KEY,
            kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
            sambapos_ticket_id INTEGER NOT NULL,
            sambapos_ticket_uid VARCHAR(100),
            ticket_number VARCHAR(50) NOT NULL,
            table_name VARCHAR(100),
            covers INTEGER,
            total_amount FLOAT,
            received_at TIMESTAMP DEFAULT NOW(),
            last_sambapos_update TIMESTAMP,
            is_active BOOLEAN DEFAULT TRUE,
            is_bumped BOOLEAN DEFAULT FALSE,
            bumped_at TIMESTAMP,
            course_states JSONB DEFAULT '{}'::jsonb,
            orders_data JSONB,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_kds_tickets_kitchen_id ON kds_tickets(kitchen_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_kds_tickets_sambapos_id ON kds_tickets(sambapos_ticket_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_kds_tickets_active ON kds_tickets(kitchen_id, is_active)
        """,

        # KDS Course Bumps table
        """
        CREATE TABLE IF NOT EXISTS kds_course_bumps (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER NOT NULL REFERENCES kds_tickets(id) ON DELETE CASCADE,
            course_name VARCHAR(100) NOT NULL,
            bumped_at TIMESTAMP DEFAULT NOW(),
            bumped_by_user_id INTEGER REFERENCES users(id),
            time_since_previous_seconds INTEGER
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_kds_course_bumps_ticket_id ON kds_course_bumps(ticket_id)
        """,
    ]

    for sql in migrations:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql.strip()))
                logger.info(f"KDS Migration executed: {sql.strip()[:60]}...")
        except Exception as e:
            error_str = str(e).lower()
            if "already exists" in error_str or "duplicate" in error_str:
                logger.info(f"KDS Migration: already exists, skipping")
            else:
                logger.warning(f"KDS Migration warning: {e}")
