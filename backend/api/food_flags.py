"""
Food Flag API — categories, flags, line item flagging + latching, recipe flag propagation.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.food_flag import FoodFlagCategory, FoodFlag, LineItemFlag, RecipeFlag, RecipeFlagOverride
from models.ingredient import Ingredient, IngredientFlag
from models.line_item import LineItem
from models.recipe import Recipe, RecipeIngredient, RecipeSubRecipe
from auth.jwt import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str
    propagation_type: str = "contains"  # "contains" | "suitable_for"
    sort_order: int = 0

class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    propagation_type: Optional[str] = None
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
        sort_order=data.sort_order,
    )
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return CategoryResponse(id=cat.id, name=cat.name, propagation_type=cat.propagation_type, sort_order=cat.sort_order)


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
    await db.delete(cat)
    await db.commit()
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
    await db.delete(flag)
    await db.commit()
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

    # Find unassessed ingredients
    all_ing_ids = await _collect_recipe_ingredient_ids(recipe_id, db)
    unique_ids = list(set(all_ing_ids))

    unassessed = []
    if unique_ids:
        for ing_id in unique_ids:
            flag_count = await db.execute(
                select(func.count(IngredientFlag.id)).where(IngredientFlag.ingredient_id == ing_id)
            )
            if flag_count.scalar() == 0:
                name_result = await db.execute(select(Ingredient.name).where(Ingredient.id == ing_id))
                name = name_result.scalar()
                if name:
                    unassessed.append({"id": ing_id, "name": name})

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
    """Toggle excludable_on_request for a plated recipe flag."""
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
    for cat in categories:
        for f in sorted(cat.flags, key=lambda x: x.sort_order):
            all_flags.append({
                "id": f.id, "name": f.name, "code": f.code,
                "category_id": cat.id, "category_name": cat.name,
                "propagation_type": cat.propagation_type,
            })

    matrix_rows = []

    # Direct recipe ingredients
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.flags))
        .where(RecipeIngredient.recipe_id == recipe_id)
        .order_by(RecipeIngredient.sort_order)
    )
    for ri in ri_result.scalars().all():
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

        flags_map = {}
        for flag_info in all_flags:
            fid = flag_info["id"]
            cat_id = flag_info["category_id"]
            flags_map[fid] = MatrixCell(
                has_flag=fid in ing_flag_ids,
                is_unassessed=cat_id not in assessed_cats,
            ).model_dump()

        matrix_rows.append(MatrixIngredient(
            ingredient_id=ing.id, ingredient_name=ing.name,
            flags=flags_map,
        ).model_dump())

    # Sub-recipe ingredients
    sr_result = await db.execute(
        select(RecipeSubRecipe)
        .options(selectinload(RecipeSubRecipe.child_recipe))
        .where(RecipeSubRecipe.parent_recipe_id == recipe_id)
        .order_by(RecipeSubRecipe.sort_order)
    )
    for sr in sr_result.scalars().all():
        child = sr.child_recipe
        if not child:
            continue
        # Get child recipe's ingredients
        cri_result = await db.execute(
            select(RecipeIngredient)
            .options(selectinload(RecipeIngredient.ingredient).selectinload(Ingredient.flags))
            .where(RecipeIngredient.recipe_id == child.id)
            .order_by(RecipeIngredient.sort_order)
        )
        for cri in cri_result.scalars().all():
            cing = cri.ingredient
            if not cing:
                continue
            ing_flag_ids = {f.food_flag_id for f in (cing.flags or [])}
            assessed_cats = set()
            for f in (cing.flags or []):
                for cat in categories:
                    if f.food_flag_id in {cf.id for cf in cat.flags}:
                        assessed_cats.add(cat.id)

            flags_map = {}
            for flag_info in all_flags:
                fid = flag_info["id"]
                cat_id = flag_info["category_id"]
                flags_map[fid] = MatrixCell(
                    has_flag=fid in ing_flag_ids,
                    is_unassessed=cat_id not in assessed_cats,
                ).model_dump()

            matrix_rows.append(MatrixIngredient(
                ingredient_id=cing.id, ingredient_name=cing.name,
                is_sub_recipe=True, sub_recipe_name=child.name,
                flags=flags_map,
            ).model_dump())

    return {"flags": all_flags, "ingredients": matrix_rows}
