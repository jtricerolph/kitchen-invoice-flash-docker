"""
Migration: Add cover overrides, forecast snapshots, and spend rate overrides tables.

Creates:
- cover_overrides: Per-day per-period cover overrides for lunch/dinner
- forecast_snapshots: Full weekly forecast snapshot (all periods/days) with spend rates
- forecast_week_snapshots: Weekly revenue totals at snapshot time
- spend_rate_overrides: Per-week per-period spend rate overrides
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Create cover_overrides table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS cover_overrides (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    override_date DATE NOT NULL,
                    period VARCHAR(20) NOT NULL,
                    override_covers INTEGER NOT NULL,
                    original_forecast INTEGER,
                    original_otb INTEGER,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_by INTEGER REFERENCES users(id),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, override_date, period)
                )
            """))
            print("+ Created cover_overrides table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- cover_overrides table already exists, skipping")
            else:
                raise

        # Create forecast_snapshots table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS forecast_snapshots (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    snapshot_date DATE NOT NULL,
                    period VARCHAR(20) NOT NULL,
                    forecast_covers INTEGER NOT NULL,
                    otb_covers INTEGER NOT NULL,
                    food_spend NUMERIC(10,2),
                    drinks_spend NUMERIC(10,2),
                    forecast_dry_revenue NUMERIC(10,2),
                    week_start DATE NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, snapshot_date, period)
                )
            """))
            print("+ Created forecast_snapshots table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- forecast_snapshots table already exists, skipping")
            else:
                raise

        # Create forecast_week_snapshots table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS forecast_week_snapshots (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    week_start DATE NOT NULL,
                    total_forecast_revenue NUMERIC(12,2),
                    total_otb_revenue NUMERIC(12,2),
                    gp_target NUMERIC(5,2),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, week_start)
                )
            """))
            print("+ Created forecast_week_snapshots table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- forecast_week_snapshots table already exists, skipping")
            else:
                raise

        # Create spend_rate_overrides table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS spend_rate_overrides (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    week_start DATE NOT NULL,
                    period VARCHAR(20) NOT NULL,
                    food_spend NUMERIC(10,2),
                    drinks_spend NUMERIC(10,2),
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_by INTEGER REFERENCES users(id),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, week_start, period)
                )
            """))
            print("+ Created spend_rate_overrides table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- spend_rate_overrides table already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_cover_overrides")
    asyncio.run(migrate())
    print("Migration complete!")
