"""
Recipe API — CRUD, costing, sub-recipe cycle check, scaling, menu sections,
cost snapshots, print HTML (full + kitchen card).
"""
import os
import uuid
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional
from html import escape as html_escape

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text, and_, delete
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, field_serializer

from database import get_db
from models.user import User
from models.recipe import (
    Recipe, MenuSection, RecipeIngredient, RecipeSubRecipe,
    RecipeStep, RecipeImage, RecipeChangeLog, RecipeCostSnapshot,
)
from models.ingredient import Ingredient, IngredientSource
from models.food_flag import RecipeFlag, FoodFlagCategory, FoodFlag
from models.ingredient import IngredientFlag, IngredientFlagNone
from models.settings import KitchenSettings
from auth.jwt import get_current_user, get_current_user_from_token
from api.ingredients import convert_to_standard, UNIT_CONVERSIONS
from models.menu import Menu, MenuItem

logger = logging.getLogger(__name__)

router = APIRouter()

DATA_DIR = "/app/data"


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class MenuSectionCreate(BaseModel):
    name: str
    sort_order: int = 0
    section_type: str = "recipe"  # "recipe" | "dish"

class MenuSectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

class MenuSectionResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    section_type: str = "recipe"
    recipe_count: int = 0

class RecipeCreate(BaseModel):
    name: str
    recipe_type: str = "component"  # "component" | "dish"
    menu_section_id: Optional[int] = None
    description: Optional[str] = None
    batch_portions: int = 1
    batch_output_type: str = "portions"  # "portions" | "bulk"
    batch_yield_qty: Optional[float] = None
    batch_yield_unit: Optional[str] = None  # g, kg, ml, ltr
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    notes: Optional[str] = None

class RecipeUpdate(BaseModel):
    name: Optional[str] = None
    recipe_type: Optional[str] = None
    menu_section_id: Optional[int] = None
    description: Optional[str] = None
    batch_portions: Optional[int] = None
    batch_output_type: Optional[str] = None
    batch_yield_qty: Optional[float] = None
    batch_yield_unit: Optional[str] = None
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    notes: Optional[str] = None
    is_archived: Optional[bool] = None
    kds_menu_item_name: Optional[str] = None
    gross_sell_price: Optional[float] = None

class IngredientAdd(BaseModel):
    ingredient_id: int
    quantity: float
    unit: Optional[str] = None  # override display unit (e.g. kg when ingredient std is g)
    yield_percent: float = 100.0
    notes: Optional[str] = None
    sort_order: int = 0

class IngredientUpdateSchema(BaseModel):
    quantity: Optional[float] = None
    unit: Optional[str] = None
    yield_percent: Optional[float] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class SubRecipeAdd(BaseModel):
    child_recipe_id: int
    portions_needed: float
    portions_needed_unit: Optional[str] = None  # override unit (e.g. ml when child yields ltr)
    notes: Optional[str] = None
    sort_order: int = 0

class SubRecipeUpdateSchema(BaseModel):
    portions_needed: Optional[float] = None
    portions_needed_unit: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class StepCreate(BaseModel):
    title: Optional[str] = None
    instruction: str
    step_number: int = 0
    duration_minutes: Optional[int] = None
    notes: Optional[str] = None

class StepUpdate(BaseModel):
    title: Optional[str] = None
    instruction: Optional[str] = None
    step_number: Optional[int] = None
    duration_minutes: Optional[int] = None
    notes: Optional[str] = None

class StepReorder(BaseModel):
    step_ids: list[int]

class IngredientReorder(BaseModel):
    ingredient_ids: list[int]

class SubRecipeReorder(BaseModel):
    sub_recipe_ids: list[int]

class RecipeListItem(BaseModel):
    id: int
    name: str
    recipe_type: str
    menu_section_id: Optional[int] = None
    menu_section_name: Optional[str] = None
    batch_portions: int = 1
    batch_output_type: str = "portions"
    batch_yield_qty: Optional[float] = None
    batch_yield_unit: Optional[str] = None
    output_unit: str = "portion"
    cost_per_portion: Optional[float] = None
    total_cost: Optional[float] = None
    is_archived: bool = False
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    flag_summary: list[dict] = []
    image_count: int = 0
    kds_menu_item_name: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


# ── Menu Section endpoints ───────────────────────────────────────────────────

@router.get("/menu-sections")
async def list_menu_sections(
    section_type: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    count_sub = (
        select(Recipe.menu_section_id, func.count(Recipe.id).label("cnt"))
        .where(Recipe.kitchen_id == user.kitchen_id, Recipe.is_archived == False)
        .group_by(Recipe.menu_section_id)
        .subquery()
    )
    query = (
        select(MenuSection, func.coalesce(count_sub.c.cnt, 0).label("recipe_count"))
        .outerjoin(count_sub, MenuSection.id == count_sub.c.menu_section_id)
        .where(MenuSection.kitchen_id == user.kitchen_id)
    )
    if section_type:
        query = query.where(MenuSection.section_type == section_type)
    query = query.order_by(MenuSection.sort_order, MenuSection.name)
    result = await db.execute(query)
    return [
        MenuSectionResponse(id=s.id, name=s.name, sort_order=s.sort_order, section_type=s.section_type, recipe_count=cnt)
        for s, cnt in result.all()
    ]


@router.post("/menu-sections")
async def create_menu_section(
    data: MenuSectionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sec = MenuSection(kitchen_id=user.kitchen_id, name=data.name, sort_order=data.sort_order, section_type=data.section_type)
    db.add(sec)
    await db.commit()
    await db.refresh(sec)
    return MenuSectionResponse(id=sec.id, name=sec.name, sort_order=sec.sort_order)


@router.patch("/menu-sections/{section_id}")
async def update_menu_section(
    section_id: int,
    data: MenuSectionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MenuSection).where(MenuSection.id == section_id, MenuSection.kitchen_id == user.kitchen_id)
    )
    sec = result.scalar_one_or_none()
    if not sec:
        raise HTTPException(404, "Section not found")
    if data.name is not None:
        sec.name = data.name
    if data.sort_order is not None:
        sec.sort_order = data.sort_order
    await db.commit()
    return {"ok": True}


@router.delete("/menu-sections/{section_id}")
async def delete_menu_section(
    section_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(MenuSection).where(MenuSection.id == section_id, MenuSection.kitchen_id == user.kitchen_id)
    )
    sec = result.scalar_one_or_none()
    if not sec:
        raise HTTPException(404, "Section not found")
    # Null out recipes in this section
    from sqlalchemy import update
    await db.execute(
        update(Recipe).where(Recipe.menu_section_id == section_id).values(menu_section_id=None)
    )
    await db.delete(sec)
    await db.commit()
    return {"ok": True}


# ── Default recipe sections and dish courses ────────────────────────────────

DEFAULT_RECIPE_SECTIONS = [
    ("Meats & Protein", 0),
    ("Sauces & Jus", 1),
    ("Starch & Vegetables", 2),
    ("Sides & Accompaniments", 3),
    ("Pastry & Dessert", 4),
    ("Garnish & Toppings", 5),
    ("Marinades & Glazes", 6),
    ("Stews & Casseroles", 7),
]

DEFAULT_DISH_COURSES = [
    ("Starter", 0),
    ("Main", 1),
    ("Dessert", 2),
    ("Side", 3),
    ("Specials", 4),
]


@router.post("/menu-sections/seed-defaults")
async def seed_default_menu_sections(
    section_type: str = Query("recipe"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if section_type not in ("recipe", "dish"):
        raise HTTPException(400, "section_type must be 'recipe' or 'dish'")

    defaults = DEFAULT_RECIPE_SECTIONS if section_type == "recipe" else DEFAULT_DISH_COURSES
    kid = user.kitchen_id
    created = 0
    for name, sort_order in defaults:
        exists = await db.execute(
            select(MenuSection).where(
                MenuSection.kitchen_id == kid,
                MenuSection.name == name,
                MenuSection.section_type == section_type,
            )
        )
        if exists.scalar_one_or_none():
            continue
        db.add(MenuSection(kitchen_id=kid, name=name, section_type=section_type, sort_order=sort_order))
        created += 1
    await db.commit()
    return {"ok": True, "created": created}


# ── Dashboard Stats ──────────────────────────────────────────────────────────

@router.get("/dashboard-stats")
async def recipe_dashboard_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Lightweight stats for the main dashboard widget."""
    kid = user.kitchen_id

    total = (await db.execute(
        select(func.count()).select_from(Recipe).where(Recipe.kitchen_id == kid, Recipe.is_archived == False)
    )).scalar() or 0

    dishes = (await db.execute(
        select(func.count()).select_from(Recipe).where(Recipe.kitchen_id == kid, Recipe.recipe_type == "dish", Recipe.is_archived == False)
    )).scalar() or 0

    component = total - dishes

    # Ingredients with no sources
    unmapped = (await db.execute(
        select(func.count()).select_from(Ingredient).where(
            Ingredient.kitchen_id == kid,
            Ingredient.is_archived == False,
            ~Ingredient.id.in_(
                select(IngredientSource.ingredient_id).where(IngredientSource.kitchen_id == kid)
            ),
        )
    )).scalar() or 0

    # Recipes without any cost snapshots
    without_costing = (await db.execute(
        select(func.count()).select_from(Recipe).where(
            Recipe.kitchen_id == kid,
            Recipe.is_archived == False,
            ~Recipe.id.in_(
                select(RecipeCostSnapshot.recipe_id).distinct()
            ),
        )
    )).scalar() or 0

    # Dishes missing allergen assessment
    # Find required flag categories for this kitchen
    req_cats = (await db.execute(
        select(FoodFlagCategory.id).where(
            FoodFlagCategory.kitchen_id == kid,
            FoodFlagCategory.required == True,
        )
    )).scalars().all()

    dishes_missing_allergens = 0
    dishes_missing_list: list[dict] = []

    if req_cats:
        # Get all dish recipes (non-archived)
        dish_rows = (await db.execute(
            select(Recipe.id, Recipe.name).where(
                Recipe.kitchen_id == kid,
                Recipe.recipe_type == "dish",
                Recipe.is_archived == False,
            )
        )).all()

        for dish_id, dish_name in dish_rows:
            # Get all ingredient IDs used by this dish (direct + via sub-recipes)
            direct_ings = (await db.execute(
                select(RecipeIngredient.ingredient_id).where(
                    RecipeIngredient.recipe_id == dish_id
                )
            )).scalars().all()

            sub_recipe_ids = (await db.execute(
                select(RecipeSubRecipe.child_recipe_id).where(
                    RecipeSubRecipe.parent_recipe_id == dish_id
                )
            )).scalars().all()

            sub_ings: list[int] = []
            for sr_id in sub_recipe_ids:
                sr_ings = (await db.execute(
                    select(RecipeIngredient.ingredient_id).where(
                        RecipeIngredient.recipe_id == sr_id
                    )
                )).scalars().all()
                sub_ings.extend(sr_ings)

            all_ing_ids = set(direct_ings) | set(sub_ings)
            if not all_ing_ids:
                continue

            # Check each ingredient against required categories
            has_unassessed = False
            for ing_id in all_ing_ids:
                for cat_id in req_cats:
                    # Check if ingredient has any flag in this category
                    has_flag = (await db.execute(
                        select(IngredientFlag.id).where(
                            IngredientFlag.ingredient_id == ing_id,
                            IngredientFlag.food_flag_id.in_(
                                select(FoodFlag.id).where(FoodFlag.category_id == cat_id)
                            ),
                        ).limit(1)
                    )).scalar_one_or_none()

                    if not has_flag:
                        # Check if ingredient has "none" for this category
                        has_none = (await db.execute(
                            select(IngredientFlagNone.id).where(
                                IngredientFlagNone.ingredient_id == ing_id,
                                IngredientFlagNone.category_id == cat_id,
                            ).limit(1)
                        )).scalar_one_or_none()

                        if not has_none:
                            has_unassessed = True
                            break
                if has_unassessed:
                    break

            if has_unassessed:
                dishes_missing_allergens += 1
                dishes_missing_list.append({"id": dish_id, "name": dish_name})

    # Recipes affected by ingredient price changes in last 14 days
    cutoff = datetime.utcnow() - timedelta(days=14)
    price_change_logs = (await db.execute(
        select(RecipeChangeLog.recipe_id).where(
            RecipeChangeLog.created_at >= cutoff,
            RecipeChangeLog.user_id == None,
            (RecipeChangeLog.change_summary.like("%price changed%") | RecipeChangeLog.change_summary.like("%price set%")),
            RecipeChangeLog.recipe_id.in_(
                select(Recipe.id).where(Recipe.kitchen_id == kid, Recipe.is_archived == False)
            ),
        ).distinct()
    )).scalars().all()

    # Menu items needing republishing
    from api.menus import _compute_staleness
    menu_result = await db.execute(
        select(Menu).options(selectinload(Menu.items)).where(
            Menu.kitchen_id == kid, Menu.is_active == True
        )
    )
    active_menus = menu_result.scalars().all()
    stale_menu_items = 0
    stale_menu_names: list[str] = []
    for menu in active_menus:
        if menu.items:
            staleness = await _compute_staleness(list(menu.items), db)
            menu_stale = sum(1 for s in staleness.values() if s.get("is_stale"))
            if menu_stale > 0:
                stale_menu_items += menu_stale
                stale_menu_names.append(menu.name)

    return {
        "total_recipes": total,
        "dish_count": dishes,
        "component_recipes": component,
        "unmapped_ingredients": unmapped,
        "recipes_without_costing": without_costing,
        "dishes_missing_allergens": dishes_missing_allergens,
        "dishes_missing_allergens_list": dishes_missing_list,
        "recipes_with_price_changes": len(price_change_logs),
        "stale_menu_items": stale_menu_items,
        "stale_menu_names": stale_menu_names,
    }


@router.get("/price-impact")
async def price_impact_report(
    days: int = Query(14, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Recipes affected by ingredient price changes within the given period."""
    kid = user.kitchen_id
    cutoff = datetime.utcnow() - timedelta(days=days)

    # Find price-change log entries within the period
    log_result = await db.execute(
        select(RecipeChangeLog).where(
            RecipeChangeLog.created_at >= cutoff,
            RecipeChangeLog.user_id == None,
            (RecipeChangeLog.change_summary.like("%price changed%") | RecipeChangeLog.change_summary.like("%price set%")),
            RecipeChangeLog.recipe_id.in_(
                select(Recipe.id).where(Recipe.kitchen_id == kid, Recipe.is_archived == False)
            ),
        ).order_by(RecipeChangeLog.created_at.desc())
    )
    logs = log_result.scalars().all()

    if not logs:
        return {"days": days, "recipes": []}

    # Group log entries by recipe
    recipe_changes: dict[int, list[dict]] = {}
    for log in logs:
        recipe_changes.setdefault(log.recipe_id, []).append({
            "summary": log.change_summary,
            "date": str(log.created_at.date()) if log.created_at else None,
        })

    # Get recipe info + cost snapshots for affected recipes
    recipe_ids = list(recipe_changes.keys())
    recipe_result = await db.execute(
        select(Recipe).where(Recipe.id.in_(recipe_ids))
    )
    recipes = {r.id: r for r in recipe_result.scalars().all()}

    items = []
    for rid in recipe_ids:
        r = recipes.get(rid)
        if not r:
            continue

        # Latest snapshot (current cost)
        latest_snap = (await db.execute(
            select(RecipeCostSnapshot).where(
                RecipeCostSnapshot.recipe_id == rid,
            ).order_by(RecipeCostSnapshot.snapshot_date.desc()).limit(1)
        )).scalar_one_or_none()

        # Snapshot just before the period (previous cost)
        prev_snap = (await db.execute(
            select(RecipeCostSnapshot).where(
                RecipeCostSnapshot.recipe_id == rid,
                RecipeCostSnapshot.snapshot_date < cutoff.date(),
            ).order_by(RecipeCostSnapshot.snapshot_date.desc()).limit(1)
        )).scalar_one_or_none()

        current_cost = float(latest_snap.cost_per_portion) if latest_snap else None
        previous_cost = float(prev_snap.cost_per_portion) if prev_snap else None
        cost_change = None
        cost_change_pct = None
        if current_cost is not None and previous_cost is not None and previous_cost > 0:
            cost_change = round(current_cost - previous_cost, 4)
            cost_change_pct = round((cost_change / previous_cost) * 100, 1)

        items.append({
            "recipe_id": rid,
            "recipe_name": r.name,
            "recipe_type": r.recipe_type,
            "output_unit": _get_output_unit(r),
            "current_cost_per_unit": current_cost,
            "previous_cost_per_unit": previous_cost,
            "cost_change": cost_change,
            "cost_change_pct": cost_change_pct,
            "ingredient_changes": recipe_changes[rid],
        })

    # Sort by absolute cost change descending (biggest movers first)
    items.sort(key=lambda x: abs(x["cost_change"] or 0), reverse=True)

    return {"days": days, "recipes": items}


# ── Recipe List & CRUD ───────────────────────────────────────────────────────

@router.get("")
async def list_recipes(
    recipe_type: Optional[str] = Query(None),
    menu_section_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    archived: bool = Query(False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Recipe)
        .options(selectinload(Recipe.menu_section), selectinload(Recipe.images))
        .where(Recipe.kitchen_id == user.kitchen_id)
    )
    if not archived:
        query = query.where(Recipe.is_archived == False)
    if recipe_type:
        query = query.where(Recipe.recipe_type == recipe_type)
    if menu_section_id:
        query = query.where(Recipe.menu_section_id == menu_section_id)
    if search:
        query = query.where(Recipe.name.ilike(f"%{search}%"))

    result = await db.execute(query.order_by(Recipe.name))
    recipes = result.scalars().all()

    items = []
    for r in recipes:
        # Get latest cost snapshot
        snap_result = await db.execute(
            select(RecipeCostSnapshot)
            .where(RecipeCostSnapshot.recipe_id == r.id)
            .order_by(RecipeCostSnapshot.snapshot_date.desc())
            .limit(1)
        )
        snap = snap_result.scalar_one_or_none()

        # Get flag summary (lightweight)
        from api.food_flags import compute_recipe_flags
        flags = await compute_recipe_flags(r.id, user.kitchen_id, db)
        flag_summary = [
            {"name": f.flag_name, "code": f.flag_code, "icon": f.flag_icon,
             "category": f.category_name, "propagation": f.propagation_type,
             "active": f.is_active, "excludable": f.excludable_on_request}
            for f in flags if f.is_active
        ]

        items.append(RecipeListItem(
            id=r.id,
            name=r.name,
            recipe_type=r.recipe_type,
            menu_section_id=r.menu_section_id,
            menu_section_name=r.menu_section.name if r.menu_section else None,
            batch_portions=r.batch_portions,
            batch_output_type=r.batch_output_type or "portions",
            batch_yield_qty=float(r.batch_yield_qty) if r.batch_yield_qty else None,
            batch_yield_unit=r.batch_yield_unit,
            output_unit=_get_output_unit(r),
            cost_per_portion=float(snap.cost_per_portion) if snap else None,
            total_cost=float(snap.total_cost) if snap else None,
            is_archived=r.is_archived,
            prep_time_minutes=r.prep_time_minutes,
            cook_time_minutes=r.cook_time_minutes,
            flag_summary=flag_summary,
            image_count=len(r.images) if r.images else 0,
            kds_menu_item_name=r.kds_menu_item_name,
            created_at=str(r.created_at) if r.created_at else "",
            updated_at=str(r.updated_at) if r.updated_at else "",
        ))

    return items


@router.post("")
async def create_recipe(
    data: RecipeCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if data.recipe_type not in ("component", "dish"):
        raise HTTPException(400, "recipe_type must be 'component' or 'dish'")

    # Validate bulk output
    if data.batch_output_type == "bulk":
        if not data.batch_yield_qty or data.batch_yield_qty <= 0:
            raise HTTPException(400, "Bulk recipes require a positive batch_yield_qty")
        if data.batch_yield_unit not in ("g", "kg", "ml", "ltr"):
            raise HTTPException(400, "batch_yield_unit must be g, kg, ml, or ltr")

    recipe = Recipe(
        kitchen_id=user.kitchen_id,
        name=data.name.strip(),
        recipe_type=data.recipe_type,
        menu_section_id=data.menu_section_id,
        description=data.description,
        batch_portions=1 if data.batch_output_type == "bulk" else (data.batch_portions if data.recipe_type == "component" else 1),
        batch_output_type=data.batch_output_type if data.recipe_type == "component" else "portions",
        batch_yield_qty=Decimal(str(data.batch_yield_qty)) if data.batch_output_type == "bulk" and data.batch_yield_qty else None,
        batch_yield_unit=data.batch_yield_unit if data.batch_output_type == "bulk" else None,
        prep_time_minutes=data.prep_time_minutes,
        cook_time_minutes=data.cook_time_minutes,
        notes=data.notes,
        created_by=user.id,
    )
    db.add(recipe)
    await db.commit()
    await db.refresh(recipe)
    return {"id": recipe.id, "name": recipe.name}


@router.get("/{recipe_id}")
async def get_recipe(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Recipe)
        .options(
            selectinload(Recipe.menu_section),
            selectinload(Recipe.ingredients).selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.sources),
            selectinload(Recipe.sub_recipes).selectinload(RecipeSubRecipe.child_recipe),
            selectinload(Recipe.steps),
            selectinload(Recipe.images),
        )
        .where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")

    # Build detailed response
    ingredients = []
    for ri in sorted(recipe.ingredients, key=lambda x: x.sort_order):
        ing = ri.ingredient
        if not ing:
            continue
        display_unit = ri.unit or ing.standard_unit
        # Get effective price (yield from recipe ingredient, not raw ingredient)
        yld = float(ri.yield_percent) if ri.yield_percent else 100.0
        eff_price = None
        if ing.sources:
            priced = [s for s in ing.sources if s.price_per_std_unit]
            if priced:
                latest = max(priced, key=lambda s: s.latest_invoice_date or date.min)
                raw = float(latest.price_per_std_unit)
                eff_price = raw / (yld / 100) if yld > 0 else raw
        is_manual_price = False
        if eff_price is None and ing.manual_price:
            eff_price = float(ing.manual_price) / (yld / 100) if yld > 0 else float(ing.manual_price)
            is_manual_price = True

        # Convert quantity to standard unit for cost calculation
        qty_in_std = _convert_unit(float(ri.quantity), display_unit, ing.standard_unit)
        cost = qty_in_std * eff_price if eff_price and ri.quantity else None

        ingredients.append({
            "id": ri.id,
            "ingredient_id": ing.id,
            "ingredient_name": ing.name,
            "quantity": float(ri.quantity),
            "unit": display_unit,
            "standard_unit": ing.standard_unit,
            "compatible_units": _get_compatible_units(ing.standard_unit),
            "yield_percent": yld,
            "effective_price": round(eff_price, 6) if eff_price else None,
            "cost": round(cost, 4) if cost else None,
            "is_manual_price": is_manual_price if not (hasattr(ing, 'is_free') and ing.is_free) else False,
            "has_no_price": (eff_price is None) if not (hasattr(ing, 'is_free') and ing.is_free) else False,
            "notes": ri.notes,
            "sort_order": ri.sort_order,
        })

    sub_recipes = []
    for sr in sorted(recipe.sub_recipes, key=lambda x: x.sort_order):
        child = sr.child_recipe
        if not child:
            continue
        # Calculate child cost from scratch (not from snapshots, which may be stale/missing)
        child_cost_data = await _calc_recipe_cost(child.id, db)
        child_total = child_cost_data.get("total_cost_recent", 0) or 0
        child_output_qty = _get_output_qty(child)
        child_cost_per_portion = child_total / child_output_qty if child_total and child_output_qty else None
        child_output_unit = _get_output_unit(child)
        needed_unit = sr.portions_needed_unit or child_output_unit
        # Convert to child output unit for costing
        needed_in_output_unit = _convert_unit(float(sr.portions_needed), needed_unit, child_output_unit)
        cost_contribution = None
        if child_cost_per_portion and sr.portions_needed:
            cost_contribution = needed_in_output_unit * child_cost_per_portion

        # Check if child recipe has any manual-priced or no-price ingredients
        child_has_manual = any(ci.get("is_manual_price") for ci in child_cost_data.get("ingredients", []))
        child_has_no_price = any(ci.get("has_no_price") for ci in child_cost_data.get("ingredients", []))
        # Also check nested sub-recipe child ingredients recursively
        def _check_subs(subs):
            m, n = False, False
            for s in (subs or []):
                for ci in s.get("child_ingredients", []):
                    if ci.get("is_manual_price"): m = True
                    if ci.get("has_no_price"): n = True
                sm, sn = _check_subs(s.get("child_sub_recipes", []))
                m = m or sm
                n = n or sn
            return m, n
        sub_m, sub_n = _check_subs(child_cost_data.get("sub_recipes", []))
        child_has_manual = child_has_manual or sub_m
        child_has_no_price = child_has_no_price or sub_n

        sub_recipes.append({
            "id": sr.id,
            "child_recipe_id": child.id,
            "child_recipe_name": child.name,
            "child_recipe_type": child.recipe_type,
            "batch_portions": child.batch_portions,
            "batch_output_type": child.batch_output_type or "portions",
            "batch_yield_qty": float(child.batch_yield_qty) if child.batch_yield_qty else None,
            "batch_yield_unit": child.batch_yield_unit,
            "output_qty": _get_output_qty(child),
            "output_unit": child_output_unit,
            "portions_needed": float(sr.portions_needed),
            "portions_needed_unit": needed_unit,
            "compatible_units": _get_compatible_units(child_output_unit),
            "cost_per_portion": child_cost_per_portion,
            "cost_contribution": round(cost_contribution, 4) if cost_contribution else None,
            "has_manual_price_ingredients": child_has_manual,
            "has_no_price_ingredients": child_has_no_price,
            "notes": sr.notes,
            "sort_order": sr.sort_order,
        })

    steps = [
        {
            "id": s.id, "step_number": s.step_number, "title": s.title,
            "instruction": s.instruction, "image_path": s.image_path,
            "duration_minutes": s.duration_minutes, "notes": s.notes,
        }
        for s in sorted(recipe.steps, key=lambda x: x.step_number)
    ]

    images = [
        {
            "id": img.id, "image_path": img.image_path, "caption": img.caption,
            "image_type": img.image_type, "sort_order": img.sort_order,
        }
        for img in sorted(recipe.images, key=lambda x: x.sort_order)
    ]

    return {
        "id": recipe.id,
        "name": recipe.name,
        "recipe_type": recipe.recipe_type,
        "menu_section_id": recipe.menu_section_id,
        "menu_section_name": recipe.menu_section.name if recipe.menu_section else None,
        "description": recipe.description,
        "batch_portions": recipe.batch_portions,
        "batch_output_type": recipe.batch_output_type or "portions",
        "batch_yield_qty": float(recipe.batch_yield_qty) if recipe.batch_yield_qty else None,
        "batch_yield_unit": recipe.batch_yield_unit,
        "output_qty": _get_output_qty(recipe),
        "output_unit": _get_output_unit(recipe),
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "notes": recipe.notes,
        "is_archived": recipe.is_archived,
        "kds_menu_item_name": recipe.kds_menu_item_name,
        "gross_sell_price": float(recipe.gross_sell_price) if recipe.gross_sell_price else None,
        "ingredients": ingredients,
        "sub_recipes": sub_recipes,
        "steps": steps,
        "images": images,
        "created_at": str(recipe.created_at) if recipe.created_at else "",
        "updated_at": str(recipe.updated_at) if recipe.updated_at else "",
    }


@router.patch("/{recipe_id}")
async def update_recipe(
    recipe_id: int,
    data: RecipeUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")

    changes = []
    if data.name is not None and data.name != recipe.name:
        changes.append(f"Name changed from '{recipe.name}' to '{data.name}'")
        recipe.name = data.name.strip()
    if data.recipe_type is not None and data.recipe_type != recipe.recipe_type:
        changes.append(f"Type changed from '{recipe.recipe_type}' to '{data.recipe_type}'")
        recipe.recipe_type = data.recipe_type
    if data.menu_section_id is not None:
        recipe.menu_section_id = data.menu_section_id
    if data.description is not None:
        recipe.description = data.description
    if data.batch_portions is not None and data.batch_portions != recipe.batch_portions:
        changes.append(f"Batch portions changed from {recipe.batch_portions} to {data.batch_portions}")
        recipe.batch_portions = data.batch_portions
    if data.batch_output_type is not None and data.batch_output_type != recipe.batch_output_type:
        changes.append(f"Output type changed from '{recipe.batch_output_type}' to '{data.batch_output_type}'")
        recipe.batch_output_type = data.batch_output_type
        if data.batch_output_type == "bulk":
            recipe.batch_portions = 1
        elif data.batch_output_type == "portions":
            recipe.batch_yield_qty = None
            recipe.batch_yield_unit = None
    if data.batch_yield_qty is not None:
        old_val = float(recipe.batch_yield_qty) if recipe.batch_yield_qty else None
        if old_val != data.batch_yield_qty:
            changes.append(f"Yield qty changed from {old_val} to {data.batch_yield_qty}")
            recipe.batch_yield_qty = Decimal(str(data.batch_yield_qty)) if data.batch_yield_qty > 0 else None
    if data.batch_yield_unit is not None and data.batch_yield_unit != recipe.batch_yield_unit:
        changes.append(f"Yield unit changed from '{recipe.batch_yield_unit}' to '{data.batch_yield_unit}'")
        recipe.batch_yield_unit = data.batch_yield_unit
    if data.prep_time_minutes is not None:
        recipe.prep_time_minutes = data.prep_time_minutes
    if data.cook_time_minutes is not None:
        recipe.cook_time_minutes = data.cook_time_minutes
    if data.notes is not None:
        recipe.notes = data.notes
    if data.is_archived is not None:
        recipe.is_archived = data.is_archived
    if data.kds_menu_item_name is not None:
        recipe.kds_menu_item_name = data.kds_menu_item_name
    if data.gross_sell_price is not None:
        recipe.gross_sell_price = data.gross_sell_price if data.gross_sell_price > 0 else None

    if changes:
        db.add(RecipeChangeLog(
            recipe_id=recipe_id,
            change_summary="; ".join(changes),
            user_id=user.id,
        ))

    await db.commit()
    if changes:
        await _snapshot_recipe_and_parents(recipe_id, db, f"recipe_updated: {'; '.join(changes)}")
    return {"ok": True}


@router.delete("/{recipe_id}")
async def archive_recipe(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")
    recipe.is_archived = True
    await db.commit()
    return {"ok": True}


@router.post("/{recipe_id}/duplicate")
async def duplicate_recipe(
    recipe_id: int,
    new_name: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Clone recipe with deep copy of ingredients, steps, images, flags. Sub-recipes are linked."""
    result = await db.execute(
        select(Recipe)
        .options(
            selectinload(Recipe.ingredients),
            selectinload(Recipe.sub_recipes),
            selectinload(Recipe.steps),
            selectinload(Recipe.images),
        )
        .where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(404, "Recipe not found")

    name = new_name or f"{original.name} (Copy)"
    clone = Recipe(
        kitchen_id=user.kitchen_id,
        name=name,
        recipe_type=original.recipe_type,
        menu_section_id=original.menu_section_id,
        description=original.description,
        batch_portions=original.batch_portions,
        batch_output_type=original.batch_output_type,
        batch_yield_qty=original.batch_yield_qty,
        batch_yield_unit=original.batch_yield_unit,
        prep_time_minutes=original.prep_time_minutes,
        cook_time_minutes=original.cook_time_minutes,
        notes=original.notes,
        created_by=user.id,
    )
    db.add(clone)
    await db.flush()

    # Copy ingredients
    for ri in original.ingredients:
        db.add(RecipeIngredient(
            recipe_id=clone.id,
            ingredient_id=ri.ingredient_id,
            quantity=ri.quantity,
            unit=ri.unit,
            notes=ri.notes,
            sort_order=ri.sort_order,
        ))

    # Link sub-recipes (not deep copy)
    for sr in original.sub_recipes:
        db.add(RecipeSubRecipe(
            parent_recipe_id=clone.id,
            child_recipe_id=sr.child_recipe_id,
            portions_needed=sr.portions_needed,
            portions_needed_unit=sr.portions_needed_unit,
            notes=sr.notes,
            sort_order=sr.sort_order,
        ))

    # Copy steps
    for step in original.steps:
        db.add(RecipeStep(
            recipe_id=clone.id,
            step_number=step.step_number,
            title=step.title,
            instruction=step.instruction,
            duration_minutes=step.duration_minutes,
            notes=step.notes,
        ))

    # Copy images (copy file references, images are shared)
    for img in original.images:
        db.add(RecipeImage(
            recipe_id=clone.id,
            image_path=img.image_path,
            caption=img.caption,
            image_type=img.image_type,
            sort_order=img.sort_order,
            uploaded_by=user.id,
        ))

    db.add(RecipeChangeLog(
        recipe_id=clone.id,
        change_summary=f"Duplicated from '{original.name}' (ID: {original.id})",
        user_id=user.id,
    ))

    await db.commit()
    return {"id": clone.id, "name": clone.name}


# ── Recipe Ingredients ───────────────────────────────────────────────────────

@router.post("/{recipe_id}/ingredients")
async def add_recipe_ingredient(
    recipe_id: int,
    data: IngredientAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    ing = await db.execute(
        select(Ingredient).where(Ingredient.id == data.ingredient_id, Ingredient.kitchen_id == user.kitchen_id)
    )
    ingredient = ing.scalar_one_or_none()
    if not ingredient:
        raise HTTPException(404, "Ingredient not found")

    # Store unit override if different from standard_unit
    unit_override = None
    display_unit = ingredient.standard_unit
    if data.unit and data.unit != ingredient.standard_unit:
        # Validate it's a compatible unit
        if data.unit not in _get_compatible_units(ingredient.standard_unit):
            raise HTTPException(400, f"Unit '{data.unit}' is not compatible with ingredient's standard unit '{ingredient.standard_unit}'")
        unit_override = data.unit
        display_unit = data.unit

    ri = RecipeIngredient(
        recipe_id=recipe_id,
        ingredient_id=data.ingredient_id,
        quantity=Decimal(str(data.quantity)),
        unit=unit_override,
        yield_percent=Decimal(str(data.yield_percent)),
        notes=data.notes,
        sort_order=data.sort_order,
    )
    db.add(ri)

    db.add(RecipeChangeLog(
        recipe_id=recipe_id,
        change_summary=f"Added {ingredient.name} ({data.quantity}{display_unit})",
        user_id=user.id,
    ))

    await db.commit()
    await db.refresh(ri)
    await _snapshot_recipe_and_parents(recipe_id, db, f"ingredient_added: {ingredient.name}")
    return {"id": ri.id}


@router.patch("/recipe-ingredients/{ri_id}")
async def update_recipe_ingredient(
    ri_id: int,
    data: IngredientUpdateSchema,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient))
        .where(RecipeIngredient.id == ri_id)
    )
    ri = ri_result.scalar_one_or_none()
    if not ri:
        raise HTTPException(404, "Recipe ingredient not found")

    changes = []
    if data.unit is not None:
        new_unit = data.unit if data.unit != ri.ingredient.standard_unit else None
        if new_unit != ri.unit:
            old_display = ri.unit or ri.ingredient.standard_unit
            new_display = data.unit or ri.ingredient.standard_unit
            if old_display != new_display:
                changes.append(f"{ri.ingredient.name} unit changed from {old_display} to {new_display}")
            ri.unit = new_unit
    if data.quantity is not None and float(ri.quantity) != data.quantity:
        old_qty = float(ri.quantity)
        display_unit = ri.unit or ri.ingredient.standard_unit
        changes.append(f"{ri.ingredient.name} quantity changed from {old_qty} to {data.quantity}{display_unit}")
        ri.quantity = Decimal(str(data.quantity))
    if data.yield_percent is not None and float(ri.yield_percent) != data.yield_percent:
        old_yld = float(ri.yield_percent)
        changes.append(f"{ri.ingredient.name} yield changed from {old_yld}% to {data.yield_percent}%")
        ri.yield_percent = Decimal(str(data.yield_percent))
    if data.notes is not None:
        ri.notes = data.notes
    if data.sort_order is not None:
        ri.sort_order = data.sort_order

    if changes:
        db.add(RecipeChangeLog(
            recipe_id=ri.recipe_id,
            change_summary="; ".join(changes),
            user_id=user.id,
        ))

    await db.commit()
    if changes:
        await _snapshot_recipe_and_parents(ri.recipe_id, db, f"ingredient_updated: {'; '.join(changes)}")
    return {"ok": True}


@router.delete("/recipe-ingredients/{ri_id}")
async def remove_recipe_ingredient(
    ri_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient))
        .where(RecipeIngredient.id == ri_id)
    )
    ri = ri_result.scalar_one_or_none()
    if not ri:
        raise HTTPException(404, "Recipe ingredient not found")

    recipe_id_for_snap = ri.recipe_id
    ing_name = ri.ingredient.name if ri.ingredient else 'unknown'
    db.add(RecipeChangeLog(
        recipe_id=recipe_id_for_snap,
        change_summary=f"Removed {ing_name}",
        user_id=user.id,
    ))
    await db.delete(ri)
    await db.commit()
    await _snapshot_recipe_and_parents(recipe_id_for_snap, db, f"ingredient_removed: {ing_name}")
    return {"ok": True}


# ── Sub-recipes ──────────────────────────────────────────────────────────────

@router.post("/{recipe_id}/sub-recipes")
async def add_sub_recipe(
    recipe_id: int,
    data: SubRecipeAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)

    if data.child_recipe_id == recipe_id:
        raise HTTPException(400, "Cannot add recipe as its own sub-recipe")

    # Circular dependency check (max 5 levels)
    cycle_check = await db.execute(
        text("""
            WITH RECURSIVE ancestors AS (
                SELECT parent_recipe_id, child_recipe_id, 1 AS depth
                FROM recipe_sub_recipes WHERE child_recipe_id = :parent_id
                UNION ALL
                SELECT rsr.parent_recipe_id, rsr.child_recipe_id, a.depth + 1
                FROM recipe_sub_recipes rsr JOIN ancestors a ON rsr.child_recipe_id = a.parent_recipe_id
                WHERE a.depth < 5
            )
            SELECT 1 FROM ancestors WHERE parent_recipe_id = :child_id LIMIT 1
        """),
        {"parent_id": recipe_id, "child_id": data.child_recipe_id},
    )
    if cycle_check.fetchone():
        raise HTTPException(400, "Adding this sub-recipe would create a circular dependency")

    sr = RecipeSubRecipe(
        parent_recipe_id=recipe_id,
        child_recipe_id=data.child_recipe_id,
        portions_needed=Decimal(str(data.portions_needed)),
        portions_needed_unit=data.portions_needed_unit,
        notes=data.notes,
        sort_order=data.sort_order,
    )
    db.add(sr)

    child = await db.execute(select(Recipe).where(Recipe.id == data.child_recipe_id))
    child_recipe = child.scalar_one_or_none()
    unit_label = data.portions_needed_unit or _get_output_unit(child_recipe) if child_recipe else "portions"
    db.add(RecipeChangeLog(
        recipe_id=recipe_id,
        change_summary=f"Added sub-recipe '{child_recipe.name if child_recipe else '?'}' ({data.portions_needed} {unit_label})",
        user_id=user.id,
    ))

    await db.commit()
    await db.refresh(sr)
    await _snapshot_recipe_and_parents(recipe_id, db, f"sub_recipe_added: {child_recipe.name if child_recipe else '?'}")
    return {"id": sr.id}


@router.patch("/recipe-sub-recipes/{sr_id}")
async def update_sub_recipe(
    sr_id: int,
    data: SubRecipeUpdateSchema,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sr_result = await db.execute(
        select(RecipeSubRecipe).where(RecipeSubRecipe.id == sr_id)
    )
    sr = sr_result.scalar_one_or_none()
    if not sr:
        raise HTTPException(404, "Sub-recipe not found")
    changed = False
    if data.portions_needed is not None:
        sr.portions_needed = Decimal(str(data.portions_needed))
        changed = True
    if data.portions_needed_unit is not None:
        sr.portions_needed_unit = data.portions_needed_unit or None
        changed = True
    if data.notes is not None:
        sr.notes = data.notes
    if data.sort_order is not None:
        sr.sort_order = data.sort_order
    await db.commit()
    if changed:
        await _snapshot_recipe_and_parents(sr.parent_recipe_id, db, "sub_recipe_qty_updated")
    return {"ok": True}


@router.delete("/recipe-sub-recipes/{sr_id}")
async def remove_sub_recipe(
    sr_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sr_result = await db.execute(
        select(RecipeSubRecipe).where(RecipeSubRecipe.id == sr_id)
    )
    sr = sr_result.scalar_one_or_none()
    if not sr:
        raise HTTPException(404, "Sub-recipe not found")
    parent_id = sr.parent_recipe_id
    await db.delete(sr)
    await db.commit()
    await _snapshot_recipe_and_parents(parent_id, db, "sub_recipe_removed")
    return {"ok": True}


# ── Steps ────────────────────────────────────────────────────────────────────

@router.post("/{recipe_id}/steps")
async def add_step(
    recipe_id: int,
    data: StepCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_recipe(recipe_id, user.kitchen_id, db)
    step = RecipeStep(
        recipe_id=recipe_id,
        step_number=data.step_number,
        title=data.title,
        instruction=data.instruction,
        duration_minutes=data.duration_minutes,
        notes=data.notes,
    )
    db.add(step)
    await db.commit()
    await db.refresh(step)
    return {"id": step.id}


@router.patch("/recipe-steps/{step_id}")
async def update_step(
    step_id: int,
    data: StepUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(RecipeStep).where(RecipeStep.id == step_id))
    step = result.scalar_one_or_none()
    if not step:
        raise HTTPException(404, "Step not found")
    if data.title is not None:
        step.title = data.title or None  # empty string -> null
    if data.instruction is not None:
        step.instruction = data.instruction
    if data.step_number is not None:
        step.step_number = data.step_number
    if data.duration_minutes is not None:
        step.duration_minutes = data.duration_minutes
    if data.notes is not None:
        step.notes = data.notes
    await db.commit()
    return {"ok": True}


@router.delete("/recipe-steps/{step_id}")
async def delete_step(
    step_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(RecipeStep).where(RecipeStep.id == step_id))
    step = result.scalar_one_or_none()
    if not step:
        raise HTTPException(404, "Step not found")
    await db.delete(step)
    await db.commit()
    return {"ok": True}


@router.patch("/{recipe_id}/ingredients/reorder")
async def reorder_ingredients(
    recipe_id: int,
    data: IngredientReorder,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Batch reorder recipe ingredients."""
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    for i, ri_id in enumerate(data.ingredient_ids):
        result = await db.execute(
            select(RecipeIngredient).where(
                RecipeIngredient.id == ri_id,
                RecipeIngredient.recipe_id == recipe_id,
            )
        )
        ri = result.scalar_one_or_none()
        if ri:
            ri.sort_order = i
    await db.commit()
    return {"ok": True}


@router.patch("/{recipe_id}/sub-recipes/reorder")
async def reorder_sub_recipes(
    recipe_id: int,
    data: SubRecipeReorder,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Batch reorder sub-recipes."""
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    for i, sr_id in enumerate(data.sub_recipe_ids):
        result = await db.execute(
            select(RecipeSubRecipe).where(
                RecipeSubRecipe.id == sr_id,
                RecipeSubRecipe.parent_recipe_id == recipe_id,
            )
        )
        sr = result.scalar_one_or_none()
        if sr:
            sr.sort_order = i
    await db.commit()
    return {"ok": True}


@router.patch("/{recipe_id}/steps/reorder")
async def reorder_steps(
    recipe_id: int,
    data: StepReorder,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for i, step_id in enumerate(data.step_ids):
        result = await db.execute(
            select(RecipeStep).where(RecipeStep.id == step_id, RecipeStep.recipe_id == recipe_id)
        )
        step = result.scalar_one_or_none()
        if step:
            step.step_number = i + 1
    await db.commit()
    return {"ok": True}


# ── Images ───────────────────────────────────────────────────────────────────

@router.post("/{recipe_id}/images")
async def upload_image(
    recipe_id: int,
    file: UploadFile = File(...),
    caption: Optional[str] = Query(None),
    image_type: str = Query("general"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)

    # Create directory
    img_dir = os.path.join(DATA_DIR, str(user.kitchen_id), "recipes")
    os.makedirs(img_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "img.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(img_dir, filename)

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    img = RecipeImage(
        recipe_id=recipe_id,
        image_path=filepath,
        caption=caption,
        image_type=image_type,
        uploaded_by=user.id,
    )
    db.add(img)
    await db.commit()
    await db.refresh(img)
    return {"id": img.id, "image_path": img.image_path}


@router.get("/{recipe_id}/images/{image_id}")
async def serve_image(
    recipe_id: int,
    image_id: int,
    token: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    # img tags can't send Authorization header, so auth via query param
    if not token:
        raise HTTPException(401, "Not authenticated")
    user = await get_current_user_from_token(token, db)
    if not user:
        raise HTTPException(401, "Not authenticated")
    await _get_recipe(recipe_id, user.kitchen_id, db)
    result = await db.execute(
        select(RecipeImage).where(RecipeImage.id == image_id, RecipeImage.recipe_id == recipe_id)
    )
    img = result.scalar_one_or_none()
    if not img or not os.path.exists(img.image_path):
        raise HTTPException(404, "Image not found")
    from fastapi.responses import FileResponse
    return FileResponse(img.image_path)


@router.delete("/recipe-images/{image_id}")
async def delete_image(
    image_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(RecipeImage).where(RecipeImage.id == image_id))
    img = result.scalar_one_or_none()
    if not img:
        raise HTTPException(404, "Image not found")
    if os.path.exists(img.image_path):
        os.remove(img.image_path)
    await db.delete(img)
    await db.commit()
    return {"ok": True}


# ── Costing ──────────────────────────────────────────────────────────────────

def _scale_child_sub_recipes(sub_recipes: list, scale: float) -> list:
    """Recursively scale nested sub-recipe data for hierarchical display."""
    result = []
    for sr in sub_recipes:
        result.append({
            "child_recipe_id": sr["child_recipe_id"],
            "child_recipe_name": sr["child_recipe_name"],
            "batch_output_type": sr.get("batch_output_type", "portions"),
            "output_qty": sr.get("output_qty", 1),
            "output_unit": sr.get("output_unit", "portion"),
            "portions_needed": round(sr["portions_needed"] * scale, 4),
            "cost_contribution": round(sr["cost_contribution"] * scale, 4) if sr.get("cost_contribution") else None,
            "child_ingredients": [
                {
                    "ingredient_id": ci["ingredient_id"],
                    "ingredient_name": ci["ingredient_name"],
                    "quantity": round(ci["quantity"] * scale, 4),
                    "unit": ci["unit"],
                    "yield_percent": ci.get("yield_percent", 100.0),
                    "cost_recent": round(ci["cost_recent"] * scale, 4) if ci.get("cost_recent") else None,
                    "cost_min": round(ci["cost_min"] * scale, 4) if ci.get("cost_min") else None,
                    "cost_max": round(ci["cost_max"] * scale, 4) if ci.get("cost_max") else None,
                    "is_manual_price": ci.get("is_manual_price", False),
                    "has_no_price": ci.get("has_no_price", False),
                }
                for ci in sr.get("child_ingredients", [])
            ],
            "child_sub_recipes": _scale_child_sub_recipes(sr.get("child_sub_recipes", []), scale),
        })
    return result


async def _calc_recipe_cost(recipe_id: int, db: AsyncSession, scale_to: Optional[float] = None) -> dict:
    """Calculate full cost breakdown for a recipe."""
    recipe_result = await db.execute(
        select(Recipe)
        .options(
            selectinload(Recipe.ingredients).selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.sources),
            selectinload(Recipe.sub_recipes).selectinload(RecipeSubRecipe.child_recipe),
        )
        .where(Recipe.id == recipe_id)
    )
    recipe = recipe_result.scalar_one_or_none()
    if not recipe:
        return {}

    output_qty = _get_output_qty(recipe)
    output_unit = _get_output_unit(recipe)
    scale_factor = (scale_to / output_qty) if scale_to else 1.0

    ingredient_costs = []
    total_ing_cost = Decimal(0)
    total_ing_cost_min = Decimal(0)
    total_ing_cost_max = Decimal(0)

    for ri in recipe.ingredients:
        ing = ri.ingredient
        if not ing:
            continue

        display_unit = ri.unit or ing.standard_unit
        qty_display = float(ri.quantity) * scale_factor
        # Convert to standard unit for cost calculation
        qty_std = _convert_unit(qty_display, display_unit, ing.standard_unit)
        yld = float(ri.yield_percent) if ri.yield_percent else 100.0

        # Get all source prices
        source_prices = []
        for src in (ing.sources or []):
            if src.price_per_std_unit:
                source_prices.append({
                    "supplier_id": src.supplier_id,
                    "price_per_std_unit": float(src.price_per_std_unit),
                    "latest_invoice_date": str(src.latest_invoice_date) if src.latest_invoice_date else None,
                })

        # Effective prices
        recent_price = None
        min_price = None
        max_price = None
        if source_prices:
            prices = [sp["price_per_std_unit"] for sp in source_prices]
            min_price = min(prices)
            max_price = max(prices)
            recent_price = source_prices[0]["price_per_std_unit"]
            # Find most recent by date
            dated = [(sp.get("latest_invoice_date", ""), sp["price_per_std_unit"]) for sp in source_prices]
            dated.sort(reverse=True)
            if dated:
                recent_price = dated[0][1]
        elif ing.manual_price:
            recent_price = min_price = max_price = float(ing.manual_price)

        ing_is_free = getattr(ing, 'is_free', False)
        is_manual_price = (not source_prices and ing.manual_price is not None) if not ing_is_free else False
        has_no_price = (recent_price is None) if not ing_is_free else False

        # Apply yield adjustment
        if recent_price and yld > 0:
            recent_eff = recent_price / (yld / 100)
        else:
            recent_eff = recent_price
        if min_price and yld > 0:
            min_eff = min_price / (yld / 100)
        else:
            min_eff = min_price
        if max_price and yld > 0:
            max_eff = max_price / (yld / 100)
        else:
            max_eff = max_price

        # Cost is calculated in standard units
        cost_recent = round(qty_std * recent_eff, 4) if recent_eff else None
        cost_min = round(qty_std * min_eff, 4) if min_eff else None
        cost_max = round(qty_std * max_eff, 4) if max_eff else None

        if cost_recent:
            total_ing_cost += Decimal(str(cost_recent))
        if cost_min:
            total_ing_cost_min += Decimal(str(cost_min))
        if cost_max:
            total_ing_cost_max += Decimal(str(cost_max))

        ingredient_costs.append({
            "ingredient_id": ing.id,
            "ingredient_name": ing.name,
            "quantity": qty_display,
            "unit": display_unit,
            "yield_percent": yld,
            "recent_price": round(recent_eff, 6) if recent_eff else None,
            "min_price": round(min_eff, 6) if min_eff else None,
            "max_price": round(max_eff, 6) if max_eff else None,
            "cost_recent": cost_recent,
            "cost_min": cost_min,
            "cost_max": cost_max,
            "sources": source_prices,
            "is_manual_price": is_manual_price,
            "has_no_price": has_no_price,
        })

    # Sub-recipe costs
    sub_recipe_costs = []
    total_sub_cost = Decimal(0)
    total_sub_cost_min = Decimal(0)
    total_sub_cost_max = Decimal(0)

    for sr in recipe.sub_recipes:
        child = sr.child_recipe
        if not child:
            continue
        child_cost_data = await _calc_recipe_cost(child.id, db)
        child_total = Decimal(str(child_cost_data.get("total_cost_recent", 0) or 0))
        child_total_min = Decimal(str(child_cost_data.get("total_cost_min", 0) or 0))
        child_total_max = Decimal(str(child_cost_data.get("total_cost_max", 0) or 0))
        child_output_qty = _get_output_qty(child)
        child_output_unit = _get_output_unit(child)
        # Convert portions_needed to child output unit if different unit was used
        needed_unit = sr.portions_needed_unit or child_output_unit
        portions_needed_raw = float(sr.portions_needed) * scale_factor
        portions_needed = _convert_unit(portions_needed_raw, needed_unit, child_output_unit)
        scale_ratio = portions_needed / child_output_qty if child_output_qty else 0
        cost_contribution = float(child_total) * scale_ratio if child_total else None
        cost_contribution_min = float(child_total_min) * scale_ratio if child_total_min else None
        cost_contribution_max = float(child_total_max) * scale_ratio if child_total_max else None

        if cost_contribution:
            total_sub_cost += Decimal(str(cost_contribution))
        if cost_contribution_min:
            total_sub_cost_min += Decimal(str(cost_contribution_min))
        if cost_contribution_max:
            total_sub_cost_max += Decimal(str(cost_contribution_max))

        # Scale child ingredients by portions_needed / child_output_qty
        # Include both direct ingredients AND ingredients from the child's own sub-recipes
        child_scale = portions_needed / child_output_qty if child_output_qty else 1
        child_ingredients = []
        for ci in child_cost_data.get("ingredients", []):
            child_ingredients.append({
                "ingredient_id": ci["ingredient_id"],
                "ingredient_name": ci["ingredient_name"],
                "quantity": round(ci["quantity"] * child_scale, 4),
                "unit": ci["unit"],
                "yield_percent": ci["yield_percent"],
                "cost_recent": round(ci["cost_recent"] * child_scale, 4) if ci.get("cost_recent") else None,
                "cost_min": round(ci["cost_min"] * child_scale, 4) if ci.get("cost_min") else None,
                "cost_max": round(ci["cost_max"] * child_scale, 4) if ci.get("cost_max") else None,
                "is_manual_price": ci.get("is_manual_price", False),
                "has_no_price": ci.get("has_no_price", False),
            })
        # Build hierarchical child_sub_recipes from the child's own sub-recipes
        child_sub_recipes = _scale_child_sub_recipes(
            child_cost_data.get("sub_recipes", []), child_scale
        )

        sub_recipe_costs.append({
            "child_recipe_id": child.id,
            "child_recipe_name": child.name,
            "batch_portions": child.batch_portions,
            "batch_output_type": child.batch_output_type or "portions",
            "output_qty": child_output_qty,
            "output_unit": child_output_unit,
            "portions_needed": portions_needed,
            "cost_per_portion": float(child_total) / child_output_qty if child_total and child_output_qty else None,
            "cost_contribution": round(cost_contribution, 4) if cost_contribution else None,
            "child_ingredients": child_ingredients,
            "child_sub_recipes": child_sub_recipes,
        })

    total_cost = float(total_ing_cost + total_sub_cost)
    total_cost_min = float(total_ing_cost_min + total_sub_cost_min)
    total_cost_max = float(total_ing_cost_max + total_sub_cost_max)
    effective_output = scale_to if scale_to else output_qty
    cost_per_portion = total_cost / effective_output if effective_output and total_cost else None

    # GP calculator for dishes (gross prices incl. 20% VAT)
    gp_comparison = None
    if recipe.recipe_type == "dish" and cost_per_portion:
        vat_rate = 1.20
        gp_comparison = [
            {"gp_target": pct, "suggested_price": round(cost_per_portion / (1 - pct / 100) * vat_rate, 2)}
            for pct in [60, 65, 70, 75, 80]
        ]

    return {
        "recipe_id": recipe.id,
        "batch_portions": recipe.batch_portions or 1,
        "batch_output_type": recipe.batch_output_type or "portions",
        "output_qty": effective_output,
        "output_unit": output_unit,
        "ingredients": ingredient_costs,
        "sub_recipes": sub_recipe_costs,
        "total_cost_recent": round(total_cost, 4) if total_cost else None,
        "total_cost_min": round(total_cost_min, 4) if total_cost_min else None,
        "total_cost_max": round(total_cost_max, 4) if total_cost_max else None,
        "cost_per_portion": round(cost_per_portion, 4) if cost_per_portion else None,
        "gp_comparison": gp_comparison,
    }


@router.get("/{recipe_id}/costing")
async def get_recipe_costing(
    recipe_id: int,
    scale_to: Optional[float] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    return await _calc_recipe_cost(recipe_id, db, scale_to)


@router.get("/{recipe_id}/cost-trend")
async def get_cost_trend(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_recipe(recipe_id, user.kitchen_id, db)
    result = await db.execute(
        select(RecipeCostSnapshot)
        .where(RecipeCostSnapshot.recipe_id == recipe_id)
        .order_by(RecipeCostSnapshot.snapshot_date)
    )
    snapshots = result.scalars().all()

    # Get change log entries to show what caused cost changes
    log_result = await db.execute(
        select(RecipeChangeLog)
        .where(RecipeChangeLog.recipe_id == recipe_id)
        .order_by(RecipeChangeLog.created_at)
    )
    logs = log_result.scalars().all()

    # Group changes by date for annotation
    changes_by_date: dict[str, list[str]] = {}
    for log in logs:
        if log.created_at:
            log_date = str(log.created_at.date()) if hasattr(log.created_at, 'date') else str(log.created_at)[:10]
            changes_by_date.setdefault(log_date, []).append(log.change_summary)

    return {
        "snapshots": [
            {
                "id": s.id,
                "created_at": str(s.snapshot_date),
                "cost_per_portion": float(s.cost_per_portion),
                "total_cost": float(s.total_cost),
                "trigger": s.trigger_source or "",
                "changes": changes_by_date.get(str(s.snapshot_date), []),
            }
            for s in snapshots
        ],
    }


async def snapshot_recipe_cost(recipe_id: int, db: AsyncSession, trigger_source: str = "manual_recalc"):
    """Calculate and store/upsert a cost snapshot for today."""
    cost_data = await _calc_recipe_cost(recipe_id, db)
    total_cost = cost_data.get("total_cost_recent")
    cost_per_portion = cost_data.get("cost_per_portion")
    if total_cost is None or cost_per_portion is None:
        return

    today = date.today()
    existing = await db.execute(
        select(RecipeCostSnapshot).where(
            RecipeCostSnapshot.recipe_id == recipe_id,
            RecipeCostSnapshot.snapshot_date == today,
        )
    )
    snap = existing.scalar_one_or_none()
    if snap:
        snap.cost_per_portion = Decimal(str(cost_per_portion))
        snap.total_cost = Decimal(str(total_cost))
        snap.trigger_source = trigger_source
    else:
        db.add(RecipeCostSnapshot(
            recipe_id=recipe_id,
            cost_per_portion=Decimal(str(cost_per_portion)),
            total_cost=Decimal(str(total_cost)),
            snapshot_date=today,
            trigger_source=trigger_source,
        ))


async def _snapshot_recipe_and_parents(recipe_id: int, db: AsyncSession, trigger_source: str = ""):
    """Snapshot a recipe and any parent recipes that use it as a sub-recipe.
    Also bumps updated_at so menu staleness detection picks up content changes."""
    # Bump updated_at on the recipe itself (ingredient/sub-recipe changes don't trigger onupdate)
    recipe_result = await db.execute(select(Recipe).where(Recipe.id == recipe_id))
    recipe = recipe_result.scalar_one_or_none()
    if recipe:
        recipe.updated_at = datetime.utcnow()

    await snapshot_recipe_cost(recipe_id, db, trigger_source)
    parent_result = await db.execute(
        select(RecipeSubRecipe.parent_recipe_id).where(RecipeSubRecipe.child_recipe_id == recipe_id)
    )
    for (parent_id,) in parent_result.fetchall():
        # Bump parent updated_at too
        p_result = await db.execute(select(Recipe).where(Recipe.id == parent_id))
        parent = p_result.scalar_one_or_none()
        if parent:
            parent.updated_at = datetime.utcnow()
        await snapshot_recipe_cost(parent_id, db, trigger_source)
    await db.commit()


async def snapshot_recipes_using_ingredient(
    ingredient_id: int,
    db: AsyncSession,
    trigger_source: str = "",
    price_info: dict | None = None,
):
    """Find all recipes using this ingredient and snapshot their costs.

    If price_info is provided ({"name", "unit", "old_price", "new_price"}),
    a RecipeChangeLog entry is created for each affected recipe.
    """
    # Direct usage
    ri_result = await db.execute(
        select(RecipeIngredient.recipe_id).where(RecipeIngredient.ingredient_id == ingredient_id)
    )
    recipe_ids = set(r[0] for r in ri_result.fetchall())

    # Also find recipes that use sub-recipes containing this ingredient (1 level)
    for rid in list(recipe_ids):
        parent_result = await db.execute(
            select(RecipeSubRecipe.parent_recipe_id).where(RecipeSubRecipe.child_recipe_id == rid)
        )
        for (parent_id,) in parent_result.fetchall():
            recipe_ids.add(parent_id)

    # Build change log message if price info available
    change_msg = None
    if price_info:
        name = price_info["name"]
        unit = price_info.get("unit", "")
        old_p = price_info.get("old_price")
        new_p = price_info["new_price"]
        unit_label = f"/{unit}" if unit else ""
        if old_p is not None:
            change_msg = f"{name} price changed: £{old_p:.4f}{unit_label} → £{new_p:.4f}{unit_label}"
        else:
            change_msg = f"{name} price set: £{new_p:.4f}{unit_label}"

    for rid in recipe_ids:
        # Bump updated_at so menu staleness detection picks up ingredient flag changes
        r_result = await db.execute(select(Recipe).where(Recipe.id == rid))
        r = r_result.scalar_one_or_none()
        if r:
            r.updated_at = datetime.utcnow()
        await snapshot_recipe_cost(rid, db, trigger_source)
        if change_msg:
            db.add(RecipeChangeLog(
                recipe_id=rid,
                change_summary=change_msg,
                user_id=None,
            ))
    if recipe_ids:
        await db.commit()


# ── Recipe Change Log ────────────────────────────────────────────────────────

@router.get("/{recipe_id}/change-log")
async def get_change_log(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_recipe(recipe_id, user.kitchen_id, db)
    result = await db.execute(
        select(RecipeChangeLog)
        .options(selectinload(RecipeChangeLog.user))
        .where(RecipeChangeLog.recipe_id == recipe_id)
        .order_by(RecipeChangeLog.created_at.desc())
    )
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "change_summary": l.change_summary,
            "username": l.user.name if l.user else "",
            "created_at": str(l.created_at) if l.created_at else "",
        }
        for l in logs
    ]


# ── Print / Recipe Card HTML ────────────────────────────────────────────────

@router.get("/{recipe_id}/print")
async def print_recipe(
    recipe_id: int,
    format: str = Query("full"),  # "full" | "kitchen"
    token: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    # window.open() can't send Authorization header, so auth via query param
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await get_current_user_from_token(token, db)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    full_data = await get_recipe(recipe_id, user, db)
    cost_data = await _calc_recipe_cost(recipe_id, db)

    # Get flags
    from api.food_flags import compute_recipe_flags
    flags = await compute_recipe_flags(recipe_id, user.kitchen_id, db)

    html = _build_recipe_html(full_data, cost_data, flags, format, recipe_id=recipe_id, token=token)
    return HTMLResponse(content=html)


def _build_recipe_html(recipe_data: dict, cost_data: dict, flags, format: str = "full", recipe_id: int = 0, token: str = "") -> str:
    """Generate print-optimised HTML for a recipe."""
    esc = html_escape
    name = esc(recipe_data.get("name", ""))
    recipe_type = recipe_data.get("recipe_type", "dish")
    batch = recipe_data.get("batch_portions", 1)
    batch_output_type = recipe_data.get("batch_output_type", "portions")
    output_qty = recipe_data.get("output_qty", batch)
    output_unit = recipe_data.get("output_unit", "portion")
    description = esc(recipe_data.get("description", "") or "")
    prep_time = recipe_data.get("prep_time_minutes")
    cook_time = recipe_data.get("cook_time_minutes")

    # Flag badges
    flag_html = ""
    for f in flags:
        if f.is_active:
            color = "#dc3545" if f.propagation_type == "contains" else "#28a745"
            badge_style = f"display:inline-block;padding:2px 8px;margin:2px;border-radius:12px;background:{color};color:white;font-size:12px;"
            if f.excludable_on_request:
                badge_style += "border:2px dashed white;"
            flag_html += f'<span style="{badge_style}">{esc(f.flag_code or f.flag_name)}</span>'

    # Ingredients table
    ing_rows = ""
    for ing in recipe_data.get("ingredients", []):
        cost_str = f"£{ing['cost']:.2f}" if ing.get("cost") else "-"
        ing_rows += f"""<tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">{esc(ing['ingredient_name'])}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">{ing['quantity']:g}{esc(ing['unit'])}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">{cost_str}</td>
        </tr>"""

    # Sub-recipes — match cost_data child_ingredients by child_recipe_id
    cost_sub_recipes = {sr["child_recipe_id"]: sr for sr in cost_data.get("sub_recipes", [])}
    sub_rows = ""
    for sr in recipe_data.get("sub_recipes", []):
        cost_sr = cost_sub_recipes.get(sr["child_recipe_id"], {})
        cost_str = f"£{sr['cost_contribution']:.2f}" if sr.get("cost_contribution") else "-"
        sr_unit = sr.get("output_unit", "portion")
        sr_unit_label = f"{sr['portions_needed']:g} {sr_unit}{'s' if sr['portions_needed'] != 1 and sr_unit == 'portion' else ''}"
        sub_rows += f"""<tr style="background:#f0f0f0;">
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;font-weight:600;">▸ {esc(sr['child_recipe_name'])} ({sr_unit_label})</td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;"></td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;font-weight:600;">{cost_str}</td>
        </tr>"""
        for ci in cost_sr.get("child_ingredients", []):
            ci_cost = f"£{ci['cost_recent']:.2f}" if ci.get("cost_recent") else "-"
            sub_rows += f"""<tr style="background:#fafafa;">
            <td style="padding:4px 10px 4px 30px;border-bottom:1px solid #f0f0f0;color:#666;">↳ {esc(ci['ingredient_name'])}</td>
            <td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">{ci['quantity']:g}{esc(ci['unit'])}</td>
            <td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">{ci_cost}</td>
        </tr>"""

    # Steps
    steps_html = ""
    for step in recipe_data.get("steps", []):
        dur = f" ({step['duration_minutes']} min)" if step.get("duration_minutes") else ""
        title = esc(step['title']) if step.get('title') else None
        instr = esc(step['instruction'])
        if title:
            steps_html += f"<li style='margin-bottom:8px;'><strong>{title}</strong>{dur}<br/><span style='color:#555;'>{instr}</span></li>"
        else:
            steps_html += f"<li style='margin-bottom:8px;'>{instr}{f' <em>{dur}</em>' if dur else ''}</li>"

    # Cost summary
    cost_per_portion = cost_data.get("cost_per_portion")
    total_cost = cost_data.get("total_cost_recent")
    cost_summary = ""
    if format == "full" and cost_per_portion:
        cost_unit_label = f"Cost per {output_unit}" if output_unit != "portion" else "Cost per portion"
        cost_summary = f"""
        <div style="margin-top:20px;padding:12px;background:#f0f0f0;border-radius:6px;">
            <strong>{cost_unit_label}:</strong> £{cost_per_portion:.4f} |
            <strong>Total cost:</strong> £{total_cost:.2f}
        </div>"""

    # Images (plating photos for kitchen card)
    images_html = ""
    if format == "kitchen":
        plating_images = [img for img in recipe_data.get("images", []) if img.get("image_type") == "plating"]
        if not plating_images:
            plating_images = recipe_data.get("images", [])[:1]
        for img in plating_images:
            img_url = f"/api/recipes/{recipe_id}/images/{img['id']}?token={token}"
            images_html += f'<img src="{esc(img_url)}" style="max-width:300px;border-radius:8px;margin:10px 0;" />'

    time_info = ""
    if prep_time or cook_time:
        parts = []
        if prep_time:
            parts.append(f"Prep: {prep_time} min")
        if cook_time:
            parts.append(f"Cook: {cook_time} min")
        time_info = f"<p style='color:#666;'>{' | '.join(parts)}</p>"

    kitchen_font_size = "font-size:16px;" if format == "kitchen" else ""

    return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{name}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:800px; margin:0 auto; padding:20px; {kitchen_font_size} }}
        @media print {{
            body {{ padding: 0; }}
            .no-print {{ display: none; }}
        }}
        h1 {{ margin-bottom: 4px; }}
        table {{ width: 100%; border-collapse: collapse; margin: 10px 0; }}
        th {{ text-align: left; padding: 8px 10px; border-bottom: 2px solid #ccc; background: #f5f5f5; }}
    </style>
</head>
<body>
    <h1>{name}</h1>
    <p style="color:#666;">
        <span style="background:#e0e0e0;padding:2px 8px;border-radius:4px;font-size:13px;">{recipe_type.upper()}</span>
        {f'Yield: {output_qty:g}{output_unit}' if recipe_type == 'component' and batch_output_type == 'bulk' else (f'Batch: {batch} portions' if recipe_type == 'component' else '')}
    </p>
    {time_info}
    {f'<p>{description}</p>' if description else ''}
    <div style="margin:10px 0;">{flag_html}</div>
    {images_html}

    <h2>Ingredients</h2>
    <table>
        <thead><tr>
            <th>Ingredient</th>
            <th style="text-align:right;">Quantity</th>
            <th style="text-align:right;">Cost</th>
        </tr></thead>
        <tbody>{ing_rows}{sub_rows}</tbody>
    </table>

    {cost_summary}

    {'<h2>Method</h2><ol>' + steps_html + '</ol>' if steps_html else ''}

    {f'<p style="color:#999;font-size:12px;margin-top:30px;">Printed {date.today().strftime("%d/%m/%Y")}</p>'}
</body>
</html>"""


# ── Helpers ──────────────────────────────────────────────────────────────────

# Unit conversion factors to a common base (g for weight, ml for volume)
_UNIT_TO_BASE = {"g": 1.0, "kg": 1000.0, "ml": 1.0, "ltr": 1000.0}

# Which units are compatible (same measurement type)
_COMPATIBLE_UNITS = {
    "g": ("g", "kg"), "kg": ("g", "kg"),
    "ml": ("ml", "ltr"), "ltr": ("ml", "ltr"),
    "portion": ("portion",), "each": ("each",),
}


def _convert_unit(value: float, from_unit: str, to_unit: str) -> float:
    """Convert a value between compatible units. Returns original value if incompatible."""
    if from_unit == to_unit:
        return value
    from_base = _UNIT_TO_BASE.get(from_unit)
    to_base = _UNIT_TO_BASE.get(to_unit)
    if from_base is None or to_base is None:
        return value
    # Check compatibility
    if to_unit not in _COMPATIBLE_UNITS.get(from_unit, ()):
        return value
    return value * from_base / to_base


def _get_compatible_units(unit: str) -> list[str]:
    """Get list of compatible units for a given output unit."""
    return list(_COMPATIBLE_UNITS.get(unit, (unit,)))


def _get_output_qty(recipe) -> float:
    """Unified output quantity: bulk uses yield_qty, portioned uses batch_portions."""
    if recipe.batch_output_type == "bulk" and recipe.batch_yield_qty:
        return float(recipe.batch_yield_qty)
    return recipe.batch_portions or 1

def _get_output_unit(recipe) -> str:
    """Unified output unit label: bulk uses yield_unit, portioned uses 'portion'."""
    if recipe.batch_output_type == "bulk" and recipe.batch_yield_unit:
        return recipe.batch_yield_unit
    return "portion"

async def _get_recipe(recipe_id: int, kitchen_id: int, db: AsyncSession) -> Recipe:
    result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == kitchen_id)
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")
    return recipe
