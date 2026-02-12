"""
Budget API endpoints for Spend Budget feature.

Calculates spending budgets based on forecasted revenue and target GP%,
allocated to suppliers based on their historical spending percentage.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from collections import defaultdict
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, case, and_, or_
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, field_serializer

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.supplier import Supplier
from models.line_item import LineItem
from models.settings import KitchenSettings
from auth.jwt import get_current_user
from services.forecast_api import ForecastAPIClient, ForecastAPIError

logger = logging.getLogger(__name__)

router = APIRouter()


# Response Models

class BudgetInvoice(BaseModel):
    """Individual invoice in budget table"""
    id: int
    invoice_number: Optional[str]
    invoice_date: Optional[date]
    net_stock: Decimal
    document_type: Optional[str] = None

    @field_serializer('net_stock')
    def serialize_net_stock(self, v: Decimal) -> float:
        return float(v)


class SupplierBudgetRow(BaseModel):
    """Supplier row in weekly budget table"""
    supplier_id: Optional[int]
    supplier_name: str
    historical_pct: Decimal  # 4-week average percentage
    allocated_budget: Decimal  # total_budget * historical_pct
    invoices_by_date: dict[str, list[BudgetInvoice]]  # date -> invoices
    actual_spent: Decimal  # Sum of invoices this week
    remaining: Decimal  # allocated - spent (negative = overspend)
    status: str  # "under", "on_track", "over"

    @field_serializer('historical_pct', 'allocated_budget', 'actual_spent', 'remaining')
    def serialize_decimals(self, v: Decimal) -> float:
        return float(v)


class DailyBudgetData(BaseModel):
    """Daily budget tracking data"""
    date: date
    day_name: str
    forecast_revenue: Decimal
    budget_split_pct: Decimal  # % of weekly budget this day gets (from historical spend)
    historical_budget: Decimal  # Budget allocated based on historical spend patterns
    revenue_budget: Decimal  # Budget allocated based on forecast revenue proportion
    actual_spent: Optional[Decimal]  # Only for past/today
    cumulative_budget: Decimal
    cumulative_spent: Optional[Decimal]

    @field_serializer('forecast_revenue', 'budget_split_pct', 'historical_budget', 'revenue_budget', 'cumulative_budget')
    def serialize_decimals(self, v: Decimal) -> float:
        return float(v)

    @field_serializer('actual_spent', 'cumulative_spent')
    def serialize_optional_decimals(self, v: Optional[Decimal]) -> Optional[float]:
        return float(v) if v is not None else None


class CoversSummary(BaseModel):
    """Covers summary for a meal period"""
    otb: int
    pickup: int
    forecast: int


class ForecastSummary(BaseModel):
    """Weekly forecast summary for rooms and covers"""
    otb_rooms: int = 0
    pickup_rooms: int = 0
    forecast_rooms: int = 0
    otb_guests: int = 0
    pickup_guests: int = 0
    forecast_guests: int = 0
    breakfast: CoversSummary = CoversSummary(otb=0, pickup=0, forecast=0)
    lunch: CoversSummary = CoversSummary(otb=0, pickup=0, forecast=0)
    dinner: CoversSummary = CoversSummary(otb=0, pickup=0, forecast=0)


class WeeklyBudgetResponse(BaseModel):
    """Response for weekly budget endpoint"""
    week_start: date
    week_end: date
    dates: list[date]  # All 7 days of the week

    # Forecast data
    otb_revenue: Decimal  # On The Books revenue (current bookings only)
    forecast_revenue: Decimal  # Full forecast revenue (OTB + expected pickup)
    forecast_source: str  # "forecast_api" or "fallback"

    # Forecast summary (rooms + covers)
    forecast_summary: Optional[ForecastSummary] = None

    # Budget calculation
    gp_target_pct: Decimal  # e.g., 65.00
    min_budget: Decimal  # Minimum budget based on OTB only
    total_budget: Decimal  # Full budget based on forecast

    # Actuals
    total_spent: Decimal  # Actual spend from confirmed invoices
    total_remaining: Decimal  # budget - spent (negative = overspend)

    # Supplier breakdown
    suppliers: list[SupplierBudgetRow]
    all_supplier_names: list[str]

    # Daily breakdown
    daily_data: list[DailyBudgetData]
    daily_totals: dict[str, Decimal]  # date -> actual spend

    @field_serializer('otb_revenue', 'forecast_revenue', 'gp_target_pct', 'min_budget', 'total_budget', 'total_spent', 'total_remaining')
    def serialize_decimals(self, v: Decimal) -> float:
        return float(v)

    @field_serializer('daily_totals')
    def serialize_daily_totals(self, v: dict[str, Decimal]) -> dict[str, float]:
        return {k: float(val) for k, val in v.items()}


class BudgetSettingsResponse(BaseModel):
    """Budget settings response"""
    forecast_api_url: Optional[str]
    forecast_api_configured: bool
    budget_gp_target: Decimal
    budget_lookback_weeks: int

    @field_serializer('budget_gp_target')
    def serialize_gp_target(self, v: Decimal) -> float:
        return float(v)


class BudgetSettingsUpdate(BaseModel):
    """Budget settings update request"""
    forecast_api_url: Optional[str] = None
    forecast_api_key: Optional[str] = None
    budget_gp_target: Optional[Decimal] = None
    budget_lookback_weeks: Optional[int] = None


class TestConnectionResponse(BaseModel):
    """Response for forecast API connection test"""
    success: bool
    message: str


# Helper Functions

async def get_settings(db: AsyncSession, kitchen_id: int) -> KitchenSettings:
    """Get kitchen settings, creating if not exists"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=kitchen_id)
        db.add(settings)
        await db.commit()
        await db.refresh(settings)

    return settings


async def get_historical_supplier_percentages(
    db: AsyncSession,
    kitchen_id: int,
    lookback_start: date,
    lookback_end: date
) -> list[tuple[int | None, str, Decimal]]:
    """
    Calculate supplier spend percentages over the lookback period.

    Returns list of (supplier_id, supplier_name, percentage) sorted by percentage desc.
    """
    # Build subquery to sum per invoice first (for credit note handling)
    invoice_stock_subq = (
        select(
            Invoice.id.label('inv_id'),
            Invoice.supplier_id.label('supplier_id'),
            Invoice.document_type.label('doc_type'),
            func.sum(LineItem.amount).label('stock_total')
        )
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .where(
            Invoice.kitchen_id == kitchen_id,
            Invoice.invoice_date >= lookback_start,
            Invoice.invoice_date <= lookback_end,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
        .group_by(Invoice.id, Invoice.supplier_id, Invoice.document_type)
        .subquery()
    )

    # Get total for period
    total_result = await db.execute(
        select(func.sum(
            case(
                (and_(invoice_stock_subq.c.doc_type == 'credit_note',
                      invoice_stock_subq.c.stock_total > 0),
                 -invoice_stock_subq.c.stock_total),
                else_=invoice_stock_subq.c.stock_total
            )
        ))
        .select_from(invoice_stock_subq)
    )
    total_spend = total_result.scalar() or Decimal("0")

    if total_spend <= 0:
        return []

    # Get supplier breakdown
    supplier_result = await db.execute(
        select(
            invoice_stock_subq.c.supplier_id,
            Supplier.name,
            func.sum(
                case(
                    (and_(invoice_stock_subq.c.doc_type == 'credit_note',
                          invoice_stock_subq.c.stock_total > 0),
                     -invoice_stock_subq.c.stock_total),
                    else_=invoice_stock_subq.c.stock_total
                )
            ).label('net_total')
        )
        .select_from(invoice_stock_subq)
        .outerjoin(Supplier, invoice_stock_subq.c.supplier_id == Supplier.id)
        .group_by(invoice_stock_subq.c.supplier_id, Supplier.name)
        .order_by(func.sum(
            case(
                (and_(invoice_stock_subq.c.doc_type == 'credit_note',
                      invoice_stock_subq.c.stock_total > 0),
                 -invoice_stock_subq.c.stock_total),
                else_=invoice_stock_subq.c.stock_total
            )
        ).desc())
    )

    result = []
    for supplier_id, supplier_name, net_total in supplier_result.all():
        if net_total and net_total != 0:
            pct = (net_total / total_spend * 100)
            result.append((
                supplier_id,
                supplier_name or "Unmatched",
                round(pct, 2)
            ))

    return result


async def get_historical_daily_distribution(
    db: AsyncSession,
    kitchen_id: int,
    lookback_start: date,
    lookback_end: date
) -> dict[int, Decimal]:
    """
    Calculate historical spend distribution by day of week.

    Returns dict of weekday (0=Mon, 6=Sun) -> percentage of weekly spend
    """
    # Get all confirmed invoices in the lookback period with their totals
    invoice_subq = (
        select(
            Invoice.id.label('inv_id'),
            Invoice.invoice_date.label('inv_date'),
            Invoice.document_type.label('doc_type'),
            func.sum(LineItem.amount).label('stock_total')
        )
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .where(
            Invoice.kitchen_id == kitchen_id,
            Invoice.invoice_date >= lookback_start,
            Invoice.invoice_date <= lookback_end,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
        .group_by(Invoice.id, Invoice.invoice_date, Invoice.document_type)
        .subquery()
    )

    # Get spend by day
    result = await db.execute(
        select(
            invoice_subq.c.inv_date,
            func.sum(
                case(
                    (and_(invoice_subq.c.doc_type == 'credit_note',
                          invoice_subq.c.stock_total > 0),
                     -invoice_subq.c.stock_total),
                    else_=invoice_subq.c.stock_total
                )
            ).label('net_total')
        )
        .select_from(invoice_subq)
        .group_by(invoice_subq.c.inv_date)
    )

    # Aggregate by day of week
    weekday_totals: dict[int, Decimal] = {i: Decimal("0") for i in range(7)}
    total_spend = Decimal("0")

    for inv_date, net_total in result.all():
        if inv_date and net_total:
            weekday = inv_date.weekday()  # 0=Monday, 6=Sunday
            weekday_totals[weekday] += Decimal(str(net_total))
            total_spend += Decimal(str(net_total))

    # Convert to percentages
    if total_spend > 0:
        return {day: (amount / total_spend * 100).quantize(Decimal("0.01"))
                for day, amount in weekday_totals.items()}
    else:
        # Default to even distribution if no historical data
        return {i: Decimal("14.29") for i in range(7)}


async def get_weekly_invoices_by_supplier(
    db: AsyncSession,
    kitchen_id: int,
    week_start: date,
    week_end: date
) -> dict[tuple[int | None, str], list[dict]]:
    """
    Get all confirmed invoices for the week grouped by supplier.

    Returns dict of (supplier_id, supplier_name) -> list of invoice data
    """
    # Get all confirmed invoices for the week with line items
    result = await db.execute(
        select(Invoice)
        .where(
            Invoice.kitchen_id == kitchen_id,
            Invoice.status == InvoiceStatus.CONFIRMED,
            Invoice.invoice_date >= week_start,
            Invoice.invoice_date <= week_end,
        )
        .options(selectinload(Invoice.line_items))
        .order_by(Invoice.invoice_date)
    )
    invoices = result.scalars().all()

    # Get supplier names
    supplier_result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == kitchen_id)
    )
    suppliers_map = {s.id: s.name for s in supplier_result.scalars().all()}

    # Group invoices by supplier
    supplier_invoices: dict[tuple[int | None, str], list[dict]] = defaultdict(list)

    for inv in invoices:
        # Calculate net stock for this invoice
        net_stock = Decimal("0")
        if inv.line_items:
            for item in inv.line_items:
                if not (item.is_non_stock or False):
                    net_stock += item.amount or Decimal("0")

        # Handle credit notes
        if inv.document_type == 'credit_note' and net_stock > 0:
            net_stock = -net_stock

        # Skip invoices with no stock value (non-stock only invoices)
        if net_stock == 0:
            continue

        # Get supplier key
        if inv.supplier_id:
            supplier_name = suppliers_map.get(inv.supplier_id, "Unknown")
            key = (inv.supplier_id, supplier_name)
        else:
            vendor = inv.vendor_name or "Unknown Supplier"
            key = (None, vendor)

        supplier_invoices[key].append({
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "invoice_date": inv.invoice_date,
            "net_stock": net_stock,
            "document_type": inv.document_type,
        })

    return supplier_invoices


# API Endpoints

@router.get("/weekly", response_model=WeeklyBudgetResponse)
async def get_weekly_budget(
    week_offset: int = 0,  # 0 = current week, -1 = last week, etc.
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get weekly budget breakdown with supplier allocations.

    week_offset: 0 = current week (Mon-Sun), -1 = previous week, etc.
    """
    # Calculate week dates (Mon-Sun)
    today = date.today()
    current_monday = today - timedelta(days=today.weekday())
    week_start = current_monday + timedelta(weeks=week_offset)
    week_end = week_start + timedelta(days=6)
    week_dates = [week_start + timedelta(days=i) for i in range(7)]

    # Get settings
    settings = await get_settings(db, current_user.kitchen_id)

    # Get forecast revenue + rooms + covers
    otb_revenue = Decimal("0")
    forecast_revenue = Decimal("0")
    forecast_source = "fallback"
    forecast_data = None  # Keep the daily forecast data
    forecast_summary = None

    if settings.forecast_api_url and settings.forecast_api_key:
        try:
            async with ForecastAPIClient(
                settings.forecast_api_url,
                settings.forecast_api_key
            ) as client:
                forecast_data = await client.get_revenue_forecast(week_start, days=7)
                otb_revenue, forecast_revenue = client.calculate_food_revenue(forecast_data)
                forecast_source = "forecast_api"
                logger.info(f"Fetched revenue - OTB: {otb_revenue}, Forecast: {forecast_revenue}")

                # Fetch rooms and covers for summary banner
                try:
                    rooms_data = await client.get_rooms_forecast(week_start, days=7)
                    covers_data = await client.get_covers_forecast(week_start, days=7)
                    rooms_agg = client.aggregate_rooms(rooms_data)
                    covers_agg = client.aggregate_covers(covers_data)
                    forecast_summary = ForecastSummary(
                        otb_rooms=rooms_agg["otb_rooms"],
                        pickup_rooms=rooms_agg["pickup_rooms"],
                        forecast_rooms=rooms_agg["forecast_rooms"],
                        otb_guests=rooms_agg["otb_guests"],
                        pickup_guests=rooms_agg["pickup_guests"],
                        forecast_guests=rooms_agg["forecast_guests"],
                        breakfast=CoversSummary(**covers_agg["breakfast"]),
                        lunch=CoversSummary(**covers_agg["lunch"]),
                        dinner=CoversSummary(**covers_agg["dinner"]),
                    )
                except Exception as e:
                    logger.warning(f"Failed to fetch rooms/covers forecast: {e}")
        except ForecastAPIError as e:
            logger.warning(f"Failed to fetch forecast: {e.message}")
            forecast_data = None

    # Calculate budgets
    gp_target = settings.budget_gp_target or Decimal("65.00")
    cost_target_pct = (100 - gp_target) / 100
    min_budget = (otb_revenue * cost_target_pct).quantize(Decimal("0.01"))
    total_budget = (forecast_revenue * cost_target_pct).quantize(Decimal("0.01"))

    # Get historical supplier percentages
    lookback_weeks = settings.budget_lookback_weeks or 4
    lookback_start = week_start - timedelta(weeks=lookback_weeks)
    lookback_end = week_start - timedelta(days=1)

    supplier_pcts = await get_historical_supplier_percentages(
        db, current_user.kitchen_id, lookback_start, lookback_end
    )

    # Get historical daily distribution (for budget allocation by day of week)
    daily_distribution = await get_historical_daily_distribution(
        db, current_user.kitchen_id, lookback_start, lookback_end
    )

    # Get this week's invoices by supplier
    weekly_invoices = await get_weekly_invoices_by_supplier(
        db, current_user.kitchen_id, week_start, week_end
    )

    # Build supplier rows
    supplier_rows = []
    all_supplier_names = []
    total_spent = Decimal("0")

    # Process historical suppliers first
    processed_suppliers = set()
    for supplier_id, supplier_name, hist_pct in supplier_pcts:
        key = (supplier_id, supplier_name)
        processed_suppliers.add(key)
        all_supplier_names.append(supplier_name)

        # Calculate allocated budget
        allocated = (total_budget * Decimal(str(hist_pct)) / 100).quantize(Decimal("0.01"))

        # Get invoices for this supplier this week
        invoices = weekly_invoices.get(key, [])

        # Organize invoices by date
        invoices_by_date: dict[str, list[BudgetInvoice]] = defaultdict(list)
        actual_spent = Decimal("0")

        for inv in invoices:
            date_str = inv["invoice_date"].isoformat() if inv["invoice_date"] else ""
            if date_str:
                invoices_by_date[date_str].append(BudgetInvoice(
                    id=inv["id"],
                    invoice_number=inv["invoice_number"],
                    invoice_date=inv["invoice_date"],
                    net_stock=inv["net_stock"],
                    document_type=inv["document_type"],
                ))
            actual_spent += inv["net_stock"]

        total_spent += actual_spent
        remaining = allocated - actual_spent

        # Determine status
        if remaining < 0:
            status = "over"
        elif remaining < allocated * Decimal("0.1"):  # Less than 10% remaining
            status = "on_track"
        else:
            status = "under"

        supplier_rows.append(SupplierBudgetRow(
            supplier_id=supplier_id,
            supplier_name=supplier_name,
            historical_pct=hist_pct,
            allocated_budget=allocated,
            invoices_by_date=dict(invoices_by_date),
            actual_spent=actual_spent,
            remaining=remaining,
            status=status,
        ))

    # Add any suppliers with invoices this week that weren't in historical data
    for key, invoices in weekly_invoices.items():
        if key not in processed_suppliers:
            supplier_id, supplier_name = key
            all_supplier_names.append(supplier_name)

            invoices_by_date: dict[str, list[BudgetInvoice]] = defaultdict(list)
            actual_spent = Decimal("0")

            for inv in invoices:
                date_str = inv["invoice_date"].isoformat() if inv["invoice_date"] else ""
                if date_str:
                    invoices_by_date[date_str].append(BudgetInvoice(
                        id=inv["id"],
                        invoice_number=inv["invoice_number"],
                        invoice_date=inv["invoice_date"],
                        net_stock=inv["net_stock"],
                        document_type=inv["document_type"],
                    ))
                actual_spent += inv["net_stock"]

            total_spent += actual_spent

            supplier_rows.append(SupplierBudgetRow(
                supplier_id=supplier_id,
                supplier_name=supplier_name,
                historical_pct=Decimal("0"),  # No historical data
                allocated_budget=Decimal("0"),
                invoices_by_date=dict(invoices_by_date),
                actual_spent=actual_spent,
                remaining=-actual_spent,  # Over by definition
                status="over" if actual_spent > 0 else "under",
            ))

    # Build daily breakdown with both historical and revenue-based budgets
    daily_data = []
    daily_totals: dict[str, Decimal] = {}
    cumulative_budget = Decimal("0")
    cumulative_spent = Decimal("0")

    # Extract daily revenue from forecast API data
    daily_forecast_revenue: dict[str, Decimal] = {}
    total_forecast_rev = Decimal("0")

    if forecast_data:
        # Use actual daily forecast from API
        for day in forecast_data:
            date_str = day.get("date")
            if date_str:
                dry = day.get("dry", {})
                dry_forecast = Decimal(str(dry.get("forecast", 0) or 0))
                daily_forecast_revenue[date_str] = dry_forecast
                total_forecast_rev += dry_forecast
    else:
        # Fallback: distribute total forecast using historical patterns
        for d in week_dates:
            weekday = d.weekday()
            day_pct = daily_distribution.get(weekday, Decimal("14.29"))
            day_forecast_rev = (forecast_revenue * day_pct / 100).quantize(Decimal("0.01"))
            daily_forecast_revenue[d.isoformat()] = day_forecast_rev
            total_forecast_rev += day_forecast_rev

    for d in week_dates:
        date_str = d.isoformat()
        day_name = d.strftime("%a")
        weekday = d.weekday()  # 0=Monday, 6=Sunday

        # Historical spend-based budget
        budget_split_pct = daily_distribution.get(weekday, Decimal("14.29"))
        historical_budget = (total_budget * budget_split_pct / 100).quantize(Decimal("0.01"))

        # Revenue-based budget (proportional to actual daily forecast revenue)
        day_forecast_rev = daily_forecast_revenue.get(date_str, Decimal("0"))
        if total_forecast_rev > 0:
            revenue_pct = (day_forecast_rev / total_forecast_rev * 100).quantize(Decimal("0.01"))
            revenue_budget = (total_budget * revenue_pct / 100).quantize(Decimal("0.01"))
        else:
            revenue_budget = (total_budget / 7).quantize(Decimal("0.01"))

        # Get actual spend for this day
        day_spent = Decimal("0")
        for supplier_row in supplier_rows:
            for inv in supplier_row.invoices_by_date.get(date_str, []):
                day_spent += inv.net_stock

        daily_totals[date_str] = day_spent
        cumulative_budget += historical_budget  # Use historical for cumulative

        # Only show cumulative spent for past/today
        if d <= today:
            cumulative_spent += day_spent
            daily_data.append(DailyBudgetData(
                date=d,
                day_name=day_name,
                forecast_revenue=day_forecast_rev,
                budget_split_pct=budget_split_pct,
                historical_budget=historical_budget,
                revenue_budget=revenue_budget,
                actual_spent=day_spent,
                cumulative_budget=cumulative_budget,
                cumulative_spent=cumulative_spent,
            ))
        else:
            daily_data.append(DailyBudgetData(
                date=d,
                day_name=day_name,
                forecast_revenue=day_forecast_rev,
                budget_split_pct=budget_split_pct,
                historical_budget=historical_budget,
                revenue_budget=revenue_budget,
                actual_spent=None,
                cumulative_budget=cumulative_budget,
                cumulative_spent=None,
            ))

    total_remaining = total_budget - total_spent

    return WeeklyBudgetResponse(
        week_start=week_start,
        week_end=week_end,
        dates=week_dates,
        otb_revenue=otb_revenue,
        forecast_revenue=forecast_revenue,
        forecast_source=forecast_source,
        forecast_summary=forecast_summary,
        gp_target_pct=gp_target,
        min_budget=min_budget,
        total_budget=total_budget,
        total_spent=total_spent,
        total_remaining=total_remaining,
        suppliers=supplier_rows,
        all_supplier_names=all_supplier_names,
        daily_data=daily_data,
        daily_totals=daily_totals,
    )


@router.get("/settings", response_model=BudgetSettingsResponse)
async def get_budget_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current budget settings"""
    settings = await get_settings(db, current_user.kitchen_id)

    return BudgetSettingsResponse(
        forecast_api_url=settings.forecast_api_url,
        forecast_api_configured=bool(settings.forecast_api_url and settings.forecast_api_key),
        budget_gp_target=settings.budget_gp_target or Decimal("65.00"),
        budget_lookback_weeks=settings.budget_lookback_weeks or 4,
    )


@router.patch("/settings", response_model=BudgetSettingsResponse)
async def update_budget_settings(
    updates: BudgetSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update budget settings"""
    settings = await get_settings(db, current_user.kitchen_id)

    if updates.forecast_api_url is not None:
        settings.forecast_api_url = updates.forecast_api_url or None

    if updates.forecast_api_key is not None:
        settings.forecast_api_key = updates.forecast_api_key or None

    if updates.budget_gp_target is not None:
        settings.budget_gp_target = updates.budget_gp_target

    if updates.budget_lookback_weeks is not None:
        settings.budget_lookback_weeks = updates.budget_lookback_weeks

    await db.commit()
    await db.refresh(settings)

    return BudgetSettingsResponse(
        forecast_api_url=settings.forecast_api_url,
        forecast_api_configured=bool(settings.forecast_api_url and settings.forecast_api_key),
        budget_gp_target=settings.budget_gp_target or Decimal("65.00"),
        budget_lookback_weeks=settings.budget_lookback_weeks or 4,
    )


@router.post("/test-forecast-connection", response_model=TestConnectionResponse)
async def test_forecast_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test connection to forecast API"""
    settings = await get_settings(db, current_user.kitchen_id)

    if not settings.forecast_api_url:
        return TestConnectionResponse(
            success=False,
            message="Forecast API URL not configured"
        )

    if not settings.forecast_api_key:
        return TestConnectionResponse(
            success=False,
            message="Forecast API key not configured"
        )

    try:
        async with ForecastAPIClient(
            settings.forecast_api_url,
            settings.forecast_api_key
        ) as client:
            success, message = await client.test_connection()
            return TestConnectionResponse(success=success, message=message)
    except Exception as e:
        return TestConnectionResponse(
            success=False,
            message=f"Connection failed: {str(e)}"
        )
