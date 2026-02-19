"""
Ingredient Library API — categories, ingredients, sources, auto-price, duplicate detection.
"""
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text, and_, or_, delete, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.ingredient import Ingredient, IngredientCategory, IngredientSource, IngredientFlag, IngredientFlagNone, IngredientFlagDismissal
from models.food_flag import FoodFlag, FoodFlagCategory
from models.line_item import LineItem
from models.invoice import Invoice
from models.supplier import Supplier
from models.recipe import Recipe, RecipeIngredient, RecipeSubRecipe
from auth.jwt import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


async def _bump_recipes_using_ingredient(ingredient_id: int, db: AsyncSession):
    """Bump updated_at on all recipes (and their parents) that use this ingredient,
    so menu staleness detection picks up allergen flag changes."""
    ri_result = await db.execute(
        select(RecipeIngredient.recipe_id).where(RecipeIngredient.ingredient_id == ingredient_id)
    )
    recipe_ids = set(r[0] for r in ri_result.fetchall())
    # Also parent recipes (1 level up)
    for rid in list(recipe_ids):
        parent_result = await db.execute(
            select(RecipeSubRecipe.parent_recipe_id).where(RecipeSubRecipe.child_recipe_id == rid)
        )
        for (parent_id,) in parent_result.fetchall():
            recipe_ids.add(parent_id)
    if recipe_ids:
        now = datetime.utcnow()
        for rid in recipe_ids:
            r = await db.execute(select(Recipe).where(Recipe.id == rid))
            recipe = r.scalar_one_or_none()
            if recipe:
                recipe.updated_at = now
        await db.commit()


# ── Unit conversion constants ────────────────────────────────────────────────

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


def convert_to_standard(value: Decimal, from_unit: str, standard_unit: str) -> Optional[Decimal]:
    """Convert a value from from_unit to standard_unit. Returns None if incompatible."""
    from_unit = from_unit.lower().strip()
    standard_unit = standard_unit.lower().strip()
    if from_unit == standard_unit:
        return value
    conversions = UNIT_CONVERSIONS.get(from_unit, {})
    factor = conversions.get(standard_unit)
    if factor is None:
        return None
    return value * Decimal(str(factor))


def calc_price_per_std_unit(
    unit_price: Decimal,
    pack_quantity: Optional[int],
    unit_size: Optional[Decimal],
    unit_size_type: Optional[str],
    standard_unit: str
) -> Optional[Decimal]:
    """Calculate price per standard unit from source pack data."""
    if not unit_price or not pack_quantity or not unit_size or not unit_size_type:
        return None
    total_in_source_unit = Decimal(str(pack_quantity)) * unit_size
    total_in_std = convert_to_standard(total_in_source_unit, unit_size_type, standard_unit)
    if not total_in_std or total_in_std == 0:
        return None
    return unit_price / total_in_std


def normalize_description(text: str | None) -> str:
    """Normalize description for matching — lowercase, collapse whitespace, strip."""
    if not text:
        return ""
    return " ".join(text.lower().strip().split())


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str
    sort_order: int = 0

class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

class CategoryResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    ingredient_count: int = 0
    class Config:
        from_attributes = True

class IngredientCreate(BaseModel):
    name: str
    category_id: Optional[int] = None
    standard_unit: str = "g"
    yield_percent: float = 100.0
    manual_price: Optional[float] = None
    notes: Optional[str] = None
    is_prepackaged: bool = False
    is_free: bool = False
    product_ingredients: Optional[str] = None

class IngredientUpdate(BaseModel):
    name: Optional[str] = None
    category_id: Optional[int] = None
    standard_unit: Optional[str] = None
    yield_percent: Optional[float] = None
    manual_price: Optional[float] = None
    notes: Optional[str] = None
    is_archived: Optional[bool] = None
    is_prepackaged: Optional[bool] = None
    is_free: Optional[bool] = None
    product_ingredients: Optional[str] = None

class SourceCreate(BaseModel):
    supplier_id: int
    product_code: Optional[str] = None
    description_pattern: Optional[str] = None
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    latest_unit_price: Optional[float] = None
    invoice_id: Optional[int] = None
    apply_to_existing: bool = False  # Bulk-set ingredient_id on matching line items

class SourceUpdate(BaseModel):
    product_code: Optional[str] = None
    description_pattern: Optional[str] = None
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None

class SourceResponse(BaseModel):
    id: int
    supplier_id: int
    supplier_name: str = ""
    product_code: Optional[str] = None
    description_pattern: Optional[str] = None
    description_aliases: list[str] = []
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    latest_unit_price: Optional[float] = None
    latest_invoice_date: Optional[date] = None
    price_per_std_unit: Optional[float] = None
    matched_line_items: Optional[int] = None  # Count of line items bulk-updated
    backfilled_count: Optional[int] = None  # Count of line items with product codes backfilled

    class Config:
        from_attributes = True

class FlagResponse(BaseModel):
    id: int
    food_flag_id: int
    flag_name: str = ""
    flag_code: Optional[str] = None
    category_name: str = ""
    propagation_type: str = "contains"
    source: str = "manual"

class IngredientResponse(BaseModel):
    id: int
    name: str
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    standard_unit: str
    yield_percent: float
    manual_price: Optional[float] = None
    notes: Optional[str] = None
    is_archived: bool = False
    flags_assessed: bool = False
    is_prepackaged: bool = False
    is_free: bool = False
    product_ingredients: Optional[str] = None
    has_label_image: bool = False
    source_count: int = 0
    effective_price: Optional[float] = None
    flags: list[FlagResponse] = []
    none_categories: list[str] = []
    created_at: str = ""

    class Config:
        from_attributes = True

class SimilarIngredient(BaseModel):
    id: int
    name: str
    similarity: float

class SuggestResponse(BaseModel):
    suggestions: list[SimilarIngredient]


# ── Category endpoints ───────────────────────────────────────────────────────

DEFAULT_INGREDIENT_CATEGORIES = [
    ("Dairy", 0), ("Meat", 1), ("Seafood", 2), ("Produce", 3),
    ("Dry Goods", 4), ("Canned & Jarred", 5), ("Frozen Goods", 6),
    ("Oils & Fats", 7), ("Herbs & Spices", 7), ("Bakery", 8),
    ("Beverages", 9), ("Condiments", 11), ("Other", 12),
]


@router.post("/categories/seed-defaults")
async def seed_default_categories(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Seed default ingredient categories. Skips any that already exist by name."""
    kid = user.kitchen_id
    created = 0
    for name, sort_order in DEFAULT_INGREDIENT_CATEGORIES:
        exists = await db.execute(
            select(IngredientCategory).where(
                IngredientCategory.kitchen_id == kid,
                IngredientCategory.name == name,
            )
        )
        if exists.scalar_one_or_none():
            continue
        db.add(IngredientCategory(kitchen_id=kid, name=name, sort_order=sort_order))
        created += 1
    await db.commit()
    return {"ok": True, "created": created}


@router.get("/categories")
async def list_categories(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Count ingredients per category
    count_sub = (
        select(Ingredient.category_id, func.count(Ingredient.id).label("cnt"))
        .where(Ingredient.kitchen_id == user.kitchen_id)
        .group_by(Ingredient.category_id)
        .subquery()
    )
    result = await db.execute(
        select(IngredientCategory, func.coalesce(count_sub.c.cnt, 0).label("ingredient_count"))
        .outerjoin(count_sub, IngredientCategory.id == count_sub.c.category_id)
        .where(IngredientCategory.kitchen_id == user.kitchen_id)
        .order_by(IngredientCategory.sort_order, IngredientCategory.name)
    )
    rows = result.all()
    return [
        CategoryResponse(id=cat.id, name=cat.name, sort_order=cat.sort_order, ingredient_count=cnt)
        for cat, cnt in rows
    ]


@router.post("/categories")
async def create_category(
    data: CategoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cat = IngredientCategory(kitchen_id=user.kitchen_id, name=data.name, sort_order=data.sort_order)
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return CategoryResponse(id=cat.id, name=cat.name, sort_order=cat.sort_order)


@router.patch("/categories/{category_id}")
async def update_category(
    category_id: int,
    data: CategoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientCategory).where(
            IngredientCategory.id == category_id,
            IngredientCategory.kitchen_id == user.kitchen_id,
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    if data.name is not None:
        cat.name = data.name
    if data.sort_order is not None:
        cat.sort_order = data.sort_order
    await db.commit()
    return CategoryResponse(id=cat.id, name=cat.name, sort_order=cat.sort_order)


@router.delete("/categories/{category_id}")
async def delete_category(
    category_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientCategory).where(
            IngredientCategory.id == category_id,
            IngredientCategory.kitchen_id == user.kitchen_id,
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    # Null out ingredients in this category
    await db.execute(
        select(Ingredient).where(Ingredient.category_id == category_id)
    )
    from sqlalchemy import update
    await db.execute(
        update(Ingredient).where(Ingredient.category_id == category_id).values(category_id=None)
    )
    await db.delete(cat)
    await db.commit()
    return {"ok": True}


# ── Ingredient endpoints ─────────────────────────────────────────────────────

def _build_ingredient_response(ing: Ingredient, source_count: int = 0, flags: list = None) -> IngredientResponse:
    """Build a response dict from an Ingredient model instance."""
    # Calculate effective price from most recent source or manual_price
    # (yield is now per recipe-ingredient use, not per raw ingredient)
    effective_price = None
    if ing.sources:
        priced_sources = [s for s in ing.sources if s.price_per_std_unit is not None]
        if priced_sources:
            latest = max(priced_sources, key=lambda s: s.latest_invoice_date or date.min)
            effective_price = float(latest.price_per_std_unit)
    if effective_price is None and ing.manual_price:
        effective_price = float(ing.manual_price)

    flag_list = []
    if flags:
        flag_list = flags
    elif hasattr(ing, 'flags') and ing.flags:
        flag_list = [
            FlagResponse(
                id=f.id,
                food_flag_id=f.food_flag_id,
                flag_name=f.food_flag.name if f.food_flag else "",
                flag_code=f.food_flag.code if f.food_flag else None,
                category_name=f.food_flag.category.name if f.food_flag and f.food_flag.category else "",
                propagation_type=f.food_flag.category.propagation_type if f.food_flag and f.food_flag.category else "contains",
                source=f.source,
            )
            for f in ing.flags
        ]

    return IngredientResponse(
        id=ing.id,
        name=ing.name,
        category_id=ing.category_id,
        category_name=ing.category.name if ing.category else None,
        standard_unit=ing.standard_unit,
        yield_percent=float(ing.yield_percent) if ing.yield_percent else 100.0,
        manual_price=float(ing.manual_price) if ing.manual_price else None,
        notes=ing.notes,
        is_archived=ing.is_archived,
        flags_assessed=ing.flags_assessed if hasattr(ing, 'flags_assessed') else False,
        is_prepackaged=ing.is_prepackaged if hasattr(ing, 'is_prepackaged') else False,
        is_free=ing.is_free if hasattr(ing, 'is_free') else False,
        product_ingredients=ing.product_ingredients if hasattr(ing, 'product_ingredients') else None,
        has_label_image=bool(ing.label_image_path) if hasattr(ing, 'label_image_path') else False,
        source_count=source_count or (len(ing.sources) if ing.sources else 0),
        effective_price=round(effective_price, 6) if effective_price else None,
        flags=flag_list,
        none_categories=[
            fn.category.name for fn in ing.flag_nones if fn.category
        ] if hasattr(ing, 'flag_nones') and ing.flag_nones else [],
        created_at=str(ing.created_at) if ing.created_at else "",
    )


@router.get("")
async def list_ingredients(
    unmapped: bool = Query(False, description="Filter to ingredients with no sources"),
    archived: bool = Query(False, description="Include archived ingredients"),
    category_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Ingredient)
        .options(
            selectinload(Ingredient.category),
            selectinload(Ingredient.sources),
            selectinload(Ingredient.flags).selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category),
            selectinload(Ingredient.flag_nones).selectinload(IngredientFlagNone.category),
        )
        .where(Ingredient.kitchen_id == user.kitchen_id)
    )
    if archived:
        query = query.where(Ingredient.is_archived == True)
    else:
        query = query.where(Ingredient.is_archived == False)
    if category_id:
        query = query.where(Ingredient.category_id == category_id)
    if search:
        query = query.where(Ingredient.name.ilike(f"%{search}%"))

    result = await db.execute(query.order_by(Ingredient.name))
    ingredients = result.scalars().all()

    responses = [_build_ingredient_response(ing) for ing in ingredients]

    if unmapped:
        responses = [r for r in responses if r.source_count == 0]

    return responses


@router.post("/")
@router.post("")
async def create_ingredient(
    data: IngredientCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Check for exact duplicate name
    existing = await db.execute(
        select(Ingredient).where(
            Ingredient.kitchen_id == user.kitchen_id,
            func.lower(Ingredient.name) == data.name.lower().strip(),
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, f"Ingredient '{data.name}' already exists")

    ing = Ingredient(
        kitchen_id=user.kitchen_id,
        name=data.name.strip(),
        category_id=data.category_id,
        standard_unit=data.standard_unit,
        yield_percent=Decimal(str(data.yield_percent)),
        manual_price=Decimal(str(data.manual_price)) if data.manual_price else None,
        notes=data.notes,
        is_prepackaged=data.is_prepackaged,
        is_free=data.is_free,
        product_ingredients=data.product_ingredients,
        created_by=user.id,
    )
    db.add(ing)
    await db.commit()
    # Re-query with full eager loading to avoid lazy-load in async context
    result2 = await db.execute(
        select(Ingredient)
        .options(
            selectinload(Ingredient.category),
            selectinload(Ingredient.sources),
            selectinload(Ingredient.flags).selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category),
            selectinload(Ingredient.flag_nones).selectinload(IngredientFlagNone.category),
        )
        .where(Ingredient.id == ing.id)
    )
    ing = result2.scalar_one()
    return _build_ingredient_response(ing)


@router.get("/suggest")
async def suggest_ingredients(
    description: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Suggest existing ingredient matches for a line item description using pg_trgm + ILIKE fallback."""
    result = await db.execute(
        text("""
            SELECT i.id, i.name, i.standard_unit, i.yield_percent,
                   ic.name AS category_name,
                   similarity(i.name, :desc) AS sim
            FROM ingredients i
            LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
            WHERE i.kitchen_id = :kid
              AND i.is_archived = false
              AND (similarity(i.name, :desc) > 0.15 OR i.name ILIKE :like)
            ORDER BY sim DESC
            LIMIT 8
        """),
        {"desc": description, "kid": user.kitchen_id, "like": f"%{description}%"},
    )
    rows = result.fetchall()
    return [
        {
            "id": r.id,
            "name": r.name,
            "standard_unit": r.standard_unit,
            "yield_percent": float(r.yield_percent),
            "category_name": r.category_name,
            "similarity": round(r.sim, 3),
        }
        for r in rows
    ]


@router.get("/check-duplicate")
async def check_duplicate(
    name: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check for similar ingredient names before creation (pg_trgm)."""
    result = await db.execute(
        text("""
            SELECT id, name, similarity(name, :name) AS sim
            FROM ingredients
            WHERE kitchen_id = :kid AND similarity(name, :name) > 0.3
            ORDER BY sim DESC
            LIMIT 5
        """),
        {"name": name, "kid": user.kitchen_id},
    )
    rows = result.fetchall()
    return [
        SimilarIngredient(id=r.id, name=r.name, similarity=round(r.sim, 3))
        for r in rows
    ]


@router.get("/bulk-nones")
async def get_bulk_nones(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all 'None' category entries for all ingredients in the kitchen (for bulk allergen grid)."""
    result = await db.execute(
        select(IngredientFlagNone.ingredient_id, IngredientFlagNone.category_id)
        .join(Ingredient, Ingredient.id == IngredientFlagNone.ingredient_id)
        .where(Ingredient.kitchen_id == user.kitchen_id)
    )
    nones = {}
    for ing_id, cat_id in result.all():
        if ing_id not in nones:
            nones[ing_id] = []
        nones[ing_id].append(cat_id)
    return nones


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
# These must be defined BEFORE /{ingredient_id} to avoid path parameter conflicts
@router.get("/ai-match")
async def ai_match_ingredient(
    description: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI-powered ingredient matching when trigram confidence is low."""
    from services.llm_service import rank_ingredient_matches

    # First get trigram candidates
    trgm_result = await db.execute(
        text("""
            SELECT i.id, i.name, i.standard_unit,
                   ic.name AS category_name,
                   similarity(i.name, :desc) AS sim
            FROM ingredients i
            LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
            WHERE i.kitchen_id = :kid
              AND i.is_archived = false
              AND (similarity(i.name, :desc) > 0.1 OR i.name ILIKE :like)
            ORDER BY sim DESC
            LIMIT 20
        """),
        {"desc": description, "kid": user.kitchen_id, "like": f"%{description}%"},
    )
    candidates = [
        {"id": r.id, "name": r.name, "standard_unit": r.standard_unit,
         "category_name": r.category_name, "similarity": round(r.sim, 3)}
        for r in trgm_result.fetchall()
    ]

    if not candidates:
        return {"llm_status": "unavailable", "ranked": [], "error": None}

    result = await rank_ingredient_matches(
        db=db,
        kitchen_id=user.kitchen_id,
        description=description,
        candidates=candidates,
    )

    return {
        "llm_status": result["status"],
        "ranked": result.get("ranked") or [],
        "trigram_candidates": candidates,
        "error": result.get("error"),
    }


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
@router.get("/ai-check-duplicate")
async def ai_check_duplicate(
    name: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI-powered semantic duplicate detection for new ingredient names."""
    from services.llm_service import check_duplicate_ingredient_llm

    # Get top trigram matches
    trgm_result = await db.execute(
        text("""
            SELECT id, name, similarity(name, :name) AS sim
            FROM ingredients
            WHERE kitchen_id = :kid AND similarity(name, :name) > 0.15
            ORDER BY sim DESC
            LIMIT 30
        """),
        {"name": name, "kid": user.kitchen_id},
    )
    existing = [
        {"id": r.id, "name": r.name, "similarity": round(r.sim, 3)}
        for r in trgm_result.fetchall()
    ]

    if not existing:
        return {"llm_status": "unavailable", "duplicates": [], "error": None}

    result = await check_duplicate_ingredient_llm(
        db=db,
        kitchen_id=user.kitchen_id,
        name=name,
        existing_ingredients=existing,
    )

    return {
        "llm_status": result["status"],
        "duplicates": result.get("duplicates") or [],
        "error": result.get("error"),
    }


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
# Feature G: AI yield estimation
@router.get("/ai-estimate-yield")
async def ai_estimate_yield(
    name: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AI-powered yield percentage estimation for an ingredient name."""
    from services.llm_service import estimate_yield

    result = await estimate_yield(
        db=db,
        kitchen_id=user.kitchen_id,
        ingredient_name=name,
    )

    return {
        "llm_status": result["status"],
        "yield_percent": result.get("yield_percent"),
        "reason": result.get("reason"),
        "error": result.get("error"),
    }


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
@router.get("/ai-pack-size")
async def ai_deduce_pack_size_from_description(
    description: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Deduce pack size from a product description.
    Tier 1: regex parse. Tier 2: LLM product knowledge fallback.
    Used by IngredientModal when creating ingredients from line items.
    """
    from ocr.azure_extractor import parse_pack_size

    # Tier 1: Regex (free, instant)
    parsed = parse_pack_size(description)
    if parsed["pack_quantity"]:
        return {
            "source": "regex",
            "pack_quantity": parsed["pack_quantity"],
            "unit_size": parsed["unit_size"],
            "unit_size_type": parsed["unit_size_type"],
            "reason": "Parsed from description",
        }

    # Tier 2: LLM deduction
    from services.llm_service import deduce_pack_size
    llm_result = await deduce_pack_size(
        db=db,
        kitchen_id=user.kitchen_id,
        description=description,
    )

    if llm_result["status"] in ("success", "cached") and llm_result["pack_quantity"]:
        return {
            "source": "ai",
            "pack_quantity": llm_result["pack_quantity"],
            "unit_size": llm_result["unit_size"],
            "unit_size_type": llm_result["unit_size_type"],
            "reason": llm_result.get("reason", "AI deduction"),
        }

    return {
        "source": None,
        "pack_quantity": None,
        "unit_size": None,
        "unit_size_type": None,
        "reason": llm_result.get("error") or "Could not determine pack size",
    }


@router.get("/{ingredient_id}")
async def get_ingredient(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Ingredient)
        .options(
            selectinload(Ingredient.category),
            selectinload(Ingredient.sources).selectinload(IngredientSource.supplier),
            selectinload(Ingredient.flags).selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category),
            selectinload(Ingredient.flag_nones).selectinload(IngredientFlagNone.category),
        )
        .where(Ingredient.id == ingredient_id, Ingredient.kitchen_id == user.kitchen_id)
    )
    ing = result.scalar_one_or_none()
    if not ing:
        raise HTTPException(404, "Ingredient not found")
    return _build_ingredient_response(ing)


@router.get("/{ingredient_id}/label-image")
async def get_label_image(
    ingredient_id: int,
    token: str,
    db: AsyncSession = Depends(get_db),
):
    """Serve the stored label image for a prepackaged ingredient.
    Uses token query param for auth (allows window.open / img src usage)."""
    import os
    from auth.jwt import get_current_user_from_token
    user = await get_current_user_from_token(token, db)
    if not user:
        raise HTTPException(401, "Not authenticated")
    result = await db.execute(
        select(Ingredient.label_image_path).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    label_path = result.scalar_one_or_none()
    if not label_path or not os.path.exists(label_path):
        raise HTTPException(404, "Label image not found")
    return FileResponse(label_path)


@router.patch("/{ingredient_id}")
async def update_ingredient(
    ingredient_id: int,
    data: IngredientUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Ingredient)
        .options(selectinload(Ingredient.category), selectinload(Ingredient.sources))
        .where(Ingredient.id == ingredient_id, Ingredient.kitchen_id == user.kitchen_id)
    )
    ing = result.scalar_one_or_none()
    if not ing:
        raise HTTPException(404, "Ingredient not found")

    if data.name is not None:
        ing.name = data.name.strip()
    if data.category_id is not None:
        ing.category_id = data.category_id
    if data.standard_unit is not None:
        ing.standard_unit = data.standard_unit
    if data.yield_percent is not None:
        ing.yield_percent = Decimal(str(data.yield_percent))
    if data.manual_price is not None:
        ing.manual_price = Decimal(str(data.manual_price))
    if data.notes is not None:
        ing.notes = data.notes
    if data.is_archived is not None:
        ing.is_archived = data.is_archived
    if data.is_prepackaged is not None:
        ing.is_prepackaged = data.is_prepackaged
    if data.is_free is not None:
        ing.is_free = data.is_free
    if data.product_ingredients is not None:
        ing.product_ingredients = data.product_ingredients

    await db.commit()
    # Re-query with full eager loading to avoid lazy-load in async context
    result2 = await db.execute(
        select(Ingredient)
        .options(
            selectinload(Ingredient.category),
            selectinload(Ingredient.sources),
            selectinload(Ingredient.flags).selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category),
            selectinload(Ingredient.flag_nones).selectinload(IngredientFlagNone.category),
        )
        .where(Ingredient.id == ing.id)
    )
    ing = result2.scalar_one()
    return _build_ingredient_response(ing)


@router.delete("/{ingredient_id}")
async def archive_ingredient(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    ing = result.scalar_one_or_none()
    if not ing:
        raise HTTPException(404, "Ingredient not found")
    ing.is_archived = True
    await db.commit()
    return {"ok": True}


# ── Backfill helper ───────────────────────────────────────────────────────────

async def backfill_product_codes_for_source(
    source: IngredientSource,
    kitchen_id: int,
    db: AsyncSession,
) -> int:
    """
    For a source that has both product_code and description_pattern,
    find line items from same supplier where product_code IS NULL and
    first line of description matches, then set their product_code and ingredient_id.
    Returns count of updated line items.
    """
    if not source.product_code or not source.description_pattern:
        return 0

    norm_pattern = normalize_description(source.description_pattern)
    if not norm_pattern:
        return 0

    # Find line items from same supplier with no product_code where first-line description matches
    result = await db.execute(
        text("""
            UPDATE line_items li
            SET product_code = :code,
                ingredient_id = COALESCE(li.ingredient_id, :ing_id)
            FROM invoices inv
            WHERE li.invoice_id = inv.id
              AND inv.kitchen_id = :kid
              AND inv.supplier_id = :sid
              AND (li.product_code IS NULL OR li.product_code = '')
              AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = LOWER(:pattern)
        """),
        {
            "code": source.product_code,
            "ing_id": source.ingredient_id,
            "kid": kitchen_id,
            "sid": source.supplier_id,
            "pattern": norm_pattern,
        },
    )
    count = result.rowcount
    if count > 0:
        logger.info(f"Backfilled product_code '{source.product_code}' on {count} line items for source {source.id}")
    return count


# ── Source endpoints ──────────────────────────────────────────────────────────

@router.get("/{ingredient_id}/sources")
async def list_sources(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientSource)
        .options(selectinload(IngredientSource.supplier))
        .where(
            IngredientSource.ingredient_id == ingredient_id,
            IngredientSource.kitchen_id == user.kitchen_id,
        )
        .order_by(IngredientSource.created_at)
    )
    sources = result.scalars().all()
    return [
        SourceResponse(
            id=s.id,
            supplier_id=s.supplier_id,
            supplier_name=s.supplier.name if s.supplier else "",
            product_code=s.product_code,
            description_pattern=s.description_pattern,
            description_aliases=s.description_aliases or [],
            pack_quantity=s.pack_quantity,
            unit_size=float(s.unit_size) if s.unit_size else None,
            unit_size_type=s.unit_size_type,
            latest_unit_price=float(s.latest_unit_price) if s.latest_unit_price else None,
            latest_invoice_date=str(s.latest_invoice_date) if s.latest_invoice_date else None,
            price_per_std_unit=float(s.price_per_std_unit) if s.price_per_std_unit else None,
        )
        for s in sources
    ]


@router.post("/{ingredient_id}/sources")
async def create_source(
    ingredient_id: int,
    data: SourceCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify ingredient belongs to kitchen
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    # Validate: at least one of product_code or description_pattern required
    if not data.product_code and not data.description_pattern:
        raise HTTPException(400, "Either product_code or description_pattern is required")

    # Calculate price_per_std_unit if pack data and price provided
    price_per_std = None
    unit_conversions = {
        'g': {'g': 1, 'kg': 0.001}, 'kg': {'g': 1000, 'kg': 1}, 'oz': {'g': 28.3495, 'kg': 0.0283495},
        'ml': {'ml': 1, 'ltr': 0.001}, 'cl': {'ml': 10, 'ltr': 0.01}, 'ltr': {'ml': 1000, 'ltr': 1},
        'each': {'each': 1},
    }
    # Re-fetch ingredient for standard_unit
    ing_obj = await db.execute(
        select(Ingredient).where(Ingredient.id == ingredient_id, Ingredient.kitchen_id == user.kitchen_id)
    )
    ingredient = ing_obj.scalar_one_or_none()
    if data.latest_unit_price and data.unit_size and data.unit_size_type and ingredient:
        pq = data.pack_quantity or 1
        conv_factor = unit_conversions.get(data.unit_size_type, {}).get(ingredient.standard_unit, 0)
        if conv_factor:
            total_std = pq * data.unit_size * conv_factor
            price_per_std = Decimal(str(data.latest_unit_price)) / Decimal(str(total_std))

    # Get invoice date if invoice_id provided
    invoice_date = None
    if data.invoice_id:
        from models.invoice import Invoice
        inv_result = await db.execute(select(Invoice.invoice_date).where(Invoice.id == data.invoice_id))
        invoice_date = inv_result.scalar_one_or_none()

    # Check for existing source (upsert: update pack data if already mapped)
    existing_conditions = [
        IngredientSource.kitchen_id == user.kitchen_id,
        IngredientSource.ingredient_id == ingredient_id,
        IngredientSource.supplier_id == data.supplier_id,
    ]
    if data.product_code:
        existing_conditions.append(IngredientSource.product_code == data.product_code)
    else:
        existing_conditions.append(IngredientSource.product_code.is_(None))
        if data.description_pattern:
            existing_conditions.append(func.lower(IngredientSource.description_pattern) == data.description_pattern.lower())

    existing_src = await db.execute(select(IngredientSource).where(and_(*existing_conditions)))
    source = existing_src.scalar_one_or_none()

    if source:
        # Update existing source with new pack/price data
        source.pack_quantity = data.pack_quantity or 1
        if data.unit_size is not None:
            source.unit_size = Decimal(str(data.unit_size))
        if data.unit_size_type:
            source.unit_size_type = data.unit_size_type
        if data.latest_unit_price is not None:
            source.latest_unit_price = Decimal(str(data.latest_unit_price))
        if data.invoice_id:
            source.latest_invoice_id = data.invoice_id
        if invoice_date:
            source.latest_invoice_date = invoice_date
        if price_per_std is not None:
            source.price_per_std_unit = price_per_std
        await db.commit()
    else:
        source = IngredientSource(
            kitchen_id=user.kitchen_id,
            ingredient_id=ingredient_id,
            supplier_id=data.supplier_id,
            product_code=data.product_code,
            description_pattern=data.description_pattern,
            pack_quantity=data.pack_quantity or 1,
            unit_size=Decimal(str(data.unit_size)) if data.unit_size else None,
            unit_size_type=data.unit_size_type,
            latest_unit_price=Decimal(str(data.latest_unit_price)) if data.latest_unit_price else None,
            latest_invoice_id=data.invoice_id,
            latest_invoice_date=invoice_date,
            price_per_std_unit=price_per_std,
        )
        db.add(source)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(409, "This supplier product is already mapped to this ingredient")
    await db.refresh(source)

    # Bulk-set ingredient_id on matching line items if requested
    matched_count = None
    if data.apply_to_existing:
        match_conditions = [
            Invoice.kitchen_id == user.kitchen_id,
            Invoice.supplier_id == data.supplier_id,
            LineItem.invoice_id == Invoice.id,
            LineItem.ingredient_id.is_(None),
        ]
        if data.product_code:
            match_conditions.append(LineItem.product_code == data.product_code)
        elif data.description_pattern:
            match_conditions.append(
                func.lower(LineItem.description).contains(data.description_pattern.lower())
            )

        result = await db.execute(
            update(LineItem)
            .where(*match_conditions)
            .values(ingredient_id=ingredient_id)
        )
        matched_count = result.rowcount
        await db.commit()
        logger.info(f"Bulk-mapped {matched_count} line items to ingredient {ingredient_id}")

    # Auto-backfill product codes on line items with matching description but missing code
    backfilled = await backfill_product_codes_for_source(source, user.kitchen_id, db)
    if backfilled > 0:
        await db.commit()

    # Load supplier name
    sup = await db.execute(select(Supplier).where(Supplier.id == data.supplier_id))
    supplier = sup.scalar_one_or_none()

    return SourceResponse(
        id=source.id,
        supplier_id=source.supplier_id,
        supplier_name=supplier.name if supplier else "",
        product_code=source.product_code,
        description_pattern=source.description_pattern,
        description_aliases=source.description_aliases or [],
        pack_quantity=source.pack_quantity,
        unit_size=float(source.unit_size) if source.unit_size else None,
        unit_size_type=source.unit_size_type,
        latest_unit_price=float(source.latest_unit_price) if source.latest_unit_price else None,
        latest_invoice_date=source.latest_invoice_date,
        price_per_std_unit=float(source.price_per_std_unit) if source.price_per_std_unit else None,
        matched_line_items=matched_count,
        backfilled_count=backfilled if backfilled > 0 else None,
    )


@router.patch("/sources/{source_id}")
async def update_source(
    source_id: int,
    data: SourceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientSource).where(
            IngredientSource.id == source_id,
            IngredientSource.kitchen_id == user.kitchen_id,
        )
    )
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Source not found")

    if data.product_code is not None:
        source.product_code = data.product_code
    if data.description_pattern is not None:
        source.description_pattern = data.description_pattern
    if data.pack_quantity is not None:
        source.pack_quantity = data.pack_quantity
    if data.unit_size is not None:
        source.unit_size = Decimal(str(data.unit_size))
    if data.unit_size_type is not None:
        source.unit_size_type = data.unit_size_type

    # Recalculate price_per_std_unit if we have price and new pack data
    if source.latest_unit_price and source.pack_quantity and source.unit_size and source.unit_size_type:
        ing = await db.execute(select(Ingredient).where(Ingredient.id == source.ingredient_id))
        ingredient = ing.scalar_one_or_none()
        if ingredient:
            source.price_per_std_unit = calc_price_per_std_unit(
                source.latest_unit_price,
                source.pack_quantity,
                source.unit_size,
                source.unit_size_type,
                ingredient.standard_unit,
            )

    # Auto-backfill product codes if source has both code and description
    backfilled = await backfill_product_codes_for_source(source, user.kitchen_id, db)

    await db.commit()
    return {"ok": True, "backfilled_count": backfilled}


@router.delete("/sources/{source_id}")
async def delete_source(
    source_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientSource).where(
            IngredientSource.id == source_id,
            IngredientSource.kitchen_id == user.kitchen_id,
        )
    )
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Source not found")
    await db.delete(source)
    await db.commit()
    return {"ok": True}


# ── Description alias endpoints ───────────────────────────────────────────────

class AddAliasRequest(BaseModel):
    alias: str

class AliasSuggestionItem(BaseModel):
    description: str
    price: Optional[float] = None

class AliasSuggestionsRequest(BaseModel):
    supplier_id: int
    items: list[AliasSuggestionItem]

class BackfillCodesRequest(BaseModel):
    source_id: Optional[int] = None
    supplier_id: Optional[int] = None


@router.post("/sources/{source_id}/aliases")
async def add_description_alias(
    source_id: int,
    data: AddAliasRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a description alias to an ingredient source and normalize matching line items."""
    result = await db.execute(
        select(IngredientSource).where(
            IngredientSource.id == source_id,
            IngredientSource.kitchen_id == user.kitchen_id,
        )
    )
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(404, "Source not found")
    if not source.description_pattern:
        raise HTTPException(400, "Source has no description_pattern to normalize to")

    alias = data.alias.strip()
    if not alias:
        raise HTTPException(400, "Alias cannot be empty")

    # Add alias (case-insensitive dedup) — create new list for SQLAlchemy change detection
    current_aliases = list(source.description_aliases or [])
    if alias.lower() not in [a.lower() for a in current_aliases]:
        current_aliases.append(alias)
        source.description_aliases = current_aliases

    # Bulk-rename line items: same supplier, first line matches alias (case-insensitive)
    # 1. Save original description into description_alt (only if not already saved)
    # 2. Replace first line of description with master description_pattern
    # 3. Set ingredient_id
    # Also backfill product_code if source has one
    master = source.description_pattern
    code_clause = ", product_code = :code" if source.product_code else ""
    code_params = {"code": source.product_code} if source.product_code else {}

    rename_result = await db.execute(
        text(f"""
            UPDATE line_items li
            SET description = :master || CASE
                    WHEN position(E'\\n' IN li.description) > 0
                    THEN substring(li.description FROM position(E'\\n' IN li.description))
                    ELSE ''
                END,
                description_alt = CASE
                    WHEN li.description_alt IS NULL THEN li.description
                    ELSE li.description_alt
                END,
                ingredient_id = COALESCE(li.ingredient_id, :ing_id)
                {code_clause}
            FROM invoices inv
            WHERE li.invoice_id = inv.id
              AND inv.kitchen_id = :kid
              AND inv.supplier_id = :sid
              AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = LOWER(:alias)
        """),
        {
            "master": master,
            "ing_id": source.ingredient_id,
            "kid": user.kitchen_id,
            "sid": source.supplier_id,
            "alias": alias,
            **code_params,
        },
    )
    renamed_count = rename_result.rowcount

    await db.commit()
    logger.info(f"Added alias '{alias}' to source {source_id}, renamed {renamed_count} line items")

    return {"ok": True, "alias": alias, "renamed_count": renamed_count}


@router.post("/sources/alias-suggestions")
async def get_alias_suggestions(
    data: AliasSuggestionsRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Find close description matches for unmapped line items from a supplier."""
    # Load all ingredient sources for this supplier + kitchen
    src_result = await db.execute(
        select(IngredientSource)
        .options(selectinload(IngredientSource.ingredient))
        .where(
            IngredientSource.kitchen_id == user.kitchen_id,
            IngredientSource.supplier_id == data.supplier_id,
        )
    )
    sources = src_result.scalars().all()
    if not sources:
        return []

    # Build candidate list: (canonical_description, source)
    candidates = []
    known_patterns = set()  # All known patterns + aliases (lowered) for exact-match skip
    for s in sources:
        if s.description_pattern:
            norm = s.description_pattern.lower().strip()
            candidates.append((s.description_pattern, s))
            known_patterns.add(norm)
            for alias in (s.description_aliases or []):
                known_patterns.add(alias.lower().strip())

    if not candidates:
        return []

    suggestions = []
    for item in data.items:
        desc = item.description.strip()
        first_line = desc.split('\n')[0].strip()
        if not first_line:
            continue
        # Skip if already an exact match to a known pattern or alias
        if first_line.lower() in known_patterns:
            continue

        # Find best match using pg_trgm similarity
        best_match = None
        best_sim = 0.0
        for pattern, source in candidates:
            sim_result = await db.execute(
                text("SELECT similarity(:a, :b) AS sim"),
                {"a": first_line, "b": pattern},
            )
            sim = float(sim_result.scalar())
            if sim > best_sim and sim >= 0.3:
                best_sim = sim
                best_match = (pattern, source)

        if best_match:
            pattern, source = best_match
            # Calculate price difference if available
            price_diff = None
            if item.price and source.latest_unit_price:
                price_diff = round(
                    abs(item.price - float(source.latest_unit_price)) / float(source.latest_unit_price) * 100, 1
                )

            suggestions.append({
                "description": first_line,
                "source_id": source.id,
                "ingredient_id": source.ingredient_id,
                "ingredient_name": source.ingredient.name if source.ingredient else None,
                "canonical_description": pattern,
                "product_code": source.product_code,
                "similarity": round(best_sim, 3),
                "price_difference": price_diff,
            })

    # Sort by similarity descending
    suggestions.sort(key=lambda x: x["similarity"], reverse=True)
    return suggestions


@router.post("/sources/backfill-codes")
async def backfill_codes(
    data: BackfillCodesRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Retroactively fill in missing product codes on line items that match by description."""
    if not data.source_id and not data.supplier_id:
        raise HTTPException(400, "Provide either source_id or supplier_id")

    query = select(IngredientSource).where(
        IngredientSource.kitchen_id == user.kitchen_id,
        IngredientSource.product_code.isnot(None),
        IngredientSource.description_pattern.isnot(None),
    )
    if data.source_id:
        query = query.where(IngredientSource.id == data.source_id)
    if data.supplier_id:
        query = query.where(IngredientSource.supplier_id == data.supplier_id)

    result = await db.execute(query)
    sources = result.scalars().all()

    total_updated = 0
    for source in sources:
        count = await backfill_product_codes_for_source(source, user.kitchen_id, db)
        total_updated += count

    if total_updated > 0:
        await db.commit()

    return {"ok": True, "updated_count": total_updated}


# ── Flag endpoints (on ingredients) ──────────────────────────────────────────

@router.get("/{ingredient_id}/flags")
async def get_ingredient_flags(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(IngredientFlag)
        .options(selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category))
        .where(IngredientFlag.ingredient_id == ingredient_id)
    )
    flags = result.scalars().all()
    return [
        FlagResponse(
            id=f.id,
            food_flag_id=f.food_flag_id,
            flag_name=f.food_flag.name if f.food_flag else "",
            flag_code=f.food_flag.code if f.food_flag else None,
            category_name=f.food_flag.category.name if f.food_flag and f.food_flag.category else "",
            source=f.source,
        )
        for f in flags
    ]


class FlagSetRequest(BaseModel):
    food_flag_ids: list[int]


@router.put("/{ingredient_id}/flags")
async def set_ingredient_flags(
    ingredient_id: int,
    data: FlagSetRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full replacement of ingredient flags (manual source)."""
    # Verify ingredient
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    # Delete existing manual flags (keep latched ones)
    await db.execute(
        delete(IngredientFlag).where(
            IngredientFlag.ingredient_id == ingredient_id,
            IngredientFlag.source == "manual",
        )
    )

    # Add new flags
    for flag_id in data.food_flag_ids:
        # Check if latched flag already exists
        existing = await db.execute(
            select(IngredientFlag).where(
                IngredientFlag.ingredient_id == ingredient_id,
                IngredientFlag.food_flag_id == flag_id,
            )
        )
        if not existing.scalar_one_or_none():
            db.add(IngredientFlag(
                ingredient_id=ingredient_id,
                food_flag_id=flag_id,
                flagged_by=user.id,
                source="manual",
            ))

    # When flags are set for a category, remove any "None" entries for that category
    if data.food_flag_ids:
        # Get category IDs for the flags being set
        cat_result = await db.execute(
            select(FoodFlag.category_id).where(FoodFlag.id.in_(data.food_flag_ids)).distinct()
        )
        cat_ids = [r for r in cat_result.scalars().all()]
        if cat_ids:
            await db.execute(
                delete(IngredientFlagNone).where(
                    IngredientFlagNone.ingredient_id == ingredient_id,
                    IngredientFlagNone.category_id.in_(cat_ids),
                )
            )

    await db.commit()
    await _bump_recipes_using_ingredient(ingredient_id, db)
    return {"ok": True}


class FlagNoneRequest(BaseModel):
    category_id: int


@router.post("/{ingredient_id}/flags/none")
async def toggle_flag_none(
    ingredient_id: int,
    data: FlagNoneRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle 'None apply' for a specific flag category on an ingredient."""
    # Verify ingredient
    result = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not result.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    # Check if "None" already exists for this category
    existing = await db.execute(
        select(IngredientFlagNone).where(
            IngredientFlagNone.ingredient_id == ingredient_id,
            IngredientFlagNone.category_id == data.category_id,
        )
    )
    if existing.scalar_one_or_none():
        # Remove "None" (toggle off)
        await db.execute(
            delete(IngredientFlagNone).where(
                IngredientFlagNone.ingredient_id == ingredient_id,
                IngredientFlagNone.category_id == data.category_id,
            )
        )
    else:
        # Set "None" — also remove any actual flags from this category
        flag_ids_result = await db.execute(
            select(FoodFlag.id).where(FoodFlag.category_id == data.category_id)
        )
        flag_ids = [r for r in flag_ids_result.scalars().all()]
        if flag_ids:
            await db.execute(
                delete(IngredientFlag).where(
                    IngredientFlag.ingredient_id == ingredient_id,
                    IngredientFlag.food_flag_id.in_(flag_ids),
                )
            )
        db.add(IngredientFlagNone(
            ingredient_id=ingredient_id,
            category_id=data.category_id,
        ))

    await db.commit()
    await _bump_recipes_using_ingredient(ingredient_id, db)
    return {"ok": True}


@router.get("/{ingredient_id}/flags/nones")
async def get_flag_nones(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get category IDs where 'None' is set for an ingredient."""
    result = await db.execute(
        select(IngredientFlagNone.category_id).where(
            IngredientFlagNone.ingredient_id == ingredient_id,
        )
    )
    return {"none_category_ids": [r for r in result.scalars().all()]}


# ── Dismissal endpoints (allergen suggestion dismissals) ─────────────────────

class DismissalCreate(BaseModel):
    food_flag_id: int
    dismissed_by_name: str
    reason: Optional[str] = None
    matched_keyword: Optional[str] = None

class DismissalResponse(BaseModel):
    id: int
    ingredient_id: int
    food_flag_id: int
    flag_name: Optional[str] = None
    dismissed_by_name: str
    reason: Optional[str] = None
    matched_keyword: Optional[str] = None
    created_at: str = ""
    class Config:
        from_attributes = True

class DismissalBatchRequest(BaseModel):
    dismissals: list[DismissalCreate]


@router.get("/{ingredient_id}/flags/dismissals")
async def get_dismissals(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all dismissed allergen suggestions for an ingredient."""
    # Verify ingredient belongs to kitchen
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    result = await db.execute(
        select(IngredientFlagDismissal)
        .options(selectinload(IngredientFlagDismissal.food_flag))
        .where(IngredientFlagDismissal.ingredient_id == ingredient_id)
        .order_by(IngredientFlagDismissal.created_at.desc())
    )
    dismissals = result.scalars().all()
    return [
        DismissalResponse(
            id=d.id,
            ingredient_id=d.ingredient_id,
            food_flag_id=d.food_flag_id,
            flag_name=d.food_flag.name if d.food_flag else None,
            dismissed_by_name=d.dismissed_by_name,
            reason=d.reason,
            matched_keyword=d.matched_keyword,
            created_at=str(d.created_at) if d.created_at else "",
        )
        for d in dismissals
    ]


@router.post("/{ingredient_id}/flags/dismissals")
async def create_dismissal(
    ingredient_id: int,
    data: DismissalCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Dismiss an allergen suggestion for an ingredient (upsert)."""
    # Verify ingredient belongs to kitchen
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    # Upsert: check if already dismissed
    existing = await db.execute(
        select(IngredientFlagDismissal).where(
            IngredientFlagDismissal.ingredient_id == ingredient_id,
            IngredientFlagDismissal.food_flag_id == data.food_flag_id,
        )
    )
    dismissal = existing.scalar_one_or_none()
    if dismissal:
        # Update existing
        dismissal.dismissed_by_name = data.dismissed_by_name
        dismissal.reason = data.reason
        dismissal.matched_keyword = data.matched_keyword
    else:
        dismissal = IngredientFlagDismissal(
            ingredient_id=ingredient_id,
            food_flag_id=data.food_flag_id,
            dismissed_by_name=data.dismissed_by_name,
            reason=data.reason,
            matched_keyword=data.matched_keyword,
        )
        db.add(dismissal)

    await db.commit()
    await db.refresh(dismissal)
    return DismissalResponse(
        id=dismissal.id,
        ingredient_id=dismissal.ingredient_id,
        food_flag_id=dismissal.food_flag_id,
        dismissed_by_name=dismissal.dismissed_by_name,
        reason=dismissal.reason,
        matched_keyword=dismissal.matched_keyword,
        created_at=str(dismissal.created_at) if dismissal.created_at else "",
    )


@router.post("/{ingredient_id}/flags/dismissals/batch")
async def batch_create_dismissals(
    ingredient_id: int,
    data: DismissalBatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Batch persist dismissals (used after ingredient creation in create mode)."""
    # Verify ingredient belongs to kitchen
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    created = 0
    for d in data.dismissals:
        # Upsert each
        existing = await db.execute(
            select(IngredientFlagDismissal).where(
                IngredientFlagDismissal.ingredient_id == ingredient_id,
                IngredientFlagDismissal.food_flag_id == d.food_flag_id,
            )
        )
        if existing.scalar_one_or_none():
            continue  # Already dismissed, skip
        db.add(IngredientFlagDismissal(
            ingredient_id=ingredient_id,
            food_flag_id=d.food_flag_id,
            dismissed_by_name=d.dismissed_by_name,
            reason=d.reason,
            matched_keyword=d.matched_keyword,
        ))
        created += 1

    await db.commit()
    return {"ok": True, "created": created}


@router.delete("/{ingredient_id}/flags/dismissals/{dismissal_id}")
async def delete_dismissal(
    ingredient_id: int,
    dismissal_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Undo a dismissal (re-enables the suggestion)."""
    # Verify ingredient belongs to kitchen
    ing = await db.execute(
        select(Ingredient).where(
            Ingredient.id == ingredient_id,
            Ingredient.kitchen_id == user.kitchen_id,
        )
    )
    if not ing.scalar_one_or_none():
        raise HTTPException(404, "Ingredient not found")

    result = await db.execute(
        select(IngredientFlagDismissal).where(
            IngredientFlagDismissal.id == dismissal_id,
            IngredientFlagDismissal.ingredient_id == ingredient_id,
        )
    )
    dismissal = result.scalar_one_or_none()
    if not dismissal:
        raise HTTPException(404, "Dismissal not found")

    await db.delete(dismissal)
    await db.commit()
    return {"ok": True}


@router.get("/{ingredient_id}/recipes")
async def get_ingredient_recipes(
    ingredient_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get recipes that use this ingredient."""
    result = await db.execute(
        select(Recipe.id, Recipe.name, Recipe.recipe_type)
        .join(RecipeIngredient, RecipeIngredient.recipe_id == Recipe.id)
        .where(
            RecipeIngredient.ingredient_id == ingredient_id,
            Recipe.kitchen_id == user.kitchen_id,
            Recipe.is_archived == False,
        )
        .order_by(Recipe.name)
    )
    return [
        {"id": r.id, "name": r.name, "recipe_type": r.recipe_type}
        for r in result.all()
    ]


# ── Auto-normalize hook (called from invoices.py) ────────────────────────────

async def auto_normalize_line_items(
    invoice_id: int,
    kitchen_id: int,
    supplier_id: int,
    db: AsyncSession,
) -> int:
    """
    Auto-normalize line items on a new invoice:
    1. Fill missing product codes from sources with matching descriptions
    2. Rename descriptions that match known aliases to the master description
    Returns total count of line items modified.
    """
    # Load all sources for this supplier
    src_result = await db.execute(
        select(IngredientSource).where(
            IngredientSource.kitchen_id == kitchen_id,
            IngredientSource.supplier_id == supplier_id,
        )
    )
    sources = src_result.scalars().all()
    if not sources:
        return 0

    total_updated = 0

    # Pass 1: Fill missing product codes
    for source in sources:
        if source.product_code and source.description_pattern:
            norm_pattern = normalize_description(source.description_pattern)
            if not norm_pattern:
                continue
            result = await db.execute(
                text("""
                    UPDATE line_items li
                    SET product_code = :code,
                        ingredient_id = COALESCE(li.ingredient_id, :ing_id)
                    FROM invoices inv
                    WHERE li.invoice_id = :inv_id
                      AND li.invoice_id = inv.id
                      AND (li.product_code IS NULL OR li.product_code = '')
                      AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = LOWER(:pattern)
                """),
                {
                    "code": source.product_code,
                    "ing_id": source.ingredient_id,
                    "inv_id": invoice_id,
                    "pattern": norm_pattern,
                },
            )
            total_updated += result.rowcount

    # Pass 2: Rename alias descriptions to master
    for source in sources:
        if not source.description_pattern or not source.description_aliases:
            continue
        master = source.description_pattern
        code_clause = ", product_code = :code" if source.product_code else ""
        code_params = {"code": source.product_code} if source.product_code else {}

        for alias in source.description_aliases:
            result = await db.execute(
                text(f"""
                    UPDATE line_items li
                    SET description = :master || CASE
                            WHEN position(E'\\n' IN li.description) > 0
                            THEN substring(li.description FROM position(E'\\n' IN li.description))
                            ELSE ''
                        END,
                        description_alt = CASE
                            WHEN li.description_alt IS NULL THEN li.description
                            ELSE li.description_alt
                        END,
                        ingredient_id = COALESCE(li.ingredient_id, :ing_id)
                        {code_clause}
                    WHERE li.invoice_id = :inv_id
                      AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = LOWER(:alias)
                """),
                {
                    "master": master,
                    "ing_id": source.ingredient_id,
                    "inv_id": invoice_id,
                    "alias": alias,
                    **code_params,
                },
            )
            total_updated += result.rowcount

    # Pass 3: Fill missing product codes from sibling line items (same supplier + description)
    # This catches cases where no ingredient source exists yet but another invoice
    # from the same supplier has the product code for the same description.
    result = await db.execute(
        text("""
            UPDATE line_items li
            SET product_code = known.code
            FROM (
                SELECT DISTINCT ON (LOWER(TRIM(split_part(li2.description, E'\\n', 1))))
                    LOWER(TRIM(split_part(li2.description, E'\\n', 1))) AS norm_desc,
                    li2.product_code AS code
                FROM line_items li2
                JOIN invoices inv ON inv.id = li2.invoice_id
                WHERE inv.supplier_id = :sid
                  AND li2.product_code IS NOT NULL
                  AND li2.product_code != ''
                ORDER BY LOWER(TRIM(split_part(li2.description, E'\\n', 1))),
                         li2.id DESC
            ) known
            WHERE li.invoice_id = :inv_id
              AND (li.product_code IS NULL OR li.product_code = '')
              AND LOWER(TRIM(split_part(li.description, E'\\n', 1))) = known.norm_desc
        """),
        {"sid": supplier_id, "inv_id": invoice_id},
    )
    total_updated += result.rowcount

    if total_updated > 0:
        logger.info(f"Auto-normalized {total_updated} line items on invoice {invoice_id}")

    return total_updated


# ── Auto-price hook (called from invoices.py) ────────────────────────────────

async def update_ingredient_prices_for_invoice(
    invoice_id: int,
    kitchen_id: int,
    db: AsyncSession,
):
    """
    Called after line items are saved/updated for an invoice.
    Matches line items to ingredient sources and updates pricing.
    Also sets line_item.ingredient_id for matched items.
    """
    # Get invoice with supplier
    inv_result = await db.execute(
        select(Invoice).where(Invoice.id == invoice_id)
    )
    invoice = inv_result.scalar_one_or_none()
    if not invoice or not invoice.supplier_id:
        return

    supplier_id = invoice.supplier_id
    invoice_date = invoice.invoice_date

    # Get all line items for this invoice
    li_result = await db.execute(
        select(LineItem).where(LineItem.invoice_id == invoice_id)
    )
    line_items = li_result.scalars().all()

    # Get all ingredient sources for this supplier + kitchen
    src_result = await db.execute(
        select(IngredientSource)
        .where(
            IngredientSource.kitchen_id == kitchen_id,
            IngredientSource.supplier_id == supplier_id,
        )
    )
    sources = src_result.scalars().all()

    if not sources:
        return

    # Build lookup structures
    code_sources = {}  # product_code -> source
    desc_sources = []  # [(normalized_pattern, source)] sorted by length desc

    for s in sources:
        if s.product_code:
            code_sources[s.product_code.strip()] = s
        if s.description_pattern:
            desc_sources.append((normalize_description(s.description_pattern), s))

    # Sort description patterns by length descending (longer = more specific)
    desc_sources.sort(key=lambda x: len(x[0]), reverse=True)

    updated_ingredients = {}  # {ingredient_id: {"name": str, "old_price": float|None, "new_price": float}}

    for li in line_items:
        matched_source = None

        # Priority 1: product_code exact match
        if li.product_code and li.product_code.strip() in code_sources:
            matched_source = code_sources[li.product_code.strip()]

        # Priority 2: description_pattern contains match
        if not matched_source and li.description:
            norm_desc = normalize_description(li.description)
            for pattern, source in desc_sources:
                if pattern and pattern in norm_desc:
                    matched_source = source
                    break

        if matched_source and li.unit_price:
            # Update source price
            matched_source.latest_unit_price = li.unit_price
            matched_source.latest_invoice_id = invoice_id
            matched_source.latest_invoice_date = invoice_date

            # Get ingredient standard unit for conversion
            ing_result = await db.execute(
                select(Ingredient).where(Ingredient.id == matched_source.ingredient_id)
            )
            ingredient = ing_result.scalar_one_or_none()

            if ingredient and matched_source.pack_quantity and matched_source.unit_size and matched_source.unit_size_type:
                old_price = float(matched_source.price_per_std_unit) if matched_source.price_per_std_unit else None
                matched_source.price_per_std_unit = calc_price_per_std_unit(
                    li.unit_price,
                    matched_source.pack_quantity,
                    matched_source.unit_size,
                    matched_source.unit_size_type,
                    ingredient.standard_unit,
                )
                new_price = float(matched_source.price_per_std_unit) if matched_source.price_per_std_unit else None
                if new_price is not None:
                    updated_ingredients[ingredient.id] = {
                        "name": ingredient.name,
                        "unit": ingredient.standard_unit or "",
                        "old_price": old_price,
                        "new_price": new_price,
                    }

            # Set line_item.ingredient_id
            if not li.ingredient_id:
                li.ingredient_id = matched_source.ingredient_id

    return updated_ingredients
