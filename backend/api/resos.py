"""
Resos API Endpoints

Handles Resos configuration, sync operations, and booking data retrieval.
"""
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from models.resos import ResosBooking, ResosDailyStats, ResosOpeningHour, ResosSyncLog
from auth.jwt import get_current_user
from services.resos_sync import ResosSyncService
from services.resos_api import ResosAPIClient, ResosAPIError

router = APIRouter()


# ============ Pydantic Schemas ============

class ResosSettingsResponse(BaseModel):
    resos_api_key_set: bool  # Masked
    resos_last_sync: datetime | None
    resos_auto_sync_enabled: bool
    resos_large_group_threshold: int
    resos_note_keywords: str | None
    resos_allergy_keywords: str | None
    resos_custom_field_mapping: dict | None
    resos_opening_hours_mapping: list | None
    resos_restaurant_table_entities: str | None

    class Config:
        from_attributes = True


class ResosSettingsUpdate(BaseModel):
    resos_api_key: str | None = None
    resos_auto_sync_enabled: bool | None = None
    resos_large_group_threshold: int | None = None
    resos_note_keywords: str | None = None
    resos_allergy_keywords: str | None = None
    resos_custom_field_mapping: dict | None = None
    resos_opening_hours_mapping: list | None = None
    resos_restaurant_table_entities: str | None = None


class DailyStatsResponse(BaseModel):
    date: str
    total_bookings: int
    total_covers: int
    service_breakdown: list[dict]
    flagged_booking_count: int
    is_forecast: bool

    class Config:
        from_attributes = True


class BookingResponse(BaseModel):
    id: int
    resos_booking_id: str
    booking_date: str
    booking_time: str
    people: int
    status: str
    seating_area: str | None
    hotel_booking_number: str | None
    is_hotel_guest: bool | None
    is_dbb: bool | None
    is_package: bool | None
    allergies: str | None
    notes: str | None
    opening_hour_name: str | None
    is_flagged: bool
    flag_reasons: str | None

    class Config:
        from_attributes = True


class DashboardCoversResponse(BaseModel):
    date: str
    total_bookings: int
    total_covers: int
    service_breakdown: list[dict]
    has_flagged_bookings: bool


# ============ Settings Endpoints ============

@router.get("/settings")
async def get_resos_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> ResosSettingsResponse:
    """Get Resos settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one()

    return ResosSettingsResponse(
        resos_api_key_set=bool(settings.resos_api_key),
        resos_last_sync=settings.resos_last_sync,
        resos_auto_sync_enabled=settings.resos_auto_sync_enabled or False,
        resos_large_group_threshold=settings.resos_large_group_threshold or 8,
        resos_note_keywords=settings.resos_note_keywords,
        resos_allergy_keywords=settings.resos_allergy_keywords,
        resos_custom_field_mapping=settings.resos_custom_field_mapping,
        resos_opening_hours_mapping=settings.resos_opening_hours_mapping,
        resos_restaurant_table_entities=settings.resos_restaurant_table_entities
    )


@router.patch("/settings")
async def update_resos_settings(
    update: ResosSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update Resos settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one()

    if update.resos_api_key is not None:
        settings.resos_api_key = update.resos_api_key
    if update.resos_auto_sync_enabled is not None:
        settings.resos_auto_sync_enabled = update.resos_auto_sync_enabled
    if update.resos_large_group_threshold is not None:
        settings.resos_large_group_threshold = update.resos_large_group_threshold
    if update.resos_note_keywords is not None:
        settings.resos_note_keywords = update.resos_note_keywords
    if update.resos_allergy_keywords is not None:
        settings.resos_allergy_keywords = update.resos_allergy_keywords
    if update.resos_custom_field_mapping is not None:
        settings.resos_custom_field_mapping = update.resos_custom_field_mapping
    if update.resos_opening_hours_mapping is not None:
        settings.resos_opening_hours_mapping = update.resos_opening_hours_mapping
    if update.resos_restaurant_table_entities is not None:
        settings.resos_restaurant_table_entities = update.resos_restaurant_table_entities

    await db.commit()
    return {"message": "Settings updated successfully"}


@router.post("/test-connection")
async def test_resos_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test Resos API connection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one()

    if not settings.resos_api_key:
        raise HTTPException(status_code=400, detail="Resos API key not configured")

    async with ResosAPIClient(settings.resos_api_key) as client:
        success = await client.test_connection()

    if not success:
        raise HTTPException(status_code=400, detail="Connection failed")

    return {"message": "Connection successful"}


@router.get("/custom-fields")
async def fetch_custom_fields(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch custom field definitions from Resos API (GET request only)"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one()

    if not settings.resos_api_key:
        raise HTTPException(status_code=400, detail="Resos API key not configured")

    async with ResosAPIClient(settings.resos_api_key) as client:
        fields = await client.get_custom_field_definitions()

    return {"custom_fields": fields}


@router.get("/opening-hours")
async def fetch_opening_hours(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Fetch opening hours/service periods from Resos API (GET request only)"""
    import logging
    logger = logging.getLogger(__name__)

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one()

    if not settings.resos_api_key:
        raise HTTPException(status_code=400, detail="Resos API key not configured")

    async with ResosAPIClient(settings.resos_api_key) as client:
        hours = await client.get_opening_hours()

    # Log the raw response to understand structure
    logger.info(f"Raw opening hours from Resos API: {len(hours)} periods")

    # Filter out special/one-off periods - only return regular service periods
    # Filter on 'special' field: True = one-off events, False = recurring service periods
    regular_hours = [h for h in hours if h.get('special') == False]

    # Day of week mapping (Resos uses 1=Monday, 7=Sunday)
    day_names = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    # Transform time format: Resos uses 'open' and 'close' as HHMM integers (e.g., 1200 = 12:00)
    # Convert to 'startTime' and 'endTime' in HH:MM format for frontend
    for hour in regular_hours:
        # Add day of week name
        day_num = hour.get('day', 0)
        if 1 <= day_num <= 7:
            hour['dayName'] = day_names[day_num]
        else:
            hour['dayName'] = 'Unknown'

        if 'open' in hour:
            open_val = hour['open']
            hours_part = open_val // 100
            mins_part = open_val % 100
            hour['startTime'] = f"{hours_part:02d}:{mins_part:02d}"

        if 'close' in hour:
            close_val = hour['close']
            hours_part = close_val // 100
            mins_part = close_val % 100
            hour['endTime'] = f"{hours_part:02d}:{mins_part:02d}"

            # Auto-calculate actual end time by subtracting booking duration
            # Resos extends close time to allow late bookings
            seating = hour.get('seating', {})
            duration = seating.get('duration', 0)  # Duration in minutes
            if duration > 0:
                # Convert close time to minutes
                close_minutes = hours_part * 60 + mins_part
                # Subtract booking duration
                actual_end_minutes = close_minutes - duration
                # Convert back to HH:MM
                actual_hours = actual_end_minutes // 60
                actual_mins = actual_end_minutes % 60
                hour['actualEnd'] = f"{actual_hours:02d}:{actual_mins:02d}"
                hour['bookingDuration'] = duration

    # Sort by day of week first, then by open time within each day
    regular_hours.sort(key=lambda h: (h.get('day', 0), h.get('open', 0)))

    logger.info(f"After filtering: {len(regular_hours)} regular periods (filtered out {len(hours) - len(regular_hours)} special periods)")

    return {"opening_hours": regular_hours}


# ============ Sync Endpoints ============

@router.post("/sync/forecast")
async def sync_forecast(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Manual forecast sync (next 60 days)"""
    sync_service = ResosSyncService(current_user.kitchen_id, db)

    today = date.today()
    to_date = today + timedelta(days=60)

    result = await sync_service.sync_bookings(today, to_date, is_forecast=True)
    return result


@router.post("/sync/historical")
async def sync_historical(
    from_date: date,
    to_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Manual historical sync"""
    sync_service = ResosSyncService(current_user.kitchen_id, db)
    result = await sync_service.sync_bookings(from_date, to_date, is_forecast=False)
    return result


# ============ Data Retrieval Endpoints ============

@router.get("/daily-stats")
async def get_daily_stats(
    from_date: date,
    to_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> list[DailyStatsResponse]:
    """Get daily stats for date range"""
    result = await db.execute(
        select(ResosDailyStats).where(
            and_(
                ResosDailyStats.kitchen_id == current_user.kitchen_id,
                ResosDailyStats.date >= from_date,
                ResosDailyStats.date <= to_date
            )
        ).order_by(ResosDailyStats.date)
    )

    stats = result.scalars().all()

    return [
        DailyStatsResponse(
            date=stat.date.isoformat(),
            total_bookings=stat.total_bookings,
            total_covers=stat.total_covers,
            service_breakdown=stat.service_breakdown or [],
            flagged_booking_count=stat.flagged_booking_count,
            is_forecast=stat.is_forecast
        )
        for stat in stats
    ]


@router.get("/bookings/{booking_date}")
async def get_bookings_for_date(
    booking_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> list[BookingResponse]:
    """Get all bookings for a specific date"""
    result = await db.execute(
        select(ResosBooking).where(
            and_(
                ResosBooking.kitchen_id == current_user.kitchen_id,
                ResosBooking.booking_date == booking_date
            )
        ).order_by(ResosBooking.booking_time)
    )

    bookings = result.scalars().all()

    return [
        BookingResponse(
            id=b.id,
            resos_booking_id=b.resos_booking_id,
            booking_date=b.booking_date.isoformat(),
            booking_time=b.booking_time.isoformat(),
            people=b.people,
            status=b.status,
            seating_area=b.seating_area,
            hotel_booking_number=b.hotel_booking_number,
            is_hotel_guest=b.is_hotel_guest,
            is_dbb=b.is_dbb,
            is_package=b.is_package,
            allergies=b.allergies,
            notes=b.notes,
            opening_hour_name=b.opening_hour_name,
            is_flagged=b.is_flagged,
            flag_reasons=b.flag_reasons
        )
        for b in bookings
    ]


# ============ Dashboard Endpoint ============

@router.get("/dashboard/today-tomorrow")
async def get_dashboard_covers(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> dict:
    """Get today and tomorrow covers for dashboard"""
    today = date.today()
    tomorrow = today + timedelta(days=1)

    result = await db.execute(
        select(ResosDailyStats).where(
            and_(
                ResosDailyStats.kitchen_id == current_user.kitchen_id,
                ResosDailyStats.date.in_([today, tomorrow])
            )
        )
    )

    stats = {stat.date: stat for stat in result.scalars().all()}

    def build_response(target_date: date) -> Optional[DashboardCoversResponse]:
        if target_date not in stats:
            return None
        stat = stats[target_date]
        return DashboardCoversResponse(
            date=stat.date.isoformat(),
            total_bookings=stat.total_bookings,
            total_covers=stat.total_covers,
            service_breakdown=stat.service_breakdown or [],
            has_flagged_bookings=stat.flagged_booking_count > 0
        )

    return {
        'today': build_response(today),
        'tomorrow': build_response(tomorrow)
    }
