"""
Menus API — CRUD for menus, divisions, items + publish/republish + image upload + duplication.
Prefix: /api/menus/
"""
import os
import uuid
import logging
from datetime import datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from sqlalchemy.orm import selectinload

from database import get_db
from auth.jwt import get_current_user
from models.user import User
from models.menu import Menu, MenuDivision, MenuItem
from models.recipe import Recipe, RecipeSubRecipe
from api.food_flags import compute_recipe_flags, _collect_recipe_ingredient_ids
from models.food_flag import FoodFlagCategory, FoodFlag
from models.ingredient import IngredientFlag, IngredientFlagNone

logger = logging.getLogger(__name__)
DATA_DIR = os.getenv("DATA_DIR", "/app/data")

router = APIRouter()

DEFAULT_DIVISIONS = ["Starters", "Mains", "Sides", "Desserts"]


# ── Pydantic Models ──────────────────────────────────────────────────────────

class MenuCreate(BaseModel):
    name: str
    description: Optional[str] = None
    notes: Optional[str] = None
    preset_divisions: bool = False

class MenuUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class DivisionCreate(BaseModel):
    name: str

class DivisionUpdate(BaseModel):
    name: str

class ItemPublish(BaseModel):
    recipe_id: int
    division_id: int
    display_name: str
    description: Optional[str] = None
    price: Optional[Decimal] = None
    confirmed_by_name: str

class ItemUpdate(BaseModel):
    display_name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[Decimal] = None
    division_id: Optional[int] = None

class RepublishRequest(BaseModel):
    confirmed_by_name: str

class BulkPublishItem(BaseModel):
    recipe_id: int
    display_name: str
    description: Optional[str] = None
    price: Optional[Decimal] = None

class BulkPublishRequest(BaseModel):
    division_id: int
    confirmed_by_name: str
    items: list[BulkPublishItem]

class BatchRepublishItem(BaseModel):
    id: int
    confirmed: bool = True

class BatchRepublishRequest(BaseModel):
    confirmed_by_name: str
    items: list[BatchRepublishItem]

class MenuDuplicate(BaseModel):
    name: str

class ReorderRequest(BaseModel):
    ids: list[int]


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_menu(menu_id: int, kitchen_id: int, db: AsyncSession) -> Menu:
    result = await db.execute(
        select(Menu).where(Menu.id == menu_id, Menu.kitchen_id == kitchen_id)
    )
    menu = result.scalar_one_or_none()
    if not menu:
        raise HTTPException(404, "Menu not found")
    return menu


async def _collect_sub_recipe_ids(recipe_id: int, db: AsyncSession, depth: int = 0) -> list[int]:
    """Recursively collect all sub-recipe IDs in a recipe tree."""
    if depth > 5:
        return []
    ids = [recipe_id]
    sr_result = await db.execute(
        select(RecipeSubRecipe.child_recipe_id).where(RecipeSubRecipe.parent_recipe_id == recipe_id)
    )
    for (child_id,) in sr_result.fetchall():
        ids.extend(await _collect_sub_recipe_ids(child_id, db, depth + 1))
    return ids


async def _compute_staleness(items: list[MenuItem], db: AsyncSession) -> dict[int, dict]:
    """Batch compute staleness for menu items. Returns {item_id: {is_stale, stale_reason, is_archived}}."""
    result = {}
    recipe_ids = [item.recipe_id for item in items if item.recipe_id is not None]

    if not recipe_ids:
        for item in items:
            result[item.id] = {
                "is_stale": False,
                "stale_reason": None,
                "is_archived": item.recipe_id is None,
            }
        return result

    # Batch load recipe updated_at and is_archived
    recipe_result = await db.execute(
        select(Recipe.id, Recipe.updated_at, Recipe.is_archived).where(Recipe.id.in_(recipe_ids))
    )
    recipe_info = {r.id: (r.updated_at, r.is_archived) for r in recipe_result.fetchall()}

    # Collect all sub-recipe trees for all menu item recipes
    all_tree_ids: dict[int, list[int]] = {}
    for rid in recipe_ids:
        all_tree_ids[rid] = await _collect_sub_recipe_ids(rid, db)

    # Batch query max updated_at for all sub-recipes
    all_sub_ids = set()
    for tree in all_tree_ids.values():
        all_sub_ids.update(tree)

    sub_updated = {}
    if all_sub_ids:
        sub_result = await db.execute(
            select(Recipe.id, Recipe.updated_at).where(Recipe.id.in_(list(all_sub_ids)))
        )
        sub_updated = {r.id: r.updated_at for r in sub_result.fetchall()}

    for item in items:
        if item.recipe_id is None:
            result[item.id] = {"is_stale": False, "stale_reason": None, "is_archived": True}
            continue

        info = recipe_info.get(item.recipe_id)
        if not info:
            # Recipe was fully deleted (shouldn't happen with SET NULL but handle it)
            result[item.id] = {"is_stale": False, "stale_reason": None, "is_archived": True}
            continue

        recipe_updated, recipe_archived = info

        if recipe_archived:
            result[item.id] = {"is_stale": False, "stale_reason": None, "is_archived": True}
            continue

        # Check staleness: recipe or any sub-recipe updated after publish
        is_stale = False
        stale_reason = None

        if recipe_updated and item.published_at and recipe_updated > item.published_at:
            is_stale = True
            stale_reason = "Dish edited after publishing"

        if not is_stale:
            tree_ids = all_tree_ids.get(item.recipe_id, [])
            for sub_id in tree_ids:
                if sub_id == item.recipe_id:
                    continue
                sub_up = sub_updated.get(sub_id)
                if sub_up and item.published_at and sub_up > item.published_at:
                    is_stale = True
                    stale_reason = "Sub-recipe edited after publishing"
                    break

        result[item.id] = {"is_stale": is_stale, "stale_reason": stale_reason, "is_archived": False}

    return result


async def _build_snapshot(item: MenuItem, flags: list, user_id: int, confirmed_by_name: str) -> dict:
    """Build the snapshot JSON blob for a menu item at publish time."""
    return {
        "display_name": item.display_name,
        "description": item.description,
        "price": str(item.price) if item.price is not None else None,
        "confirmed_flags": [
            {
                "id": f.food_flag_id,
                "name": f.flag_name,
                "code": f.flag_code,
                "icon": f.flag_icon,
                "category": f.category_name,
                "propagation": f.propagation_type,
                "excludable": f.excludable_on_request,
            }
            for f in flags if f.is_active
        ],
        "confirmed_by_name": confirmed_by_name,
        "confirmed_by_user_id": user_id,
        "published_at": datetime.utcnow().isoformat(),
    }


async def _check_unassessed(recipe_id: int, kitchen_id: int, db: AsyncSession) -> list[dict]:
    """Check for unassessed ingredients in a recipe. Returns list of unassessed if any."""
    all_ing_ids = await _collect_recipe_ingredient_ids(recipe_id, db)
    unique_ids = list(set(all_ing_ids))
    if not unique_ids:
        return []

    req_cat_result = await db.execute(
        select(FoodFlagCategory.id, FoodFlagCategory.name).where(
            FoodFlagCategory.kitchen_id == kitchen_id,
            FoodFlagCategory.required == True,
        )
    )
    required_cats = req_cat_result.all()
    if not required_cats:
        return []

    cat_flag_map: dict[int, set[int]] = {}
    for cat_id, _ in required_cats:
        rf_result = await db.execute(select(FoodFlag.id).where(FoodFlag.category_id == cat_id))
        cat_flag_map[cat_id] = set(rf_result.scalars().all())

    from models.ingredient import Ingredient
    unassessed = []
    for ing_id in unique_ids:
        ing_result = await db.execute(select(Ingredient.name).where(Ingredient.id == ing_id))
        name = ing_result.scalar()
        if not name:
            continue

        none_result = await db.execute(
            select(IngredientFlagNone.category_id).where(IngredientFlagNone.ingredient_id == ing_id)
        )
        none_cat_ids = set(none_result.scalars().all())

        for cat_id, cat_name in required_cats:
            if cat_id in none_cat_ids:
                continue
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
                break

    return unassessed


# ── Menu CRUD ────────────────────────────────────────────────────────────────

@router.get("")
async def list_menus(
    search: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List menus with division/item counts."""
    query = (
        select(Menu)
        .options(selectinload(Menu.divisions), selectinload(Menu.items))
        .where(Menu.kitchen_id == user.kitchen_id)
        .order_by(Menu.sort_order, Menu.name)
    )
    result = await db.execute(query)
    menus = result.scalars().all()

    if search:
        search_lower = search.lower()
        menus = [m for m in menus if search_lower in m.name.lower()]

    items_list = []
    for m in menus:
        # Count how many items are on active menus for published indicator
        items_list.append({
            "id": m.id,
            "name": m.name,
            "description": m.description,
            "notes": m.notes,
            "is_active": m.is_active,
            "sort_order": m.sort_order,
            "division_count": len(m.divisions) if m.divisions else 0,
            "item_count": len(m.items) if m.items else 0,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "updated_at": m.updated_at.isoformat() if m.updated_at else None,
        })

    return items_list


@router.post("")
async def create_menu(
    body: MenuCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new menu, optionally with preset divisions."""
    # Check unique name
    existing = await db.execute(
        select(Menu).where(Menu.kitchen_id == user.kitchen_id, Menu.name == body.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "A menu with this name already exists")

    # Get next sort_order
    max_order = await db.execute(
        select(func.max(Menu.sort_order)).where(Menu.kitchen_id == user.kitchen_id)
    )
    next_order = (max_order.scalar() or 0) + 1

    menu = Menu(
        kitchen_id=user.kitchen_id,
        name=body.name,
        description=body.description,
        notes=body.notes,
        sort_order=next_order,
    )
    db.add(menu)
    await db.flush()

    if body.preset_divisions:
        for i, name in enumerate(DEFAULT_DIVISIONS):
            db.add(MenuDivision(menu_id=menu.id, name=name, sort_order=i))

    await db.commit()
    await db.refresh(menu)

    return {
        "id": menu.id,
        "name": menu.name,
        "description": menu.description,
        "notes": menu.notes,
        "is_active": menu.is_active,
        "sort_order": menu.sort_order,
    }


@router.get("/{menu_id}")
async def get_menu(
    menu_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full menu detail with divisions, items, staleness, and archived indicators."""
    result = await db.execute(
        select(Menu)
        .options(
            selectinload(Menu.divisions).selectinload(MenuDivision.items),
            selectinload(Menu.items),
        )
        .where(Menu.id == menu_id, Menu.kitchen_id == user.kitchen_id)
    )
    menu = result.scalar_one_or_none()
    if not menu:
        raise HTTPException(404, "Menu not found")

    # Compute staleness for all items
    all_items = menu.items or []
    staleness = await _compute_staleness(all_items, db)

    # Build divisions with items
    divisions_data = []
    for div in sorted(menu.divisions or [], key=lambda d: d.sort_order):
        div_items = sorted(
            [i for i in all_items if i.division_id == div.id],
            key=lambda i: i.sort_order,
        )
        items_data = []
        for item in div_items:
            stale_info = staleness.get(item.id, {"is_stale": False, "stale_reason": None, "is_archived": False})
            items_data.append({
                "id": item.id,
                "recipe_id": item.recipe_id,
                "display_name": item.display_name,
                "description": item.description,
                "price": str(item.price) if item.price is not None else None,
                "sort_order": item.sort_order,
                "snapshot_json": item.snapshot_json,
                "confirmed_by_name": item.confirmed_by_name,
                "confirmed_by_user_id": item.confirmed_by_user_id,
                "published_at": item.published_at.isoformat() if item.published_at else None,
                "has_image": bool(item.image_path),
                "is_stale": stale_info["is_stale"],
                "stale_reason": stale_info["stale_reason"],
                "is_archived": stale_info["is_archived"],
            })
        divisions_data.append({
            "id": div.id,
            "name": div.name,
            "sort_order": div.sort_order,
            "items": items_data,
        })

    return {
        "id": menu.id,
        "name": menu.name,
        "description": menu.description,
        "notes": menu.notes,
        "is_active": menu.is_active,
        "sort_order": menu.sort_order,
        "created_at": menu.created_at.isoformat() if menu.created_at else None,
        "updated_at": menu.updated_at.isoformat() if menu.updated_at else None,
        "divisions": divisions_data,
    }


@router.put("/{menu_id}")
async def update_menu(
    menu_id: int,
    body: MenuUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update menu name, description, notes, or active status."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    if body.name is not None and body.name != menu.name:
        existing = await db.execute(
            select(Menu).where(
                Menu.kitchen_id == user.kitchen_id,
                Menu.name == body.name,
                Menu.id != menu_id,
            )
        )
        if existing.scalar_one_or_none():
            raise HTTPException(400, "A menu with this name already exists")
        menu.name = body.name

    if body.description is not None:
        menu.description = body.description
    if body.notes is not None:
        menu.notes = body.notes
    if body.is_active is not None:
        menu.is_active = body.is_active

    menu.updated_at = datetime.utcnow()
    await db.commit()
    return {"ok": True}


@router.delete("/{menu_id}")
async def delete_menu(
    menu_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a menu and all its divisions/items."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    # Clean up menu item images from disk
    items_result = await db.execute(
        select(MenuItem.image_path).where(MenuItem.menu_id == menu_id, MenuItem.image_path != None)
    )
    for (path,) in items_result.fetchall():
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

    await db.delete(menu)
    await db.commit()
    return {"ok": True}


@router.patch("/reorder")
async def reorder_menus(
    body: ReorderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reorder menus."""
    for i, mid in enumerate(body.ids):
        result = await db.execute(
            select(Menu).where(Menu.id == mid, Menu.kitchen_id == user.kitchen_id)
        )
        m = result.scalar_one_or_none()
        if m:
            m.sort_order = i
    await db.commit()
    return {"ok": True}


# ── Division CRUD ────────────────────────────────────────────────────────────

@router.post("/{menu_id}/divisions")
async def add_division(
    menu_id: int,
    body: DivisionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a division to a menu."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    existing = await db.execute(
        select(MenuDivision).where(MenuDivision.menu_id == menu_id, MenuDivision.name == body.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "A division with this name already exists in this menu")

    max_order = await db.execute(
        select(func.max(MenuDivision.sort_order)).where(MenuDivision.menu_id == menu_id)
    )
    next_order = (max_order.scalar() or 0) + 1

    div = MenuDivision(menu_id=menu_id, name=body.name, sort_order=next_order)
    db.add(div)
    await db.commit()
    await db.refresh(div)

    return {"id": div.id, "name": div.name, "sort_order": div.sort_order}


@router.put("/{menu_id}/divisions/{division_id}")
async def update_division(
    menu_id: int,
    division_id: int,
    body: DivisionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rename a division."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuDivision).where(MenuDivision.id == division_id, MenuDivision.menu_id == menu_id)
    )
    div = result.scalar_one_or_none()
    if not div:
        raise HTTPException(404, "Division not found")

    # Check unique name
    existing = await db.execute(
        select(MenuDivision).where(
            MenuDivision.menu_id == menu_id,
            MenuDivision.name == body.name,
            MenuDivision.id != division_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "A division with this name already exists in this menu")

    div.name = body.name
    await db.commit()
    return {"ok": True}


@router.delete("/{menu_id}/divisions/{division_id}")
async def delete_division(
    menu_id: int,
    division_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a division and its items."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuDivision).where(MenuDivision.id == division_id, MenuDivision.menu_id == menu_id)
    )
    div = result.scalar_one_or_none()
    if not div:
        raise HTTPException(404, "Division not found")

    # Clean up item images
    items_result = await db.execute(
        select(MenuItem.image_path).where(MenuItem.division_id == division_id, MenuItem.image_path != None)
    )
    for (path,) in items_result.fetchall():
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

    await db.delete(div)
    await db.commit()
    return {"ok": True}


@router.patch("/{menu_id}/divisions/reorder")
async def reorder_divisions(
    menu_id: int,
    body: ReorderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reorder divisions within a menu."""
    await _get_menu(menu_id, user.kitchen_id, db)

    for i, div_id in enumerate(body.ids):
        result = await db.execute(
            select(MenuDivision).where(MenuDivision.id == div_id, MenuDivision.menu_id == menu_id)
        )
        div = result.scalar_one_or_none()
        if div:
            div.sort_order = i
    await db.commit()
    return {"ok": True}


# ── Publish / Items ──────────────────────────────────────────────────────────

@router.post("/{menu_id}/items")
async def publish_item(
    menu_id: int,
    body: ItemPublish,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Publish a dish to a menu with allergen confirmation."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    # Verify recipe is a non-archived dish
    recipe_result = await db.execute(
        select(Recipe).where(
            Recipe.id == body.recipe_id,
            Recipe.kitchen_id == user.kitchen_id,
            Recipe.recipe_type == "dish",
            Recipe.is_archived == False,
        )
    )
    recipe = recipe_result.scalar_one_or_none()
    if not recipe:
        raise HTTPException(404, "Dish not found or is archived")

    # Check not already on this menu
    existing = await db.execute(
        select(MenuItem).where(MenuItem.menu_id == menu_id, MenuItem.recipe_id == body.recipe_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "This dish is already on this menu")

    # Verify division belongs to this menu
    div_result = await db.execute(
        select(MenuDivision).where(MenuDivision.id == body.division_id, MenuDivision.menu_id == menu_id)
    )
    if not div_result.scalar_one_or_none():
        raise HTTPException(400, "Division not found in this menu")

    # Check for unassessed ingredients
    unassessed = await _check_unassessed(body.recipe_id, user.kitchen_id, db)
    if unassessed:
        raise HTTPException(400, detail={
            "message": "Cannot publish: dish has unassessed ingredients",
            "unassessed_ingredients": unassessed,
        })

    # Compute flags
    flags = await compute_recipe_flags(body.recipe_id, user.kitchen_id, db)

    # Get next sort_order
    max_order = await db.execute(
        select(func.max(MenuItem.sort_order)).where(
            MenuItem.menu_id == menu_id, MenuItem.division_id == body.division_id
        )
    )
    next_order = (max_order.scalar() or 0) + 1

    item = MenuItem(
        menu_id=menu_id,
        division_id=body.division_id,
        recipe_id=body.recipe_id,
        display_name=body.display_name,
        description=body.description,
        price=body.price,
        sort_order=next_order,
        confirmed_by_user_id=user.id,
        confirmed_by_name=body.confirmed_by_name,
        published_at=datetime.utcnow(),
    )

    # Build snapshot
    item.snapshot_json = await _build_snapshot(item, flags, user.id, body.confirmed_by_name)

    db.add(item)
    await db.commit()
    await db.refresh(item)

    return {
        "id": item.id,
        "display_name": item.display_name,
        "published_at": item.published_at.isoformat() if item.published_at else None,
    }


@router.post("/{menu_id}/items/bulk")
async def bulk_publish_items(
    menu_id: int,
    body: BulkPublishRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bulk publish multiple dishes to a menu."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    # Verify division
    div_result = await db.execute(
        select(MenuDivision).where(MenuDivision.id == body.division_id, MenuDivision.menu_id == menu_id)
    )
    if not div_result.scalar_one_or_none():
        raise HTTPException(400, "Division not found in this menu")

    # Validate all dishes first
    errors = []
    valid_items = []
    for bi in body.items:
        recipe_result = await db.execute(
            select(Recipe).where(
                Recipe.id == bi.recipe_id,
                Recipe.kitchen_id == user.kitchen_id,
                Recipe.recipe_type == "dish",
                Recipe.is_archived == False,
            )
        )
        recipe = recipe_result.scalar_one_or_none()
        if not recipe:
            errors.append({"recipe_id": bi.recipe_id, "error": "Dish not found or is archived"})
            continue

        existing = await db.execute(
            select(MenuItem).where(MenuItem.menu_id == menu_id, MenuItem.recipe_id == bi.recipe_id)
        )
        if existing.scalar_one_or_none():
            errors.append({"recipe_id": bi.recipe_id, "error": "Already on this menu"})
            continue

        unassessed = await _check_unassessed(bi.recipe_id, user.kitchen_id, db)
        if unassessed:
            errors.append({
                "recipe_id": bi.recipe_id,
                "error": "Has unassessed ingredients",
                "unassessed_ingredients": unassessed,
            })
            continue

        valid_items.append((bi, recipe))

    if errors:
        raise HTTPException(400, detail={"message": "Some dishes failed validation", "errors": errors})

    # All valid — publish
    max_order = await db.execute(
        select(func.max(MenuItem.sort_order)).where(
            MenuItem.menu_id == menu_id, MenuItem.division_id == body.division_id
        )
    )
    next_order = (max_order.scalar() or 0) + 1

    created = []
    for i, (bi, recipe) in enumerate(valid_items):
        flags = await compute_recipe_flags(bi.recipe_id, user.kitchen_id, db)

        item = MenuItem(
            menu_id=menu_id,
            division_id=body.division_id,
            recipe_id=bi.recipe_id,
            display_name=bi.display_name,
            description=bi.description,
            price=bi.price,
            sort_order=next_order + i,
            confirmed_by_user_id=user.id,
            confirmed_by_name=body.confirmed_by_name,
            published_at=datetime.utcnow(),
        )
        item.snapshot_json = await _build_snapshot(item, flags, user.id, body.confirmed_by_name)
        db.add(item)
        created.append(bi.recipe_id)

    await db.commit()
    return {"ok": True, "published_count": len(created), "published_recipe_ids": created}


@router.put("/{menu_id}/items/{item_id}")
async def update_item(
    menu_id: int,
    item_id: int,
    body: ItemUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Edit a menu item's display info or move to a different division."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Menu item not found")

    if body.display_name is not None:
        item.display_name = body.display_name
    if body.description is not None:
        item.description = body.description
    if body.price is not None:
        item.price = body.price
    if body.division_id is not None:
        div_result = await db.execute(
            select(MenuDivision).where(MenuDivision.id == body.division_id, MenuDivision.menu_id == menu_id)
        )
        if not div_result.scalar_one_or_none():
            raise HTTPException(400, "Target division not found in this menu")
        item.division_id = body.division_id

    # Update snapshot display fields
    if item.snapshot_json:
        snapshot = dict(item.snapshot_json)
        if body.display_name is not None:
            snapshot["display_name"] = body.display_name
        if body.description is not None:
            snapshot["description"] = body.description
        if body.price is not None:
            snapshot["price"] = str(body.price)
        item.snapshot_json = snapshot

    await db.commit()
    return {"ok": True}


@router.delete("/{menu_id}/items/{item_id}")
async def delete_item(
    menu_id: int,
    item_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a dish from a menu."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Menu item not found")

    # Clean up image
    if item.image_path and os.path.exists(item.image_path):
        try:
            os.remove(item.image_path)
        except OSError:
            pass

    await db.delete(item)
    await db.commit()
    return {"ok": True}


@router.post("/{menu_id}/items/{item_id}/republish")
async def republish_item(
    menu_id: int,
    item_id: int,
    body: RepublishRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Republish a menu item — re-confirm allergens and update snapshot."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Menu item not found")

    if item.recipe_id is None:
        raise HTTPException(400, "Cannot republish: dish has been archived or deleted")

    # Check unassessed
    unassessed = await _check_unassessed(item.recipe_id, user.kitchen_id, db)
    if unassessed:
        raise HTTPException(400, detail={
            "message": "Cannot republish: dish has unassessed ingredients",
            "unassessed_ingredients": unassessed,
        })

    # Recompute flags
    flags = await compute_recipe_flags(item.recipe_id, user.kitchen_id, db)

    item.confirmed_by_user_id = user.id
    item.confirmed_by_name = body.confirmed_by_name
    item.published_at = datetime.utcnow()
    item.snapshot_json = await _build_snapshot(item, flags, user.id, body.confirmed_by_name)

    await db.commit()
    return {"ok": True, "published_at": item.published_at.isoformat()}


@router.patch("/{menu_id}/items/reorder")
async def reorder_items(
    menu_id: int,
    body: ReorderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reorder items within a menu."""
    await _get_menu(menu_id, user.kitchen_id, db)

    for i, item_id in enumerate(body.ids):
        result = await db.execute(
            select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
        )
        item = result.scalar_one_or_none()
        if item:
            item.sort_order = i
    await db.commit()
    return {"ok": True}


# ── Batch Republish ──────────────────────────────────────────────────────────

@router.post("/{menu_id}/republish-stale")
async def batch_republish_stale(
    menu_id: int,
    body: BatchRepublishRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Batch republish stale items on a menu."""
    await _get_menu(menu_id, user.kitchen_id, db)

    results = []
    for bi in body.items:
        if not bi.confirmed:
            results.append({"id": bi.id, "status": "skipped"})
            continue

        result = await db.execute(
            select(MenuItem).where(MenuItem.id == bi.id, MenuItem.menu_id == menu_id)
        )
        item = result.scalar_one_or_none()
        if not item:
            results.append({"id": bi.id, "status": "error", "message": "Item not found"})
            continue

        if item.recipe_id is None:
            results.append({"id": bi.id, "status": "error", "message": "Dish archived"})
            continue

        unassessed = await _check_unassessed(item.recipe_id, user.kitchen_id, db)
        if unassessed:
            results.append({
                "id": bi.id, "status": "blocked",
                "message": "Has unassessed ingredients",
                "unassessed_ingredients": unassessed,
            })
            continue

        flags = await compute_recipe_flags(item.recipe_id, user.kitchen_id, db)
        item.confirmed_by_user_id = user.id
        item.confirmed_by_name = body.confirmed_by_name
        item.published_at = datetime.utcnow()
        item.snapshot_json = await _build_snapshot(item, flags, user.id, body.confirmed_by_name)
        results.append({"id": bi.id, "status": "republished"})

    await db.commit()
    return {"results": results}


# ── Menu Item Image ──────────────────────────────────────────────────────────

@router.post("/{menu_id}/items/{item_id}/image")
async def upload_item_image(
    menu_id: int,
    item_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a customer-quality image for a menu item."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Menu item not found")

    # Remove old image if exists
    if item.image_path and os.path.exists(item.image_path):
        try:
            os.remove(item.image_path)
        except OSError:
            pass

    # Save new image
    img_dir = os.path.join(DATA_DIR, str(user.kitchen_id), "menus")
    os.makedirs(img_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "img.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(img_dir, filename)

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    item.image_path = filepath
    item.uploaded_by = user.id

    # Update snapshot with image indicator
    if item.snapshot_json:
        snapshot = dict(item.snapshot_json)
        snapshot["has_image"] = True
        item.snapshot_json = snapshot

    await db.commit()
    return {"ok": True}


@router.get("/{menu_id}/items/{item_id}/image")
async def serve_item_image(
    menu_id: int,
    item_id: int,
    token: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Serve a menu item image. Auth via token query param."""
    if not token:
        raise HTTPException(401, "Missing token")

    # Validate token
    from auth.jwt import verify_token
    try:
        verify_token(token)
    except Exception:
        raise HTTPException(401, "Invalid token")

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item or not item.image_path:
        raise HTTPException(404, "Image not found")

    if not os.path.exists(item.image_path):
        raise HTTPException(404, "Image file not found")

    return FileResponse(item.image_path)


@router.delete("/{menu_id}/items/{item_id}/image")
async def delete_item_image(
    menu_id: int,
    item_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a menu item's image."""
    await _get_menu(menu_id, user.kitchen_id, db)

    result = await db.execute(
        select(MenuItem).where(MenuItem.id == item_id, MenuItem.menu_id == menu_id)
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Menu item not found")

    if item.image_path and os.path.exists(item.image_path):
        try:
            os.remove(item.image_path)
        except OSError:
            pass

    item.image_path = None
    item.uploaded_by = None

    if item.snapshot_json:
        snapshot = dict(item.snapshot_json)
        snapshot.pop("has_image", None)
        item.snapshot_json = snapshot

    await db.commit()
    return {"ok": True}


# ── Menu Duplication ─────────────────────────────────────────────────────────

@router.post("/{menu_id}/duplicate")
async def duplicate_menu(
    menu_id: int,
    body: MenuDuplicate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Clone a menu with new name, copying divisions and items (not images)."""
    menu = await _get_menu(menu_id, user.kitchen_id, db)

    # Check unique name
    existing = await db.execute(
        select(Menu).where(Menu.kitchen_id == user.kitchen_id, Menu.name == body.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "A menu with this name already exists")

    # Load full menu
    result = await db.execute(
        select(Menu)
        .options(selectinload(Menu.divisions).selectinload(MenuDivision.items))
        .where(Menu.id == menu_id, Menu.kitchen_id == user.kitchen_id)
    )
    source = result.scalar_one_or_none()

    max_order = await db.execute(
        select(func.max(Menu.sort_order)).where(Menu.kitchen_id == user.kitchen_id)
    )
    next_order = (max_order.scalar() or 0) + 1

    new_menu = Menu(
        kitchen_id=user.kitchen_id,
        name=body.name,
        description=source.description,
        notes=source.notes,
        is_active=False,  # Start inactive
        sort_order=next_order,
    )
    db.add(new_menu)
    await db.flush()

    # Copy divisions and items
    for div in sorted(source.divisions or [], key=lambda d: d.sort_order):
        new_div = MenuDivision(menu_id=new_menu.id, name=div.name, sort_order=div.sort_order)
        db.add(new_div)
        await db.flush()

        for item in sorted(div.items or [], key=lambda i: i.sort_order):
            new_item = MenuItem(
                menu_id=new_menu.id,
                division_id=new_div.id,
                recipe_id=item.recipe_id,
                display_name=item.display_name,
                description=item.description,
                price=item.price,
                sort_order=item.sort_order,
                snapshot_json=item.snapshot_json,
                confirmed_by_user_id=item.confirmed_by_user_id,
                confirmed_by_name=item.confirmed_by_name,
                published_at=item.published_at,
                # image_path not copied — new menu needs own images
            )
            db.add(new_item)

    await db.commit()
    return {"id": new_menu.id, "name": new_menu.name}


# ── Flag Matrix (for print) ─────────────────────────────────────────────────

@router.get("/{menu_id}/flags")
async def get_menu_flag_matrix(
    menu_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Consolidated flag matrix for all items on a menu (for print view)."""
    result = await db.execute(
        select(Menu)
        .options(
            selectinload(Menu.divisions).selectinload(MenuDivision.items),
            selectinload(Menu.items),
        )
        .where(Menu.id == menu_id, Menu.kitchen_id == user.kitchen_id)
    )
    menu = result.scalar_one_or_none()
    if not menu:
        raise HTTPException(404, "Menu not found")

    # Get all flag categories and flags for this kitchen
    cat_result = await db.execute(
        select(FoodFlagCategory)
        .options(selectinload(FoodFlagCategory.flags))
        .where(FoodFlagCategory.kitchen_id == user.kitchen_id)
        .order_by(FoodFlagCategory.sort_order)
    )
    categories = cat_result.scalars().all()

    all_flags = []
    for cat in categories:
        for f in sorted(cat.flags, key=lambda x: x.sort_order):
            all_flags.append({
                "id": f.id,
                "name": f.name,
                "code": f.code,
                "icon": f.icon,
                "category_id": cat.id,
                "category_name": cat.name,
            })

    # Build matrix from snapshots
    divisions_data = []
    for div in sorted(menu.divisions or [], key=lambda d: d.sort_order):
        div_items = sorted(
            [i for i in (menu.items or []) if i.division_id == div.id],
            key=lambda i: i.sort_order,
        )
        items_matrix = []
        for item in div_items:
            snapshot_flags = {}
            if item.snapshot_json and "confirmed_flags" in item.snapshot_json:
                snapshot_flags = {f["id"]: True for f in item.snapshot_json["confirmed_flags"]}

            flag_cells = {}
            for f in all_flags:
                flag_cells[str(f["id"])] = snapshot_flags.get(f["id"], False)

            items_matrix.append({
                "id": item.id,
                "display_name": item.display_name,
                "flags": flag_cells,
            })

        divisions_data.append({
            "name": div.name,
            "items": items_matrix,
        })

    return {
        "menu_name": menu.name,
        "all_flags": all_flags,
        "divisions": divisions_data,
    }


# ── Dish-on-menu lookup (for DishEditor/DishList indicators) ─────────────────

@router.get("/dish/{recipe_id}/menus")
async def get_dish_menus(
    recipe_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get list of menus a dish is published on."""
    result = await db.execute(
        select(MenuItem.menu_id, Menu.name, Menu.is_active)
        .join(Menu, MenuItem.menu_id == Menu.id)
        .where(
            MenuItem.recipe_id == recipe_id,
            Menu.kitchen_id == user.kitchen_id,
        )
    )
    rows = result.fetchall()
    return [
        {"menu_id": r.menu_id, "menu_name": r.name, "is_active": r.is_active}
        for r in rows
    ]
