"""
Migration: Create purchase_orders and purchase_order_line_items tables.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    async with engine.begin() as conn:
        # Create purchase_orders table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS purchase_orders (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
                    order_date DATE NOT NULL,
                    order_type VARCHAR(20) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
                    total_amount NUMERIC(12,2),
                    order_reference VARCHAR(200),
                    notes TEXT,
                    attachment_path VARCHAR(500),
                    attachment_original_name VARCHAR(255),
                    linked_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
                    created_by INTEGER NOT NULL REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_by INTEGER REFERENCES users(id),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created purchase_orders table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- purchase_orders table already exists, skipping")
            else:
                raise

        # Create indexes for purchase_orders
        for idx_name, idx_cols in [
            ("idx_po_kitchen_date", "kitchen_id, order_date"),
            ("idx_po_kitchen_supplier", "kitchen_id, supplier_id"),
            ("idx_po_kitchen_status", "kitchen_id, status"),
        ]:
            try:
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {idx_name} ON purchase_orders({idx_cols})"
                ))
                print(f"+ Created index {idx_name}")
            except Exception as e:
                if "already exists" in str(e).lower():
                    print(f"- Index {idx_name} already exists, skipping")
                else:
                    raise

        # Create purchase_order_line_items table
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS purchase_order_line_items (
                    id SERIAL PRIMARY KEY,
                    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    product_id INTEGER,
                    product_code VARCHAR(100),
                    description VARCHAR(500) NOT NULL,
                    unit VARCHAR(50),
                    unit_price NUMERIC(12,4) NOT NULL,
                    quantity NUMERIC(10,3) NOT NULL,
                    total NUMERIC(12,2) NOT NULL,
                    line_number INTEGER DEFAULT 0,
                    source VARCHAR(20) DEFAULT 'manual',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created purchase_order_line_items table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- purchase_order_line_items table already exists, skipping")
            else:
                raise


if __name__ == "__main__":
    print("Running migration: add_purchase_orders")
    asyncio.run(migrate())
    print("Migration complete!")
