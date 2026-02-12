"""
Cover Override API endpoints.

Handles forecast snapshots, cover overrides, and spend rate overrides
for the Spend Budget feature.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, select, delete
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from auth.jwt import get_current_user
from services.forecast_api import ForecastAPIClient, ForecastAPIError

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Request/Response Models ---

class SnapshotRequest(BaseModel):
    week_offset: int = 0


class CoverOverrideRequest(BaseModel):
    override_date: str  # YYYY-MM-DD
    period: str  # 'lunch' or 'dinner'
    override_covers: int  # target total covers


class SpendRateOverrideRequest(BaseModel):
    week_offset: int = 0
    period: str  # 'breakfast', 'lunch', or 'dinner'
    food_spend: Optional[float] = None
    drinks_spend: Optional[float] = None


class SnapshotData(BaseModel):
    date: str
    period: str
    forecast_covers: int
    otb_covers: int
    food_spend: Optional[float]
    drinks_spend: Optional[float]
    forecast_dry_revenue: Optional[float]


class OverrideData(BaseModel):
    id: int
    override_date: str
    period: str
    override_covers: int
    original_forecast: Optional[int]
    original_otb: Optional[int]


class SpendRateData(BaseModel):
    period: str
    food_spend_api: Optional[float]
    drinks_spend_api: Optional[float]
    food_spend_snapshot: Optional[float]
    drinks_spend_snapshot: Optional[float]
    food_spend_override: Optional[float]
    drinks_spend_override: Optional[float]
    food_spend_effective: float
    drinks_spend_effective: float


class RecalcDay(BaseModel):
    date: str
    day_name: str
    is_past: bool
    periods: dict  # period -> {actual, otb, pickup, effective, override, snapshot, variance}
    day_revenue: float


class WeeklyOverrideResponse(BaseModel):
    week_start: str
    week_end: str
    has_snapshot: bool
    vat_rate: float = 1.20
    snapshot_revenue: Optional[float] = None
    adjusted_revenue: Optional[float] = None
    snapshots: list[SnapshotData] = []
    overrides: list[OverrideData] = []
    spend_rates: list[SpendRateData] = []
    recalc_days: list[RecalcDay] = []


# --- Helpers ---

def get_week_dates(week_offset: int = 0) -> tuple[date, date, list[date]]:
    today = date.today()
    current_monday = today - timedelta(days=today.weekday())
    week_start = current_monday + timedelta(weeks=week_offset)
    week_end = week_start + timedelta(days=6)
    week_dates = [week_start + timedelta(days=i) for i in range(7)]
    return week_start, week_end, week_dates


async def get_settings(db: AsyncSession, kitchen_id: int) -> KitchenSettings:
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    settings = result.scalar_one_or_none()
    if not settings:
        raise HTTPException(status_code=404, detail="Kitchen settings not found")
    return settings


# --- Endpoints ---

@router.get("/weekly", response_model=WeeklyOverrideResponse)
async def get_weekly_overrides(
    week_offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get snapshot, overrides, spend rates, and recalculated breakdown for a week."""
    week_start, week_end, week_dates = get_week_dates(week_offset)
    kitchen_id = current_user.kitchen_id
    today = date.today()

    # Check if snapshot exists
    snap_result = await db.execute(text("""
        SELECT snapshot_date, period, forecast_covers, otb_covers,
               food_spend, drinks_spend, forecast_dry_revenue
        FROM forecast_snapshots
        WHERE kitchen_id = :kid AND week_start = :ws
        ORDER BY snapshot_date, period
    """), {"kid": kitchen_id, "ws": week_start})
    snap_rows = snap_result.fetchall()

    has_snapshot = len(snap_rows) > 0
    snapshots = []
    snap_lookup = {}  # (date_str, period) -> row

    for row in snap_rows:
        date_str = row.snapshot_date.isoformat() if hasattr(row.snapshot_date, 'isoformat') else str(row.snapshot_date)
        snapshots.append(SnapshotData(
            date=date_str,
            period=row.period,
            forecast_covers=row.forecast_covers,
            otb_covers=row.otb_covers,
            food_spend=float(row.food_spend) if row.food_spend else None,
            drinks_spend=float(row.drinks_spend) if row.drinks_spend else None,
            forecast_dry_revenue=float(row.forecast_dry_revenue) if row.forecast_dry_revenue else None,
        ))
        snap_lookup[(date_str, row.period)] = row

    # Get week snapshot for revenue totals
    week_snap_result = await db.execute(text("""
        SELECT total_forecast_revenue, total_otb_revenue, gp_target
        FROM forecast_week_snapshots
        WHERE kitchen_id = :kid AND week_start = :ws
    """), {"kid": kitchen_id, "ws": week_start})
    week_snap = week_snap_result.fetchone()
    snapshot_revenue = float(week_snap.total_forecast_revenue) if week_snap and week_snap.total_forecast_revenue else None

    # Get overrides
    override_result = await db.execute(text("""
        SELECT id, override_date, period, override_covers, original_forecast, original_otb
        FROM cover_overrides
        WHERE kitchen_id = :kid
          AND override_date >= :ws AND override_date <= :we
        ORDER BY override_date, period
    """), {"kid": kitchen_id, "ws": week_start, "we": week_end})
    override_rows = override_result.fetchall()

    overrides = []
    override_lookup = {}  # (date_str, period) -> row
    for row in override_rows:
        date_str = row.override_date.isoformat() if hasattr(row.override_date, 'isoformat') else str(row.override_date)
        overrides.append(OverrideData(
            id=row.id,
            override_date=date_str,
            period=row.period,
            override_covers=row.override_covers,
            original_forecast=row.original_forecast,
            original_otb=row.original_otb,
        ))
        override_lookup[(date_str, row.period)] = row

    # Get spend rate overrides
    spend_override_result = await db.execute(text("""
        SELECT id, period, food_spend, drinks_spend
        FROM spend_rate_overrides
        WHERE kitchen_id = :kid AND week_start = :ws
    """), {"kid": kitchen_id, "ws": week_start})
    spend_override_rows = spend_override_result.fetchall()
    spend_override_lookup = {row.period: row for row in spend_override_rows}

    # Fetch live forecast data + spend rates from API
    settings = await get_settings(db, kitchen_id)
    api_spend_rates = {}
    api_vat_rate = 1.20
    covers_data = []
    revenue_data = []

    if settings.forecast_api_url and settings.forecast_api_key:
        try:
            async with ForecastAPIClient(settings.forecast_api_url, settings.forecast_api_key) as client:
                try:
                    sr = await client.get_spend_rates()
                    api_spend_rates = sr.get("periods", {})
                    api_vat_rate = sr.get("vat_rate", 1.20)
                except Exception as e:
                    logger.warning(f"Failed to fetch spend rates: {e}")

                try:
                    covers_data = await client.get_covers_forecast(week_start, days=7)
                except Exception as e:
                    logger.warning(f"Failed to fetch covers: {e}")

                try:
                    revenue_data = await client.get_revenue_forecast(week_start, days=7)
                except Exception as e:
                    logger.warning(f"Failed to fetch revenue: {e}")
        except Exception as e:
            logger.warning(f"Failed to connect to forecast API: {e}")

    # Build spend rates response (per period)
    spend_rates = []
    spend_effective = {}  # period -> {food, drinks}
    for period in ("breakfast", "lunch", "dinner"):
        api_food = api_spend_rates.get(period, {}).get("food_spend_net", 0)
        api_drinks = api_spend_rates.get(period, {}).get("drinks_spend_net", 0)

        # Get snapshot values (from first day of snapshot, same for all days in a period)
        snap_food = None
        snap_drinks = None
        for d in week_dates:
            key = (d.isoformat(), period)
            if key in snap_lookup:
                snap_food = float(snap_lookup[key].food_spend) if snap_lookup[key].food_spend else None
                snap_drinks = float(snap_lookup[key].drinks_spend) if snap_lookup[key].drinks_spend else None
                break

        # Get override values
        ovr = spend_override_lookup.get(period)
        ovr_food = float(ovr.food_spend) if ovr and ovr.food_spend else None
        ovr_drinks = float(ovr.drinks_spend) if ovr and ovr.drinks_spend else None

        # Resolve effective: override > snapshot > API
        eff_food = ovr_food if ovr_food is not None else (snap_food if snap_food is not None else api_food)
        eff_drinks = ovr_drinks if ovr_drinks is not None else (snap_drinks if snap_drinks is not None else api_drinks)

        spend_effective[period] = {"food": eff_food, "drinks": eff_drinks}
        spend_rates.append(SpendRateData(
            period=period,
            food_spend_api=api_food,
            drinks_spend_api=api_drinks,
            food_spend_snapshot=snap_food,
            drinks_spend_snapshot=snap_drinks,
            food_spend_override=ovr_food,
            drinks_spend_override=ovr_drinks,
            food_spend_effective=eff_food,
            drinks_spend_effective=eff_drinks,
        ))

    # Build recalculated days
    covers_by_date = {d.get("date", ""): d for d in covers_data}
    revenue_by_date = {d.get("date", ""): d for d in revenue_data}
    recalc_days = []
    total_adjusted_revenue = Decimal("0")

    for d in week_dates:
        date_str = d.isoformat()
        is_past = d < today
        day_covers = covers_by_date.get(date_str, {})
        day_revenue = revenue_by_date.get(date_str, {})
        day_name = day_covers.get("day", d.strftime("%a"))

        periods_data = {}
        day_rev = Decimal("0")

        for period in ("breakfast", "lunch", "dinner"):
            p_covers = day_covers.get(period, {})
            otb = p_covers.get("otb", 0) or 0
            forecast = p_covers.get("forecast", 0) or 0
            pickup = forecast - otb

            # Get snapshot and override for this day/period
            snap = snap_lookup.get((date_str, period))
            ovr = override_lookup.get((date_str, period))

            snap_forecast = snap.forecast_covers if snap else None
            override_val = ovr.override_covers if ovr else None

            if is_past:
                # Past day: use actual (forecast value from API is actual for past dates)
                effective = forecast
                actual = forecast
                # Calculate variance vs override or snapshot
                variance = None
                if override_val is not None:
                    diff = actual - override_val
                    if diff != 0:
                        variance = diff
                elif snap_forecast is not None:
                    diff = actual - snap_forecast
                    if diff != 0:
                        variance = diff

                # Past revenue from API (dry revenue)
                dry = day_revenue.get("dry", {})
                period_rev = Decimal(str(dry.get("forecast", 0) or 0)) if period == "breakfast" else Decimal("0")
                # For past days, use actual total revenue from the API (proportioned by period isn't available,
                # so we'll use effective_covers * spend_rates as approximation, but actual total from revenue API)
                eff_food = Decimal(str(spend_effective.get(period, {}).get("food", 0)))
                period_rev = Decimal(str(effective)) * eff_food

                periods_data[period] = {
                    "actual": actual,
                    "otb": otb,
                    "pickup": 0,
                    "effective": effective,
                    "override": override_val,
                    "snapshot": snap_forecast,
                    "variance": variance,
                    "is_overridden": False,
                }
            else:
                # Today/future: apply override logic
                if override_val is not None:
                    if otb >= override_val:
                        effective = otb  # OTB supersedes upward
                        adj_pickup = 0
                    else:
                        effective = override_val
                        adj_pickup = override_val - otb
                    is_overridden = True
                else:
                    effective = forecast
                    adj_pickup = pickup
                    is_overridden = False

                # Calculate revenue for this period (dry/food only - budget tracks food revenue)
                eff_food = Decimal(str(spend_effective.get(period, {}).get("food", 0)))
                period_rev = Decimal(str(effective)) * eff_food

                periods_data[period] = {
                    "actual": None,
                    "otb": otb,
                    "pickup": adj_pickup,
                    "effective": effective,
                    "override": override_val,
                    "snapshot": snap_forecast,
                    "variance": None,
                    "is_overridden": is_overridden,
                }

            day_rev += period_rev

        # For past days, use actual revenue from API if available
        if is_past and day_revenue:
            dry = day_revenue.get("dry", {})
            actual_dry_rev = Decimal(str(dry.get("forecast", 0) or 0))
            if actual_dry_rev > 0:
                day_rev = actual_dry_rev

        total_adjusted_revenue += day_rev

        recalc_days.append(RecalcDay(
            date=date_str,
            day_name=day_name,
            is_past=is_past,
            periods=periods_data,
            day_revenue=float(round(day_rev, 2)),
        ))

    return WeeklyOverrideResponse(
        week_start=week_start.isoformat(),
        week_end=week_end.isoformat(),
        has_snapshot=has_snapshot,
        vat_rate=api_vat_rate,
        snapshot_revenue=snapshot_revenue,
        adjusted_revenue=float(round(total_adjusted_revenue, 2)),
        snapshots=snapshots,
        overrides=overrides,
        spend_rates=spend_rates,
        recalc_days=recalc_days,
    )


@router.post("/snapshot")
async def create_snapshot(
    req: SnapshotRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Take a snapshot of the current forecast for a week (all periods, all days)."""
    week_start, week_end, week_dates = get_week_dates(req.week_offset)
    kitchen_id = current_user.kitchen_id
    settings = await get_settings(db, kitchen_id)

    if not settings.forecast_api_url or not settings.forecast_api_key:
        raise HTTPException(status_code=400, detail="Forecast API not configured")

    async with ForecastAPIClient(settings.forecast_api_url, settings.forecast_api_key) as client:
        covers_data = await client.get_covers_forecast(week_start, days=7)
        revenue_data = await client.get_revenue_forecast(week_start, days=7)
        spend_rates_response = await client.get_spend_rates()

    api_spend = spend_rates_response.get("periods", {})
    vat_rate = spend_rates_response.get("vat_rate", 1.20)

    covers_by_date = {d.get("date", ""): d for d in covers_data}
    revenue_by_date = {d.get("date", ""): d for d in revenue_data}

    # Delete existing snapshots for this week (re-snapshot)
    await db.execute(text("""
        DELETE FROM forecast_snapshots
        WHERE kitchen_id = :kid AND week_start = :ws
    """), {"kid": kitchen_id, "ws": week_start})

    # Insert snapshot for each day/period
    total_forecast_rev = Decimal("0")
    total_otb_rev = Decimal("0")

    for d in week_dates:
        date_str = d.isoformat()
        day_covers = covers_by_date.get(date_str, {})
        day_revenue = revenue_by_date.get(date_str, {})

        for period in ("breakfast", "lunch", "dinner"):
            p = day_covers.get(period, {})
            otb = p.get("otb", 0) or 0
            forecast = p.get("forecast", 0) or 0

            # Spend rates (net, ex VAT)
            food_net = api_spend.get(period, {}).get("food_spend_net", 0)
            drinks_net = api_spend.get(period, {}).get("drinks_spend_net", 0)

            # Calculate dry revenue for this period/day
            dry_rev = Decimal(str(forecast)) * Decimal(str(food_net))

            await db.execute(text("""
                INSERT INTO forecast_snapshots
                    (kitchen_id, snapshot_date, period, forecast_covers, otb_covers,
                     food_spend, drinks_spend, forecast_dry_revenue, week_start)
                VALUES (:kid, :sd, :period, :fc, :oc, :fs, :ds, :dr, :ws)
            """), {
                "kid": kitchen_id, "sd": d, "period": period,
                "fc": forecast, "oc": otb,
                "fs": food_net, "ds": drinks_net,
                "dr": float(round(dry_rev, 2)),
                "ws": week_start,
            })

            # Accumulate weekly totals from revenue API
            dry = day_revenue.get("dry", {})
            total_forecast_rev += Decimal(str(dry.get("forecast", 0) or 0))
            total_otb_rev += Decimal(str(dry.get("otb", 0) or 0))

    # Divide by 3 since we're iterating 3 periods but revenue data is per-day total
    # Actually, the revenue API returns per-day totals, not per-period.
    # We accumulated 3x per day. Let's recalculate from revenue_data directly.
    total_forecast_rev = Decimal("0")
    total_otb_rev = Decimal("0")
    for d in revenue_data:
        dry = d.get("dry", {})
        total_forecast_rev += Decimal(str(dry.get("forecast", 0) or 0))
        total_otb_rev += Decimal(str(dry.get("otb", 0) or 0))

    # Upsert week snapshot
    gp_target = float(settings.budget_gp_target) if settings.budget_gp_target else 65.0

    await db.execute(text("""
        DELETE FROM forecast_week_snapshots
        WHERE kitchen_id = :kid AND week_start = :ws
    """), {"kid": kitchen_id, "ws": week_start})

    await db.execute(text("""
        INSERT INTO forecast_week_snapshots
            (kitchen_id, week_start, total_forecast_revenue, total_otb_revenue, gp_target)
        VALUES (:kid, :ws, :tfr, :tor, :gp)
    """), {
        "kid": kitchen_id, "ws": week_start,
        "tfr": float(round(total_forecast_rev, 2)),
        "tor": float(round(total_otb_rev, 2)),
        "gp": gp_target,
    })

    await db.commit()

    return {
        "success": True,
        "message": "Forecast snapshot created",
        "week_start": week_start.isoformat(),
        "total_forecast_revenue": float(round(total_forecast_rev, 2)),
        "total_otb_revenue": float(round(total_otb_rev, 2)),
        "days_snapshotted": len(week_dates),
        "periods_per_day": 3,
    }


@router.put("")
async def upsert_cover_override(
    req: CoverOverrideRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Set or update a cover override for a specific date+period."""
    kitchen_id = current_user.kitchen_id

    if req.period not in ("lunch", "dinner"):
        raise HTTPException(status_code=400, detail="Period must be 'lunch' or 'dinner'")

    if req.override_covers < 0:
        raise HTTPException(status_code=400, detail="Override covers cannot be negative")

    override_date = date.fromisoformat(req.override_date)

    # Check existing
    existing = await db.execute(text("""
        SELECT id FROM cover_overrides
        WHERE kitchen_id = :kid AND override_date = :od AND period = :p
    """), {"kid": kitchen_id, "od": override_date, "p": req.period})
    row = existing.fetchone()

    if row:
        await db.execute(text("""
            UPDATE cover_overrides
            SET override_covers = :oc, updated_by = :uid, updated_at = NOW()
            WHERE id = :id
        """), {"oc": req.override_covers, "uid": current_user.id, "id": row.id})
    else:
        # Get current forecast for snapshot
        settings = await get_settings(db, kitchen_id)
        original_forecast = None
        original_otb = None

        if settings.forecast_api_url and settings.forecast_api_key:
            try:
                async with ForecastAPIClient(settings.forecast_api_url, settings.forecast_api_key) as client:
                    covers = await client.get_covers_forecast(override_date, days=1)
                    if covers:
                        p = covers[0].get(req.period, {})
                        original_forecast = p.get("forecast", 0) or 0
                        original_otb = p.get("otb", 0) or 0
            except Exception as e:
                logger.warning(f"Failed to get forecast for snapshot: {e}")

        await db.execute(text("""
            INSERT INTO cover_overrides
                (kitchen_id, override_date, period, override_covers,
                 original_forecast, original_otb, created_by, updated_by)
            VALUES (:kid, :od, :p, :oc, :of, :oo, :uid, :uid)
        """), {
            "kid": kitchen_id, "od": override_date, "p": req.period,
            "oc": req.override_covers, "of": original_forecast, "oo": original_otb,
            "uid": current_user.id,
        })

    await db.commit()
    return {"success": True, "date": req.override_date, "period": req.period, "covers": req.override_covers}


@router.delete("/{override_id}")
async def delete_cover_override(
    override_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Remove a cover override (revert to forecast)."""
    result = await db.execute(text("""
        DELETE FROM cover_overrides
        WHERE id = :id AND kitchen_id = :kid
        RETURNING id
    """), {"id": override_id, "kid": current_user.kitchen_id})
    deleted = result.fetchone()

    if not deleted:
        raise HTTPException(status_code=404, detail="Override not found")

    await db.commit()
    return {"success": True, "deleted_id": override_id}


@router.put("/spend-rates")
async def upsert_spend_rate_override(
    req: SpendRateOverrideRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Set or update a spend rate override for a week+period."""
    kitchen_id = current_user.kitchen_id
    week_start, _, _ = get_week_dates(req.week_offset)

    if req.period not in ("breakfast", "lunch", "dinner"):
        raise HTTPException(status_code=400, detail="Period must be 'breakfast', 'lunch', or 'dinner'")

    # Check existing
    existing = await db.execute(text("""
        SELECT id FROM spend_rate_overrides
        WHERE kitchen_id = :kid AND week_start = :ws AND period = :p
    """), {"kid": kitchen_id, "ws": week_start, "p": req.period})
    row = existing.fetchone()

    if row:
        await db.execute(text("""
            UPDATE spend_rate_overrides
            SET food_spend = :fs, drinks_spend = :ds, updated_by = :uid, updated_at = NOW()
            WHERE id = :id
        """), {"fs": req.food_spend, "ds": req.drinks_spend, "uid": current_user.id, "id": row.id})
    else:
        await db.execute(text("""
            INSERT INTO spend_rate_overrides
                (kitchen_id, week_start, period, food_spend, drinks_spend, created_by, updated_by)
            VALUES (:kid, :ws, :p, :fs, :ds, :uid, :uid)
        """), {
            "kid": kitchen_id, "ws": week_start, "p": req.period,
            "fs": req.food_spend, "ds": req.drinks_spend, "uid": current_user.id,
        })

    await db.commit()
    return {"success": True, "week_start": week_start.isoformat(), "period": req.period}


@router.delete("/spend-rates/{override_id}")
async def delete_spend_rate_override(
    override_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Remove a spend rate override (revert to snapshot/API value)."""
    result = await db.execute(text("""
        DELETE FROM spend_rate_overrides
        WHERE id = :id AND kitchen_id = :kid
        RETURNING id
    """), {"id": override_id, "kid": current_user.kitchen_id})
    deleted = result.fetchone()

    if not deleted:
        raise HTTPException(status_code=404, detail="Spend rate override not found")

    await db.commit()
    return {"success": True, "deleted_id": override_id}
