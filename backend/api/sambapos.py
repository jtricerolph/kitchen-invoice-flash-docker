"""
SambaPOS API Endpoints

Handles SambaPOS MSSQL configuration and category management.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from auth.jwt import get_current_user
from services.sambapos_api import SambaPOSClient

router = APIRouter()


# ============ Pydantic Schemas ============

class SambaPOSSettingsResponse(BaseModel):
    sambapos_db_host: str | None
    sambapos_db_port: int | None
    sambapos_db_name: str | None
    sambapos_db_username: str | None
    sambapos_db_password_set: bool
    sambapos_tracked_categories: list[str]
    sambapos_excluded_items: list[str]

    class Config:
        from_attributes = True


class SambaPOSSettingsUpdate(BaseModel):
    sambapos_db_host: str | None = None
    sambapos_db_port: int | None = None
    sambapos_db_name: str | None = None
    sambapos_db_username: str | None = None
    sambapos_db_password: str | None = None


class CategoryResponse(BaseModel):
    id: int
    name: str


class MenuItemResponse(BaseModel):
    name: str
    category: str


class TrackedCategoriesUpdate(BaseModel):
    categories: list[str]


class ExcludedItemsUpdate(BaseModel):
    items: list[str]


# ============ Settings Endpoints ============

@router.get("/settings", response_model=SambaPOSSettingsResponse)
async def get_sambapos_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get SambaPOS connection settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Parse tracked categories from comma-separated string
    tracked_categories = []
    if settings.sambapos_tracked_categories:
        tracked_categories = [c.strip() for c in settings.sambapos_tracked_categories.split(',') if c.strip()]

    # Parse excluded items from comma-separated string
    excluded_items = []
    if settings.sambapos_excluded_items:
        excluded_items = [i.strip() for i in settings.sambapos_excluded_items.split('|') if i.strip()]

    return SambaPOSSettingsResponse(
        sambapos_db_host=settings.sambapos_db_host,
        sambapos_db_port=settings.sambapos_db_port,
        sambapos_db_name=settings.sambapos_db_name,
        sambapos_db_username=settings.sambapos_db_username,
        sambapos_db_password_set=bool(settings.sambapos_db_password),
        sambapos_tracked_categories=tracked_categories,
        sambapos_excluded_items=excluded_items
    )


@router.patch("/settings", response_model=SambaPOSSettingsResponse)
async def update_sambapos_settings(
    update: SambaPOSSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update SambaPOS connection settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    # Parse tracked categories from comma-separated string
    tracked_categories = []
    if settings.sambapos_tracked_categories:
        tracked_categories = [c.strip() for c in settings.sambapos_tracked_categories.split(',') if c.strip()]

    # Parse excluded items from pipe-separated string
    excluded_items = []
    if settings.sambapos_excluded_items:
        excluded_items = [i.strip() for i in settings.sambapos_excluded_items.split('|') if i.strip()]

    return SambaPOSSettingsResponse(
        sambapos_db_host=settings.sambapos_db_host,
        sambapos_db_port=settings.sambapos_db_port,
        sambapos_db_name=settings.sambapos_db_name,
        sambapos_db_username=settings.sambapos_db_username,
        sambapos_db_password_set=bool(settings.sambapos_db_password),
        sambapos_tracked_categories=tracked_categories,
        sambapos_excluded_items=excluded_items
    )


@router.post("/test-connection")
async def test_sambapos_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test SambaPOS database connection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not all([
        settings.sambapos_db_host,
        settings.sambapos_db_name,
        settings.sambapos_db_username,
        settings.sambapos_db_password
    ]):
        raise HTTPException(status_code=400, detail="SambaPOS database credentials not fully configured")

    client = SambaPOSClient(
        host=settings.sambapos_db_host,
        port=settings.sambapos_db_port or 1433,
        database=settings.sambapos_db_name,
        username=settings.sambapos_db_username,
        password=settings.sambapos_db_password
    )

    result = await client.test_connection()

    if result["success"]:
        return {"status": "success", "message": "SambaPOS connection successful"}
    else:
        raise HTTPException(status_code=400, detail=f"Connection failed: {result['message']}")


# ============ Categories Endpoints ============

@router.get("/categories", response_model=list[CategoryResponse])
async def get_sambapos_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch all menu categories from SambaPOS database"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not all([
        settings.sambapos_db_host,
        settings.sambapos_db_name,
        settings.sambapos_db_username,
        settings.sambapos_db_password
    ]):
        raise HTTPException(status_code=400, detail="SambaPOS database credentials not configured")

    client = SambaPOSClient(
        host=settings.sambapos_db_host,
        port=settings.sambapos_db_port or 1433,
        database=settings.sambapos_db_name,
        username=settings.sambapos_db_username,
        password=settings.sambapos_db_password
    )

    try:
        categories = await client.get_categories()
        return [CategoryResponse(id=cat["id"], name=cat["name"]) for cat in categories]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch categories: {str(e)}")


@router.get("/tracked-categories")
async def get_tracked_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get list of category names enabled for top sellers"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Parse tracked categories from comma-separated string
    tracked_categories = []
    if settings.sambapos_tracked_categories:
        tracked_categories = [c.strip() for c in settings.sambapos_tracked_categories.split(',') if c.strip()]

    return {"categories": tracked_categories}


@router.patch("/tracked-categories")
async def update_tracked_categories(
    update: TrackedCategoriesUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update which categories are included in top sellers"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Store as comma-separated string
    settings.sambapos_tracked_categories = ','.join(update.categories)

    await db.commit()

    return {"status": "success", "categories": update.categories}


@router.get("/debug/menuitems")
async def debug_menuitems(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Debug endpoint to explore MenuItems table structure"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.sambapos_db_password:
        raise HTTPException(status_code=400, detail="SambaPOS not configured")

    client = SambaPOSClient(
        host=settings.sambapos_db_host,
        port=settings.sambapos_db_port or 1433,
        database=settings.sambapos_db_name,
        username=settings.sambapos_db_username,
        password=settings.sambapos_db_password
    )

    try:
        return await client.debug_menu_items()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============ Menu Items Endpoints ============

@router.get("/menu-items", response_model=list[MenuItemResponse])
async def get_menu_items(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch all unique menu item names with their categories for exclusion selection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not all([
        settings.sambapos_db_host,
        settings.sambapos_db_name,
        settings.sambapos_db_username,
        settings.sambapos_db_password
    ]):
        raise HTTPException(status_code=400, detail="SambaPOS database credentials not configured")

    # Get tracked categories to filter menu items
    tracked_categories = []
    if settings.sambapos_tracked_categories:
        tracked_categories = [c.strip() for c in settings.sambapos_tracked_categories.split(',') if c.strip()]

    client = SambaPOSClient(
        host=settings.sambapos_db_host,
        port=settings.sambapos_db_port or 1433,
        database=settings.sambapos_db_name,
        username=settings.sambapos_db_username,
        password=settings.sambapos_db_password
    )

    try:
        items = await client.get_menu_item_names(categories=tracked_categories if tracked_categories else None)
        return [MenuItemResponse(name=item["name"], category=item["category"]) for item in items]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch menu items: {str(e)}")


@router.get("/excluded-items")
async def get_excluded_items(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get list of menu item names excluded from top sellers report"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Parse excluded items from pipe-separated string
    excluded_items = []
    if settings.sambapos_excluded_items:
        excluded_items = [i.strip() for i in settings.sambapos_excluded_items.split('|') if i.strip()]

    return {"items": excluded_items}


@router.patch("/excluded-items")
async def update_excluded_items(
    update: ExcludedItemsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update which menu item GroupCodes are excluded from top sellers report"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Store as pipe-separated string (to allow commas in names)
    settings.sambapos_excluded_items = '|'.join(update.items)

    await db.commit()

    return {"status": "success", "items": update.items}


# ============ Group Codes Endpoints ============

class GroupCodeResponse(BaseModel):
    name: str


@router.get("/group-codes", response_model=list[GroupCodeResponse])
async def get_group_codes(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch all distinct GroupCode values from MenuItems table for exclusion selection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not all([
        settings.sambapos_db_host,
        settings.sambapos_db_name,
        settings.sambapos_db_username,
        settings.sambapos_db_password
    ]):
        raise HTTPException(status_code=400, detail="SambaPOS database credentials not configured")

    client = SambaPOSClient(
        host=settings.sambapos_db_host,
        port=settings.sambapos_db_port or 1433,
        database=settings.sambapos_db_name,
        username=settings.sambapos_db_username,
        password=settings.sambapos_db_password
    )

    try:
        group_codes = await client.get_menu_group_codes()
        return [GroupCodeResponse(name=gc["name"]) for gc in group_codes]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch group codes: {str(e)}")
