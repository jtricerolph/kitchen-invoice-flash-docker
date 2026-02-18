"""
Migration: Add allergen_keywords table for keyword-based allergen suggestion,
plus is_prepackaged/product_ingredients/label_image_path columns on ingredients.
Seeds default keywords from OFF allergens taxonomy per kitchen.
"""
import asyncio
from sqlalchemy import text
from database import engine


# Default keywords informed by Open Food Facts allergens taxonomy, FSA guidance,
# UK food labelling terms, common food products, and dish/meal association keywords.
# Three tiers:
#   1. Direct ingredients (flour, milk, egg, etc.)
#   2. Derivative/processed forms (casein, malt extract, surimi, etc.)
#   3. Dish/meal associations — "this product often contains X" (carbonara, pesto, satay, etc.)
ALLERGEN_KEYWORDS = {
    "Gluten": [
        # --- Direct grains & flours ---
        "wheat", "flour", "bread", "pasta", "barley", "rye", "oat", "spelt",
        "couscous", "bulgur", "semolina", "noodle", "crouton", "breadcrumb",
        "panko", "tortilla", "pita", "naan", "sourdough", "brioche",
        "croissant", "pastry", "pastries", "biscuit", "cracker", "kamut", "durum",
        "farro", "seitan", "malt", "starch",
        # --- Extended grains & derivatives ---
        "einkorn", "emmer", "triticale", "wheat bran", "wheat protein",
        "wheat starch", "modified starch", "wheat rusk", "rusk",
        "pearl barley", "barley malt", "malt extract", "malt vinegar",
        "durum wheat", "wholemeal", "wholegrain", "wheat flour",
        "rye flour", "barley flour", "oat fibre",
        # --- Baked goods & products ---
        "doughnut", "waffle", "bagel", "chapati", "focaccia", "ciabatta",
        "pumpernickel", "pretzel", "pitta", "wrap", "flatbread",
        "crumpet", "muffin", "cake", "sponge", "scone",
        "pancake", "crepe", "batter", "dumpling",
        # --- Dish/meal associations (often contains gluten) ---
        "carbonara", "lasagne", "lasagna", "pizza", "quiche",
        "tempura", "ramen", "gyoza", "dim sum", "spring roll",
        "scotch egg", "bhaji", "samosa", "pie", "gratin",
        "fondue", "gnocchi", "ravioli", "trifle", "brownie",
        "tiramisu", "crumble", "french toast",
        "soy sauce",  # most soy sauce contains wheat
    ],
    "Milk": [
        # --- Direct dairy ---
        "milk", "cream", "butter", "cheese", "yogurt", "yoghurt", "whey",
        "casein", "lactose", "ghee", "mascarpone", "ricotta", "mozzarella",
        "parmesan", "cheddar", "brie", "camembert", "gruyere", "halloumi",
        "paneer", "creme fraiche", "custard", "bechamel", "dairy",
        "condensed milk", "evaporated milk", "buttermilk", "kefir",
        "quark", "fromage", "emmental", "gouda", "stilton", "feta",
        "milk powder", "skimmed milk", "whole milk",
        # --- Extended cheese varieties & derivatives ---
        "taleggio", "pecorino", "roquefort", "manchego", "provolone",
        "reblochon", "raclette", "edam", "havarti", "jarlsberg",
        "wensleydale", "red leicester", "lancashire", "monterey jack",
        "cottage cheese", "cream cheese", "processed cheese",
        "clotted cream", "double cream", "single cream", "whipping cream",
        "sour cream", "curd", "dulce de leche",
        # --- Milk protein derivatives ---
        "lactalbumin", "lactoglobulin", "caseinates", "sodium caseinate",
        "calcium caseinate", "milk solids", "milk protein", "milk fat",
        # --- Milk-containing products ---
        "milk chocolate", "white chocolate", "ice cream", "gelato",
        "panna cotta", "lassi", "skyr",
        # --- Dish/meal associations (often contains milk) ---
        "carbonara", "risotto", "gratin", "fondue", "quiche",
        "bechamel", "mousse", "creme brulee", "souffle",
        "tikka masala", "korma", "bisque", "chowder",
        "ranch", "bearnaise", "scone", "pancake", "waffle",
        "french toast", "brioche", "croissant", "brownie",
        "tiramisu", "trifle", "gnocchi", "ravioli",
        "naan", "tzatziki", "raita",
    ],
    "Eggs": [
        # --- Direct egg forms ---
        "egg", "meringue", "mayonnaise", "aioli", "hollandaise",
        "quiche", "frittata", "omelette", "albumin",
        "egg white", "egg yolk", "whole egg", "dried egg", "egg powder",
        "egg wash", "eggnog", "duck egg", "quail egg",
        "lecithin", "lysozyme",
        # --- Dish/meal associations (often contains egg) ---
        "carbonara", "caesar", "pad thai", "ramen",
        "scotch egg", "french toast", "pancake", "waffle",
        "brioche", "croissant", "scone", "brownie",
        "tiramisu", "mousse", "creme brulee", "souffle",
        "trifle", "macaron", "meringue", "coleslaw",
        "waldorf", "gnocchi", "ravioli", "tempura",
        "tartare sauce", "ranch", "bearnaise",
        "custard", "batter",
    ],
    "Fish": [
        # --- Common fish species ---
        "cod", "salmon", "tuna", "haddock", "mackerel", "sardine", "sardines",
        "anchovy", "anchovies", "trout", "bass", "bream", "sole", "plaice",
        "halibut", "swordfish", "monkfish", "pollock", "herring",
        "whitebait", "fish sauce", "worcestershire", "fish",
        # --- Extended species ---
        "hake", "coley", "john dory", "brill", "turbot", "dab",
        "flounder", "sprat", "pike", "perch", "tilapia", "snapper",
        "grouper", "barramundi", "sea bream", "sea bass",
        "dover sole", "lemon sole", "pilchard",
        # --- Processed fish products ---
        "smoked salmon", "gravlax", "kipper", "rollmop", "surimi",
        "fish stock", "bonito", "katsuobushi", "fish cake",
        "fish finger", "fish pie", "taramasalata",
        # --- Dish/meal associations (often contains fish) ---
        "caesar",  # anchovy in dressing
        "kedgeree", "paella", "bouillabaisse", "sushi",
        "tom yum", "laksa",
    ],
    "Crustaceans": [
        # --- Direct crustacean types ---
        "prawn", "shrimp", "crab", "lobster", "crayfish", "langoustine",
        "scampi", "crustacean",
        # --- Extended terms ---
        "crawfish", "king prawn", "tiger prawn",
        "shrimp paste", "crab paste", "crab stick",
        "potted shrimp",
        # --- Dish/meal associations (often contains crustaceans) ---
        "bisque", "thermidor", "paella", "bouillabaisse",
        "tom yum", "laksa", "gumbo", "dim sum", "sushi",
        "pad thai",
    ],
    "Molluscs": [
        # --- Direct mollusc types ---
        "squid", "calamari", "octopus", "mussel", "clam", "oyster",
        "scallop", "cockle", "whelk", "snail", "escargot", "mollusc",
        # --- Extended terms ---
        "cuttlefish", "abalone", "periwinkle", "razor clam",
        "limpet", "winkle",
        # --- Dish/meal associations (often contains molluscs) ---
        "paella", "bouillabaisse", "chowder", "gumbo",
        "marinara",  # often includes shellfish
    ],
    "Peanuts": [
        # --- Direct forms ---
        "peanut", "groundnut", "arachis", "monkey nut",
        "peanut butter", "peanut oil", "peanut flour", "peanut paste",
        "groundnut oil",
        # --- Dish/meal associations (often contains peanuts) ---
        "satay", "pad thai", "laksa", "kung pao",
    ],
    "Tree Nuts": [
        # --- Direct nut types ---
        "almond", "hazelnut", "walnut", "cashew", "pecan", "pistachio",
        "macadamia", "brazil nut", "pine nut", "chestnut", "praline",
        "marzipan", "frangipane", "nougat",
        # --- Extended nut products ---
        "almond milk", "almond flour", "almond butter", "ground almond",
        "hazelnut oil", "walnut oil", "cashew butter",
        "pistachio paste", "pine kernel", "mixed nuts",
        "nut butter", "nut milk", "nut oil",
        "amaretti", "pecan pie",
        # --- Dish/meal associations (often contains tree nuts) ---
        "pesto",  # pine nuts + parmesan
        "baklava", "macaron", "korma", "waldorf",
        "praline", "frangipane",
    ],
    "Soya": [
        # --- Direct soya forms ---
        "soy", "soya", "tofu", "tempeh", "edamame", "miso", "tamari",
        "soybean", "soy lecithin", "soya lecithin",
        # --- Extended forms ---
        "soy sauce", "soy protein", "soy flour", "soya oil",
        "soy milk", "soybean oil", "soy protein isolate",
        "bean curd", "natto", "kinako", "yuba",
        # --- Dish/meal associations (often contains soya) ---
        "teriyaki", "ramen", "gyoza", "dim sum", "spring roll",
        "sushi", "stir fry",
    ],
    "Celery": [
        # --- Direct forms ---
        "celery", "celeriac",
        "celery salt", "celery seed", "celery oil", "celery powder",
        # --- Dish/meal associations (often contains celery) ---
        "waldorf", "bloody mary", "bolognese", "soffritto", "mirepoix",
    ],
    "Mustard": [
        # --- Direct forms ---
        "mustard", "dijon",
        "mustard seed", "mustard powder", "mustard oil",
        "english mustard", "wholegrain mustard", "mustard flour",
        # --- Dish/meal associations (often contains mustard) ---
        "vinaigrette", "coleslaw", "dhal",
    ],
    "Sesame": [
        # --- Direct forms ---
        "sesame", "tahini", "halva", "halvah",
        "sesame oil", "sesame seed", "sesame paste", "gomashio",
        # --- Dish/meal associations (often contains sesame) ---
        "hummus",  # tahini
        "falafel", "ramen", "gyoza", "spring roll",
        "sushi", "dim sum",
    ],
    "Sulphites": [
        # --- Chemical names ---
        "sulphite", "sulfite", "sulphur dioxide", "sulfur dioxide",
        "metabisulphite", "metabisulfite",
        # --- E numbers ---
        "e220", "e221", "e222", "e223", "e224", "e226", "e227", "e228",
        # --- Chemical salt forms ---
        "sodium sulphite", "sodium bisulphite", "potassium sulphite",
        "calcium sulphite", "potassium bisulphite",
        "sodium metabisulphite", "potassium metabisulphite",
        # --- Foods commonly containing sulphites ---
        "wine", "dried fruit", "vinegar", "cordial", "molasses",
        # --- Dish/meal associations ---
        "vinaigrette",
    ],
    "Lupin": [
        # --- Direct forms ---
        "lupin", "lupine", "lupini",
        "lupin flour", "lupin seed", "lupin bean",
    ],
}


async def migrate():
    async with engine.begin() as conn:
        # 1. Create allergen_keywords table
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS allergen_keywords (
                id SERIAL PRIMARY KEY,
                kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
                food_flag_id INTEGER NOT NULL REFERENCES food_flags(id) ON DELETE CASCADE,
                keyword VARCHAR(100) NOT NULL,
                is_default BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT uq_allergen_keywords_kit_flag_kw UNIQUE (kitchen_id, food_flag_id, keyword)
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_allergen_keywords_kitchen ON allergen_keywords(kitchen_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_allergen_keywords_flag ON allergen_keywords(food_flag_id)"
        ))
        print("+ Created allergen_keywords table")

        # 2. Add new columns to ingredients table
        for col_sql in [
            "ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS is_prepackaged BOOLEAN DEFAULT FALSE",
            "ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS product_ingredients TEXT",
            "ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS label_image_path VARCHAR(500)",
        ]:
            try:
                await conn.execute(text(col_sql))
            except Exception:
                pass
        print("+ Added is_prepackaged, product_ingredients, label_image_path columns to ingredients")

    # 3. Seed default keywords (separate transaction for safety)
    async with engine.begin() as conn:
        result = await conn.execute(text("SELECT id FROM kitchens"))
        kitchen_ids = [row[0] for row in result.fetchall()]

        for kid in kitchen_ids:
            seeded = 0
            for flag_name, keywords in ALLERGEN_KEYWORDS.items():
                # Find the food_flag by name for this kitchen
                flag_result = await conn.execute(text(
                    "SELECT id FROM food_flags WHERE kitchen_id = :kid AND name = :name LIMIT 1"
                ), {"kid": kid, "name": flag_name})
                flag_row = flag_result.fetchone()
                if not flag_row:
                    continue
                flag_id = flag_row[0]

                for kw in keywords:
                    await conn.execute(text("""
                        INSERT INTO allergen_keywords (kitchen_id, food_flag_id, keyword, is_default, created_at)
                        VALUES (:kid, :fid, :kw, TRUE, NOW())
                        ON CONFLICT (kitchen_id, food_flag_id, keyword) DO NOTHING
                    """), {"kid": kid, "fid": flag_id, "kw": kw.lower()})
                    seeded += 1

            print(f"  Kitchen {kid}: seeded up to {seeded} allergen keywords")

    print("+ Allergen keywords migration complete")


if __name__ == "__main__":
    print("Running migration: add_allergen_keywords")
    asyncio.run(migrate())
    print("Migration complete!")
