"""
Event Order API — create event orders, add recipes × quantities,
generate aggregated shopping lists, and optionally create purchase orders.
"""
import logging
from datetime import date
from decimal import Decimal
from typing import Optional
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.event_order import EventOrder, EventOrderItem
from models.recipe import Recipe, RecipeIngredient, RecipeSubRecipe
from models.ingredient import Ingredient, IngredientSource, IngredientCategory
from models.supplier import Supplier
from auth.jwt import get_current_user
from api.ingredients import convert_to_standard, UNIT_CONVERSIONS

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class EventOrderCreate(BaseModel):
    name: str
    event_date: Optional[date] = None
    notes: Optional[str] = None

class EventOrderUpdate(BaseModel):
    name: Optional[str] = None
    event_date: Optional[date] = None
    notes: Optional[str] = None
    status: Optional[str] = None

class EventOrderItemAdd(BaseModel):
    recipe_id: int
    quantity: int
    notes: Optional[str] = None
    sort_order: int = 0

class EventOrderItemUpdate(BaseModel):
    quantity: Optional[int] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class BulkItemEntry(BaseModel):
    recipe_id: int
    quantity: int
    notes: Optional[str] = None

class EventOrderBulkAdd(BaseModel):
    items: list[BulkItemEntry]

class EventOrderResponse(BaseModel):
    id: int
    name: str
    event_date: Optional[str] = None
    notes: Optional[str] = None
    status: str
    item_count: int = 0
    estimated_cost: Optional[float] = None
    created_at: str = ""
    updated_at: str = ""

class EventOrderItemResponse(BaseModel):
    id: int
    recipe_id: int
    recipe_name: str = ""
    recipe_type: str = ""
    batch_portions: int = 1
    quantity: int
    cost_per_portion: Optional[float] = None
    subtotal: Optional[float] = None
    notes: Optional[str] = None
    sort_order: int = 0


# ── Event Order CRUD ─────────────────────────────────────────────────────────

@router.get("")
async def list_event_orders(
    status: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(EventOrder)
        .options(selectinload(EventOrder.items))
        .where(EventOrder.kitchen_id == user.kitchen_id)
    )
    if status:
        query = query.where(EventOrder.status == status)

    result = await db.execute(query.order_by(EventOrder.event_date.desc().nullslast(), EventOrder.created_at.desc()))
    orders = result.scalars().all()

    responses = []
    for o in orders:
        responses.append(EventOrderResponse(
            id=o.id,
            name=o.name,
            event_date=str(o.event_date) if o.event_date else None,
            notes=o.notes,
            status=o.status,
            item_count=len(o.items) if o.items else 0,
            created_at=str(o.created_at) if o.created_at else "",
            updated_at=str(o.updated_at) if o.updated_at else "",
        ))

    return responses


@router.post("")
async def create_event_order(
    data: EventOrderCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    order = EventOrder(
        kitchen_id=user.kitchen_id,
        name=data.name,
        event_date=data.event_date,
        notes=data.notes,
        created_by=user.id,
    )
    db.add(order)
    await db.commit()
    await db.refresh(order)
    return {"id": order.id, "name": order.name}


@router.get("/{order_id}")
async def get_event_order(
    order_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(EventOrder)
        .options(selectinload(EventOrder.items).selectinload(EventOrderItem.recipe))
        .where(EventOrder.id == order_id, EventOrder.kitchen_id == user.kitchen_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(404, "Event order not found")

    items = []
    for item in sorted(order.items, key=lambda x: x.sort_order):
        recipe = item.recipe
        # Get cost per portion from latest snapshot
        from models.recipe import RecipeCostSnapshot
        snap_result = await db.execute(
            select(RecipeCostSnapshot)
            .where(RecipeCostSnapshot.recipe_id == item.recipe_id)
            .order_by(RecipeCostSnapshot.snapshot_date.desc())
            .limit(1)
        )
        snap = snap_result.scalar_one_or_none()
        cpp = float(snap.cost_per_portion) if snap else None
        subtotal = cpp * item.quantity if cpp else None

        items.append(EventOrderItemResponse(
            id=item.id,
            recipe_id=item.recipe_id,
            recipe_name=recipe.name if recipe else "",
            recipe_type=recipe.recipe_type if recipe else "",
            batch_portions=recipe.batch_portions if recipe else 1,
            quantity=item.quantity,
            cost_per_portion=cpp,
            subtotal=round(subtotal, 2) if subtotal else None,
            notes=item.notes,
            sort_order=item.sort_order,
        ))

    return {
        "id": order.id,
        "name": order.name,
        "event_date": str(order.event_date) if order.event_date else None,
        "notes": order.notes,
        "status": order.status,
        "items": [i.model_dump() for i in items],
        "created_at": str(order.created_at) if order.created_at else "",
        "updated_at": str(order.updated_at) if order.updated_at else "",
    }


@router.patch("/{order_id}")
async def update_event_order(
    order_id: int,
    data: EventOrderUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(EventOrder).where(EventOrder.id == order_id, EventOrder.kitchen_id == user.kitchen_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(404, "Event order not found")
    if data.name is not None:
        order.name = data.name
    if data.event_date is not None:
        order.event_date = data.event_date
    if data.notes is not None:
        order.notes = data.notes
    if data.status is not None:
        order.status = data.status
    await db.commit()
    return {"ok": True}


@router.delete("/{order_id}")
async def delete_event_order(
    order_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(EventOrder).where(EventOrder.id == order_id, EventOrder.kitchen_id == user.kitchen_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(404, "Event order not found")
    if order.status != "DRAFT":
        raise HTTPException(400, "Only DRAFT orders can be deleted")
    await db.delete(order)
    await db.commit()
    return {"ok": True}


# ── Event Order Items ────────────────────────────────────────────────────────

@router.post("/{order_id}/items")
async def add_item(
    order_id: int,
    data: EventOrderItemAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    order = await _get_order(order_id, user.kitchen_id, db)
    recipe = await db.execute(
        select(Recipe).where(Recipe.id == data.recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    if not recipe.scalar_one_or_none():
        raise HTTPException(404, "Recipe not found")

    item = EventOrderItem(
        event_order_id=order_id,
        recipe_id=data.recipe_id,
        quantity=data.quantity,
        notes=data.notes,
        sort_order=data.sort_order,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"id": item.id}


@router.post("/{order_id}/items/bulk")
async def add_items_bulk(
    order_id: int,
    data: EventOrderBulkAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add multiple recipes to an event order at once (e.g. from a menu)."""
    order = await _get_order(order_id, user.kitchen_id, db)

    # Get existing recipe_ids on this order to detect duplicates
    existing_result = await db.execute(
        select(EventOrderItem.recipe_id).where(EventOrderItem.event_order_id == order_id)
    )
    existing_ids = {r[0] for r in existing_result.all()}

    # Get max sort_order
    max_sort_result = await db.execute(
        select(func.coalesce(func.max(EventOrderItem.sort_order), -1))
        .where(EventOrderItem.event_order_id == order_id)
    )
    next_sort = (max_sort_result.scalar() or 0) + 1

    # Validate all recipe_ids belong to this kitchen
    recipe_ids = [entry.recipe_id for entry in data.items]
    valid_result = await db.execute(
        select(Recipe.id).where(Recipe.id.in_(recipe_ids), Recipe.kitchen_id == user.kitchen_id)
    )
    valid_ids = {r[0] for r in valid_result.all()}

    added = 0
    skipped = 0
    for entry in data.items:
        if entry.recipe_id not in valid_ids:
            skipped += 1
            continue
        if entry.recipe_id in existing_ids:
            skipped += 1
            continue
        item = EventOrderItem(
            event_order_id=order_id,
            recipe_id=entry.recipe_id,
            quantity=entry.quantity,
            notes=entry.notes,
            sort_order=next_sort,
        )
        db.add(item)
        existing_ids.add(entry.recipe_id)
        next_sort += 1
        added += 1

    await db.commit()
    return {"added": added, "skipped": skipped}


@router.patch("/items/{item_id}")
async def update_item(
    item_id: int,
    data: EventOrderItemUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(EventOrderItem).where(EventOrderItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    if data.quantity is not None:
        item.quantity = data.quantity
    if data.notes is not None:
        item.notes = data.notes
    if data.sort_order is not None:
        item.sort_order = data.sort_order
    await db.commit()
    return {"ok": True}


@router.delete("/items/{item_id}")
async def delete_item(
    item_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(EventOrderItem).where(EventOrderItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    await db.delete(item)
    await db.commit()
    return {"ok": True}


# ── Shopping List ────────────────────────────────────────────────────────────

async def _collect_ingredients_for_recipe(
    recipe_id: int,
    multiplier: float,
    db: AsyncSession,
    depth: int = 0,
) -> dict[int, float]:
    """Recursively collect ingredient quantities for a recipe × multiplier.
    Returns {ingredient_id: total_quantity_in_standard_unit}."""
    if depth > 5:
        return {}

    result: dict[int, float] = defaultdict(float)

    # Direct ingredients (yield-adjusted: divide by yield to get required purchase qty)
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient))
        .where(RecipeIngredient.recipe_id == recipe_id)
    )
    _bases = {"g": 1.0, "kg": 1000.0, "ml": 1.0, "ltr": 1000.0}
    for ri in ri_result.scalars().all():
        yld = float(ri.yield_percent) if ri.yield_percent else 100.0
        raw_qty = float(ri.quantity) * multiplier
        # Convert from display unit to standard unit if needed
        if ri.unit and ri.ingredient and ri.unit != ri.ingredient.standard_unit:
            from_base = _bases.get(ri.unit)
            to_base = _bases.get(ri.ingredient.standard_unit)
            if from_base and to_base:
                raw_qty = raw_qty * from_base / to_base
        adjusted_qty = raw_qty / (yld / 100) if yld > 0 else raw_qty
        result[ri.ingredient_id] += adjusted_qty

    # Sub-recipe ingredients
    sr_result = await db.execute(
        select(RecipeSubRecipe).where(RecipeSubRecipe.parent_recipe_id == recipe_id)
    )
    for sr in sr_result.scalars().all():
        child_result = await db.execute(
            select(Recipe).where(Recipe.id == sr.child_recipe_id)
        )
        child_recipe = child_result.scalar_one_or_none()
        if not child_recipe:
            continue
        # Use unified output qty (handles both portioned and bulk)
        child_output_qty = float(child_recipe.batch_yield_qty) if child_recipe.batch_output_type == "bulk" and child_recipe.batch_yield_qty else (child_recipe.batch_portions or 1)
        child_output_unit = child_recipe.batch_yield_unit if child_recipe.batch_output_type == "bulk" and child_recipe.batch_yield_unit else "portion"
        # Convert portions_needed to child output unit if different unit was used
        needed = float(sr.portions_needed)
        needed_unit = sr.portions_needed_unit or child_output_unit
        if needed_unit != child_output_unit:
            _bases = {"g": 1.0, "kg": 1000.0, "ml": 1.0, "ltr": 1000.0}
            if needed_unit in _bases and child_output_unit in _bases:
                needed = needed * _bases[needed_unit] / _bases[child_output_unit]
        child_multiplier = multiplier * (needed / child_output_qty)
        child_ings = await _collect_ingredients_for_recipe(sr.child_recipe_id, child_multiplier, db, depth + 1)
        for ing_id, qty in child_ings.items():
            result[ing_id] += qty

    return dict(result)


@router.get("/{order_id}/shopping-list")
async def get_shopping_list(
    order_id: int,
    group_by_supplier: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Aggregated ingredient shopping list across all event order items."""
    order = await _get_order(order_id, user.kitchen_id, db)

    # Get all items
    items_result = await db.execute(
        select(EventOrderItem)
        .options(selectinload(EventOrderItem.recipe))
        .where(EventOrderItem.event_order_id == order_id)
    )
    items = items_result.scalars().all()

    # Aggregate ingredient quantities across all recipes
    total_ingredients: dict[int, float] = defaultdict(float)
    recipe_breakdown: dict[int, list] = defaultdict(list)  # ingredient_id -> [{recipe, qty}]

    for item in items:
        recipe = item.recipe
        if not recipe:
            continue

        # For dish: multiplier = quantity (servings) / output_qty
        # For component: multiplier = quantity (batches)
        if recipe.recipe_type == "component":
            multiplier = float(item.quantity)  # each item.quantity = number of batches
        else:
            # Dishes are always portioned with batch_portions=1
            multiplier = float(item.quantity) / (recipe.batch_portions or 1)

        ings = await _collect_ingredients_for_recipe(recipe.id, multiplier, db)
        for ing_id, qty in ings.items():
            total_ingredients[ing_id] += qty
            recipe_breakdown[ing_id].append({
                "recipe_name": recipe.name,
                "quantity": round(qty, 3),
            })

    if not total_ingredients:
        return {"items": [], "by_supplier": {}}

    # Load ingredient details and sources
    ing_ids = list(total_ingredients.keys())
    ing_result = await db.execute(
        select(Ingredient)
        .options(
            selectinload(Ingredient.category),
            selectinload(Ingredient.sources).selectinload(IngredientSource.supplier),
        )
        .where(Ingredient.id.in_(ing_ids))
    )
    ingredients = {ing.id: ing for ing in ing_result.scalars().all()}

    shopping_items = []
    by_supplier: dict[str, list] = defaultdict(list)

    for ing_id, total_qty in sorted(total_ingredients.items(), key=lambda x: x[0]):
        ing = ingredients.get(ing_id)
        if not ing:
            continue

        # Quantity already yield-adjusted during collection
        adjusted_qty = total_qty

        # Source info
        sources = []
        for src in (ing.sources or []):
            pack_total = None
            suggested_packs = None
            cost_per_pack = None

            if src.pack_quantity and src.unit_size and src.unit_size_type:
                pack_in_std = convert_to_standard(
                    Decimal(str(src.pack_quantity)) * src.unit_size,
                    src.unit_size_type,
                    ing.standard_unit,
                )
                if pack_in_std and float(pack_in_std) > 0:
                    pack_total = float(pack_in_std)
                    suggested_packs = int(adjusted_qty / pack_total) + (1 if adjusted_qty % pack_total > 0 else 0)
                    if src.latest_unit_price:
                        cost_per_pack = float(src.latest_unit_price)

            source_info = {
                "supplier_id": src.supplier_id,
                "supplier_name": src.supplier.name if src.supplier else "",
                "product_code": src.product_code,
                "pack_description": f"{src.pack_quantity}×{src.unit_size}{src.unit_size_type}" if src.pack_quantity and src.unit_size else None,
                "pack_total_std_unit": pack_total,
                "suggested_packs": suggested_packs,
                "cost_per_pack": cost_per_pack,
                "subtotal": round(cost_per_pack * suggested_packs, 2) if cost_per_pack and suggested_packs else None,
            }
            sources.append(source_info)

            if group_by_supplier:
                supplier_name = src.supplier.name if src.supplier else "Unknown"
                by_supplier[supplier_name].append({
                    "ingredient_name": ing.name,
                    "quantity_needed": round(adjusted_qty, 3),
                    "unit": ing.standard_unit,
                    **source_info,
                })

        item_data = {
            "ingredient_id": ing.id,
            "ingredient_name": ing.name,
            "category": ing.category.name if ing.category else "Other",
            "total_quantity": round(total_qty, 3),
            "adjusted_quantity": round(adjusted_qty, 3),
            "unit": ing.standard_unit,
            "sources": sources,
            "recipe_breakdown": recipe_breakdown.get(ing_id, []),
        }
        shopping_items.append(item_data)

    # Sort by category
    shopping_items.sort(key=lambda x: (x["category"], x["ingredient_name"]))

    return {"items": shopping_items, "by_supplier": dict(by_supplier) if group_by_supplier else {}}


# ── Generate Purchase Orders ─────────────────────────────────────────────────

@router.post("/{order_id}/generate-po")
async def generate_purchase_orders(
    order_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate purchase orders from shopping list, grouped by supplier."""
    from models.purchase_order import PurchaseOrder, PurchaseOrderLineItem

    order = await _get_order(order_id, user.kitchen_id, db)

    # Get shopping list grouped by supplier
    items_result = await db.execute(
        select(EventOrderItem)
        .options(selectinload(EventOrderItem.recipe))
        .where(EventOrderItem.event_order_id == order_id)
    )
    items = items_result.scalars().all()

    # Aggregate ingredient quantities
    total_ingredients: dict[int, float] = defaultdict(float)
    for item in items:
        recipe = item.recipe
        if not recipe:
            continue
        if recipe.recipe_type == "component":
            multiplier = float(item.quantity)
        else:
            multiplier = float(item.quantity) / (recipe.batch_portions or 1)
        ings = await _collect_ingredients_for_recipe(recipe.id, multiplier, db)
        for ing_id, qty in ings.items():
            total_ingredients[ing_id] += qty

    if not total_ingredients:
        raise HTTPException(400, "No ingredients to order")

    # Load ingredients with sources
    from sqlalchemy.orm import selectinload as si
    ing_result = await db.execute(
        select(Ingredient)
        .options(
            selectinload(Ingredient.sources).selectinload(IngredientSource.supplier),
        )
        .where(Ingredient.id.in_(list(total_ingredients.keys())))
    )
    ingredients = {ing.id: ing for ing in ing_result.scalars().all()}

    # Group by supplier: {supplier_id: [{ingredient, qty, source}]}
    supplier_lines: dict[int, list] = defaultdict(list)
    unmapped = []

    for ing_id, total_qty in total_ingredients.items():
        ing = ingredients.get(ing_id)
        if not ing:
            continue

        # Quantity already yield-adjusted during collection
        adjusted_qty = total_qty

        # Pick the most recent source (by latest_invoice_date)
        best_source = None
        for src in (ing.sources or []):
            if best_source is None or (src.latest_invoice_date and (
                not best_source.latest_invoice_date or src.latest_invoice_date > best_source.latest_invoice_date
            )):
                best_source = src

        if best_source and best_source.supplier_id:
            pack_total = None
            suggested_packs = 1
            if best_source.pack_quantity and best_source.unit_size and best_source.unit_size_type:
                pack_in_std = convert_to_standard(
                    Decimal(str(best_source.pack_quantity)) * best_source.unit_size,
                    best_source.unit_size_type,
                    ing.standard_unit,
                )
                if pack_in_std and float(pack_in_std) > 0:
                    pack_total = float(pack_in_std)
                    suggested_packs = int(adjusted_qty / pack_total) + (1 if adjusted_qty % pack_total > 0 else 0)

            supplier_lines[best_source.supplier_id].append({
                "ingredient": ing,
                "source": best_source,
                "quantity": max(suggested_packs, 1),
                "unit_price": float(best_source.latest_unit_price) if best_source.latest_unit_price else 0,
            })
        else:
            unmapped.append(ing.name)

    # Create one PO per supplier
    created_pos = []
    for supplier_id, lines in supplier_lines.items():
        total = sum(l["quantity"] * l["unit_price"] for l in lines)
        po = PurchaseOrder(
            kitchen_id=user.kitchen_id,
            supplier_id=supplier_id,
            order_date=order.event_date or date.today(),
            order_type="itemised",
            status="DRAFT",
            total_amount=Decimal(str(round(total, 2))),
            notes=f"Auto-generated from event order: {order.name}",
            created_by=user.id,
        )
        db.add(po)
        await db.flush()

        for idx, line in enumerate(lines):
            line_total = round(line["quantity"] * line["unit_price"], 2)
            po_line = PurchaseOrderLineItem(
                purchase_order_id=po.id,
                kitchen_id=user.kitchen_id,
                product_code=line["source"].product_code,
                description=line["ingredient"].name,
                unit=line["ingredient"].standard_unit,
                unit_price=Decimal(str(line["unit_price"])),
                quantity=Decimal(str(line["quantity"])),
                total=Decimal(str(line_total)),
                line_number=idx + 1,
                source="event_order",
            )
            db.add(po_line)

        created_pos.append({"id": po.id, "supplier_id": supplier_id})

    await db.commit()

    return {
        "created": len(created_pos),
        "purchase_orders": created_pos,
        "unmapped_ingredients": unmapped,
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_order(order_id: int, kitchen_id: int, db: AsyncSession) -> EventOrder:
    result = await db.execute(
        select(EventOrder).where(EventOrder.id == order_id, EventOrder.kitchen_id == kitchen_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(404, "Event order not found")
    return order
