# Recipe, Ingredient & Food Flag System — Implementation Plan

## Context

The kitchen-invoice-flash app currently tracks invoices, line items, and suppliers with a basic portioning feature (scales icon → cost breakdown modal). This plan introduces a full **Recipe & Ingredient Management System** that:

1. Creates a canonical **ingredient library** with yield tracking, duplicate detection, and multi-supplier price comparison
2. Builds a **hierarchical recipe system** with sub-recipes, batch portions, scaling, cost trending, and printable recipe cards
3. Replaces hardcoded allergens with a **configurable food flag system** — categories with different propagation logic ("contains" for allergens, "suitable_for" for dietary)
4. Adds flag tracking cascading from line items → ingredients → recipes → plated dishes, with audit trails for overrides
5. Introduces **event/function ordering** — select recipes × quantities to generate aggregated shopping lists and purchase orders
6. Provides an **internal API** (API key auth) for in-house apps (e.g., menu display plugin) and **KDS recipe linking** for kitchen display integration

The existing portioning inline expansion (scales icon) becomes an **ingredient-first mapping modal dialog** — pack/unit fields remain but now feed into ingredient unit conversion rather than standalone portioning.

---

## Phase 1: Database Schema & Backend Models

### New Tables

#### `ingredient_categories` — Configurable ingredient groupings
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(100) NOT NULL           -- "Dairy", "Meat", "Produce", etc.
sort_order          INT DEFAULT 0
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```
Pre-seeded: Dairy, Meat, Seafood, Produce, Dry Goods, Oils & Fats, Herbs & Spices, Bakery, Beverages, Condiments, Other

#### `ingredients` — Canonical ingredient library
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(255) NOT NULL           -- "Butter", "Minced Beef 80/20", "Plain Flour"
category_id         INT FK → ingredient_categories(id) ON DELETE SET NULL
standard_unit       VARCHAR(20) NOT NULL            -- "g", "kg", "ml", "ltr", "each"
yield_percent       NUMERIC(5,2) DEFAULT 100.00     -- usable % after trim/peel/waste (e.g., 85 for carrots, 65 for whole chicken)
manual_price        NUMERIC(12,6)                   -- placeholder price/std_unit for unmapped ingredients
notes               TEXT
is_archived         BOOL DEFAULT false
created_by          INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
updated_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```

#### `ingredient_sources` — Maps supplier products → ingredients (with unit conversion)
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
ingredient_id       INT FK → ingredients(id) ON DELETE CASCADE
supplier_id         INT FK → suppliers(id) NOT NULL
product_code        VARCHAR(100)                    -- matches line_items.product_code (NULL for no-SKU suppliers)
description_pattern VARCHAR(255)                    -- normalised substring match against line_item descriptions (used when product_code is NULL)
-- Pack/conversion data (persisted like product_definitions)
pack_quantity       INT                             -- e.g., 10 (10 blocks of butter)
unit_size           NUMERIC(10,3)                   -- e.g., 250 (250g each)
unit_size_type      VARCHAR(10)                     -- "g", "kg", "ml", "ltr", "oz", "cl", "each"
-- Price tracking (auto-updated from most recent matched line item)
latest_unit_price   NUMERIC(10,2)
latest_invoice_id   INT FK → invoices(id) ON DELETE SET NULL
latest_invoice_date DATE
price_per_std_unit  NUMERIC(12,6)                   -- auto-calc: latest_unit_price / total_in_standard_unit
created_at          TIMESTAMP DEFAULT NOW()
updated_at          TIMESTAMP DEFAULT NOW()
-- Dual unique constraints for SKU and non-SKU suppliers
UNIQUE(kitchen_id, ingredient_id, supplier_id, product_code)  -- for items WITH product_code
```
```sql
-- Partial unique index for no-SKU items (product_code IS NULL)
CREATE UNIQUE INDEX uix_ingredient_source_desc
  ON ingredient_sources(kitchen_id, ingredient_id, supplier_id, description_pattern)
  WHERE product_code IS NULL;
```
**Matching priority** (same as existing product_definitions pattern):
1. Try `supplier_id + product_code` exact match first
2. Fall back to `supplier_id + description_pattern` normalised contains-match (for no-SKU suppliers)
3. Longer patterns match before shorter ones (more specific wins)

**Validation rule**: When `product_code` is NULL, `description_pattern` is required (and vice versa — at least one must be set).

#### `food_flag_categories` — Configurable flag category types (Allergy, Dietary, etc.)
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(100) NOT NULL           -- "Allergy", "Dietary", "Religious", etc.
propagation_type    VARCHAR(20) NOT NULL            -- "contains" (any-match, union) | "suitable_for" (all-must-match, intersection)
sort_order          INT DEFAULT 0
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```
Pre-seeded:
- "Allergy" (propagation: "contains") — if ANY child ingredient has it, recipe has it
- "Dietary" (propagation: "suitable_for") — only applies if ALL children qualify

#### `food_flags` — Individual flags within categories
```sql
id                  SERIAL PK
category_id         INT FK → food_flag_categories(id) ON DELETE CASCADE
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(100) NOT NULL           -- "Gluten", "Milk", "Vegetarian", "Vegan", etc.
code                VARCHAR(10)                     -- short code: "Gl", "Mi", "V", "Ve" (for badges)
icon                VARCHAR(10)                     -- optional emoji/symbol
sort_order          INT DEFAULT 0
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```
Pre-seeded Allergy flags: Celery, Gluten, Crustaceans, Eggs, Fish, Lupin, Milk, Molluscs, Mustard, Tree Nuts, Peanuts, Sesame, Soya, Sulphites
Pre-seeded Dietary flags: Vegetarian, Vegan, Pescatarian, Gluten-Free (dietary, not allergy)

#### `ingredient_flags` — Canonical flag assignments on ingredients (latching)
```sql
id                  SERIAL PK
ingredient_id       INT FK → ingredients(id) ON DELETE CASCADE
food_flag_id        INT FK → food_flags(id) ON DELETE CASCADE
flagged_by          INT FK → users(id)
source              VARCHAR(20) DEFAULT 'manual'    -- "manual" | "latched" (auto-set from line_item_flag)
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(ingredient_id, food_flag_id)
```
**Latching behavior**: When a line item is flagged AND that line item is mapped to an ingredient (via `ingredient_id`), the system auto-creates an `ingredient_flag` with `source='latched'`. Flags latch on permanently — they never auto-remove. Only manual deletion by a user can remove an ingredient flag.

This table is the **canonical source of truth** for ingredient-level flags. Recipe flag propagation reads from here, not from line_item_flags.

#### `line_item_flags` — Flags on supplier line items (data entry mechanism)
```sql
id                  SERIAL PK
line_item_id        INT FK → line_items(id) ON DELETE CASCADE
food_flag_id        INT FK → food_flags(id) ON DELETE CASCADE
flagged_by          INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(line_item_id, food_flag_id)
```
Line item flags serve as a data-entry point. When set, they trigger latching to the mapped ingredient (if `line_item.ingredient_id` is set). The ingredient_flags table holds the persistent truth.

#### `menu_sections` — Groupings for recipes (both plated and component)
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(100) NOT NULL           -- Plated: "Starters", "Mains", "Desserts". Component: "Sauces", "Bases", "Preparations"
sort_order          INT DEFAULT 0
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```
Sections work for both recipe types. The recipe list page filters sections by selected type (component/plated). No separate `section_type` needed — a section like "Sauces" naturally only has components assigned to it.

#### `recipes` — Component and plated recipes
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(255) NOT NULL
recipe_type         VARCHAR(20) NOT NULL            -- "component" | "plated"
menu_section_id     INT FK → menu_sections(id) ON DELETE SET NULL  -- optional grouping for either type
description         TEXT
batch_portions      INT NOT NULL DEFAULT 1          -- components only: how many portions this batch makes (plated always 1)
prep_time_minutes   INT
cook_time_minutes   INT
notes               TEXT
is_archived         BOOL DEFAULT false
kds_menu_item_name  VARCHAR(255)                    -- Phase 7: matches KDS/SambaPOS menu item name for linking
created_by          INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
updated_at          TIMESTAMP DEFAULT NOW()
UNIQUE(kitchen_id, name)
```

#### `recipe_ingredients` — Ingredients used in a recipe
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
ingredient_id       INT FK → ingredients(id) ON DELETE RESTRICT
quantity            NUMERIC(10,3) NOT NULL          -- in ingredient's standard_unit
notes               TEXT                            -- "finely diced", "room temperature"
sort_order          INT DEFAULT 0
```

#### `recipe_sub_recipes` — Sub-recipes used in a recipe (max 5 levels deep)
```sql
id                  SERIAL PK
parent_recipe_id    INT FK → recipes(id) ON DELETE CASCADE
child_recipe_id     INT FK → recipes(id) ON DELETE RESTRICT
portions_needed     NUMERIC(10,3) NOT NULL          -- how many portions of the child batch we use
notes               TEXT
sort_order          INT DEFAULT 0
CHECK(parent_recipe_id != child_recipe_id)
```

#### `recipe_steps` — Cooking instructions
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
step_number         INT NOT NULL
instruction         TEXT NOT NULL
image_path          VARCHAR(500)                    -- optional step photo (local Docker volume)
duration_minutes    INT
notes               TEXT
```

#### `recipe_images` — General recipe/plating photos
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
image_path          VARCHAR(500) NOT NULL           -- stored at /app/data/{kitchen_id}/recipes/{uuid}.{ext}
caption             TEXT
image_type          VARCHAR(20) DEFAULT 'general'   -- "general" | "plating" | "method"
sort_order          INT DEFAULT 0
uploaded_by         INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
```

#### `recipe_flags` — Flag state on recipes (manual additions + override state)
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
food_flag_id        INT FK → food_flags(id) ON DELETE CASCADE
source_type         VARCHAR(20) NOT NULL            -- "auto" | "manual"
is_active           BOOL DEFAULT true               -- false = overridden/deactivated
excludable_on_request BOOL DEFAULT false            -- plated only: can prepare without on request
created_at          TIMESTAMP DEFAULT NOW()
updated_at          TIMESTAMP DEFAULT NOW()
UNIQUE(recipe_id, food_flag_id)
```

#### `recipe_flag_overrides` — Audit log for flag changes (mandatory notes)
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
food_flag_id        INT FK → food_flags(id) ON DELETE CASCADE
action              VARCHAR(20) NOT NULL            -- "deactivated" | "reactivated" | "set_excludable" | "unset_excludable"
note                TEXT NOT NULL                   -- mandatory reason
user_id             INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
```

#### `recipe_change_log` — Recipe change history
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
change_summary      TEXT NOT NULL                   -- "Butter quantity changed from 200g to 250g; Added Oregano 5g"
user_id             INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
```

#### `recipe_cost_snapshots` — Cost trending over time
```sql
id                  SERIAL PK
recipe_id           INT FK → recipes(id) ON DELETE CASCADE
cost_per_portion    NUMERIC(12,6) NOT NULL
total_cost          NUMERIC(12,6) NOT NULL
snapshot_date       DATE NOT NULL
trigger_source      VARCHAR(100)                    -- "ingredient_price_update: Butter" or "manual_recalc"
created_at          TIMESTAMP DEFAULT NOW()
UNIQUE(recipe_id, snapshot_date)                    -- one snapshot per recipe per day (upsert on conflict)
```
**Upsert behavior**: If a snapshot already exists for today, update it with the latest cost values. Multiple ingredient price changes on the same day result in one snapshot reflecting the final state.

#### `event_orders` — Function/event ordering (select recipes × quantities → generate shopping list)
```sql
id                  SERIAL PK
kitchen_id          INT FK → kitchens(id) NOT NULL
name                VARCHAR(255) NOT NULL           -- "Wedding Reception 15th March", "Staff Party"
event_date          DATE
notes               TEXT
status              VARCHAR(20) DEFAULT 'DRAFT'     -- DRAFT | FINALISED | ORDERED
created_by          INT FK → users(id)
created_at          TIMESTAMP DEFAULT NOW()
updated_at          TIMESTAMP DEFAULT NOW()
```

#### `event_order_items` — Recipes and quantities for an event
```sql
id                  SERIAL PK
event_order_id      INT FK → event_orders(id) ON DELETE CASCADE
recipe_id           INT FK → recipes(id) ON DELETE RESTRICT
quantity            INT NOT NULL                    -- how many servings/batches of this recipe
notes               TEXT
sort_order          INT DEFAULT 0
```
Both plated and component recipes can be added to an event order. Components show batch_portions for context (e.g., "Burger Sauce — batch of 20 portions, qty: 3 batches = 60 portions").

### Existing Table Modifications

#### `line_items` — Add `ingredient_id` column
```sql
ALTER TABLE line_items ADD COLUMN ingredient_id INT REFERENCES ingredients(id) ON DELETE SET NULL;
CREATE INDEX idx_line_items_ingredient ON line_items(ingredient_id);
```
Direct link from line item to its mapped ingredient. Set when a user maps a line item to an ingredient via the ingredient mapping modal. Nullable — only populated for mapped items.

**Benefits**:
- Direct relationship for queries ("show all line items for Butter")
- Enables latching: when a line_item_flag is set, check `ingredient_id` and auto-create ingredient_flag
- Scales icon tooltip can show "→ Butter" without a lookup query

#### `kitchen_settings` — Add API key fields
```sql
ALTER TABLE kitchen_settings ADD COLUMN api_key VARCHAR(100);
ALTER TABLE kitchen_settings ADD COLUMN api_key_enabled BOOL DEFAULT false;
```
Used by external in-house apps (e.g., menu display plugin) to authenticate against the internal API endpoints.

### Database Extensions

#### `pg_trgm` — Trigram similarity for duplicate detection
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```
Used for fuzzy ingredient name matching during creation. Provides `similarity()` function:
```sql
SELECT name, similarity(name, 'Butter') AS sim
FROM ingredients
WHERE kitchen_id = :kid AND similarity(name, 'Butter') > 0.3
ORDER BY sim DESC LIMIT 5;
```
Returns similar names like "Unsalted Butter" (0.47), "Salted Butter" (0.47) as warnings before creating a potential duplicate.

### Unit Conversion Constants
Standard units: `g`, `kg`, `ml`, `ltr`, `each`. Conversion factors in code:

```python
UNIT_CONVERSIONS = {
    "g":    {"g": 1, "kg": 0.001},
    "kg":   {"g": 1000, "kg": 1},
    "oz":   {"g": 28.3495, "kg": 0.0283495},
    "lb":   {"g": 453.592, "kg": 0.453592},
    "ml":   {"ml": 1, "ltr": 0.001},
    "cl":   {"ml": 10, "ltr": 0.01},
    "ltr":  {"ml": 1000, "ltr": 1},
    "each": {"each": 1},
}
```

### Key Calculation Logic

**Ingredient cost from source:**
```
total_in_std_unit = pack_quantity × unit_size × conversion_factor(unit_size_type → standard_unit)
price_per_std_unit = latest_unit_price / total_in_std_unit
```

**Yield-adjusted effective price** (used in recipes):
```
raw_price = most recent source price_per_std_unit (or manual_price if unmapped)
effective_price = raw_price / (yield_percent / 100)
-- e.g., carrots at £1/kg with 85% yield → £1.18/kg usable
-- whole chicken at £3/kg with 65% yield → £4.62/kg usable
```

**Recipe cost:**
```
ingredient_cost = SUM(recipe_ingredient.quantity × ingredient.effective_price)
sub_recipe_cost = SUM((sub.portions_needed / child.batch_portions) × child.total_cost)
total_cost = ingredient_cost + sub_recipe_cost
cost_per_portion = total_cost / batch_portions
```

**Cost range on recipes:**
```
min_cost = use cheapest source for each ingredient
max_cost = use most expensive source for each ingredient
recent_cost = use most recent purchase for each ingredient (default)
```

**GP calculator on plated recipes:**
```
At target GP%: suggested_price = cost_per_portion / (1 - target_gp)
Show comparison at 60%, 65%, 70% GP targets
```

**Food flag propagation (computed on-read via ingredient_flags):**
```
For each food_flag_category:
    if propagation_type == "contains":
        Collect flags from ALL recipe_ingredients → ingredient → ingredient_flags
        Union with flags from ALL sub-recipes (recursive)
        → Recipe has flag if ANY ingredient has it

    if propagation_type == "suitable_for":
        For each flag in category:
            Check ALL recipe_ingredients → ingredient → ingredient_flags has this flag
            AND ALL sub-recipes have this flag (recursive)
            → Recipe has flag only if ALL ingredients have it
            → Ingredients with NO flags assessed for this category count as "unknown" (not a match)

Merge with manual additions (source_type="manual" in recipe_flags)
Apply overrides (is_active=false entries from recipe_flags with audit log)
```

**Flag latching flow:**
```
1. User flags a line_item with "Contains: Milk" via Review.tsx flag button
2. System checks line_item.ingredient_id — if set (e.g., ingredient "Butter"):
   a. Auto-create ingredient_flag(ingredient=Butter, flag=Milk, source='latched') if not exists
   b. ingredient_flag persists permanently regardless of future line item changes
3. All recipes using "Butter" now auto-inherit "Contains: Milk" via propagation
```

### Files to Create
- `backend/models/ingredient.py` — Ingredient, IngredientCategory, IngredientSource, IngredientFlag
- `backend/models/recipe.py` — Recipe, MenuSection, RecipeIngredient, RecipeSubRecipe, RecipeStep, RecipeImage, RecipeChangeLog, RecipeCostSnapshot
- `backend/models/food_flag.py` — FoodFlagCategory, FoodFlag, LineItemFlag, RecipeFlag, RecipeFlagOverride
- `backend/models/event_order.py` — EventOrder, EventOrderItem
- `backend/api/ingredients.py` — Ingredient CRUD + source mapping + auto-price hook
- `backend/api/recipes.py` — Recipe CRUD + costing + sub-recipe cycle check + scaling + recipe card HTML + menu section CRUD + cost snapshot calculation
- `backend/api/food_flags.py` — Flag management + ingredient flagging + line item flagging + latching logic + recipe flag propagation + overrides
- `backend/api/event_orders.py` — Event ordering + aggregated shopping list generation
- `backend/api/external.py` — Internal API endpoints with API key auth for in-house apps
- `backend/migrations/add_recipe_system.py` — All new tables + pre-seeded data + pg_trgm extension
- `frontend/src/components/Ingredients.tsx` — Ingredient library page
- `frontend/src/components/RecipeList.tsx` — Recipe list page
- `frontend/src/components/RecipeEditor.tsx` — Recipe builder/editor page
- `frontend/src/components/RecipeFlagMatrix.tsx` — Flag breakdown matrix (ingredients × flags)
- `frontend/src/components/FoodFlagBadges.tsx` — Reusable flag badges component
- `frontend/src/components/EventOrders.tsx` — Event ordering page
- `frontend/src/components/EventOrderEditor.tsx` — Event order builder

### Files to Modify
- `backend/models/__init__.py` — Register new models (IngredientFlag added)
- `backend/models/line_item.py` — Add `ingredient_id` FK column
- `backend/main.py` — Register new routers (ingredients, recipes, food_flags, event_orders, external)
- `frontend/src/App.tsx` — Add routes + new **"Recipes" dropdown** in top header nav (matching existing Invoices/Bookings/Reports dropdown pattern) containing: Recipes, Ingredients, Event Orders
- `frontend/src/components/Review.tsx` — Replace inline scales expansion with ingredient mapping modal dialog + add flag button
- `frontend/src/components/Dashboard.tsx` — Add unmapped ingredients widget
- `backend/api/invoices.py` — Auto-price update hook when line items saved + flag latching trigger + cost snapshot trigger
- `frontend/src/pages/Settings.tsx` — Add Food Flag Categories/Flags management section + API Key management section

---

## Phase 2: Foundation — Schema, Models, Ingredient Library

### 2a: Migration & Models
- Create migration `add_recipe_system.py` with all tables above
- Enable `pg_trgm` extension
- Add `ingredient_id` column to `line_items` table
- Add `api_key` + `api_key_enabled` columns to `kitchen_settings` table
- Pre-seed `ingredient_categories` with defaults
- Pre-seed `food_flag_categories` (Allergy/contains, Dietary/suitable_for) and `food_flags` (EU 14 + dietary defaults). Pre-seeded categories and flags are user-editable and deletable — no special protection needed (kitchen can customise to their needs)
- Create all SQLAlchemy models
- Register in `__init__.py` and `main.py`

### 2b: Ingredient Backend
**Endpoints:**
- `GET /api/ingredient-categories` — List categories (for dropdowns)
- `POST /api/ingredient-categories` — Create category
- `PATCH /api/ingredient-categories/{id}` — Rename/reorder
- `DELETE /api/ingredient-categories/{id}` — Delete (sets ingredients to null category)
- `GET /api/ingredients` — List all (with source count, flag summary, effective price)
- `GET /api/ingredients?unmapped=true` — Filter to ingredients with no sources
- `POST /api/ingredients` — Create (name, category_id, standard_unit, yield_percent, optional manual_price). **Duplicate detection**: uses pg_trgm `similarity()` to fuzzy-match name against existing ingredients, returns warnings if similar names found (threshold > 0.3)
- `PATCH /api/ingredients/{id}` — Update (including yield_percent)
- `DELETE /api/ingredients/{id}` — Soft-archive (is_archived=true)
- `GET /api/ingredients/{id}/sources` — List all supplier sources with prices
- `POST /api/ingredients/{id}/sources` — Map a supplier product (requires product_code OR description_pattern)
- `PATCH /api/ingredient-sources/{id}` — Update pack/conversion data
- `DELETE /api/ingredient-sources/{id}` — Remove mapping
- `GET /api/ingredients/{id}/flags` — List ingredient's flags
- `PUT /api/ingredients/{id}/flags` — Set/update ingredient flags (manual)
- `GET /api/ingredients/suggest?description={text}` — Suggest existing ingredient matches for a line item description (uses pg_trgm similarity). Used by the ingredient mapping modal to auto-populate the ingredient dropdown

**Auto-price hook** (in `invoices.py` line item save/update):
- When a line item is saved/updated, get supplier_id via `line_item → invoice → supplier_id` (line_items don't have direct supplier_id)
- **Match priority**: Try `supplier_id + product_code` exact match against ingredient_sources first. If no product_code on the line item (or no match), try `supplier_id + description_pattern` normalised contains-match (lowercase, collapse whitespace, check if pattern is contained in description). Longer patterns match before shorter ones (more specific wins)
- If match found: update latest_unit_price, latest_invoice_id, latest_invoice_date, recalculate price_per_std_unit
- Also set `line_item.ingredient_id` to the matched ingredient (if not already set)

**Flag latching hook** (logic in `food_flags.py`, called from line item flag save endpoints):
- When a `line_item_flag` is created/updated AND `line_item.ingredient_id` is set:
  - Auto-create `ingredient_flag` for that ingredient + flag if not already present (source='latched')
  - Ingredient flags are permanent — latching only adds, never removes

### 2c: Ingredient Frontend — `/ingredients` page
- Searchable/filterable table of all ingredients
- Columns: name, category, standard unit, yield %, sources count, flags (FoodFlagBadges), effective price/unit (yield-adjusted)
- Expandable row: all sources with supplier name, product code/description pattern, pack info, price/std unit, last invoice date
- "Create Ingredient" modal with **duplicate detection** (on name blur, API call checks pg_trgm similarity, shows warning with similar existing names)
- Filter toggle: "Show unmapped only" (ingredients without any sources)
- Category management: "+Add" button in category filter dropdown (opens inline input)

### 2d: Ingredient Mapping Modal (replaces inline scales expansion in Review.tsx)
- **Keep scales icon** with existing colour scheme: red (no data), amber (partial/parsed), green (fully mapped to ingredient)
- Tooltip updates to show ingredient name + conversion info when mapped (e.g., "→ Butter (250g × 10 = 2.5kg @ £4.20/kg)")
- **Clicking scales icon opens a modal dialog** (replaces the current inline expandable row — the extra fields need more space):
  1. **Auto-populate**: Parse line item description to suggest existing ingredient match (via pg_trgm similarity search). Pre-fill pack fields from line item's existing pack_quantity/unit_size/unit_size_type. Load product_definition if exists
  2. **Ingredient mapping section**: Searchable dropdown of ingredients. If no match exists, "Create new ingredient" opens inline mini-form (name, category, standard unit) within the modal. Shows current mapping if already mapped
  3. **Pack fields**: pack_quantity, unit_size, unit_size_type (editable, auto-filled from OCR/product_definition)
  4. **Conversion display**: Shows calculated total_in_standard_unit and price_per_std_unit based on current pack fields + ingredient's standard unit
  5. **Save**: Creates/updates the ingredient_source mapping. Sets `line_item.ingredient_id`. Checkbox to "Update saved definition" (existing product_definition behavior preserved)
- Existing `portions_per_unit` / `cost_per_portion` fields remain on line_item model for backward compatibility but are de-emphasised in the UI (shown in a collapsible "Legacy Portioning" section within the modal)

---

## Phase 3: Recipe Builder

### 3a: Recipe Backend

**Menu sections:**
- `GET /api/menu-sections` — List all sections (for dropdowns, filtered by recipe type in frontend)
- `POST /api/menu-sections` — Create section (name)
- `PATCH /api/menu-sections/{id}` — Rename/reorder
- `DELETE /api/menu-sections/{id}` — Delete (sets recipes to null section)

**Recipe endpoints:**
- `GET /api/recipes` — List all (filterable by type, menu section, search by name, flag include/exclude, ingredient contains)
- `GET /api/recipes/{id}` — Full recipe with ingredients, sub-recipes, steps, images, flags, costing
- `POST /api/recipes` — Create
- `PATCH /api/recipes/{id}` — Update metadata (logs change to recipe_change_log)
- `DELETE /api/recipes/{id}` — Soft-archive
- `POST /api/recipes/{id}/duplicate` — Clone recipe with rename prompt. Deep copies: ingredients, steps, images, flags, notes. Sub-recipe references are **linked** (not deep-copied) — the duplicate shares the same component recipes. User prompted to enter new name (pre-filled with "Original Name (Copy)")

**Recipe ingredients:**
- `POST /api/recipes/{id}/ingredients` — Add ingredient (logs change)
- `PATCH /api/recipe-ingredients/{id}` — Update quantity/notes (logs old→new)
- `DELETE /api/recipe-ingredients/{id}` — Remove (logs removal)

**Recipe sub-recipes:**
- `POST /api/recipes/{id}/sub-recipes` — Add (with circular dependency check via recursive CTE, max 5 levels)
- `PATCH /api/recipe-sub-recipes/{id}` — Update portions_needed
- `DELETE /api/recipe-sub-recipes/{id}` — Remove

**Circular dependency check:**
```sql
WITH RECURSIVE ancestors AS (
    SELECT parent_recipe_id, child_recipe_id, 1 AS depth
    FROM recipe_sub_recipes WHERE child_recipe_id = :new_parent_id
    UNION ALL
    SELECT rsr.parent_recipe_id, rsr.child_recipe_id, a.depth + 1
    FROM recipe_sub_recipes rsr JOIN ancestors a ON rsr.child_recipe_id = a.parent_recipe_id
    WHERE a.depth < 5
)
SELECT 1 FROM ancestors WHERE parent_recipe_id = :new_child_id LIMIT 1;
-- If returns a row → would create cycle → reject
```

**Recipe steps:**
- `POST /api/recipes/{id}/steps` — Add step
- `PATCH /api/recipe-steps/{id}` — Update
- `DELETE /api/recipe-steps/{id}` — Remove
- `PATCH /api/recipes/{id}/steps/reorder` — Bulk reorder

**Recipe images:**
- `POST /api/recipes/{id}/images` — Upload (multipart, stored at `/app/data/{kitchen_id}/recipes/{uuid}.{ext}`)
- `GET /api/recipes/{recipe_id}/images/{image_id}` — Serve image (authenticated, same pattern as invoice image endpoint)
- `DELETE /api/recipe-images/{id}` — Remove file + DB record

**Costing:**
- `GET /api/recipes/{id}/costing` — Full cost breakdown:
  - Per ingredient: quantity, unit, yield %, effective price (yield-adjusted), all source prices, min/max
  - Per sub-recipe: name, batch_portions, portions_needed, cost per portion, cost contribution
  - Totals: recent cost, min cost, max cost, cost per portion
  - GP calculator: suggested prices at 60%, 65%, 70% GP targets (plated only)
- `GET /api/recipes/{id}/costing?scale_to=50` — Same but with quantities scaled to target portions
- `GET /api/recipes/{id}/cost-trend` — Cost snapshot history for trend chart
- **Cost snapshot trigger**: Snapshot calculation function lives in `recipes.py`. Called by the auto-price hook in `invoices.py` when an ingredient source price updates — recalculates and snapshots all recipes that use that ingredient. Uses **upsert** (INSERT ... ON CONFLICT UPDATE) — if today's snapshot exists, update it; otherwise create new

**Recipe card (HTML + browser print):**
- `GET /api/recipes/{id}/print?format=full&token={jwt}` — Full recipe HTML page (all details, images, costs, flags). Print-optimised with `@media print` CSS, same pattern as PO preview (`_build_po_html()` in purchase_orders.py)
- `GET /api/recipes/{id}/print?format=kitchen&token={jwt}` — Kitchen card HTML (large font, ingredients, steps, plating photo, flags)
- User clicks "Print Recipe" → opens in new tab → browser print dialog (includes "Save as PDF" option)

### 3b: Recipe Frontend

**`/recipes` page (RecipeList.tsx):**
- Card/list view toggle
- **Basic filters** (always visible): type (component/plated), search by name, menu section dropdown
- **Expandable filter panel** ("Show Filters" toggle reveals):
  - "Contains ingredient" searchable multi-select (find recipes using specific ingredients)
  - Flag filters: every flag shown with three-state toggle — neutral (no filter) / must include / must exclude
  - Flag filters grouped by category (Allergy section, Dietary section, etc.)
  - Cost range filter (min/max cost per portion)
  - All filters apply **live** with debounce on text fields — no "Apply" button needed
- Each card: name, type badge, menu section, batch portions (if component), cost/portion, flag badges
- Quick actions: edit, duplicate, archive
- Stats bar: total recipes, component count, plated count, unmapped ingredients count (links to /ingredients?unmapped=true)
- Menu section management: "+Add Section" (e.g., Starters, Mains, Desserts, Sauces, Bases)

**`/recipes/:id` page (RecipeEditor.tsx):**
- **Header**: Name, type (component/plated), menu section (dropdown, for either type), description, batch_portions (component only), prep/cook time
- **Ingredients section**:
  - Table: ingredient name, quantity, unit, cost (recent/min/max), flag indicators
  - "Add ingredient" searchable dropdown from library — or "Create new" inline modal (name, category, standard_unit, optional manual_price, optional first line item search+map)
  - Drag-to-reorder via sort_order
- **Sub-recipes section**:
  - Table: recipe name, type, batch size, portions needed, cost contribution
  - "Add sub-recipe" dropdown (excludes self + descendants, filtered by recipe search)
  - Shows "uses X of Y portions" with cost math inline
- **Steps section**:
  - Ordered list with step number, instruction textarea, optional image upload, optional duration
  - Drag-to-reorder, add/remove
- **Images section**:
  - Grid gallery with upload, caption, type tag (method/plating/general)
  - Plated recipes show plating photos prominently
- **Flags section**: Flag summary badges + notification block + expandable flag matrix (see Phase 4)
- **Cost summary panel** (sticky bottom bar):
  - Recent cost | Min cost | Max cost | Cost per portion
  - GP comparison table (plated only): suggested sell price at 60%, 65%, 70%
  - Expandable ingredient-by-ingredient breakdown with source options
- **Scaling calculator** (in cost summary panel):
  - Input: "Scale to X portions" → recalculates all ingredient quantities and sub-recipe portions for display
  - Frontend-only calculation, no schema change — just multiplies quantities by (target_portions / batch_portions)
  - Useful for event prep or varying batch sizes
- **Cost trend chart** (expandable in cost summary):
  - Line chart showing cost_per_portion over time (from recipe_cost_snapshots)
  - Highlights when/why cost changed (trigger_source label on hover)
- **Print recipe button**:
  - Opens new tab with print-optimised HTML page from backend
  - Dropdown: "Full Recipe" or "Kitchen Card"
  - Browser print dialog (includes "Save as PDF")
  - Includes flag badges and yield-adjusted costs
- **Change history** (expandable section at bottom):
  - Scrollable log: timestamp, user, change summary
  - Most recent first

---

## Phase 4: Food Flag System

### 4a: Flag Management Backend
**Settings endpoints:**
- `GET /api/food-flag-categories` — List categories with their flags
- `POST /api/food-flag-categories` — Create category (name, propagation_type)
- `PATCH /api/food-flag-categories/{id}` — Update name/propagation_type/sort_order
- `DELETE /api/food-flag-categories/{id}` — Delete (cascade deletes flags)
- `POST /api/food-flags` — Create flag within category
- `PATCH /api/food-flags/{id}` — Update name/code/icon/sort_order
- `DELETE /api/food-flags/{id}` — Delete flag

**Ingredient flags:**
- `GET /api/ingredients/{id}/flags` — Get all flags for an ingredient
- `PUT /api/ingredients/{id}/flags` — Set flags (full replacement: send array of food_flag_ids, source='manual')
- Flags are the canonical source for recipe propagation

**Line item flags (data entry + latching):**
- `GET /api/line-items/{id}/flags` — Get flags for a line item
- `PUT /api/line-items/{id}/flags` — Set flags (full replacement: send array of food_flag_ids)
  - **Latching trigger**: For each flag being set, if `line_item.ingredient_id` is not null, auto-create `ingredient_flag` (source='latched') if not already present
- Icon button on line item row in Review.tsx

**Recipe flag propagation logic (computed on-read from ingredient_flags):**
```
For each food_flag_category:
    if propagation_type == "contains":
        For each recipe_ingredient → get ingredient → get ingredient_flags
        Union with flags from ALL sub-recipes (recursive, same logic)
        → Recipe has flag if ANY ingredient has it

    if propagation_type == "suitable_for":
        For each flag in category:
            Check ALL recipe_ingredients → ingredient → ingredient_flags has this flag
            AND ALL sub-recipes have this flag (recursive)
            → Recipe has flag only if ALL ingredients have it
            → Ingredients with NO ingredient_flags for this category = "unassessed" (treated as unknown, NOT a match)

Merge with manual additions (source_type="manual" in recipe_flags)
Apply overrides (is_active=false entries from recipe_flags with audit log)
```

**Recipe flag endpoints:**
- `GET /api/recipes/{id}/flags` — Full flag state with source tracing per flag + unassessed ingredient list
- `POST /api/recipes/{id}/flags/{flag_id}/deactivate` — Override off (requires `note`, creates audit log)
- `POST /api/recipes/{id}/flags/{flag_id}/reactivate` — Undo override (creates audit log)
- `PATCH /api/recipes/{id}/flags/{flag_id}` — Toggle excludable_on_request (plated only, requires `note`)
- `POST /api/recipes/{id}/flags/manual` — Manually add a flag not auto-detected
- `GET /api/recipes/{id}/flags/audit-log` — Override history
- `GET /api/recipes/{id}/flags/matrix` — Full ingredient × flag matrix data for the flag breakdown table

### 4b: Flag Frontend

**Line item flag button (Review.tsx):**
- New icon button alongside scales icon (shield/warning icon)
- Opens modal with flags grouped by category (Allergy section, Dietary section, etc.)
- Checkboxes for each flag
- Icon color: grey = no flags, amber = has allergy flags, green = has dietary flags, both = combined indicator
- When saving: triggers latching to mapped ingredient (if ingredient_id set)

**Flag management in Settings page:**
- Section for "Food Flag Categories"
- Each category: name, propagation type display ("Contains" / "Suitable For"), expandable flag list
- "+Add Category" button
- Within each category: "+Add Flag" with name, code, icon fields
- Reorder via drag or arrows

**Recipe flag notification block (in RecipeEditor.tsx, above flag badges):**
- Appears when ingredients have incomplete flag coverage:
  > ⚠️ **3 ingredients are missing allergen details** — Lettuce, Mustard, Salt
- Additional line when manual recipe-level flags exist AND there are still unassessed ingredients:
  > ℹ️ Recipe-level flags have been manually set (may not reflect all ingredients)
- Links each ingredient name to the ingredient's flag editing interface
- Dismisses when all ingredients have been assessed

**Recipe flag summary badges (in RecipeEditor.tsx):**
- Compact FoodFlagBadges row showing the computed recipe-level flags
- Below the notification block (if present)
- Same badges as on recipe list cards

**Recipe flag matrix (RecipeFlagMatrix.tsx — expandable section in RecipeEditor.tsx):**
- Table layout: ingredients down the left, food flags as columns
- Columns grouped by category (Allergy columns, then Dietary columns, etc.)
- **Direct recipe ingredients** shown as regular rows
- **Sub-recipe ingredients** grouped under a bold header row with the component name:
  ```
  | Ingredient          | Crust. | Eggs | Milk | Gluten | ... | Veg  | Vegan |
  |---------------------|--------|------|------|--------|-----|------|-------|
  | Brioche Bun         |        |      |      | 🔴✓   |     | 🟢✓ | 🔴✗  |
  | Lettuce             | ❓     | ❓   | ❓   | ❓     |     | ❓   | ❓    |
  | ▸ Burger Patty      |        |      |      |        |     |      |       |
  |   ↳ Beef Mince      |        |      |      |        |     | 🔴✗ | 🔴✗  |
  |   ↳ Breadcrumbs     |        |      |      | 🔴✓   |     | 🟢✓ | 🟢✓  |
  |   ↳ Egg             |        | 🔴✓ |      |        |     | 🟢✓ | 🔴✗  |
  | ▸ Burger Sauce      |        |      |      |        |     |      |       |
  |   ↳ Mayonnaise      |        | 🔴✓ |      |        |     | 🟢✓ | 🔴✗  |
  |   ↳ Mustard         | ❓     | ❓   | ❓   | ❓     |     | ❓   | ❓    |
  | ══ Recipe Total ══  |        | 🔴✓ |      | 🔴✓   |     | 🔴✗ | 🔴✗  |
  ```
- **Colour logic per flag category**:
  - **"Contains" flags (allergens)**: 🔴 red tick = contains (bad), empty = doesn't contain (good)
  - **"Suitable for" flags (dietary)**: 🟢 green tick = qualifies (good), 🔴 red cross = doesn't qualify (bad)
  - **❓ Amber question mark** = ingredient has NOT been assessed for ANY flags in this category (missing data)
- **Recipe total row** uses propagation logic:
  - Allergens: union (any red tick in column → recipe total is red tick)
  - Dietary: intersection (any red cross OR any amber ❓ in column → recipe total is red cross or ❓)
- Overrides shown with strikethrough + hover tooltip showing mandatory note
- "Excludable on request" flags shown with dashed border
- Click on any ingredient row to navigate to that ingredient's flag editor

**FoodFlagBadges.tsx (reusable component):**
- Compact row of colored badges using flag codes (Gl, Mi, Eg, V, Ve, etc.)
- Color by category (red for allergens, green for dietary, blue for other)
- Tooltip: full name + source trace
- "Excludable" flags: dashed border or different opacity
- Used in: recipe list cards, ingredient rows, line item rows, recipe editor

---

## Phase 5: Dashboard Integration & Internal API

### 5a: Dashboard Widgets
- **Main dashboard (Dashboard.tsx)**: Small card showing:
  - Unmapped ingredients count (links to `/ingredients?unmapped=true`)
  - Recipes without complete costing count
  - Links to `/recipes` overview

### 5b: Recipe Overview Stats (on `/recipes` page)
- Total recipes / components / plated
- Unmapped ingredients count
- Recipes with incomplete flag coverage
- Recently updated recipes

### 5c: Internal API for In-House Apps
**Authentication**: API key in request header (not JWT). Kitchen identified from API key lookup.
```
X-API-Key: {kitchen_settings.api_key}
```

**Endpoints** (prefix `/api/external/`):
- `GET /api/external/recipes/plated` — List non-archived plated recipes
  - Query params:
    - `include_ingredients=flat` (consolidated ingredient list) | `nested` (shows sub-recipe ingredient breakdown) | `none`
    - `include_costs=true|false` (whether to include cost data — default false)
    - `exclude_flags=1,5,7` (filter out recipes containing specific flags by ID)
  - Returns: id, name, description, menu_section, images, flags (with excludable markers), ingredients (if requested)
- `GET /api/external/recipes/{id}` — Single plated recipe with same query param options
- `GET /api/external/food-flags` — List all flag categories and flags (for external app to understand flag IDs)

**Use case**: Menu display app queries plated recipes → selects corresponding recipe for a menu item → reads flags to calculate and display allergen/dietary information.

**Settings page**: "API Access" section under Settings
- Generate / regenerate API key button
- Toggle API key enabled/disabled
- Copy key to clipboard
- Show when key was last used (optional future enhancement)

---

## Phase 6: Event/Function Ordering

### 6a: Backend
**Endpoints:**
- `GET /api/event-orders` — List all event orders (filterable by status, date range)
- `POST /api/event-orders` — Create event order (name, event_date, notes)
- `PATCH /api/event-orders/{id}` — Update metadata/status
- `DELETE /api/event-orders/{id}` — Delete (DRAFT only)
- `POST /api/event-orders/{id}/items` — Add recipe × quantity (both plated and component recipes)
- `PATCH /api/event-order-items/{id}` — Update quantity
- `DELETE /api/event-order-items/{id}` — Remove
- `GET /api/event-orders/{id}/shopping-list` — **Aggregated ingredient shopping list**:
  - Walks all selected recipes (including sub-recipes) × quantities
  - Aggregates total quantity needed per ingredient (in standard units, yield-adjusted)
  - Groups by ingredient category
  - For each ingredient: shows total needed, available sources with pack sizes, suggested packs to order (rounded up)
  - Can group by supplier for generating per-supplier order lists
- `POST /api/event-orders/{id}/generate-po` — Optional: auto-generate purchase orders from shopping list (links to existing PO system)

### 6b: Frontend

**`/event-orders` page (EventOrders.tsx):**
- List of event orders with name, date, status, recipe count, estimated total cost
- Create new event order

**`/event-orders/:id` page (EventOrderEditor.tsx):**
- **Header**: Event name, date, status, notes
- **Recipe selection**:
  - Searchable dropdown of all recipes (plated and component, with menu section grouping)
  - For component recipes: shows batch_portions for context (e.g., "Burger Sauce — batch of 20 portions")
  - Quantity input per recipe (servings for plated, batches for component)
  - Shows: recipe name, type badge, cost/portion, quantity, subtotal
  - Running total at bottom
- **Shopping list view** (toggle/tab):
  - Aggregated ingredients grouped by category
  - Each row: ingredient name, total quantity needed (standard unit), yield-adjusted quantity
  - Expandable: which recipes need this ingredient and how much each
  - Source info: supplier(s), pack size, suggested packs to order, cost per pack, subtotal
  - Group-by-supplier view: generates per-supplier order lists
  - "Generate Purchase Orders" button → creates POs in existing system per supplier
- **Cost summary**: Total ingredient cost, cost per head, GP comparison

---

## Phase 7: KDS Recipe Link

### 7a: Schema
Already included in main `recipes` table schema (Phase 1) as `kds_menu_item_name VARCHAR(255)`. No separate migration needed.

### 7b: Backend (added to existing `backend/api/kds.py`)
- `GET /api/kds/recipe-link/{menu_item_name}` — Look up linked recipe for a KDS order item
- Display recipe summary (plating photo, key steps, flag badges) in a KDS-friendly format

### 7c: Frontend (KDS page enhancement)
- When a KDS order item has a linked recipe: show small recipe icon
- Tap to view: plating photo, ingredient list, key steps, flag badges
- Useful for new staff or complex dishes
- Lightweight overlay that doesn't disrupt KDS workflow

---

## Implementation Order

| Phase | Scope | Key Deliverables |
|-------|-------|------------------|
| 2a | Migration + models | All DB tables, pg_trgm extension, line_item.ingredient_id, pre-seeded data, SQLAlchemy models |
| 2b | Ingredient backend | CRUD endpoints, source mapping (product_code + description_pattern), auto-price hook, flag latching, duplicate detection |
| 2c | Ingredient frontend | `/ingredients` page, category management, yield %, duplicate warnings, flag display |
| 2d | Ingredient mapping modal | Modal dialog in Review.tsx replacing inline expansion, ingredient_id linking |
| 3a | Recipe backend | CRUD, costing, cycle check, change logging, cost snapshots (upsert), menu sections, print HTML |
| 3b | Recipe frontend | `/recipes` list + `/recipes/:id` editor with scaling, cost trend chart, print button |
| 4a | Flag management backend | Flag categories/flags CRUD, ingredient flagging, line item flagging + latching, recipe propagation via ingredient_flags |
| 4b | Flag frontend | Line item flag button, settings management, recipe flag notification block + matrix + badges |
| 5a-c | Dashboard + internal API | Dashboard widgets, recipe stats, API key auth, external endpoints for in-house apps |
| 6a-b | Event ordering backend + frontend | Event orders (plated + component), aggregated shopping list, PO generation |
| 7a-c | KDS recipe link | Link plated recipes to KDS menu items, recipe overlay on KDS |

### Verification Plan
1. **Phase 2a**: Run migration → verify all tables + pre-seeded data via `psql`. Verify pg_trgm extension active. Verify line_items.ingredient_id column exists
2. **Phase 2b**: Create ingredients via API, map line items as sources → verify unit conversion + yield-adjusted price. Test duplicate detection via pg_trgm on similar names. Process a new invoice → verify auto-price update (supplier_id resolved via invoice join). Test description_pattern matching for no-SKU suppliers. Verify ingredient_id set on matched line items
3. **Phase 2c-d**: Create ingredient from `/ingredients` page with yield %. Open ingredient mapping modal on a line item → verify auto-populate from description. Map to ingredient → verify source created with correct conversion and line_item.ingredient_id set
4. **Phase 3**: Create "Burger Patty" component in "Preparations" section (batch: 4 portions). Create "Beef Burger" plated in "Mains" section using 1 portion of Burger Patty + bun → verify cost = (1/4 × patty total) + bun cost. Test scaling calculator at different portion counts. Verify cost trend chart after ingredient price changes (upsert for same-day updates). Print recipe card via HTML preview
5. **Phase 4**: Flag ingredient "Butter" with "Contains: Milk". Flag a line item → verify latching creates ingredient_flag. Open recipe flag matrix → verify "Contains: Milk" propagates from Butter via any-match. Verify "suitable_for" propagates via all-must-match. Verify amber ❓ shows for unassessed ingredients. Test override with mandatory note + audit log. Test excludable_on_request on plated. Verify notification block shows missing flag count
6. **Phase 5**: Dashboard widget shows unmapped count. Generate API key in Settings. Use API key to query `/api/external/recipes/plated` → verify returns recipes with flags. Test `include_ingredients` and `include_costs` query params
7. **Phase 6**: Create event order for "Wedding Reception", add 50× Beef Burger (plated) + 3× Burger Sauce (component, 20-portion batch) → verify aggregated shopping list totals ingredients correctly across recipes. Test suggested packs calculation. Generate POs per supplier
8. **Phase 7**: Link "Beef Burger" recipe to KDS menu item. Verify recipe overlay appears on KDS when that item is ordered

### Key Design Decisions
- **Standard units: g, kg, ml, ltr, each** — chefs choose the appropriate standard per ingredient (saffron in g, beef in kg)
- **Yield percentage** on ingredients adjusts effective cost for waste/trim (e.g., 85% yield carrots, 65% whole chicken)
- **Most recent purchase price** used as default recipe cost (not pinned suppliers) — auto-updates as new invoices are processed. Min/max show the range across all sources
- **ingredient_sources coexist with product_definitions** — existing portioning works unchanged. Ingredient mapping is additive
- **Dual matching: product_code first, then description_pattern** — supports both SKU-based and description-based suppliers. Same priority pattern as existing product_definitions
- **ingredient_id FK on line_items** — direct link from line item to ingredient, simplifies queries and enables flag latching
- **ingredient_flags as canonical flag source** — flags live on ingredients, not just line items. Line item flags are a data-entry mechanism that auto-latches to ingredients. Recipe propagation reads from ingredient_flags
- **Flag latching** — when a line item is flagged, the system auto-creates a permanent ingredient_flag. Flags only accumulate, never auto-remove. Manual removal by user only
- **Food flags computed on-read** — always fresh from ingredient_flags, no cache invalidation needed. `recipe_flags` table only stores manual additions + override state
- **Propagation type per category** — "contains" (allergens, any-match) vs "suitable_for" (dietary, all-must-match) enables correct semantics for both flag types
- **Unassessed ingredients shown as amber ❓** — clearly distinguishes "not yet assessed" from "assessed as clean", prevents false negatives in dietary flags
- **Flag matrix with grouped sub-recipe ingredients** — full ingredient × flag breakdown with component grouping headers, colour-coded by flag type
- **Notification block for incomplete flag coverage** — warns when ingredients are missing allergen details, notes when manual recipe flags are a stopgap
- **Duplicate ingredient detection** — pg_trgm trigram similarity (PostgreSQL extension) for fuzzy name matching, threshold > 0.3
- **Max 5 levels** sub-recipe nesting — enforced via recursive CTE depth check
- **Batch portions on components only** — plated recipes always represent 1 serving
- **Menu sections for both recipe types** — Starters/Mains/Desserts for plated, Sauces/Bases/Preparations for components. Shared table, filtered by recipe type in UI
- **Recipe scaling calculator** — frontend-only, multiplies quantities by target/batch ratio for display
- **Cost trend snapshots with upsert** — daily snapshots triggered by ingredient price changes. Multiple updates on same day upsert to latest values
- **Recipe cards via HTML + browser print** — follows existing PO preview pattern (`_build_po_html()`). Two formats: full detail and kitchen card. No new PDF library needed
- **Recipe image serving** — authenticated endpoint `GET /api/recipes/{id}/images/{image_id}`, same pattern as invoice image endpoints. Stored at `/app/data/{kitchen_id}/recipes/{uuid}.{ext}` on existing Docker volume
- **Event ordering supports both recipe types** — plated (servings) and component (batches) can be added to event orders
- **Internal API with API key auth** — `/api/external/` prefix, X-API-Key header, for in-house apps (e.g., menu display plugin querying recipes for allergen calculation). Not publicly unauthenticated
- **API key management in Settings** — generate/regenerate, enable/disable toggle, per-kitchen
- **KDS recipe link** — matches plated recipes to KDS menu items for quick recipe/plating reference
- **Change history as summary strings** — single log entry per save with old→new field values
- **Recipe images on local Docker volume** at `/app/data/{kitchen_id}/recipes/` — backed up via existing Nextcloud
- **Any user can create/edit** recipes — uses existing auth, no new roles needed
- **Inline ingredient creation** from both mapping modal and recipe editor — with duplicate detection and ability to search+map a line item source or set manual placeholder price
- **Recipe duplication** copies top-level content (ingredients, steps, images, flags) but links sub-recipes (not deep-copied)
- **Flag filters** offer both include AND exclude for every flag — three-state toggle (neutral/include/exclude)
- **Live filtering** on recipe list with debounce — no "Apply" button
- **New "Recipes" dropdown in top header nav** — matches existing Invoices/Bookings/Reports dropdown pattern, separate from invoice navigation
- **Ingredient mapping modal replaces inline expansion** — more space for ingredient search, pack fields, and conversion display
- **Scales icon colours preserved** — red/amber/green as before, tooltip shows ingredient name when mapped
- **Supplier_id resolved via invoice join** — line_items don't have direct supplier_id, the auto-price hook joins through invoice.supplier_id
