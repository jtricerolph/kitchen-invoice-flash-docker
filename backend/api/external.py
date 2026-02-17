"""
Internal API for in-house apps — API key authentication, dish recipe data,
food flag listings. Prefix: /api/external/
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Header, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from database import get_db
from models.settings import KitchenSettings
from models.recipe import Recipe, RecipeIngredient, RecipeSubRecipe, RecipeImage
from models.ingredient import Ingredient
from models.food_flag import FoodFlagCategory, FoodFlag
from api.food_flags import compute_recipe_flags

logger = logging.getLogger(__name__)

router = APIRouter()


async def get_kitchen_from_api_key(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> KitchenSettings:
    """Authenticate via API key and return the kitchen settings."""
    if not x_api_key:
        raise HTTPException(401, "Missing X-API-Key header")

    result = await db.execute(
        select(KitchenSettings).where(
            KitchenSettings.api_key == x_api_key,
            KitchenSettings.api_key_enabled == True,
        )
    )
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(401, "Invalid or disabled API key")
    return settings


@router.get("/recipes/dishes")
async def list_dish_recipes(
    include_ingredients: str = Query("none", regex="^(none|flat|nested)$"),
    include_costs: bool = Query(False),
    exclude_flags: Optional[str] = Query(None, description="Comma-separated flag IDs to exclude"),
    kitchen: KitchenSettings = Depends(get_kitchen_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """List non-archived dish recipes for external consumption."""
    query = (
        select(Recipe)
        .options(
            selectinload(Recipe.menu_section),
            selectinload(Recipe.images),
        )
        .where(
            Recipe.kitchen_id == kitchen.kitchen_id,
            Recipe.recipe_type == "dish",
            Recipe.is_archived == False,
        )
        .order_by(Recipe.name)
    )
    result = await db.execute(query)
    recipes = result.scalars().all()

    exclude_flag_ids = set()
    if exclude_flags:
        exclude_flag_ids = {int(x.strip()) for x in exclude_flags.split(",") if x.strip().isdigit()}

    items = []
    for r in recipes:
        # Get flags
        flags = await compute_recipe_flags(r.id, kitchen.kitchen_id, db)
        active_flags = [f for f in flags if f.is_active]

        # Check exclude filter
        if exclude_flag_ids:
            recipe_flag_ids = {f.food_flag_id for f in active_flags}
            if recipe_flag_ids & exclude_flag_ids:
                continue

        flag_data = [
            {
                "id": f.food_flag_id,
                "name": f.flag_name,
                "code": f.flag_code,
                "icon": f.flag_icon,
                "category": f.category_name,
                "propagation": f.propagation_type,
                "excludable": f.excludable_on_request,
            }
            for f in active_flags
        ]

        item = {
            "id": r.id,
            "name": r.name,
            "description": r.description,
            "menu_section": r.menu_section.name if r.menu_section else None,
            "prep_time_minutes": r.prep_time_minutes,
            "cook_time_minutes": r.cook_time_minutes,
            "flags": flag_data,
            "images": [
                {"id": img.id, "caption": img.caption, "image_type": img.image_type}
                for img in (r.images or [])
            ],
        }

        # Include costs if requested
        if include_costs:
            from api.recipes import _calc_recipe_cost
            cost_data = await _calc_recipe_cost(r.id, db)
            item["cost_per_portion"] = cost_data.get("cost_per_portion")
            item["total_cost"] = cost_data.get("total_cost_recent")

        # Include ingredients if requested
        if include_ingredients != "none":
            item["ingredients"] = await _get_recipe_ingredients(r.id, kitchen.kitchen_id, db, include_ingredients)

        items.append(item)

    return items


@router.get("/recipes/plated")
async def list_plated_recipes_compat(
    include_ingredients: str = Query("none", regex="^(none|flat|nested)$"),
    include_costs: bool = Query(False),
    exclude_flags: Optional[str] = Query(None, description="Comma-separated flag IDs to exclude"),
    kitchen: KitchenSettings = Depends(get_kitchen_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Backward-compatible alias for /recipes/dishes."""
    return await list_dish_recipes(include_ingredients, include_costs, exclude_flags, kitchen, db)


@router.get("/recipes/{recipe_id}")
async def get_dish_recipe(
    recipe_id: int,
    include_ingredients: str = Query("none", regex="^(none|flat|nested)$"),
    include_costs: bool = Query(False),
    kitchen: KitchenSettings = Depends(get_kitchen_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """Get a single dish recipe for external consumption."""
    result = await db.execute(
        select(Recipe)
        .options(selectinload(Recipe.menu_section), selectinload(Recipe.images))
        .where(
            Recipe.id == recipe_id,
            Recipe.kitchen_id == kitchen.kitchen_id,
            Recipe.recipe_type == "dish",
            Recipe.is_archived == False,
        )
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Recipe not found")

    flags = await compute_recipe_flags(recipe.id, kitchen.kitchen_id, db)
    active_flags = [f for f in flags if f.is_active]

    item = {
        "id": recipe.id,
        "name": recipe.name,
        "description": recipe.description,
        "menu_section": recipe.menu_section.name if recipe.menu_section else None,
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "flags": [
            {
                "id": f.food_flag_id,
                "name": f.flag_name,
                "code": f.flag_code,
                "icon": f.flag_icon,
                "category": f.category_name,
                "propagation": f.propagation_type,
                "excludable": f.excludable_on_request,
            }
            for f in active_flags
        ],
        "images": [
            {"id": img.id, "caption": img.caption, "image_type": img.image_type}
            for img in (recipe.images or [])
        ],
    }

    if include_costs:
        from api.recipes import _calc_recipe_cost
        cost_data = await _calc_recipe_cost(recipe.id, db)
        item["cost_per_portion"] = cost_data.get("cost_per_portion")
        item["total_cost"] = cost_data.get("total_cost_recent")

    if include_ingredients != "none":
        item["ingredients"] = await _get_recipe_ingredients(recipe.id, kitchen.kitchen_id, db, include_ingredients)

    return item


@router.get("/food-flags")
async def list_food_flags(
    kitchen: KitchenSettings = Depends(get_kitchen_from_api_key),
    db: AsyncSession = Depends(get_db),
):
    """List all flag categories and flags for external apps."""
    result = await db.execute(
        select(FoodFlagCategory)
        .options(selectinload(FoodFlagCategory.flags))
        .where(FoodFlagCategory.kitchen_id == kitchen.kitchen_id)
        .order_by(FoodFlagCategory.sort_order)
    )
    categories = result.scalars().all()
    return [
        {
            "id": cat.id,
            "name": cat.name,
            "propagation_type": cat.propagation_type,
            "flags": [
                {"id": f.id, "name": f.name, "code": f.code, "icon": f.icon}
                for f in sorted(cat.flags, key=lambda x: x.sort_order)
            ],
        }
        for cat in categories
    ]


async def _get_recipe_ingredients(recipe_id: int, kitchen_id: int, db: AsyncSession, mode: str) -> list:
    """Get ingredient list for external API — flat (consolidated) or nested (sub-recipe breakdown)."""
    if mode == "flat":
        # Consolidated list
        from api.event_orders import _collect_ingredients_for_recipe
        ing_qtys = await _collect_ingredients_for_recipe(recipe_id, 1.0, db)
        if not ing_qtys:
            return []

        result = await db.execute(
            select(Ingredient).where(Ingredient.id.in_(list(ing_qtys.keys())))
        )
        ingredients = {ing.id: ing for ing in result.scalars().all()}

        return [
            {
                "ingredient_id": ing_id,
                "name": ingredients[ing_id].name if ing_id in ingredients else "?",
                "quantity": round(qty, 3),
                "unit": ingredients[ing_id].standard_unit if ing_id in ingredients else "",
            }
            for ing_id, qty in sorted(ing_qtys.items())
        ]

    elif mode == "nested":
        # Show sub-recipe breakdown
        ri_result = await db.execute(
            select(RecipeIngredient)
            .options(selectinload(RecipeIngredient.ingredient))
            .where(RecipeIngredient.recipe_id == recipe_id)
            .order_by(RecipeIngredient.sort_order)
        )
        direct = [
            {
                "ingredient_id": ri.ingredient_id,
                "name": ri.ingredient.name if ri.ingredient else "?",
                "quantity": float(ri.quantity),
                "unit": ri.ingredient.standard_unit if ri.ingredient else "",
                "source": "direct",
            }
            for ri in ri_result.scalars().all()
        ]

        sr_result = await db.execute(
            select(RecipeSubRecipe)
            .options(selectinload(RecipeSubRecipe.child_recipe))
            .where(RecipeSubRecipe.parent_recipe_id == recipe_id)
        )
        sub_recipe_ings = []
        for sr in sr_result.scalars().all():
            child = sr.child_recipe
            if not child:
                continue
            cri_result = await db.execute(
                select(RecipeIngredient)
                .options(selectinload(RecipeIngredient.ingredient))
                .where(RecipeIngredient.recipe_id == child.id)
            )
            # Use unified output qty for bulk/portioned child recipes
            child_output_qty = float(child.batch_yield_qty) if child.batch_output_type == "bulk" and child.batch_yield_qty else (child.batch_portions or 1)
            child_output_unit = child.batch_yield_unit if child.batch_output_type == "bulk" and child.batch_yield_unit else "portion"
            # Convert portions_needed to child output unit if different unit was used
            needed = float(sr.portions_needed)
            needed_unit = sr.portions_needed_unit or child_output_unit
            if needed_unit != child_output_unit:
                _bases = {"g": 1.0, "kg": 1000.0, "ml": 1.0, "ltr": 1000.0}
                if needed_unit in _bases and child_output_unit in _bases:
                    needed = needed * _bases[needed_unit] / _bases[child_output_unit]
            scale = needed / child_output_qty
            for cri in cri_result.scalars().all():
                sub_recipe_ings.append({
                    "ingredient_id": cri.ingredient_id,
                    "name": cri.ingredient.name if cri.ingredient else "?",
                    "quantity": round(float(cri.quantity) * scale, 3),
                    "unit": cri.ingredient.standard_unit if cri.ingredient else "",
                    "source": f"sub-recipe: {child.name}",
                })

        return direct + sub_recipe_ings

    return []
