"""
Recipe API — CRUD, costing, sub-recipe cycle check, scaling, menu sections,
cost snapshots, print HTML (full + kitchen card).
"""
import os
import uuid
import logging
from datetime import date, datetime
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
from models.food_flag import RecipeFlag
from models.settings import KitchenSettings
from auth.jwt import get_current_user, get_current_user_from_token
from api.ingredients import convert_to_standard, UNIT_CONVERSIONS

logger = logging.getLogger(__name__)

router = APIRouter()

DATA_DIR = "/app/data"


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class MenuSectionCreate(BaseModel):
    name: str
    sort_order: int = 0

class MenuSectionUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None

class MenuSectionResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    recipe_count: int = 0

class RecipeCreate(BaseModel):
    name: str
    recipe_type: str = "plated"  # "component" | "plated"
    menu_section_id: Optional[int] = None
    description: Optional[str] = None
    batch_portions: int = 1
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    notes: Optional[str] = None

class RecipeUpdate(BaseModel):
    name: Optional[str] = None
    recipe_type: Optional[str] = None
    menu_section_id: Optional[int] = None
    description: Optional[str] = None
    batch_portions: Optional[int] = None
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    notes: Optional[str] = None
    is_archived: Optional[bool] = None
    kds_menu_item_name: Optional[str] = None

class IngredientAdd(BaseModel):
    ingredient_id: int
    quantity: float
    notes: Optional[str] = None
    sort_order: int = 0

class IngredientUpdateSchema(BaseModel):
    quantity: Optional[float] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class SubRecipeAdd(BaseModel):
    child_recipe_id: int
    portions_needed: float
    notes: Optional[str] = None
    sort_order: int = 0

class SubRecipeUpdateSchema(BaseModel):
    portions_needed: Optional[float] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None

class StepCreate(BaseModel):
    instruction: str
    step_number: int = 0
    duration_minutes: Optional[int] = None
    notes: Optional[str] = None

class StepUpdate(BaseModel):
    instruction: Optional[str] = None
    step_number: Optional[int] = None
    duration_minutes: Optional[int] = None
    notes: Optional[str] = None

class StepReorder(BaseModel):
    step_ids: list[int]

class RecipeListItem(BaseModel):
    id: int
    name: str
    recipe_type: str
    menu_section_id: Optional[int] = None
    menu_section_name: Optional[str] = None
    batch_portions: int = 1
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    count_sub = (
        select(Recipe.menu_section_id, func.count(Recipe.id).label("cnt"))
        .where(Recipe.kitchen_id == user.kitchen_id, Recipe.is_archived == False)
        .group_by(Recipe.menu_section_id)
        .subquery()
    )
    result = await db.execute(
        select(MenuSection, func.coalesce(count_sub.c.cnt, 0).label("recipe_count"))
        .outerjoin(count_sub, MenuSection.id == count_sub.c.menu_section_id)
        .where(MenuSection.kitchen_id == user.kitchen_id)
        .order_by(MenuSection.sort_order, MenuSection.name)
    )
    return [
        MenuSectionResponse(id=s.id, name=s.name, sort_order=s.sort_order, recipe_count=cnt)
        for s, cnt in result.all()
    ]


@router.post("/menu-sections")
async def create_menu_section(
    data: MenuSectionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sec = MenuSection(kitchen_id=user.kitchen_id, name=data.name, sort_order=data.sort_order)
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

    plated = (await db.execute(
        select(func.count()).select_from(Recipe).where(Recipe.kitchen_id == kid, Recipe.recipe_type == "plated", Recipe.is_archived == False)
    )).scalar() or 0

    component = total - plated

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

    return {
        "total_recipes": total,
        "plated_recipes": plated,
        "component_recipes": component,
        "unmapped_ingredients": unmapped,
    }


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
    if data.recipe_type not in ("component", "plated"):
        raise HTTPException(400, "recipe_type must be 'component' or 'plated'")

    recipe = Recipe(
        kitchen_id=user.kitchen_id,
        name=data.name.strip(),
        recipe_type=data.recipe_type,
        menu_section_id=data.menu_section_id,
        description=data.description,
        batch_portions=data.batch_portions if data.recipe_type == "component" else 1,
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
        # Get effective price
        eff_price = None
        if ing.sources:
            priced = [s for s in ing.sources if s.price_per_std_unit]
            if priced:
                latest = max(priced, key=lambda s: s.latest_invoice_date or date.min)
                raw = float(latest.price_per_std_unit)
                yld = float(ing.yield_percent) if ing.yield_percent else 100.0
                eff_price = raw / (yld / 100) if yld > 0 else raw
        if eff_price is None and ing.manual_price:
            yld = float(ing.yield_percent) if ing.yield_percent else 100.0
            eff_price = float(ing.manual_price) / (yld / 100) if yld > 0 else float(ing.manual_price)

        cost = float(ri.quantity) * eff_price if eff_price and ri.quantity else None

        ingredients.append({
            "id": ri.id,
            "ingredient_id": ing.id,
            "ingredient_name": ing.name,
            "quantity": float(ri.quantity),
            "unit": ing.standard_unit,
            "yield_percent": float(ing.yield_percent) if ing.yield_percent else 100.0,
            "effective_price": round(eff_price, 6) if eff_price else None,
            "cost": round(cost, 4) if cost else None,
            "notes": ri.notes,
            "sort_order": ri.sort_order,
        })

    sub_recipes = []
    for sr in sorted(recipe.sub_recipes, key=lambda x: x.sort_order):
        child = sr.child_recipe
        if not child:
            continue
        # Get child cost
        child_snap = await db.execute(
            select(RecipeCostSnapshot)
            .where(RecipeCostSnapshot.recipe_id == child.id)
            .order_by(RecipeCostSnapshot.snapshot_date.desc())
            .limit(1)
        )
        child_cost_snap = child_snap.scalar_one_or_none()
        child_cost_per_portion = float(child_cost_snap.cost_per_portion) if child_cost_snap else None
        cost_contribution = None
        if child_cost_per_portion and sr.portions_needed:
            cost_contribution = float(sr.portions_needed) * child_cost_per_portion

        sub_recipes.append({
            "id": sr.id,
            "child_recipe_id": child.id,
            "child_recipe_name": child.name,
            "child_recipe_type": child.recipe_type,
            "batch_portions": child.batch_portions,
            "portions_needed": float(sr.portions_needed),
            "cost_per_portion": child_cost_per_portion,
            "cost_contribution": round(cost_contribution, 4) if cost_contribution else None,
            "notes": sr.notes,
            "sort_order": sr.sort_order,
        })

    steps = [
        {
            "id": s.id, "step_number": s.step_number, "instruction": s.instruction,
            "image_path": s.image_path, "duration_minutes": s.duration_minutes,
            "notes": s.notes,
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
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "notes": recipe.notes,
        "is_archived": recipe.is_archived,
        "kds_menu_item_name": recipe.kds_menu_item_name,
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

    if changes:
        db.add(RecipeChangeLog(
            recipe_id=recipe_id,
            change_summary="; ".join(changes),
            user_id=user.id,
        ))

    await db.commit()
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
            notes=ri.notes,
            sort_order=ri.sort_order,
        ))

    # Link sub-recipes (not deep copy)
    for sr in original.sub_recipes:
        db.add(RecipeSubRecipe(
            parent_recipe_id=clone.id,
            child_recipe_id=sr.child_recipe_id,
            portions_needed=sr.portions_needed,
            notes=sr.notes,
            sort_order=sr.sort_order,
        ))

    # Copy steps
    for step in original.steps:
        db.add(RecipeStep(
            recipe_id=clone.id,
            step_number=step.step_number,
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

    ri = RecipeIngredient(
        recipe_id=recipe_id,
        ingredient_id=data.ingredient_id,
        quantity=Decimal(str(data.quantity)),
        notes=data.notes,
        sort_order=data.sort_order,
    )
    db.add(ri)

    db.add(RecipeChangeLog(
        recipe_id=recipe_id,
        change_summary=f"Added {ingredient.name} ({data.quantity}{ingredient.standard_unit})",
        user_id=user.id,
    ))

    await db.commit()
    await db.refresh(ri)
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
    if data.quantity is not None and float(ri.quantity) != data.quantity:
        old_qty = float(ri.quantity)
        changes.append(f"{ri.ingredient.name} quantity changed from {old_qty} to {data.quantity}")
        ri.quantity = Decimal(str(data.quantity))
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

    db.add(RecipeChangeLog(
        recipe_id=ri.recipe_id,
        change_summary=f"Removed {ri.ingredient.name if ri.ingredient else 'unknown'}",
        user_id=user.id,
    ))
    await db.delete(ri)
    await db.commit()
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
        notes=data.notes,
        sort_order=data.sort_order,
    )
    db.add(sr)

    child = await db.execute(select(Recipe).where(Recipe.id == data.child_recipe_id))
    child_recipe = child.scalar_one_or_none()
    db.add(RecipeChangeLog(
        recipe_id=recipe_id,
        change_summary=f"Added sub-recipe '{child_recipe.name if child_recipe else '?'}' ({data.portions_needed} portions)",
        user_id=user.id,
    ))

    await db.commit()
    await db.refresh(sr)
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
    if data.portions_needed is not None:
        sr.portions_needed = Decimal(str(data.portions_needed))
    if data.notes is not None:
        sr.notes = data.notes
    if data.sort_order is not None:
        sr.sort_order = data.sort_order
    await db.commit()
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
    await db.delete(sr)
    await db.commit()
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
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

async def _calc_recipe_cost(recipe_id: int, db: AsyncSession, scale_to: Optional[int] = None) -> dict:
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

    batch_portions = recipe.batch_portions or 1
    scale_factor = (scale_to / batch_portions) if scale_to else 1.0

    ingredient_costs = []
    total_ing_cost = Decimal(0)
    total_ing_cost_min = Decimal(0)
    total_ing_cost_max = Decimal(0)

    for ri in recipe.ingredients:
        ing = ri.ingredient
        if not ing:
            continue

        qty = float(ri.quantity) * scale_factor
        yld = float(ing.yield_percent) if ing.yield_percent else 100.0

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

        cost_recent = round(qty * recent_eff, 4) if recent_eff else None
        cost_min = round(qty * min_eff, 4) if min_eff else None
        cost_max = round(qty * max_eff, 4) if max_eff else None

        if cost_recent:
            total_ing_cost += Decimal(str(cost_recent))
        if cost_min:
            total_ing_cost_min += Decimal(str(cost_min))
        if cost_max:
            total_ing_cost_max += Decimal(str(cost_max))

        ingredient_costs.append({
            "ingredient_id": ing.id,
            "ingredient_name": ing.name,
            "quantity": qty,
            "unit": ing.standard_unit,
            "yield_percent": yld,
            "recent_price": round(recent_eff, 6) if recent_eff else None,
            "min_price": round(min_eff, 6) if min_eff else None,
            "max_price": round(max_eff, 6) if max_eff else None,
            "cost_recent": cost_recent,
            "cost_min": cost_min,
            "cost_max": cost_max,
            "sources": source_prices,
        })

    # Sub-recipe costs
    sub_recipe_costs = []
    total_sub_cost = Decimal(0)

    for sr in recipe.sub_recipes:
        child = sr.child_recipe
        if not child:
            continue
        child_cost_data = await _calc_recipe_cost(child.id, db)
        child_total = Decimal(str(child_cost_data.get("total_cost_recent", 0) or 0))
        child_batch = child.batch_portions or 1
        portions_needed = float(sr.portions_needed) * scale_factor
        cost_contribution = float(child_total) * (portions_needed / child_batch) if child_total else None

        if cost_contribution:
            total_sub_cost += Decimal(str(cost_contribution))

        sub_recipe_costs.append({
            "child_recipe_id": child.id,
            "child_recipe_name": child.name,
            "batch_portions": child_batch,
            "portions_needed": portions_needed,
            "cost_per_portion": float(child_total / child_batch) if child_total and child_batch else None,
            "cost_contribution": round(cost_contribution, 4) if cost_contribution else None,
        })

    total_cost = float(total_ing_cost + total_sub_cost)
    effective_batch = scale_to if scale_to else batch_portions
    cost_per_portion = total_cost / effective_batch if effective_batch and total_cost else None

    # GP calculator for plated recipes
    gp_comparison = None
    if recipe.recipe_type == "plated" and cost_per_portion:
        gp_comparison = [
            {"gp_target": pct, "suggested_price": round(cost_per_portion / (1 - pct / 100), 2)}
            for pct in [60, 65, 70]
        ]

    return {
        "recipe_id": recipe.id,
        "batch_portions": effective_batch,
        "ingredients": ingredient_costs,
        "sub_recipes": sub_recipe_costs,
        "total_cost_recent": round(total_cost, 4) if total_cost else None,
        "total_cost_min": round(float(total_ing_cost_min), 4) if total_ing_cost_min else None,
        "total_cost_max": round(float(total_ing_cost_max), 4) if total_ing_cost_max else None,
        "cost_per_portion": round(cost_per_portion, 4) if cost_per_portion else None,
        "gp_comparison": gp_comparison,
    }


@router.get("/{recipe_id}/costing")
async def get_recipe_costing(
    recipe_id: int,
    scale_to: Optional[int] = Query(None),
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
    return [
        {
            "date": str(s.snapshot_date),
            "cost_per_portion": float(s.cost_per_portion),
            "total_cost": float(s.total_cost),
            "trigger_source": s.trigger_source,
        }
        for s in snapshots
    ]


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


async def snapshot_recipes_using_ingredient(ingredient_id: int, db: AsyncSession, trigger_source: str = ""):
    """Find all recipes using this ingredient and snapshot their costs."""
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

    for rid in recipe_ids:
        await snapshot_recipe_cost(rid, db, trigger_source)


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
            "username": l.user.username if l.user else "",
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _get_recipe(recipe_id, user.kitchen_id, db)
    full_data = await get_recipe(recipe_id, user, db)
    cost_data = await _calc_recipe_cost(recipe_id, db)

    # Get flags
    from api.food_flags import compute_recipe_flags
    flags = await compute_recipe_flags(recipe_id, user.kitchen_id, db)

    html = _build_recipe_html(full_data, cost_data, flags, format)
    return HTMLResponse(content=html)


def _build_recipe_html(recipe_data: dict, cost_data: dict, flags, format: str = "full") -> str:
    """Generate print-optimised HTML for a recipe."""
    esc = html_escape
    name = esc(recipe_data.get("name", ""))
    recipe_type = recipe_data.get("recipe_type", "plated")
    batch = recipe_data.get("batch_portions", 1)
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

    # Sub-recipes
    sub_rows = ""
    for sr in recipe_data.get("sub_recipes", []):
        cost_str = f"£{sr['cost_contribution']:.2f}" if sr.get("cost_contribution") else "-"
        sub_rows += f"""<tr style="background:#f8f9fa;">
            <td style="padding:6px 10px;border-bottom:1px solid #eee;">▸ {esc(sr['child_recipe_name'])}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">{sr['portions_needed']:g} portions</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">{cost_str}</td>
        </tr>"""

    # Steps
    steps_html = ""
    for step in recipe_data.get("steps", []):
        dur = f" <em>({step['duration_minutes']} min)</em>" if step.get("duration_minutes") else ""
        steps_html += f"<li style='margin-bottom:8px;'>{esc(step['instruction'])}{dur}</li>"

    # Cost summary
    cost_per_portion = cost_data.get("cost_per_portion")
    total_cost = cost_data.get("total_cost_recent")
    cost_summary = ""
    if format == "full" and cost_per_portion:
        cost_summary = f"""
        <div style="margin-top:20px;padding:12px;background:#f0f0f0;border-radius:6px;">
            <strong>Cost per portion:</strong> £{cost_per_portion:.2f} |
            <strong>Total cost:</strong> £{total_cost:.2f}
        </div>"""

    # Images (plating photos for kitchen card)
    images_html = ""
    if format == "kitchen":
        plating_images = [img for img in recipe_data.get("images", []) if img.get("image_type") == "plating"]
        if not plating_images:
            plating_images = recipe_data.get("images", [])[:1]
        for img in plating_images:
            images_html += f'<img src="{esc(img["image_path"])}" style="max-width:300px;border-radius:8px;margin:10px 0;" />'

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
        {f'Batch: {batch} portions' if recipe_type == 'component' else ''}
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

async def _get_recipe(recipe_id: int, kitchen_id: int, db: AsyncSession) -> Recipe:
    result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == kitchen_id)
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")
    return recipe
