"""
Food Flag API — categories, flags, line item flagging + latching, recipe flag propagation,
allergen keyword suggestions, and label OCR scanning.
"""
import logging
import os
import uuid
from typing import Optional

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.food_flag import FoodFlagCategory, FoodFlag, LineItemFlag, RecipeFlag, RecipeFlagOverride, AllergenKeyword, BrakesProductCache
from models.ingredient import Ingredient, IngredientFlag, IngredientFlagNone
from models.line_item import LineItem
from models.recipe import Recipe, RecipeIngredient, RecipeSubRecipe
from models.settings import KitchenSettings
from auth.jwt import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str
    propagation_type: str = "contains"  # "contains" | "suitable_for"
    required: bool = False
    sort_order: int = 0

class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    propagation_type: Optional[str] = None
    required: Optional[bool] = None
    sort_order: Optional[int] = None

class FlagCreate(BaseModel):
    category_id: int
    name: str
    code: Optional[str] = None
    icon: Optional[str] = None
    sort_order: int = 0

class FlagUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None

class FlagResponse(BaseModel):
    id: int
    name: str
    code: Optional[str] = None
    icon: Optional[str] = None
    sort_order: int = 0
    category_id: int
    category_name: str = ""
    propagation_type: str = "contains"

class CategoryResponse(BaseModel):
    id: int
    name: str
    propagation_type: str
    required: bool = False
    sort_order: int
    flags: list[FlagResponse] = []

class LineItemFlagSet(BaseModel):
    food_flag_ids: list[int]

class LineItemFlagResponse(BaseModel):
    id: int
    food_flag_id: int
    flag_name: str = ""
    flag_code: Optional[str] = None
    category_name: str = ""

class RecipeFlagState(BaseModel):
    food_flag_id: int
    flag_name: str = ""
    flag_code: Optional[str] = None
    flag_icon: Optional[str] = None
    category_id: int
    category_name: str = ""
    propagation_type: str = "contains"
    source_type: str = "auto"  # "auto" | "manual"
    is_active: bool = True
    excludable_on_request: bool = False
    source_ingredients: list[str] = []  # ingredient names that contribute this flag

class RecipeFlagOverrideLog(BaseModel):
    id: int
    food_flag_id: int
    flag_name: str = ""
    action: str
    note: str
    username: str = ""
    created_at: str = ""

class OverrideRequest(BaseModel):
    note: str

class ManualFlagAdd(BaseModel):
    food_flag_id: int

class ExcludableToggle(BaseModel):
    note: str

class MatrixCell(BaseModel):
    has_flag: bool = False
    is_unassessed: bool = False
    is_none: bool = False  # "None apply" set for this flag's category

class MatrixIngredient(BaseModel):
    ingredient_id: int
    ingredient_name: str
    is_sub_recipe: bool = False
    sub_recipe_name: Optional[str] = None
    flags: dict[int, MatrixCell] = {}  # food_flag_id -> cell state


# ── Category endpoints ───────────────────────────────────────────────────────

@router.get("/categories")
async def list_categories(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FoodFlagCategory)
        .options(selectinload(FoodFlagCategory.flags))
        .where(FoodFlagCategory.kitchen_id == user.kitchen_id)
        .order_by(FoodFlagCategory.sort_order, FoodFlagCategory.name)
    )
    cats = result.scalars().all()
    return [
        CategoryResponse(
            id=c.id,
            name=c.name,
            propagation_type=c.propagation_type,
            required=c.required,
            sort_order=c.sort_order,
            flags=[
                FlagResponse(
                    id=f.id, name=f.name, code=f.code, icon=f.icon,
                    sort_order=f.sort_order, category_id=c.id,
                    category_name=c.name, propagation_type=c.propagation_type,
                )
                for f in sorted(c.flags, key=lambda x: (x.sort_order, x.name))
            ],
        )
        for c in cats
    ]


@router.post("/categories")
async def create_category(
    data: CategoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if data.propagation_type not in ("contains", "suitable_for"):
        raise HTTPException(400, "propagation_type must be 'contains' or 'suitable_for'")
    cat = FoodFlagCategory(
        kitchen_id=user.kitchen_id,
        name=data.name,
        propagation_type=data.propagation_type,
        required=data.required,
        sort_order=data.sort_order,
    )
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return CategoryResponse(id=cat.id, name=cat.name, propagation_type=cat.propagation_type, required=cat.required, sort_order=cat.sort_order)


@router.patch("/categories/{cat_id}")
async def update_category(
    cat_id: int,
    data: CategoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FoodFlagCategory).where(
            FoodFlagCategory.id == cat_id,
            FoodFlagCategory.kitchen_id == user.kitchen_id,
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    if data.name is not None:
        cat.name = data.name
    if data.propagation_type is not None:
        if data.propagation_type not in ("contains", "suitable_for"):
            raise HTTPException(400, "propagation_type must be 'contains' or 'suitable_for'")
        cat.propagation_type = data.propagation_type
    if data.required is not None:
        cat.required = data.required
    if data.sort_order is not None:
        cat.sort_order = data.sort_order
    await db.commit()
    return {"ok": True}


@router.delete("/categories/{cat_id}")
async def delete_category(
    cat_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FoodFlagCategory).where(
            FoodFlagCategory.id == cat_id,
            FoodFlagCategory.kitchen_id == user.kitchen_id,
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    # Clean up IngredientFlagNone records for this category
    await db.execute(
        delete(IngredientFlagNone).where(IngredientFlagNone.category_id == cat_id)
    )
    try:
        await db.delete(cat)
        await db.commit()
    except Exception as e:
        await db.rollback()
        logger.error(f"Failed to delete category {cat_id}: {e}")
        raise HTTPException(500, f"Failed to delete category: {str(e)}")
    return {"ok": True}


# ── Flag CRUD ────────────────────────────────────────────────────────────────

@router.post("/flags")
async def create_flag(
    data: FlagCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify category belongs to kitchen
    cat = await db.execute(
        select(FoodFlagCategory).where(
            FoodFlagCategory.id == data.category_id,
            FoodFlagCategory.kitchen_id == user.kitchen_id,
        )
    )
    if not cat.scalar_one_or_none():
        raise HTTPException(404, "Category not found")

    flag = FoodFlag(
        category_id=data.category_id,
        kitchen_id=user.kitchen_id,
        name=data.name,
        code=data.code,
        icon=data.icon,
        sort_order=data.sort_order,
    )
    db.add(flag)
    await db.commit()
    await db.refresh(flag)
    return FlagResponse(
        id=flag.id, name=flag.name, code=flag.code, icon=flag.icon,
        sort_order=flag.sort_order, category_id=data.category_id,
    )


@router.patch("/flags/{flag_id}")
async def update_flag(
    flag_id: int,
    data: FlagUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FoodFlag).where(
            FoodFlag.id == flag_id,
            FoodFlag.kitchen_id == user.kitchen_id,
        )
    )
    flag = result.scalar_one_or_none()
    if not flag:
        raise HTTPException(404, "Flag not found")
    if data.name is not None:
        flag.name = data.name
    if data.code is not None:
        flag.code = data.code
    if data.icon is not None:
        flag.icon = data.icon
    if data.sort_order is not None:
        flag.sort_order = data.sort_order
    await db.commit()
    return {"ok": True}


@router.delete("/flags/{flag_id}")
async def delete_flag(
    flag_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FoodFlag).where(
            FoodFlag.id == flag_id,
            FoodFlag.kitchen_id == user.kitchen_id,
        )
    )
    flag = result.scalar_one_or_none()
    if not flag:
        raise HTTPException(404, "Flag not found")
    # Explicitly clean up related records (belt + suspenders alongside CASCADE)
    await db.execute(delete(IngredientFlag).where(IngredientFlag.food_flag_id == flag_id))
    await db.execute(delete(RecipeFlag).where(RecipeFlag.food_flag_id == flag_id))
    await db.execute(delete(RecipeFlagOverride).where(RecipeFlagOverride.food_flag_id == flag_id))
    await db.execute(delete(LineItemFlag).where(LineItemFlag.food_flag_id == flag_id))
    try:
        await db.delete(flag)
        await db.commit()
    except Exception as e:
        await db.rollback()
        logger.error(f"Failed to delete flag {flag_id}: {e}")
        raise HTTPException(500, f"Failed to delete flag: {str(e)}")
    return {"ok": True}


# ── Line Item Flags + Latching ───────────────────────────────────────────────

@router.get("/line-items/{line_item_id}/flags")
async def get_line_item_flags(
    line_item_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(LineItemFlag)
        .options(selectinload(LineItemFlag.food_flag).selectinload(FoodFlag.category))
        .where(LineItemFlag.line_item_id == line_item_id)
    )
    flags = result.scalars().all()
    return [
        LineItemFlagResponse(
            id=f.id,
            food_flag_id=f.food_flag_id,
            flag_name=f.food_flag.name if f.food_flag else "",
            flag_code=f.food_flag.code if f.food_flag else None,
            category_name=f.food_flag.category.name if f.food_flag and f.food_flag.category else "",
        )
        for f in flags
    ]


@router.put("/line-items/{line_item_id}/flags")
async def set_line_item_flags(
    line_item_id: int,
    data: LineItemFlagSet,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set flags on a line item (full replacement). Triggers latching to mapped ingredient."""
    # Get the line item to check ingredient_id
    li_result = await db.execute(select(LineItem).where(LineItem.id == line_item_id))
    li = li_result.scalar_one_or_none()
    if not li:
        raise HTTPException(404, "Line item not found")

    # Delete existing line item flags
    await db.execute(delete(LineItemFlag).where(LineItemFlag.line_item_id == line_item_id))

    # Add new flags
    for flag_id in data.food_flag_ids:
        db.add(LineItemFlag(
            line_item_id=line_item_id,
            food_flag_id=flag_id,
            flagged_by=user.id,
        ))

        # Latching: if line item is mapped to an ingredient, auto-create ingredient_flag
        if li.ingredient_id:
            existing = await db.execute(
                select(IngredientFlag).where(
                    IngredientFlag.ingredient_id == li.ingredient_id,
                    IngredientFlag.food_flag_id == flag_id,
                )
            )
            if not existing.scalar_one_or_none():
                db.add(IngredientFlag(
                    ingredient_id=li.ingredient_id,
                    food_flag_id=flag_id,
                    flagged_by=user.id,
                    source="latched",
                ))

    await db.commit()
    return {"ok": True}


# ── Recipe Flag Propagation ──────────────────────────────────────────────────

async def _collect_recipe_ingredient_ids(recipe_id: int, db: AsyncSession, depth: int = 0) -> list[int]:
    """Recursively collect all ingredient IDs used in a recipe (including sub-recipes)."""
    if depth > 5:
        return []

    ingredient_ids = []

    # Direct ingredients
    ri_result = await db.execute(
        select(RecipeIngredient.ingredient_id).where(RecipeIngredient.recipe_id == recipe_id)
    )
    ingredient_ids.extend([r[0] for r in ri_result.fetchall()])

    # Sub-recipe ingredients (recursive)
    sr_result = await db.execute(
        select(RecipeSubRecipe.child_recipe_id).where(RecipeSubRecipe.parent_recipe_id == recipe_id)
    )
    for (child_id,) in sr_result.fetchall():
        child_ids = await _collect_recipe_ingredient_ids(child_id, db, depth + 1)
        ingredient_ids.extend(child_ids)

    return ingredient_ids


async def compute_recipe_flags(recipe_id: int, kitchen_id: int, db: AsyncSession) -> list[RecipeFlagState]:
    """Compute the full flag state for a recipe using ingredient_flags as canonical source."""
    # Get all ingredient IDs (including sub-recipes)
    all_ingredient_ids = await _collect_recipe_ingredient_ids(recipe_id, db)
    if not all_ingredient_ids:
        # Check for manual recipe flags only
        manual_result = await db.execute(
            select(RecipeFlag)
            .options(selectinload(RecipeFlag.food_flag).selectinload(FoodFlag.category))
            .where(RecipeFlag.recipe_id == recipe_id)
        )
        manual_flags = manual_result.scalars().all()
        return [
            RecipeFlagState(
                food_flag_id=rf.food_flag_id,
                flag_name=rf.food_flag.name if rf.food_flag else "",
                flag_code=rf.food_flag.code if rf.food_flag else None,
                flag_icon=rf.food_flag.icon if rf.food_flag else None,
                category_id=rf.food_flag.category_id if rf.food_flag else 0,
                category_name=rf.food_flag.category.name if rf.food_flag and rf.food_flag.category else "",
                propagation_type=rf.food_flag.category.propagation_type if rf.food_flag and rf.food_flag.category else "contains",
                source_type=rf.source_type,
                is_active=rf.is_active,
                excludable_on_request=rf.excludable_on_request,
            )
            for rf in manual_flags
        ]

    unique_ingredient_ids = list(set(all_ingredient_ids))

    # Get all ingredient flags for these ingredients
    if_result = await db.execute(
        select(IngredientFlag)
        .options(selectinload(IngredientFlag.food_flag).selectinload(FoodFlag.category))
        .where(IngredientFlag.ingredient_id.in_(unique_ingredient_ids))
    )
    ingredient_flags = if_result.scalars().all()

    # Get all food flag categories for this kitchen
    cat_result = await db.execute(
        select(FoodFlagCategory)
        .options(selectinload(FoodFlagCategory.flags))
        .where(FoodFlagCategory.kitchen_id == kitchen_id)
    )
    categories = cat_result.scalars().all()

    # Build ingredient -> flags mapping
    ing_flag_map: dict[int, set[int]] = {}
    for ifl in ingredient_flags:
        ing_flag_map.setdefault(ifl.ingredient_id, set()).add(ifl.food_flag_id)

    # Build flag_id -> ingredient_names mapping (for source tracing)
    flag_source_names: dict[int, list[str]] = {}
    # Load ingredient names
    ing_names_result = await db.execute(
        select(Ingredient.id, Ingredient.name).where(Ingredient.id.in_(unique_ingredient_ids))
    )
    ing_names = {r[0]: r[1] for r in ing_names_result.fetchall()}

    for ifl in ingredient_flags:
        flag_source_names.setdefault(ifl.food_flag_id, []).append(ing_names.get(ifl.ingredient_id, "?"))

    # Compute propagated flags
    computed_flags: dict[int, RecipeFlagState] = {}

    for cat in categories:
        if cat.propagation_type == "contains":
            # Union: recipe has flag if ANY ingredient has it
            for flag in cat.flags:
                for ing_id in unique_ingredient_ids:
                    if flag.id in ing_flag_map.get(ing_id, set()):
                        computed_flags[flag.id] = RecipeFlagState(
                            food_flag_id=flag.id,
                            flag_name=flag.name,
                            flag_code=flag.code,
                            flag_icon=flag.icon,
                            category_id=cat.id,
                            category_name=cat.name,
                            propagation_type="contains",
                            source_type="auto",
                            is_active=True,
                            source_ingredients=flag_source_names.get(flag.id, []),
                        )
                        break

        elif cat.propagation_type == "suitable_for":
            # Intersection: recipe has flag only if ALL ingredients have it
            for flag in cat.flags:
                all_have = True
                for ing_id in unique_ingredient_ids:
                    ing_flags = ing_flag_map.get(ing_id, set())
                    # Check if ingredient has ANY flags in this category (if not, it's unassessed)
                    cat_flag_ids = {f.id for f in cat.flags}
                    has_any_in_cat = bool(ing_flags & cat_flag_ids)
                    if not has_any_in_cat or flag.id not in ing_flags:
                        all_have = False
                        break
                if all_have:
                    computed_flags[flag.id] = RecipeFlagState(
                        food_flag_id=flag.id,
                        flag_name=flag.name,
                        flag_code=flag.code,
                        flag_icon=flag.icon,
                        category_id=cat.id,
                        category_name=cat.name,
                        propagation_type="suitable_for",
                        source_type="auto",
                        is_active=True,
                        source_ingredients=[ing_names.get(i, "?") for i in unique_ingredient_ids],
                    )

    # Merge with manual recipe flags and apply overrides
    rf_result = await db.execute(
        select(RecipeFlag)
        .options(selectinload(RecipeFlag.food_flag).selectinload(FoodFlag.category))
        .where(RecipeFlag.recipe_id == recipe_id)
    )
    recipe_flags = rf_result.scalars().all()

    for rf in recipe_flags:
        if rf.source_type == "manual" and rf.food_flag_id not in computed_flags:
            computed_flags[rf.food_flag_id] = RecipeFlagState(
                food_flag_id=rf.food_flag_id,
                flag_name=rf.food_flag.name if rf.food_flag else "",
                flag_code=rf.food_flag.code if rf.food_flag else None,
                flag_icon=rf.food_flag.icon if rf.food_flag else None,
                category_id=rf.food_flag.category_id if rf.food_flag else 0,
                category_name=rf.food_flag.category.name if rf.food_flag and rf.food_flag.category else "",
                propagation_type=rf.food_flag.category.propagation_type if rf.food_flag and rf.food_flag.category else "contains",
                source_type="manual",
                is_active=rf.is_active,
                excludable_on_request=rf.excludable_on_request,
            )
        elif rf.food_flag_id in computed_flags:
            # Apply overrides from recipe_flags to computed flags
            computed_flags[rf.food_flag_id].is_active = rf.is_active
            computed_flags[rf.food_flag_id].excludable_on_request = rf.excludable_on_request
            if rf.source_type == "manual":
                computed_flags[rf.food_flag_id].source_type = "manual"

    return list(computed_flags.values())


# ── Recipe Flag endpoints ────────────────────────────────────────────────────

@router.get("/recipes/{recipe_id}/flags")
async def get_recipe_flags(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full flag state with source tracing and unassessed ingredient list."""
    # Verify recipe
    r = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    if not r.scalar_one_or_none():
        raise HTTPException(404, "Recipe not found")

    flags = await compute_recipe_flags(recipe_id, user.kitchen_id, db)

    # Find unassessed ingredients — per required category evaluation
    all_ing_ids = await _collect_recipe_ingredient_ids(recipe_id, db)
    unique_ids = list(set(all_ing_ids))

    # Get required categories with their flag IDs
    req_cat_result = await db.execute(
        select(FoodFlagCategory.id, FoodFlagCategory.name).where(
            FoodFlagCategory.kitchen_id == user.kitchen_id,
            FoodFlagCategory.required == True,
        )
    )
    required_cats = req_cat_result.all()

    # Build map: category_id → set of flag_ids
    cat_flag_map: dict[int, set[int]] = {}
    for cat_id, _ in required_cats:
        rf_result = await db.execute(
            select(FoodFlag.id).where(FoodFlag.category_id == cat_id)
        )
        cat_flag_map[cat_id] = set(rf_result.scalars().all())

    unassessed = []
    if unique_ids and required_cats:
        for ing_id in unique_ids:
            ing_result = await db.execute(
                select(Ingredient.name).where(Ingredient.id == ing_id)
            )
            name = ing_result.scalar()
            if not name:
                continue

            # Get "None" entries for this ingredient
            none_result = await db.execute(
                select(IngredientFlagNone.category_id).where(
                    IngredientFlagNone.ingredient_id == ing_id,
                )
            )
            none_cat_ids = set(none_result.scalars().all())

            # Check each required category separately
            for cat_id, cat_name in required_cats:
                if cat_id in none_cat_ids:
                    continue  # "None" selected for this category
                flag_ids = cat_flag_map.get(cat_id, set())
                if not flag_ids:
                    continue
                flag_count = await db.execute(
                    select(func.count(IngredientFlag.id)).where(
                        IngredientFlag.ingredient_id == ing_id,
                        IngredientFlag.food_flag_id.in_(flag_ids),
                    )
                )
                if flag_count.scalar() == 0:
                    unassessed.append({"id": ing_id, "name": name, "category": cat_name})
                    break  # One missing category is enough to flag the ingredient

    return {"flags": [f.model_dump() for f in flags], "unassessed_ingredients": unassessed}


@router.post("/recipes/{recipe_id}/flags/{flag_id}/deactivate")
async def deactivate_recipe_flag(
    recipe_id: int,
    flag_id: int,
    data: OverrideRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Override a flag off (requires note, creates audit log)."""
    # Upsert recipe_flag
    rf_result = await db.execute(
        select(RecipeFlag).where(RecipeFlag.recipe_id == recipe_id, RecipeFlag.food_flag_id == flag_id)
    )
    rf = rf_result.scalar_one_or_none()
    if rf:
        rf.is_active = False
    else:
        rf = RecipeFlag(recipe_id=recipe_id, food_flag_id=flag_id, source_type="auto", is_active=False)
        db.add(rf)

    # Audit log
    db.add(RecipeFlagOverride(
        recipe_id=recipe_id, food_flag_id=flag_id,
        action="deactivated", note=data.note, user_id=user.id,
    ))
    await db.commit()
    return {"ok": True}


@router.post("/recipes/{recipe_id}/flags/{flag_id}/reactivate")
async def reactivate_recipe_flag(
    recipe_id: int,
    flag_id: int,
    data: OverrideRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rf_result = await db.execute(
        select(RecipeFlag).where(RecipeFlag.recipe_id == recipe_id, RecipeFlag.food_flag_id == flag_id)
    )
    rf = rf_result.scalar_one_or_none()
    if rf:
        rf.is_active = True

    db.add(RecipeFlagOverride(
        recipe_id=recipe_id, food_flag_id=flag_id,
        action="reactivated", note=data.note, user_id=user.id,
    ))
    await db.commit()
    return {"ok": True}


@router.patch("/recipes/{recipe_id}/flags/{flag_id}")
async def toggle_excludable(
    recipe_id: int,
    flag_id: int,
    data: ExcludableToggle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle excludable_on_request for a dish recipe flag."""
    rf_result = await db.execute(
        select(RecipeFlag).where(RecipeFlag.recipe_id == recipe_id, RecipeFlag.food_flag_id == flag_id)
    )
    rf = rf_result.scalar_one_or_none()
    if rf:
        new_state = not rf.excludable_on_request
        rf.excludable_on_request = new_state
        action = "set_excludable" if new_state else "unset_excludable"
    else:
        rf = RecipeFlag(
            recipe_id=recipe_id, food_flag_id=flag_id,
            source_type="auto", is_active=True, excludable_on_request=True,
        )
        db.add(rf)
        action = "set_excludable"

    db.add(RecipeFlagOverride(
        recipe_id=recipe_id, food_flag_id=flag_id,
        action=action, note=data.note, user_id=user.id,
    ))
    await db.commit()
    return {"ok": True}


@router.post("/recipes/{recipe_id}/flags/manual")
async def add_manual_flag(
    recipe_id: int,
    data: ManualFlagAdd,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually add a flag to a recipe."""
    existing = await db.execute(
        select(RecipeFlag).where(
            RecipeFlag.recipe_id == recipe_id,
            RecipeFlag.food_flag_id == data.food_flag_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Flag already exists on this recipe")

    db.add(RecipeFlag(
        recipe_id=recipe_id, food_flag_id=data.food_flag_id,
        source_type="manual", is_active=True,
    ))
    await db.commit()
    return {"ok": True}


@router.get("/recipes/{recipe_id}/flags/audit-log")
async def get_flag_audit_log(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RecipeFlagOverride)
        .options(
            selectinload(RecipeFlagOverride.food_flag),
            selectinload(RecipeFlagOverride.user),
        )
        .where(RecipeFlagOverride.recipe_id == recipe_id)
        .order_by(RecipeFlagOverride.created_at.desc())
    )
    overrides = result.scalars().all()
    return [
        RecipeFlagOverrideLog(
            id=o.id,
            food_flag_id=o.food_flag_id,
            flag_name=o.food_flag.name if o.food_flag else "",
            action=o.action,
            note=o.note,
            username=o.user.username if o.user else "",
            created_at=str(o.created_at) if o.created_at else "",
        )
        for o in overrides
    ]


@router.get("/recipes/{recipe_id}/flags/matrix")
async def get_flag_matrix(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full ingredient × flag matrix data for the flag breakdown table."""
    # Verify recipe
    r_result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    recipe = r_result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")

    # Get all flag categories and flags
    cats = await db.execute(
        select(FoodFlagCategory)
        .options(selectinload(FoodFlagCategory.flags))
        .where(FoodFlagCategory.kitchen_id == user.kitchen_id)
        .order_by(FoodFlagCategory.sort_order)
    )
    categories = cats.scalars().all()

    all_flags = []
    required_cat_ids = set()
    for cat in categories:
        if cat.required:
            required_cat_ids.add(cat.id)
        for f in sorted(cat.flags, key=lambda x: x.sort_order):
            all_flags.append({
                "id": f.id, "name": f.name, "code": f.code,
                "category_id": cat.id, "category_name": cat.name,
                "propagation_type": cat.propagation_type,
                "required": cat.required,
            })

    matrix_rows = []

    # Direct recipe ingredients
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.flags))
        .where(RecipeIngredient.recipe_id == recipe_id)
        .order_by(RecipeIngredient.sort_order)
    )
    direct_ris = ri_result.scalars().all()

    # Sub-recipe ingredients
    sr_result = await db.execute(
        select(RecipeSubRecipe)
        .options(selectinload(RecipeSubRecipe.child_recipe))
        .where(RecipeSubRecipe.parent_recipe_id == recipe_id)
        .order_by(RecipeSubRecipe.sort_order)
    )
    sub_recipes = sr_result.scalars().all()

    # Fetch child recipe ingredients for each sub-recipe
    sub_recipe_ingredients = {}  # child_id -> (child_recipe, [RecipeIngredient...])
    for sr in sub_recipes:
        child = sr.child_recipe
        if not child:
            continue
        cri_result = await db.execute(
            select(RecipeIngredient)
            .options(selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.flags))
            .where(RecipeIngredient.recipe_id == child.id)
            .order_by(RecipeIngredient.sort_order)
        )
        sub_recipe_ingredients[child.id] = (child, cri_result.scalars().all())

    # Collect all ingredient IDs from direct + sub-recipe ingredients
    all_ingredient_ids = set()
    for ri in direct_ris:
        if ri.ingredient:
            all_ingredient_ids.add(ri.ingredient.id)
    for child_id, (child, cris) in sub_recipe_ingredients.items():
        for cri in cris:
            if cri.ingredient:
                all_ingredient_ids.add(cri.ingredient.id)

    # Batch-fetch all "None apply" records so they count as assessed
    ingredient_nones = {}
    if all_ingredient_ids:
        none_result = await db.execute(
            select(IngredientFlagNone.ingredient_id, IngredientFlagNone.category_id)
            .where(IngredientFlagNone.ingredient_id.in_(list(all_ingredient_ids)))
        )
        for ing_id, cat_id in none_result.all():
            if ing_id not in ingredient_nones:
                ingredient_nones[ing_id] = set()
            ingredient_nones[ing_id].add(cat_id)

    # Build matrix rows for direct ingredients
    for ri in direct_ris:
        ing = ri.ingredient
        if not ing:
            continue
        ing_flag_ids = {f.food_flag_id for f in (ing.flags or [])}
        # Check which categories this ingredient has ANY flags in
        assessed_cats = set()
        for f in (ing.flags or []):
            for cat in categories:
                if f.food_flag_id in {cf.id for cf in cat.flags}:
                    assessed_cats.add(cat.id)
        # Also count "None apply" categories as assessed
        assessed_cats |= ingredient_nones.get(ing.id, set())

        none_cats = ingredient_nones.get(ing.id, set())
        flags_map = {}
        for flag_info in all_flags:
            fid = flag_info["id"]
            cat_id = flag_info["category_id"]
            # Non-required categories: never show as unassessed
            is_unassessed = cat_id not in assessed_cats and cat_id in required_cat_ids
            flags_map[fid] = MatrixCell(
                has_flag=fid in ing_flag_ids,
                is_unassessed=is_unassessed,
                is_none=cat_id in none_cats,
            ).model_dump()

        matrix_rows.append(MatrixIngredient(
            ingredient_id=ing.id, ingredient_name=ing.name,
            flags=flags_map,
        ).model_dump())

    # Build matrix rows for sub-recipe ingredients
    for sr in sub_recipes:
        child = sr.child_recipe
        if not child or child.id not in sub_recipe_ingredients:
            continue
        _, cris = sub_recipe_ingredients[child.id]
        for cri in cris:
            cing = cri.ingredient
            if not cing:
                continue
            ing_flag_ids = {f.food_flag_id for f in (cing.flags or [])}
            assessed_cats = set()
            for f in (cing.flags or []):
                for cat in categories:
                    if f.food_flag_id in {cf.id for cf in cat.flags}:
                        assessed_cats.add(cat.id)
            # Also count "None apply" categories as assessed
            assessed_cats |= ingredient_nones.get(cing.id, set())

            none_cats = ingredient_nones.get(cing.id, set())
            flags_map = {}
            for flag_info in all_flags:
                fid = flag_info["id"]
                cat_id = flag_info["category_id"]
                is_unassessed = cat_id not in assessed_cats and cat_id in required_cat_ids
                flags_map[fid] = MatrixCell(
                    has_flag=fid in ing_flag_ids,
                    is_unassessed=is_unassessed,
                    is_none=cat_id in none_cats,
                ).model_dump()

            matrix_rows.append(MatrixIngredient(
                ingredient_id=cing.id, ingredient_name=cing.name,
                is_sub_recipe=True, sub_recipe_name=child.name,
                flags=flags_map,
            ).model_dump())

    return {"flags": all_flags, "ingredients": matrix_rows}


class MatrixBulkItem(BaseModel):
    ingredient_id: int
    food_flag_id: int
    has_flag: bool


class MatrixBulkUpdate(BaseModel):
    updates: list[MatrixBulkItem]


@router.put("/recipes/{recipe_id}/flags/matrix")
async def update_flag_matrix(
    recipe_id: int,
    data: MatrixBulkUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bulk update ingredient flags from the recipe flag matrix view."""
    # Verify recipe belongs to kitchen
    r_result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    if not r_result.scalar_one_or_none():
        raise HTTPException(404, "Recipe not found")

    updated = 0
    for item in data.updates:
        # Verify ingredient belongs to this kitchen
        ing_result = await db.execute(
            select(Ingredient).where(
                Ingredient.id == item.ingredient_id,
                Ingredient.kitchen_id == user.kitchen_id,
            )
        )
        ingredient = ing_result.scalar_one_or_none()
        if not ingredient:
            continue

        # Verify flag belongs to this kitchen
        flag_result = await db.execute(
            select(FoodFlag).where(
                FoodFlag.id == item.food_flag_id,
                FoodFlag.kitchen_id == user.kitchen_id,
            )
        )
        if not flag_result.scalar_one_or_none():
            continue

        # Check if flag assignment exists
        existing = await db.execute(
            select(IngredientFlag).where(
                IngredientFlag.ingredient_id == item.ingredient_id,
                IngredientFlag.food_flag_id == item.food_flag_id,
            )
        )
        flag_row = existing.scalar_one_or_none()

        if item.has_flag and not flag_row:
            # Add flag — also remove any "None apply" for this flag's category
            flag_obj = flag_result.scalar_one_or_none() if not flag_result else None
            # Re-fetch to get category_id
            flag_detail = await db.execute(
                select(FoodFlag).where(FoodFlag.id == item.food_flag_id)
            )
            flag_detail_obj = flag_detail.scalar_one_or_none()
            if flag_detail_obj:
                await db.execute(
                    delete(IngredientFlagNone).where(
                        IngredientFlagNone.ingredient_id == item.ingredient_id,
                        IngredientFlagNone.category_id == flag_detail_obj.category_id,
                    )
                )
            db.add(IngredientFlag(
                ingredient_id=item.ingredient_id,
                food_flag_id=item.food_flag_id,
                flagged_by=user.id,
                source="manual",
            ))
            updated += 1
        elif not item.has_flag and flag_row:
            # Remove flag (only manual ones; latched flags stay)
            if flag_row.source == "manual":
                await db.delete(flag_row)
                updated += 1

    await db.commit()
    return {"ok": True, "updated": updated}


class MatrixNoneToggle(BaseModel):
    ingredient_id: int
    category_id: int


@router.post("/recipes/{recipe_id}/flags/matrix/none")
async def toggle_matrix_none(
    recipe_id: int,
    data: MatrixNoneToggle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Toggle 'None apply' for a category on an ingredient, from the recipe matrix."""
    # Verify recipe belongs to kitchen
    r_result = await db.execute(
        select(Recipe).where(Recipe.id == recipe_id, Recipe.kitchen_id == user.kitchen_id)
    )
    if not r_result.scalar_one_or_none():
        raise HTTPException(404, "Recipe not found")

    # Check if already set
    existing = await db.execute(
        select(IngredientFlagNone).where(
            IngredientFlagNone.ingredient_id == data.ingredient_id,
            IngredientFlagNone.category_id == data.category_id,
        )
    )
    none_row = existing.scalar_one_or_none()

    if none_row:
        # Toggle OFF
        await db.delete(none_row)
        await db.commit()
        return {"ok": True, "is_none": False}
    else:
        # Toggle ON — remove any flags in this category first
        cat_flag_ids = await db.execute(
            select(FoodFlag.id).where(
                FoodFlag.category_id == data.category_id,
                FoodFlag.kitchen_id == user.kitchen_id,
            )
        )
        flag_ids = [r for r in cat_flag_ids.scalars().all()]
        if flag_ids:
            await db.execute(
                delete(IngredientFlag).where(
                    IngredientFlag.ingredient_id == data.ingredient_id,
                    IngredientFlag.food_flag_id.in_(flag_ids),
                )
            )
        db.add(IngredientFlagNone(
            ingredient_id=data.ingredient_id,
            category_id=data.category_id,
        ))
        await db.commit()
        return {"ok": True, "is_none": True}


# ── Shared allergen keyword matching ─────────────────────────────────────────

def match_allergen_keywords(text: str, keywords: list) -> list[dict]:
    """Match text against allergen keywords. Returns suggested flags with matched keywords."""
    text_lower = text.lower()
    matches: dict[int, dict] = {}
    for kw in keywords:
        if kw.keyword in text_lower:
            fid = kw.food_flag_id
            if fid not in matches:
                flag = kw.food_flag
                matches[fid] = {
                    "flag_id": fid,
                    "flag_name": flag.name if flag else "",
                    "flag_code": flag.code if flag else None,
                    "category_name": flag.category.name if flag and flag.category else "",
                    "matched_keywords": [],
                }
            matches[fid]["matched_keywords"].append(kw.keyword)
    return list(matches.values())


# ── Allergen keyword suggestion ──────────────────────────────────────────────

@router.get("/suggest")
async def suggest_allergens(
    name: str = Query("", description="Ingredient name to check"),
    text: str = Query("", description="Product ingredients text to check"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Suggest allergen flags based on ingredient name and/or product ingredients text."""
    combined = f"{name} {text}".strip()
    if len(combined) < 2:
        return []

    result = await db.execute(
        select(AllergenKeyword)
        .options(selectinload(AllergenKeyword.food_flag).selectinload(FoodFlag.category))
        .where(AllergenKeyword.kitchen_id == user.kitchen_id)
    )
    keywords = result.scalars().all()
    return match_allergen_keywords(combined, keywords)


# ── Allergen keyword CRUD (Settings) ────────────────────────────────────────

class KeywordCreate(BaseModel):
    food_flag_id: int
    keyword: str

@router.get("/keywords")
async def list_keywords(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all allergen keywords grouped by flag."""
    result = await db.execute(
        select(AllergenKeyword)
        .options(selectinload(AllergenKeyword.food_flag).selectinload(FoodFlag.category))
        .where(AllergenKeyword.kitchen_id == user.kitchen_id)
        .order_by(AllergenKeyword.food_flag_id, AllergenKeyword.keyword)
    )
    keywords = result.scalars().all()

    groups: dict[int, dict] = {}
    for kw in keywords:
        fid = kw.food_flag_id
        if fid not in groups:
            flag = kw.food_flag
            groups[fid] = {
                "flag_id": fid,
                "flag_name": flag.name if flag else "",
                "flag_code": flag.code if flag else None,
                "category_name": flag.category.name if flag and flag.category else "",
                "keywords": [],
            }
        groups[fid]["keywords"].append({
            "id": kw.id,
            "keyword": kw.keyword,
            "is_default": kw.is_default,
        })
    return list(groups.values())


@router.post("/keywords")
async def add_keyword(
    data: KeywordCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a custom allergen keyword."""
    # Verify flag belongs to this kitchen
    flag = await db.get(FoodFlag, data.food_flag_id)
    if not flag or flag.kitchen_id != user.kitchen_id:
        raise HTTPException(404, "Flag not found")

    kw = AllergenKeyword(
        kitchen_id=user.kitchen_id,
        food_flag_id=data.food_flag_id,
        keyword=data.keyword.lower().strip(),
        is_default=False,
    )
    db.add(kw)
    try:
        await db.commit()
        await db.refresh(kw)
    except Exception:
        await db.rollback()
        raise HTTPException(409, "Keyword already exists for this flag")
    return {"id": kw.id, "keyword": kw.keyword, "is_default": False}


@router.delete("/keywords/{keyword_id}")
async def delete_keyword(
    keyword_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove an allergen keyword."""
    kw = await db.get(AllergenKeyword, keyword_id)
    if not kw or kw.kitchen_id != user.kitchen_id:
        raise HTTPException(404, "Keyword not found")
    await db.delete(kw)
    await db.commit()
    return {"ok": True}


@router.post("/keywords/reset-defaults")
async def reset_default_keywords(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete all default keywords and re-seed from built-in dictionary. Preserves user-added keywords."""
    from migrations.add_allergen_keywords import ALLERGEN_KEYWORDS
    from sqlalchemy import text as sql_text

    # Delete existing defaults
    await db.execute(
        delete(AllergenKeyword).where(
            AllergenKeyword.kitchen_id == user.kitchen_id,
            AllergenKeyword.is_default == True,
        )
    )
    await db.flush()

    # Re-seed defaults
    seeded = 0
    for flag_name, keywords in ALLERGEN_KEYWORDS.items():
        flag_result = await db.execute(
            select(FoodFlag).where(
                FoodFlag.kitchen_id == user.kitchen_id,
                FoodFlag.name == flag_name,
            )
        )
        flag = flag_result.scalar_one_or_none()
        if not flag:
            continue
        for kw_str in keywords:
            kw = AllergenKeyword(
                kitchen_id=user.kitchen_id,
                food_flag_id=flag.id,
                keyword=kw_str.lower(),
                is_default=True,
            )
            db.add(kw)
            seeded += 1

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(500, "Failed to re-seed keywords")

    return {"ok": True, "seeded": seeded}


# ── Label OCR scanning ──────────────────────────────────────────────────────

@router.post("/scan-label")
async def scan_label(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """OCR a product ingredient label image and suggest allergen flags.
    For create mode (ingredient doesn't exist yet) — returns raw text + suggestions.
    """
    # Validate file type
    allowed = {"image/jpeg", "image/png", "image/webp", "image/heic"}
    if file.content_type not in allowed:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")

    # Get Azure credentials
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == user.kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()
    if not settings or not settings.azure_endpoint or not settings.azure_key:
        raise HTTPException(400, "Azure Document Intelligence not configured. Set it up in Settings.")

    # Read file content
    image_bytes = await file.read()

    # OCR with Azure prebuilt-read
    try:
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential

        client = DocumentAnalysisClient(settings.azure_endpoint, AzureKeyCredential(settings.azure_key))
        poller = client.begin_analyze_document("prebuilt-read", document=image_bytes)
        result = poller.result()
        raw_text = " ".join([line.content for page in result.pages for line in page.lines])
    except Exception as e:
        logger.error(f"Azure OCR failed: {e}")
        raise HTTPException(500, f"OCR failed: {str(e)}")

    # Match keywords
    kw_result = await db.execute(
        select(AllergenKeyword)
        .options(selectinload(AllergenKeyword.food_flag).selectinload(FoodFlag.category))
        .where(AllergenKeyword.kitchen_id == user.kitchen_id)
    )
    keywords = kw_result.scalars().all()
    suggestions = match_allergen_keywords(raw_text, keywords)

    return {
        "raw_text": raw_text,
        "suggested_flags": suggestions,
    }


@router.post("/scan-label/{ingredient_id}")
async def scan_label_for_ingredient(
    ingredient_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """OCR a product ingredient label, save the image, and suggest allergen flags.
    For edit mode (ingredient exists) — saves label image to disk.
    """
    # Verify ingredient
    ing = await db.get(Ingredient, ingredient_id)
    if not ing or ing.kitchen_id != user.kitchen_id:
        raise HTTPException(404, "Ingredient not found")

    # Validate file type
    allowed = {"image/jpeg", "image/png", "image/webp", "image/heic"}
    if file.content_type not in allowed:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")

    # Get Azure credentials
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == user.kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()
    if not settings or not settings.azure_endpoint or not settings.azure_key:
        raise HTTPException(400, "Azure Document Intelligence not configured. Set it up in Settings.")

    # Read file content
    image_bytes = await file.read()

    # Save label image
    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "jpg"
    label_dir = f"/app/data/{user.kitchen_id}/labels"
    os.makedirs(label_dir, exist_ok=True)
    filename = f"{uuid.uuid4()}.{ext}"
    filepath = os.path.join(label_dir, filename)
    async with aiofiles.open(filepath, "wb") as f:
        await f.write(image_bytes)

    # Update ingredient
    ing.label_image_path = filepath
    await db.flush()

    # OCR with Azure prebuilt-read
    try:
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential

        client = DocumentAnalysisClient(settings.azure_endpoint, AzureKeyCredential(settings.azure_key))
        poller = client.begin_analyze_document("prebuilt-read", document=image_bytes)
        result = poller.result()
        raw_text = " ".join([line.content for page in result.pages for line in page.lines])
    except Exception as e:
        logger.error(f"Azure OCR failed: {e}")
        await db.commit()  # Still save the image even if OCR fails
        raise HTTPException(500, f"OCR failed: {str(e)}")

    # Update product_ingredients
    ing.product_ingredients = raw_text
    await db.commit()

    # Match keywords
    kw_result = await db.execute(
        select(AllergenKeyword)
        .options(selectinload(AllergenKeyword.food_flag).selectinload(FoodFlag.category))
        .where(AllergenKeyword.kitchen_id == user.kitchen_id)
    )
    keywords = kw_result.scalars().all()
    suggestions = match_allergen_keywords(raw_text, keywords)

    return {
        "raw_text": raw_text,
        "suggested_flags": suggestions,
        "label_saved": True,
    }


# ── Brakes product lookup ─────────────────────────────────────────────────

@router.get("/brakes-lookup")
async def brakes_lookup(
    product_code: str = Query(..., description="Brakes product code"),
    force: bool = Query(False, description="Bypass cache and re-fetch from website"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Look up a Brakes product by code, returning ingredients + allergen suggestions.
    Uses a cache table to avoid repeated requests to brake.co.uk.
    """
    import json
    from datetime import datetime, timedelta
    from services.brakes_scraper import fetch_brakes_product

    clean_code = product_code.lstrip("$").strip()
    if not clean_code:
        raise HTTPException(400, "Product code required")

    # Check cache
    cache_result = await db.execute(
        select(BrakesProductCache).where(BrakesProductCache.product_code == clean_code)
    )
    cached = cache_result.scalar_one_or_none()

    now = datetime.utcnow()
    cache_ttl = timedelta(days=30)
    not_found_ttl = timedelta(days=7)

    if cached and not force:
        age = now - cached.fetched_at
        if cached.not_found and age < not_found_ttl:
            return {"found": False, "product_code": clean_code, "suggested_flags": []}
        if not cached.not_found and age < cache_ttl:
            # Serve from cache — build suggestions
            contains = json.loads(cached.contains_allergens) if cached.contains_allergens else []
            suggestions = await _build_brakes_suggestions(
                db, user.kitchen_id, contains, cached.ingredients_text or ""
            )
            return {
                "found": True,
                "product_code": clean_code,
                "product_name": cached.product_name or "",
                "ingredients_text": cached.ingredients_text or "",
                "contains_allergens": contains,
                "suggested_flags": suggestions,
            }

    # Cache miss or stale — fetch from website
    product = await fetch_brakes_product(clean_code)

    if product is None or (not product.ingredients_text and not product.product_name):
        # 404 or empty page — cache as not_found
        if cached:
            cached.not_found = True
            cached.fetched_at = now
        else:
            db.add(BrakesProductCache(
                product_code=clean_code,
                not_found=True,
                fetched_at=now,
            ))
        await db.commit()
        return {"found": False, "product_code": clean_code, "suggested_flags": []}

    # Store in cache
    contains_json = json.dumps(product.contains_allergens)
    if cached:
        cached.product_name = product.product_name
        cached.ingredients_text = product.ingredients_text
        cached.contains_allergens = contains_json
        cached.not_found = False
        cached.fetched_at = now
    else:
        db.add(BrakesProductCache(
            product_code=clean_code,
            product_name=product.product_name,
            ingredients_text=product.ingredients_text,
            contains_allergens=contains_json,
            not_found=False,
            fetched_at=now,
        ))
    await db.commit()

    # Build suggestions
    suggestions = await _build_brakes_suggestions(
        db, user.kitchen_id, product.contains_allergens, product.ingredients_text
    )

    return {
        "found": True,
        "product_code": clean_code,
        "product_name": product.product_name,
        "ingredients_text": product.ingredients_text,
        "contains_allergens": product.contains_allergens,
        "suggested_flags": suggestions,
    }


async def _build_brakes_suggestions(
    db: AsyncSession,
    kitchen_id: int,
    contains_allergens: list[str],
    ingredients_text: str,
) -> list[dict]:
    """Build allergen flag suggestions from Brakes 'Contains' statement + keyword matching."""
    # Get all flags for this kitchen
    flags_result = await db.execute(
        select(FoodFlag)
        .options(selectinload(FoodFlag.category))
        .where(FoodFlag.kitchen_id == kitchen_id)
    )
    all_flags = flags_result.scalars().all()
    flag_by_name = {f.name.lower(): f for f in all_flags}

    suggestions: dict[int, dict] = {}

    def _find_flag(name: str):
        """Match flag by exact name, then try singular/plural variants."""
        n = name.lower().strip()
        if n in flag_by_name:
            return flag_by_name[n]
        # Try removing trailing 's' (Eggs -> Egg, Crustaceans -> Crustacean)
        if n.endswith("s") and n[:-1] in flag_by_name:
            return flag_by_name[n[:-1]]
        # Try adding 's' (Egg -> Eggs, Peanut -> Peanuts)
        if f"{n}s" in flag_by_name:
            return flag_by_name[f"{n}s"]
        # Try 'es' removal (Mollusces -> Mollusc)
        if n.endswith("es") and n[:-2] in flag_by_name:
            return flag_by_name[n[:-2]]
        return None

    # 1. Direct match from "Contains" statement (high confidence)
    for allergen_name in contains_allergens:
        flag = _find_flag(allergen_name)
        if flag:
            suggestions[flag.id] = {
                "flag_id": flag.id,
                "flag_name": flag.name,
                "flag_code": flag.code,
                "category_name": flag.category.name if flag.category else "",
                "source": "contains",
                "matched_keywords": [],
            }

    # 2. Keyword matching against full ingredients text (catches extras)
    if ingredients_text:
        kw_result = await db.execute(
            select(AllergenKeyword)
            .options(selectinload(AllergenKeyword.food_flag).selectinload(FoodFlag.category))
            .where(AllergenKeyword.kitchen_id == kitchen_id)
        )
        keywords = kw_result.scalars().all()
        keyword_matches = match_allergen_keywords(ingredients_text, keywords)

        for km in keyword_matches:
            fid = km["flag_id"]
            if fid not in suggestions:
                km["source"] = "keyword"
                suggestions[fid] = km
            else:
                # Already matched via "contains" — append keyword info
                suggestions[fid]["matched_keywords"] = km.get("matched_keywords", [])

    return list(suggestions.values())
