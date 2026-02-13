"""
Migration: Create cost_distributions, cost_distribution_line_selections,
and cost_distribution_entries tables. Add cost_distribution_max_days to kitchen_settings.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Create cost_distributions table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS cost_distributions (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
                    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
                    method VARCHAR(20) NOT NULL,
                    notes TEXT,
                    total_distributed_value NUMERIC(12,2) NOT NULL,
                    remaining_balance NUMERIC(12,2) NOT NULL,
                    source_date DATE NOT NULL,
                    created_by INTEGER NOT NULL REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    cancelled_by INTEGER REFERENCES users(id),
                    cancelled_at TIMESTAMP
                )
            """))
            print("+ Created cost_distributions table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- cost_distributions table already exists, skipping")
            else:
                raise

        # Create indexes for cost_distributions
        for idx_name, idx_cols in [
            ("idx_cd_kitchen_status", "kitchen_id, status"),
            ("idx_cd_kitchen_invoice", "kitchen_id, invoice_id"),
            ("idx_cd_source_date", "kitchen_id, source_date"),
        ]:
            try:
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {idx_name} ON cost_distributions({idx_cols})"
                ))
                print(f"+ Created index {idx_name}")
            except Exception as e:
                if "already exists" in str(e).lower():
                    print(f"- Index {idx_name} already exists, skipping")
                else:
                    raise

        # Create cost_distribution_line_selections table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS cost_distribution_line_selections (
                    id SERIAL PRIMARY KEY,
                    distribution_id INTEGER NOT NULL REFERENCES cost_distributions(id) ON DELETE CASCADE,
                    line_item_id INTEGER NOT NULL REFERENCES line_items(id),
                    selected_quantity NUMERIC(10,3) NOT NULL,
                    unit_price NUMERIC(10,2) NOT NULL,
                    distributed_value NUMERIC(12,2) NOT NULL
                )
            """))
            print("+ Created cost_distribution_line_selections table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- cost_distribution_line_selections table already exists, skipping")
            else:
                raise

        # Create cost_distribution_entries table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS cost_distribution_entries (
                    id SERIAL PRIMARY KEY,
                    distribution_id INTEGER NOT NULL REFERENCES cost_distributions(id) ON DELETE CASCADE,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    entry_date DATE NOT NULL,
                    amount NUMERIC(12,2) NOT NULL,
                    is_source_offset BOOLEAN DEFAULT FALSE,
                    is_overpay BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created cost_distribution_entries table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- cost_distribution_entries table already exists, skipping")
            else:
                raise

        # Create indexes for cost_distribution_entries
        for idx_name, idx_cols in [
            ("idx_cde_kitchen_date", "kitchen_id, entry_date"),
            ("idx_cde_distribution", "distribution_id, entry_date"),
        ]:
            try:
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {idx_name} ON cost_distribution_entries({idx_cols})"
                ))
                print(f"+ Created index {idx_name}")
            except Exception as e:
                if "already exists" in str(e).lower():
                    print(f"- Index {idx_name} already exists, skipping")
                else:
                    raise

        # Add cost_distribution_max_days to kitchen_settings
        try:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN cost_distribution_max_days INTEGER DEFAULT 90"
            ))
            print("+ Added cost_distribution_max_days to kitchen_settings")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate column" in str(e).lower():
                print("- cost_distribution_max_days column already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_cost_distributions")
    asyncio.run(migrate())
    print("Migration complete!")
