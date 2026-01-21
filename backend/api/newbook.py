"""
Newbook API Endpoints

Handles Newbook configuration, GL account management, and data sync operations.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from models.newbook import (
    NewbookGLAccount, NewbookDailyRevenue, NewbookDailyOccupancy, NewbookSyncLog, NewbookRoomCategory
)
from models.resos import ResosBooking, ResosOpeningHour
from auth.jwt import get_current_user
from services.newbook_sync import NewbookSyncService
from services.newbook_api import NewbookAPIClient, NewbookAPIError

router = APIRouter()


# ============ Pydantic Schemas ============

class NewbookSettingsResponse(BaseModel):
    newbook_api_username: str | None
    newbook_api_password_set: bool
    newbook_api_key_set: bool
    newbook_api_region: str | None
    newbook_instance_id: str | None
    newbook_last_sync: datetime | None
    newbook_auto_sync_enabled: bool
    newbook_breakfast_gl_codes: str | None
    newbook_dinner_gl_codes: str | None
    newbook_breakfast_vat_rate: Decimal | None
    newbook_dinner_vat_rate: Decimal | None

    class Config:
        from_attributes = True


class NewbookSettingsUpdate(BaseModel):
    newbook_api_username: str | None = None
    newbook_api_password: str | None = None
    newbook_api_key: str | None = None
    newbook_api_region: str | None = None  # au, ap, eu, us
    newbook_instance_id: str | None = None
    newbook_auto_sync_enabled: bool | None = None
    newbook_breakfast_gl_codes: str | None = None
    newbook_dinner_gl_codes: str | None = None
    newbook_breakfast_vat_rate: Decimal | None = None
    newbook_dinner_vat_rate: Decimal | None = None


class GLAccountResponse(BaseModel):
    id: int
    gl_account_id: str
    gl_code: str | None
    gl_name: str
    gl_type: str | None
    gl_group_id: str | None
    gl_group_name: str | None
    is_tracked: bool
    display_order: int

    class Config:
        from_attributes = True


class GLAccountUpdate(BaseModel):
    is_tracked: bool
    display_order: int | None = None


class GLAccountBulkUpdateItem(BaseModel):
    id: int
    is_tracked: bool
    display_order: int | None = None


class GLAccountBulkUpdate(BaseModel):
    updates: list[GLAccountBulkUpdateItem]


class RoomCategoryResponse(BaseModel):
    id: int
    site_id: str
    site_name: str
    site_type: str | None
    room_count: int = 0
    is_included: bool
    display_order: int

    class Config:
        from_attributes = True


class RoomCategoryUpdate(BaseModel):
    is_included: bool
    display_order: int | None = None


class RoomCategoryBulkUpdateItem(BaseModel):
    id: int
    is_included: bool
    display_order: int | None = None


class RoomCategoryBulkUpdate(BaseModel):
    updates: list[RoomCategoryBulkUpdateItem]


class DailyRevenueResponse(BaseModel):
    date: date
    gl_account_id: int
    gl_account_name: str
    amount_net: Decimal

    class Config:
        from_attributes = True


class RevenueSummaryResponse(BaseModel):
    start_date: date
    end_date: date
    total_revenue: Decimal
    by_account: list[dict]  # {gl_account_name, total}
    by_date: list[dict]  # {date, total}


class OccupancyResponse(BaseModel):
    date: date
    total_rooms: int | None
    occupied_rooms: int | None
    occupancy_percentage: Decimal | None
    total_guests: int | None
    breakfast_allocation_qty: int | None
    breakfast_allocation_netvalue: Decimal | None
    dinner_allocation_qty: int | None
    dinner_allocation_netvalue: Decimal | None
    is_forecast: bool

    class Config:
        from_attributes = True


class SyncLogResponse(BaseModel):
    id: int
    sync_type: str
    started_at: datetime
    completed_at: datetime | None
    status: str
    records_fetched: int
    error_message: str | None
    date_from: date | None
    date_to: date | None

    class Config:
        from_attributes = True


class HistoricalSyncRequest(BaseModel):
    date_from: date
    date_to: date


class CalendarDayData(BaseModel):
    date: date
    has_data: bool
    is_forecast: bool
    # Occupancy
    total_rooms: int | None = None
    occupied_rooms: int | None = None
    occupancy_percentage: Decimal | None = None
    total_guests: int | None = None
    # Meal allocations
    breakfast_allocation_qty: int | None = None
    breakfast_allocation_netvalue: Decimal | None = None
    dinner_allocation_qty: int | None = None
    dinner_allocation_netvalue: Decimal | None = None
    # Revenue
    total_revenue: Decimal | None = None
    revenue_by_account: list[dict] | None = None  # [{gl_name, amount}]


class CalendarDataResponse(BaseModel):
    year: int
    month: int
    days: list[CalendarDayData]


# ============ Settings Endpoints ============

@router.get("/settings", response_model=NewbookSettingsResponse)
async def get_newbook_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get Newbook API settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    return NewbookSettingsResponse(
        newbook_api_username=settings.newbook_api_username,
        newbook_api_password_set=bool(settings.newbook_api_password),
        newbook_api_key_set=bool(settings.newbook_api_key),
        newbook_api_region=settings.newbook_api_region,
        newbook_instance_id=settings.newbook_instance_id,
        newbook_last_sync=settings.newbook_last_sync,
        newbook_auto_sync_enabled=settings.newbook_auto_sync_enabled,
        newbook_breakfast_gl_codes=settings.newbook_breakfast_gl_codes,
        newbook_dinner_gl_codes=settings.newbook_dinner_gl_codes,
        newbook_breakfast_vat_rate=settings.newbook_breakfast_vat_rate,
        newbook_dinner_vat_rate=settings.newbook_dinner_vat_rate
    )


@router.patch("/settings", response_model=NewbookSettingsResponse)
async def update_newbook_settings(
    update: NewbookSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update Newbook API settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Validate region if provided
    if update.newbook_api_region and update.newbook_api_region not in ["au", "ap", "eu", "us"]:
        raise HTTPException(status_code=400, detail="Invalid region. Must be: au, ap, eu, us")

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return NewbookSettingsResponse(
        newbook_api_username=settings.newbook_api_username,
        newbook_api_password_set=bool(settings.newbook_api_password),
        newbook_api_key_set=bool(settings.newbook_api_key),
        newbook_api_region=settings.newbook_api_region,
        newbook_instance_id=settings.newbook_instance_id,
        newbook_last_sync=settings.newbook_last_sync,
        newbook_auto_sync_enabled=settings.newbook_auto_sync_enabled,
        newbook_breakfast_gl_codes=settings.newbook_breakfast_gl_codes,
        newbook_dinner_gl_codes=settings.newbook_dinner_gl_codes,
        newbook_breakfast_vat_rate=settings.newbook_breakfast_vat_rate,
        newbook_dinner_vat_rate=settings.newbook_dinner_vat_rate
    )


@router.post("/test-connection")
async def test_newbook_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test Newbook API connection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not all([
        settings.newbook_api_username,
        settings.newbook_api_password,
        settings.newbook_api_key,
        settings.newbook_api_region
    ]):
        raise HTTPException(status_code=400, detail="Newbook credentials not fully configured")

    try:
        async with NewbookAPIClient(
            username=settings.newbook_api_username,
            password=settings.newbook_api_password,
            api_key=settings.newbook_api_key,
            region=settings.newbook_api_region,
            instance_id=settings.newbook_instance_id
        ) as client:
            success = await client.test_connection()

            if success:
                return {"status": "success", "message": "Newbook connection successful"}
            else:
                raise HTTPException(status_code=400, detail="Connection test failed")

    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")


# ============ GL Account Endpoints ============

@router.get("/gl-accounts", response_model=list[GLAccountResponse])
async def list_gl_accounts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all GL accounts for this kitchen, sorted by group then name"""
    result = await db.execute(
        select(NewbookGLAccount)
        .where(NewbookGLAccount.kitchen_id == current_user.kitchen_id)
        .order_by(NewbookGLAccount.gl_group_name, NewbookGLAccount.display_order, NewbookGLAccount.gl_name)
    )
    return list(result.scalars().all())


@router.post("/gl-accounts/fetch")
async def fetch_gl_accounts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch/refresh GL accounts from Newbook API"""
    try:
        sync_service = NewbookSyncService(db, current_user.kitchen_id)
        accounts = await sync_service.sync_gl_accounts()

        return {
            "status": "success",
            "message": f"Fetched {len(accounts)} GL accounts",
            "count": len(accounts)
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")


@router.patch("/gl-accounts/bulk-update")
async def bulk_update_gl_accounts(
    request: GLAccountBulkUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Bulk update GL account selections"""
    updated = 0
    for upd in request.updates:
        result = await db.execute(
            select(NewbookGLAccount).where(
                NewbookGLAccount.id == upd.id,
                NewbookGLAccount.kitchen_id == current_user.kitchen_id
            )
        )
        account = result.scalar_one_or_none()
        if account:
            account.is_tracked = upd.is_tracked
            if upd.display_order is not None:
                account.display_order = upd.display_order
            updated += 1

    await db.commit()
    return {"status": "success", "updated": updated}


@router.patch("/gl-accounts/{account_id}", response_model=GLAccountResponse)
async def update_gl_account(
    account_id: int,
    update: GLAccountUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update GL account tracking settings"""
    result = await db.execute(
        select(NewbookGLAccount).where(
            NewbookGLAccount.id == account_id,
            NewbookGLAccount.kitchen_id == current_user.kitchen_id
        )
    )
    account = result.scalar_one_or_none()

    if not account:
        raise HTTPException(status_code=404, detail="GL account not found")

    account.is_tracked = update.is_tracked
    if update.display_order is not None:
        account.display_order = update.display_order

    await db.commit()
    await db.refresh(account)
    return account


# ============ Room Category Endpoints ============

@router.get("/room-categories", response_model=list[RoomCategoryResponse])
async def get_room_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get all room categories for the kitchen"""
    result = await db.execute(
        select(NewbookRoomCategory)
        .where(NewbookRoomCategory.kitchen_id == current_user.kitchen_id)
        .order_by(NewbookRoomCategory.display_order, NewbookRoomCategory.site_name)
    )
    return list(result.scalars().all())


@router.post("/room-categories/fetch")
async def fetch_room_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch room categories from Newbook API and store in database"""
    # Get settings
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.newbook_api_username:
        raise HTTPException(status_code=400, detail="Newbook credentials not configured")

    try:
        async with NewbookAPIClient(
            username=settings.newbook_api_username,
            password=settings.newbook_api_password,
            api_key=settings.newbook_api_key,
            region=settings.newbook_api_region or "au",
            instance_id=settings.newbook_instance_id
        ) as client:
            categories = await client.get_site_list()

        # Delete all existing room categories for this kitchen (fresh replace)
        await db.execute(
            delete(NewbookRoomCategory).where(
                NewbookRoomCategory.kitchen_id == current_user.kitchen_id
            )
        )

        # Insert fresh aggregated room types
        for cat in categories:
            new_cat = NewbookRoomCategory(
                kitchen_id=current_user.kitchen_id,
                site_id=cat["id"],
                site_name=cat["name"],
                site_type=cat.get("type"),
                room_count=cat.get("count", 0),
                is_included=True,  # Default to included
            )
            db.add(new_cat)

        await db.commit()

        return {
            "status": "success",
            "count": len(categories)
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")


@router.patch("/room-categories/bulk-update")
async def bulk_update_room_categories(
    request: RoomCategoryBulkUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Bulk update room category selections"""
    updated = 0
    for upd in request.updates:
        result = await db.execute(
            select(NewbookRoomCategory).where(
                NewbookRoomCategory.id == upd.id,
                NewbookRoomCategory.kitchen_id == current_user.kitchen_id
            )
        )
        category = result.scalar_one_or_none()
        if category:
            category.is_included = upd.is_included
            if upd.display_order is not None:
                category.display_order = upd.display_order
            updated += 1

    await db.commit()
    return {"status": "success", "updated": updated}


@router.patch("/room-categories/{category_id}", response_model=RoomCategoryResponse)
async def update_room_category(
    category_id: int,
    update: RoomCategoryUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update room category settings"""
    result = await db.execute(
        select(NewbookRoomCategory).where(
            NewbookRoomCategory.id == category_id,
            NewbookRoomCategory.kitchen_id == current_user.kitchen_id
        )
    )
    category = result.scalar_one_or_none()

    if not category:
        raise HTTPException(status_code=404, detail="Room category not found")

    category.is_included = update.is_included
    if update.display_order is not None:
        category.display_order = update.display_order

    await db.commit()
    await db.refresh(category)
    return category


# ============ Revenue Endpoints ============

@router.get("/revenue", response_model=list[DailyRevenueResponse])
async def get_revenue(
    start_date: date,
    end_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get daily revenue data for a date range"""
    result = await db.execute(
        select(NewbookDailyRevenue, NewbookGLAccount.gl_name)
        .join(NewbookGLAccount)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= start_date,
            NewbookDailyRevenue.date <= end_date,
            NewbookGLAccount.is_tracked == True
        )
        .order_by(NewbookDailyRevenue.date, NewbookGLAccount.display_order)
    )

    revenue_data = []
    for rev, gl_name in result.all():
        revenue_data.append(DailyRevenueResponse(
            date=rev.date,
            gl_account_id=rev.gl_account_id,
            gl_account_name=gl_name,
            amount_net=rev.amount_net
        ))

    return revenue_data


@router.get("/revenue/summary", response_model=RevenueSummaryResponse)
async def get_revenue_summary(
    start_date: date,
    end_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get aggregated revenue summary for a date range"""
    # Total revenue
    total_result = await db.execute(
        select(func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= start_date,
            NewbookDailyRevenue.date <= end_date,
            NewbookGLAccount.is_tracked == True
        )
    )
    total_revenue = total_result.scalar() or Decimal("0.00")

    # By account
    by_account_result = await db.execute(
        select(NewbookGLAccount.gl_name, func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= start_date,
            NewbookDailyRevenue.date <= end_date,
            NewbookGLAccount.is_tracked == True
        )
        .group_by(NewbookGLAccount.gl_name)
        .order_by(func.sum(NewbookDailyRevenue.amount_net).desc())
    )
    by_account = [{"gl_account_name": name, "total": float(total)} for name, total in by_account_result.all()]

    # By date
    by_date_result = await db.execute(
        select(NewbookDailyRevenue.date, func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= start_date,
            NewbookDailyRevenue.date <= end_date,
            NewbookGLAccount.is_tracked == True
        )
        .group_by(NewbookDailyRevenue.date)
        .order_by(NewbookDailyRevenue.date)
    )
    by_date = [{"date": d.isoformat(), "total": float(total)} for d, total in by_date_result.all()]

    return RevenueSummaryResponse(
        start_date=start_date,
        end_date=end_date,
        total_revenue=total_revenue,
        by_account=by_account,
        by_date=by_date
    )


# ============ Occupancy Endpoints ============

@router.get("/occupancy", response_model=list[OccupancyResponse])
async def get_occupancy(
    start_date: date,
    end_date: date,
    include_forecast: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get occupancy data for a date range"""
    query = select(NewbookDailyOccupancy).where(
        NewbookDailyOccupancy.kitchen_id == current_user.kitchen_id,
        NewbookDailyOccupancy.date >= start_date,
        NewbookDailyOccupancy.date <= end_date
    )

    if not include_forecast:
        query = query.where(NewbookDailyOccupancy.is_forecast == False)

    query = query.order_by(NewbookDailyOccupancy.date)
    result = await db.execute(query)

    return list(result.scalars().all())


# ============ Calendar Data Endpoint ============

@router.get("/calendar/{year}/{month}", response_model=CalendarDataResponse)
async def get_calendar_data(
    year: int,
    month: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get calendar view data for a specific month"""
    import calendar
    from datetime import date as date_type
    from collections import defaultdict

    # Calculate month date range
    _, last_day = calendar.monthrange(year, month)
    month_start = date_type(year, month, 1)
    month_end = date_type(year, month, last_day)
    today = date_type.today()

    # Fetch occupancy data for the month
    occupancy_result = await db.execute(
        select(NewbookDailyOccupancy)
        .where(
            NewbookDailyOccupancy.kitchen_id == current_user.kitchen_id,
            NewbookDailyOccupancy.date >= month_start,
            NewbookDailyOccupancy.date <= month_end
        )
    )
    occupancy_by_date = {occ.date: occ for occ in occupancy_result.scalars().all()}

    # Fetch revenue data for the month (grouped by date and GL account)
    revenue_result = await db.execute(
        select(
            NewbookDailyRevenue.date,
            NewbookGLAccount.gl_name,
            NewbookDailyRevenue.amount_net
        )
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= month_start,
            NewbookDailyRevenue.date <= month_end,
            NewbookGLAccount.is_tracked == True
        )
        .order_by(NewbookDailyRevenue.date, NewbookGLAccount.gl_name)
    )

    # Group revenue by date
    revenue_by_date = defaultdict(list)
    for row_date, gl_name, amount in revenue_result.all():
        revenue_by_date[row_date].append({
            "gl_name": gl_name,
            "amount": float(amount)
        })

    # Build calendar days
    days = []
    for day in range(1, last_day + 1):
        current_date = date_type(year, month, day)
        occupancy = occupancy_by_date.get(current_date)
        revenue_entries = revenue_by_date.get(current_date, [])

        has_data = occupancy is not None or len(revenue_entries) > 0

        # Determine if forecast: today or future date, or marked as forecast in occupancy
        # Today is considered "current" (updatable), not historical (locked)
        is_forecast = current_date >= today
        if occupancy and occupancy.is_forecast:
            is_forecast = True

        # Calculate total revenue for the day
        total_revenue = sum(entry["amount"] for entry in revenue_entries) if revenue_entries else None

        day_data = CalendarDayData(
            date=current_date,
            has_data=has_data,
            is_forecast=is_forecast,
            total_rooms=occupancy.total_rooms if occupancy else None,
            occupied_rooms=occupancy.occupied_rooms if occupancy else None,
            occupancy_percentage=occupancy.occupancy_percentage if occupancy else None,
            total_guests=occupancy.total_guests if occupancy else None,
            breakfast_allocation_qty=occupancy.breakfast_allocation_qty if occupancy else None,
            breakfast_allocation_netvalue=occupancy.breakfast_allocation_netvalue if occupancy else None,
            dinner_allocation_qty=occupancy.dinner_allocation_qty if occupancy else None,
            dinner_allocation_netvalue=occupancy.dinner_allocation_netvalue if occupancy else None,
            total_revenue=Decimal(str(total_revenue)) if total_revenue else None,
            revenue_by_account=revenue_entries if revenue_entries else None
        )
        days.append(day_data)

    return CalendarDataResponse(
        year=year,
        month=month,
        days=days
    )


# ============ Sync Endpoints ============

@router.post("/sync/forecast")
async def sync_forecast_data(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Sync forecast period data (next ~2 months)"""
    try:
        sync_service = NewbookSyncService(db, current_user.kitchen_id)
        results = await sync_service.sync_forecast_period()

        return {
            "status": "success",
            "message": "Forecast data synced",
            "results": results
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")


@router.post("/sync/historical")
async def sync_historical_data(
    request: HistoricalSyncRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Sync historical data for specific date range"""
    if request.date_from > request.date_to:
        raise HTTPException(status_code=400, detail="date_from must be before date_to")

    if (request.date_to - request.date_from).days > 365:
        raise HTTPException(status_code=400, detail="Date range cannot exceed 1 year")

    try:
        sync_service = NewbookSyncService(db, current_user.kitchen_id)
        results = await sync_service.sync_historical_range(request.date_from, request.date_to)

        return {
            "status": "success",
            "message": f"Historical data synced for {request.date_from} to {request.date_to}",
            "results": results
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")


@router.get("/sync/logs", response_model=list[SyncLogResponse])
async def get_sync_logs(
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get recent sync logs"""
    result = await db.execute(
        select(NewbookSyncLog)
        .where(NewbookSyncLog.kitchen_id == current_user.kitchen_id)
        .order_by(NewbookSyncLog.started_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


# ============ Dashboard Endpoints ============

class ArrivalDayStats(BaseModel):
    date: date
    day_name: str  # "Today", "Tomorrow", day of week
    arrival_count: int
    arrival_guests: int
    table_bookings: int
    table_covers: int
    matched_arrivals: int  # Arrivals with table bookings
    unmatched_arrivals: int  # Arrivals without table bookings
    opportunity_guests: int  # Guests from unmatched arrivals


class ArrivalDashboardResponse(BaseModel):
    days: list[ArrivalDayStats]
    service_filter_name: str | None = None  # Name of service type being filtered (e.g., "Dinner")


@router.get("/dashboard/arrivals", response_model=ArrivalDashboardResponse)
async def get_arrival_dashboard(
    days: int = 3,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get arrival statistics for dashboard widget (next N days)"""
    today = date.today()
    end_date = today + timedelta(days=days - 1)

    # Fetch kitchen settings to get service filter
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()
    service_filter_type = settings.resos_arrival_widget_service_filter if settings else None

    # Get opening hour IDs that match the service type filter
    service_filter_name = None
    opening_hour_ids = []

    if service_filter_type and settings and settings.resos_opening_hours_mapping:
        # Find all opening hours mapped to this service type
        for mapping in settings.resos_opening_hours_mapping:
            if isinstance(mapping, dict) and mapping.get("service_type") == service_filter_type:
                opening_hour_ids.append(mapping.get("resos_id"))

        # Set display name to capitalized service type
        if opening_hour_ids:
            service_filter_name = service_filter_type.capitalize()

    # Fetch occupancy data with arrival info
    occupancy_result = await db.execute(
        select(NewbookDailyOccupancy)
        .where(
            NewbookDailyOccupancy.kitchen_id == current_user.kitchen_id,
            NewbookDailyOccupancy.date >= today,
            NewbookDailyOccupancy.date <= end_date
        )
        .order_by(NewbookDailyOccupancy.date)
    )
    occupancy_by_date = {occ.date: occ for occ in occupancy_result.scalars().all()}

    # Fetch restaurant bookings for the same period (with optional service filter)
    # Note: We fetch ALL bookings (not just guest-linked ones) to show total booking count
    bookings_query = select(ResosBooking).where(
        ResosBooking.kitchen_id == current_user.kitchen_id,
        ResosBooking.booking_date >= today,
        ResosBooking.booking_date <= end_date
    )

    # Apply service filter if set - filter by ANY opening hour that matches the service type
    if opening_hour_ids:
        bookings_query = bookings_query.where(ResosBooking.opening_hour_id.in_(opening_hour_ids))

    bookings_result = await db.execute(bookings_query)
    bookings = list(bookings_result.scalars().all())

    # Group bookings by date
    bookings_by_date = {}
    for booking in bookings:
        if booking.booking_date not in bookings_by_date:
            bookings_by_date[booking.booking_date] = []
        bookings_by_date[booking.booking_date].append(booking)

    # Build stats for each day
    days_stats = []
    day_names = ["Today", "Tomorrow"]

    for i in range(days):
        current_date = today + timedelta(days=i)
        occupancy = occupancy_by_date.get(current_date)
        day_bookings = bookings_by_date.get(current_date, [])

        # Day name
        if i < len(day_names):
            day_name = day_names[i]
        else:
            day_name = current_date.strftime("%A")  # Day of week

        # Default values
        arrival_count = 0
        arrival_guests = 0
        matched_arrivals = 0
        unmatched_arrivals = 0
        opportunity_guests = 0

        if occupancy and occupancy.arrival_count:
            arrival_count = occupancy.arrival_count or 0
            arrival_details = occupancy.arrival_booking_details or []

            # Calculate total guests from arrivals
            arrival_guests = sum(detail.get("num_guests", 0) for detail in arrival_details)

            # Get hotel booking numbers from Resos
            hotel_refs = {b.hotel_booking_number for b in day_bookings if b.hotel_booking_number}

            # Match arrivals with table bookings
            matched = []
            unmatched = []

            for detail in arrival_details:
                booking_ref = detail.get("booking_reference", "")
                booking_id = detail.get("booking_id", "")

                # Check if this arrival has a matching table booking
                if booking_ref in hotel_refs or booking_id in hotel_refs:
                    matched.append(detail)
                else:
                    unmatched.append(detail)

            matched_arrivals = len(matched)
            unmatched_arrivals = len(unmatched)
            opportunity_guests = sum(detail.get("num_guests", 0) for detail in unmatched)

        # Table booking stats
        table_bookings = len(day_bookings)
        table_covers = sum(b.people for b in day_bookings)

        days_stats.append(ArrivalDayStats(
            date=current_date,
            day_name=day_name,
            arrival_count=arrival_count,
            arrival_guests=arrival_guests,
            table_bookings=table_bookings,
            table_covers=table_covers,
            matched_arrivals=matched_arrivals,
            unmatched_arrivals=unmatched_arrivals,
            opportunity_guests=opportunity_guests
        ))

    return ArrivalDashboardResponse(days=days_stats, service_filter_name=service_filter_name)
