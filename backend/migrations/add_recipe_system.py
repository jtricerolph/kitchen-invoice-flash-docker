"""
Migration: Recipe, Ingredient & Food Flag System
Creates all tables for the recipe system and pre-seeds reference data.
"""
import asyncio
from sqlalchemy import text
from database import engine


async def migrate():
    # ══ CRITICAL: Add columns to existing tables FIRST (own transaction) ══
    # These MUST succeed even if new table creation fails, otherwise
    # the KitchenSettings SQLAlchemy model breaks ALL existing endpoints.
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS api_key VARCHAR(100)"
            ))
            await conn.execute(text(
                "ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS api_key_enabled BOOLEAN DEFAULT false"
            ))
            await conn.execute(text(
                "ALTER TABLE line_items ADD COLUMN IF NOT EXISTS ingredient_id INTEGER REFERENCES ingredients(id) ON DELETE SET NULL"
            ))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_line_items_ingredient ON line_items(ingredient_id)"
            ))
            print("+ Added columns to existing tables (api_key, api_key_enabled, ingredient_id)")
    except Exception as e:
        print(f"! CRITICAL: Failed to add columns to existing tables: {e}")

    # ── pg_trgm extension (separate transaction — may need superuser) ──
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            print("+ Enabled pg_trgm extension")
    except Exception as e:
        print(f"- pg_trgm extension not available ({e}), fuzzy search will be limited")

    async with engine.begin() as conn:
        # ── ingredient_categories ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS ingredient_categories (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(100) NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created ingredient_categories table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- ingredient_categories table already exists, skipping")
            else:
                raise

        # ── ingredients ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS ingredients (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(255) NOT NULL,
                    category_id INTEGER REFERENCES ingredient_categories(id) ON DELETE SET NULL,
                    standard_unit VARCHAR(20) NOT NULL,
                    yield_percent NUMERIC(5,2) DEFAULT 100.00,
                    manual_price NUMERIC(12,6),
                    notes TEXT,
                    is_archived BOOLEAN DEFAULT false,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created ingredients table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- ingredients table already exists, skipping")
            else:
                raise

        # ── ingredient_sources ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS ingredient_sources (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
                    product_code VARCHAR(100),
                    description_pattern VARCHAR(255),
                    pack_quantity INTEGER,
                    unit_size NUMERIC(10,3),
                    unit_size_type VARCHAR(10),
                    latest_unit_price NUMERIC(10,2),
                    latest_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
                    latest_invoice_date DATE,
                    price_per_std_unit NUMERIC(12,6),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, ingredient_id, supplier_id, product_code)
                )
            """))
            print("+ Created ingredient_sources table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- ingredient_sources table already exists, skipping")
            else:
                raise

        # Partial unique index for no-SKU items (product_code IS NULL)
        try:
            await conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uix_ingredient_source_desc
                ON ingredient_sources(kitchen_id, ingredient_id, supplier_id, description_pattern)
                WHERE product_code IS NULL
            """))
            print("+ Created partial unique index uix_ingredient_source_desc")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- Index uix_ingredient_source_desc already exists, skipping")
            else:
                raise

        # ── food_flag_categories ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS food_flag_categories (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(100) NOT NULL,
                    propagation_type VARCHAR(20) NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created food_flag_categories table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- food_flag_categories table already exists, skipping")
            else:
                raise

        # ── food_flags ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS food_flags (
                    id SERIAL PRIMARY KEY,
                    category_id INTEGER NOT NULL REFERENCES food_flag_categories(id) ON DELETE CASCADE,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(100) NOT NULL,
                    code VARCHAR(10),
                    icon VARCHAR(10),
                    sort_order INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created food_flags table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- food_flags table already exists, skipping")
            else:
                raise

        # ── ingredient_flags (canonical flag source) ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS ingredient_flags (
                    id SERIAL PRIMARY KEY,
                    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                    food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                    flagged_by INTEGER REFERENCES users(id),
                    source VARCHAR(20) DEFAULT 'manual',
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(ingredient_id, food_flag_id)
                )
            """))
            print("+ Created ingredient_flags table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- ingredient_flags table already exists, skipping")
            else:
                raise

        # ── line_item_flags (data entry mechanism) ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS line_item_flags (
                    id SERIAL PRIMARY KEY,
                    line_item_id INTEGER NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
                    food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                    flagged_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(line_item_id, food_flag_id)
                )
            """))
            print("+ Created line_item_flags table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- line_item_flags table already exists, skipping")
            else:
                raise

        # ── menu_sections ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS menu_sections (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(100) NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created menu_sections table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- menu_sections table already exists, skipping")
            else:
                raise

        # ── recipes ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipes (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(255) NOT NULL,
                    recipe_type VARCHAR(20) NOT NULL,
                    menu_section_id INTEGER REFERENCES menu_sections(id) ON DELETE SET NULL,
                    description TEXT,
                    batch_portions INTEGER NOT NULL DEFAULT 1,
                    prep_time_minutes INTEGER,
                    cook_time_minutes INTEGER,
                    notes TEXT,
                    is_archived BOOLEAN DEFAULT false,
                    kds_menu_item_name VARCHAR(255),
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(kitchen_id, name)
                )
            """))
            print("+ Created recipes table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipes table already exists, skipping")
            else:
                raise

        # ── recipe_ingredients ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_ingredients (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
                    quantity NUMERIC(10,3) NOT NULL,
                    notes TEXT,
                    sort_order INTEGER DEFAULT 0
                )
            """))
            print("+ Created recipe_ingredients table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_ingredients table already exists, skipping")
            else:
                raise

        # ── recipe_sub_recipes ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_sub_recipes (
                    id SERIAL PRIMARY KEY,
                    parent_recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    child_recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
                    portions_needed NUMERIC(10,3) NOT NULL,
                    notes TEXT,
                    sort_order INTEGER DEFAULT 0,
                    CHECK(parent_recipe_id != child_recipe_id)
                )
            """))
            print("+ Created recipe_sub_recipes table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_sub_recipes table already exists, skipping")
            else:
                raise

        # ── recipe_steps ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_steps (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    step_number INTEGER NOT NULL,
                    instruction TEXT NOT NULL,
                    image_path VARCHAR(500),
                    duration_minutes INTEGER,
                    notes TEXT
                )
            """))
            print("+ Created recipe_steps table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_steps table already exists, skipping")
            else:
                raise

        # ── recipe_images ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_images (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    image_path VARCHAR(500) NOT NULL,
                    caption TEXT,
                    image_type VARCHAR(20) DEFAULT 'general',
                    sort_order INTEGER DEFAULT 0,
                    uploaded_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created recipe_images table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_images table already exists, skipping")
            else:
                raise

        # ── recipe_flags (manual additions + override state) ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_flags (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                    source_type VARCHAR(20) NOT NULL,
                    is_active BOOLEAN DEFAULT true,
                    excludable_on_request BOOLEAN DEFAULT false,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(recipe_id, food_flag_id)
                )
            """))
            print("+ Created recipe_flags table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_flags table already exists, skipping")
            else:
                raise

        # ── recipe_flag_overrides (audit log) ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_flag_overrides (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                    action VARCHAR(20) NOT NULL,
                    note TEXT NOT NULL,
                    user_id INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created recipe_flag_overrides table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_flag_overrides table already exists, skipping")
            else:
                raise

        # ── recipe_change_log ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_change_log (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    change_summary TEXT NOT NULL,
                    user_id INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created recipe_change_log table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_change_log table already exists, skipping")
            else:
                raise

        # ── recipe_cost_snapshots ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recipe_cost_snapshots (
                    id SERIAL PRIMARY KEY,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
                    cost_per_portion NUMERIC(12,6) NOT NULL,
                    total_cost NUMERIC(12,6) NOT NULL,
                    snapshot_date DATE NOT NULL,
                    trigger_source VARCHAR(100),
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(recipe_id, snapshot_date)
                )
            """))
            print("+ Created recipe_cost_snapshots table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- recipe_cost_snapshots table already exists, skipping")
            else:
                raise

        # ── event_orders ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS event_orders (
                    id SERIAL PRIMARY KEY,
                    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                    name VARCHAR(255) NOT NULL,
                    event_date DATE,
                    notes TEXT,
                    status VARCHAR(20) DEFAULT 'DRAFT',
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            """))
            print("+ Created event_orders table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- event_orders table already exists, skipping")
            else:
                raise

        # ── event_order_items ──
        try:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS event_order_items (
                    id SERIAL PRIMARY KEY,
                    event_order_id INTEGER NOT NULL REFERENCES event_orders(id) ON DELETE CASCADE,
                    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
                    quantity INTEGER NOT NULL,
                    notes TEXT,
                    sort_order INTEGER DEFAULT 0
                )
            """))
            print("+ Created event_order_items table")
        except Exception as e:
            if "already exists" in str(e).lower():
                print("- event_order_items table already exists, skipping")
            else:
                raise

        # (ALTER TABLE for existing tables already ran in separate transaction above)

        # ── Indexes ──
        for idx_name, idx_def in [
            ("idx_ingredients_kitchen", "ingredients(kitchen_id)"),
            ("idx_ingredients_category", "ingredients(category_id)"),
            ("idx_ingredient_sources_ingredient", "ingredient_sources(ingredient_id)"),
            ("idx_ingredient_sources_supplier", "ingredient_sources(supplier_id)"),
            ("idx_ingredient_flags_ingredient", "ingredient_flags(ingredient_id)"),
            ("idx_ingredient_flags_flag", "ingredient_flags(food_flag_id)"),
            ("idx_food_flags_category", "food_flags(category_id)"),
            ("idx_line_item_flags_line_item", "line_item_flags(line_item_id)"),
            ("idx_recipes_kitchen", "recipes(kitchen_id)"),
            ("idx_recipes_type", "recipes(kitchen_id, recipe_type)"),
            ("idx_recipes_section", "recipes(menu_section_id)"),
            ("idx_recipe_ingredients_recipe", "recipe_ingredients(recipe_id)"),
            ("idx_recipe_sub_recipes_parent", "recipe_sub_recipes(parent_recipe_id)"),
            ("idx_recipe_sub_recipes_child", "recipe_sub_recipes(child_recipe_id)"),
            ("idx_recipe_steps_recipe", "recipe_steps(recipe_id)"),
            ("idx_recipe_images_recipe", "recipe_images(recipe_id)"),
            ("idx_recipe_flags_recipe", "recipe_flags(recipe_id)"),
            ("idx_recipe_cost_snapshots_recipe", "recipe_cost_snapshots(recipe_id)"),
            ("idx_event_orders_kitchen", "event_orders(kitchen_id)"),
            ("idx_event_order_items_order", "event_order_items(event_order_id)"),
        ]:
            try:
                await conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {idx_name} ON {idx_def}"
                ))
            except Exception:
                pass  # Skip silently — indexes are non-critical if they exist
        print("+ Created indexes")

        # ── Pre-seed ingredient categories for all existing kitchens ──
        try:
            result = await conn.execute(text("SELECT id FROM kitchens"))
            kitchen_ids = [row[0] for row in result.fetchall()]

            categories = [
                "Dairy", "Meat", "Seafood", "Produce", "Dry Goods",
                "Oils & Fats", "Herbs & Spices", "Bakery", "Beverages",
                "Condiments", "Other"
            ]

            for kid in kitchen_ids:
                for i, cat in enumerate(categories):
                    await conn.execute(text("""
                        INSERT INTO ingredient_categories (kitchen_id, name, sort_order)
                        VALUES (:kid, :name, :sort)
                        ON CONFLICT (kitchen_id, name) DO NOTHING
                    """), {"kid": kid, "name": cat, "sort": i})

            print(f"+ Pre-seeded ingredient categories for {len(kitchen_ids)} kitchen(s)")
        except Exception as e:
            print(f"! Warning seeding ingredient categories: {e}")

        # ── Pre-seed food flag categories and flags ──
        try:
            allergy_flags = [
                ("Celery", "Ce", None),
                ("Gluten", "Gl", None),
                ("Crustaceans", "Cr", None),
                ("Eggs", "Eg", None),
                ("Fish", "Fi", None),
                ("Lupin", "Lu", None),
                ("Milk", "Mi", None),
                ("Molluscs", "Mo", None),
                ("Mustard", "Mu", None),
                ("Tree Nuts", "TN", None),
                ("Peanuts", "Pn", None),
                ("Sesame", "Se", None),
                ("Soya", "So", None),
                ("Sulphites", "Su", None),
            ]

            dietary_flags = [
                ("Vegetarian", "V", None),
                ("Vegan", "Ve", None),
                ("Pescatarian", "Pe", None),
                ("Gluten-Free", "GF", None),
            ]

            for kid in kitchen_ids:
                # Create Allergy category
                result = await conn.execute(text("""
                    INSERT INTO food_flag_categories (kitchen_id, name, propagation_type, sort_order)
                    VALUES (:kid, 'Allergy', 'contains', 0)
                    ON CONFLICT (kitchen_id, name) DO NOTHING
                    RETURNING id
                """), {"kid": kid})
                row = result.fetchone()
                if row:
                    allergy_cat_id = row[0]
                else:
                    r = await conn.execute(text(
                        "SELECT id FROM food_flag_categories WHERE kitchen_id = :kid AND name = 'Allergy'"
                    ), {"kid": kid})
                    allergy_cat_id = r.fetchone()[0]

                # Create Dietary category
                result = await conn.execute(text("""
                    INSERT INTO food_flag_categories (kitchen_id, name, propagation_type, sort_order)
                    VALUES (:kid, 'Dietary', 'suitable_for', 1)
                    ON CONFLICT (kitchen_id, name) DO NOTHING
                    RETURNING id
                """), {"kid": kid})
                row = result.fetchone()
                if row:
                    dietary_cat_id = row[0]
                else:
                    r = await conn.execute(text(
                        "SELECT id FROM food_flag_categories WHERE kitchen_id = :kid AND name = 'Dietary'"
                    ), {"kid": kid})
                    dietary_cat_id = r.fetchone()[0]

                # Seed allergy flags
                for i, (name, code, icon) in enumerate(allergy_flags):
                    await conn.execute(text("""
                        INSERT INTO food_flags (category_id, kitchen_id, name, code, icon, sort_order)
                        VALUES (:cat_id, :kid, :name, :code, :icon, :sort)
                        ON CONFLICT (kitchen_id, name) DO NOTHING
                    """), {"cat_id": allergy_cat_id, "kid": kid, "name": name, "code": code, "icon": icon, "sort": i})

                # Seed dietary flags
                for i, (name, code, icon) in enumerate(dietary_flags):
                    await conn.execute(text("""
                        INSERT INTO food_flags (category_id, kitchen_id, name, code, icon, sort_order)
                        VALUES (:cat_id, :kid, :name, :code, :icon, :sort)
                        ON CONFLICT (kitchen_id, name) DO NOTHING
                    """), {"cat_id": dietary_cat_id, "kid": kid, "name": name, "code": code, "icon": icon, "sort": i})

            print(f"+ Pre-seeded food flag categories and flags for {len(kitchen_ids)} kitchen(s)")
        except Exception as e:
            print(f"! Warning seeding food flags: {e}")


if __name__ == "__main__":
    print("Running migration: add_recipe_system")
    asyncio.run(migrate())
    print("Migration complete!")
