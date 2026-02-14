"""
Ingredient Library API — categories, ingredients, sources, auto-price, duplicate detection.
"""
import logging
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text, and_, or_, delete
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, field_serializer

from database import get_db
from models.user import User
from models.ingredient import Ingredient, IngredientCategory, IngredientSource, IngredientFlag
from models.food_flag import FoodFlag
from models.line_item import LineItem
from models.invoice import Invoice
from models.supplier import Supplier
from auth.jwt import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

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

class IngredientUpdate(BaseModel):
    name: Optional[str] = None
    category_id: Optional[int] = None
    standard_unit: Optional[str] = None
    yield_percent: Optional[float] = None
    manual_price: Optional[float] = None
    notes: Optional[str] = None
    is_archived: Optional[bool] = None

class SourceCreate(BaseModel):
    supplier_id: int
    product_code: Optional[str] = None
    description_pattern: Optional[str] = None
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None

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
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    latest_unit_price: Optional[float] = None
    latest_invoice_date: Optional[str] = None
    price_per_std_unit: Optional[float] = None

    @field_serializer('latest_invoice_date')
    def ser_date(self, v):
        return str(v) if v else None

    class Config:
        from_attributes = True

class FlagResponse(BaseModel):
    id: int
    food_flag_id: int
    flag_name: str = ""
    flag_code: Optional[str] = None
    category_name: str = ""
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
    source_count: int = 0
    effective_price: Optional[float] = None
    flags: list[FlagResponse] = []
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
    effective_price = None
    if ing.sources:
        # Find source with most recent price
        priced_sources = [s for s in ing.sources if s.price_per_std_unit is not None]
        if priced_sources:
            latest = max(priced_sources, key=lambda s: s.latest_invoice_date or date.min)
            raw_price = float(latest.price_per_std_unit)
            yield_pct = float(ing.yield_percent) if ing.yield_percent else 100.0
            effective_price = raw_price / (yield_pct / 100) if yield_pct > 0 else raw_price
    if effective_price is None and ing.manual_price:
        yield_pct = float(ing.yield_percent) if ing.yield_percent else 100.0
        effective_price = float(ing.manual_price) / (yield_pct / 100) if yield_pct > 0 else float(ing.manual_price)

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
        source_count=source_count or (len(ing.sources) if ing.sources else 0),
        effective_price=round(effective_price, 6) if effective_price else None,
        flags=flag_list,
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
        )
        .where(Ingredient.kitchen_id == user.kitchen_id)
    )
    if not archived:
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
        created_by=user.id,
    )
    db.add(ing)
    await db.commit()
    await db.refresh(ing, ["category", "sources", "flags"])
    return _build_ingredient_response(ing)


@router.get("/suggest")
async def suggest_ingredients(
    description: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Suggest existing ingredient matches for a line item description using pg_trgm."""
    result = await db.execute(
        text("""
            SELECT id, name, similarity(name, :desc) AS sim
            FROM ingredients
            WHERE kitchen_id = :kid AND similarity(name, :desc) > 0.2
            ORDER BY sim DESC
            LIMIT 8
        """),
        {"desc": description, "kid": user.kitchen_id},
    )
    rows = result.fetchall()
    return SuggestResponse(
        suggestions=[
            SimilarIngredient(id=r.id, name=r.name, similarity=round(r.sim, 3))
            for r in rows
        ]
    )


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
        )
        .where(Ingredient.id == ingredient_id, Ingredient.kitchen_id == user.kitchen_id)
    )
    ing = result.scalar_one_or_none()
    if not ing:
        raise HTTPException(404, "Ingredient not found")
    return _build_ingredient_response(ing)


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

    await db.commit()
    await db.refresh(ing, ["category", "sources", "flags"])
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

    # Calculate price_per_std_unit if pack data provided
    price_per_std = None
    # We'll set price when line items match

    source = IngredientSource(
        kitchen_id=user.kitchen_id,
        ingredient_id=ingredient_id,
        supplier_id=data.supplier_id,
        product_code=data.product_code,
        description_pattern=data.description_pattern,
        pack_quantity=data.pack_quantity,
        unit_size=Decimal(str(data.unit_size)) if data.unit_size else None,
        unit_size_type=data.unit_size_type,
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)

    # Load supplier name
    sup = await db.execute(select(Supplier).where(Supplier.id == data.supplier_id))
    supplier = sup.scalar_one_or_none()

    return SourceResponse(
        id=source.id,
        supplier_id=source.supplier_id,
        supplier_name=supplier.name if supplier else "",
        product_code=source.product_code,
        description_pattern=source.description_pattern,
        pack_quantity=source.pack_quantity,
        unit_size=float(source.unit_size) if source.unit_size else None,
        unit_size_type=source.unit_size_type,
        latest_unit_price=None,
        latest_invoice_date=None,
        price_per_std_unit=None,
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

    await db.commit()
    return {"ok": True}


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

    await db.commit()
    return {"ok": True}


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

    updated_ingredient_ids = set()

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
                matched_source.price_per_std_unit = calc_price_per_std_unit(
                    li.unit_price,
                    matched_source.pack_quantity,
                    matched_source.unit_size,
                    matched_source.unit_size_type,
                    ingredient.standard_unit,
                )
                updated_ingredient_ids.add(ingredient.id)

            # Set line_item.ingredient_id
            if not li.ingredient_id:
                li.ingredient_id = matched_source.ingredient_id

    return updated_ingredient_ids
