"""
Migration: Add budget settings columns to kitchen_settings table

Adds:
- forecast_api_url: URL for external forecasting API
- forecast_api_key: API key for forecast authentication
- budget_gp_target: Target GP percentage (default 65%)
- budget_lookback_weeks: Number of weeks for supplier % calculation (default 4)
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Add forecast_api_url column
        try:
            await conn.execute(text(
                """
                ALTER TABLE kitchen_settings
                ADD COLUMN forecast_api_url VARCHAR(500)
                """
            ))
            print("+ Added forecast_api_url column")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- forecast_api_url column already exists, skipping")
            else:
                raise

        # Add forecast_api_key column
        try:
            await conn.execute(text(
                """
                ALTER TABLE kitchen_settings
                ADD COLUMN forecast_api_key VARCHAR(500)
                """
            ))
            print("+ Added forecast_api_key column")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- forecast_api_key column already exists, skipping")
            else:
                raise

        # Add budget_gp_target column
        try:
            await conn.execute(text(
                """
                ALTER TABLE kitchen_settings
                ADD COLUMN budget_gp_target NUMERIC(5,2) DEFAULT 65.00
                """
            ))
            print("+ Added budget_gp_target column")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- budget_gp_target column already exists, skipping")
            else:
                raise

        # Add budget_lookback_weeks column
        try:
            await conn.execute(text(
                """
                ALTER TABLE kitchen_settings
                ADD COLUMN budget_lookback_weeks INTEGER DEFAULT 4
                """
            ))
            print("+ Added budget_lookback_weeks column")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- budget_lookback_weeks column already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_budget_settings")
    asyncio.run(migrate())
    print("Migration complete!")
