from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.gp import RevenueEntry, GPPeriod
from models.newbook import NewbookDailyRevenue, NewbookGLAccount
from auth.jwt import get_current_user

router = APIRouter()


class RevenueEntryCreate(BaseModel):
    date: date
    amount: Decimal
    category: str = "total"
    notes: Optional[str] = None


class RevenueEntryResponse(BaseModel):
    id: int
    date: date
    amount: Decimal
    category: str
    notes: Optional[str]

    class Config:
        from_attributes = True


class GPReportRequest(BaseModel):
    start_date: date
    end_date: date


class GPReportResponse(BaseModel):
    start_date: date
    end_date: date
    total_revenue: Decimal
    total_costs: Decimal
    gp_amount: Decimal
    gp_percentage: Decimal
    category_breakdown: dict
    # Revenue breakdown
    newbook_revenue: Optional[Decimal] = None
    manual_revenue: Optional[Decimal] = None


class DashboardResponse(BaseModel):
    current_period: GPReportResponse | None
    previous_period: GPReportResponse | None
    recent_invoices: int
    pending_review: int


class PurchaseInvoice(BaseModel):
    id: int
    invoice_number: str | None
    total: Decimal | None
    supplier_match_type: str | None  # "exact", "fuzzy", or None (unmatched)

    class Config:
        from_attributes = True


class SupplierRow(BaseModel):
    supplier_id: int | None  # None for unmatched invoices
    supplier_name: str  # Supplier name or vendor_name for unmatched
    is_unmatched: bool
    invoices_by_date: dict[str, list[PurchaseInvoice]]  # date string -> invoices
    total: Decimal
    percentage: Decimal


class WeeklyPurchasesResponse(BaseModel):
    week_start: date
    week_end: date
    dates: list[date]  # 7 days
    suppliers: list[SupplierRow]
    daily_totals: dict[str, Decimal]  # date string -> total
    week_total: Decimal


# Monthly Purchases Calendar models
class MonthlyPurchaseInvoice(BaseModel):
    """Invoice with full detail for monthly view"""
    id: int
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None  # Gross total (inc. VAT)
    net_total: Decimal | None  # Net total (exc. VAT)
    net_stock: Decimal | None  # Net stock items only
    gross_stock: Decimal | None  # Gross stock items only (net_stock + stock VAT)
    supplier_match_type: str | None

    class Config:
        from_attributes = True


class MonthlySupplierRow(BaseModel):
    """Supplier row for monthly purchases - consistent order across weeks"""
    supplier_id: int | None
    supplier_name: str
    is_unmatched: bool
    invoices_by_date: dict[str, list[MonthlyPurchaseInvoice]]  # date string -> invoices
    total_net_stock: Decimal  # Sum of net_stock for all invoices
    percentage: Decimal


class WeekData(BaseModel):
    """Data for one week in the monthly view"""
    week_start: date
    week_end: date
    dates: list[date]  # 7 days (Mon-Sun)
    suppliers: list[MonthlySupplierRow]  # Same order as month-level suppliers
    daily_totals: dict[str, Decimal]  # date string -> net_stock total
    week_total: Decimal  # Net stock total for week


class MonthlyPurchasesResponse(BaseModel):
    """Response for monthly purchases calendar view"""
    year: int
    month: int
    month_name: str
    weeks: list[WeekData]  # All weeks in the month
    all_suppliers: list[str]  # Ordered list of all supplier names for consistent display
    daily_totals: dict[str, Decimal]  # All days in month -> net_stock total
    month_total: Decimal  # Net stock total for entire month


class DateRangePurchasesResponse(BaseModel):
    """Response for date range purchases view"""
    from_date: date
    to_date: date
    period_label: str  # Human-readable label like "Dec 18 - Jan 17, 2026"
    weeks: list[WeekData]  # All weeks in the range
    all_suppliers: list[str]  # Ordered list of all supplier names for consistent display
    daily_totals: dict[str, Decimal]  # All days in range -> net_stock total
    period_total: Decimal  # Net stock total for entire period


@router.post("/revenue", response_model=RevenueEntryResponse)
async def add_revenue(
    request: RevenueEntryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Add a revenue entry for GP calculation"""
    entry = RevenueEntry(
        kitchen_id=current_user.kitchen_id,
        date=request.date,
        amount=request.amount,
        category=request.category,
        notes=request.notes
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)

    return RevenueEntryResponse(
        id=entry.id,
        date=entry.date,
        amount=entry.amount,
        category=entry.category,
        notes=entry.notes
    )


@router.get("/revenue", response_model=list[RevenueEntryResponse])
async def list_revenue(
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List revenue entries for a date range"""
    query = select(RevenueEntry).where(
        RevenueEntry.kitchen_id == current_user.kitchen_id
    )

    if start_date:
        query = query.where(RevenueEntry.date >= start_date)
    if end_date:
        query = query.where(RevenueEntry.date <= end_date)

    query = query.order_by(RevenueEntry.date.desc())
    result = await db.execute(query)
    entries = result.scalars().all()

    return [
        RevenueEntryResponse(
            id=e.id,
            date=e.date,
            amount=e.amount,
            category=e.category,
            notes=e.notes
        )
        for e in entries
    ]


@router.post("/gp", response_model=GPReportResponse)
async def calculate_gp(
    request: GPReportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Calculate GP for a specific date range"""
    # Get manual revenue entries for period
    manual_revenue_result = await db.execute(
        select(func.sum(RevenueEntry.amount))
        .where(
            RevenueEntry.kitchen_id == current_user.kitchen_id,
            RevenueEntry.date >= request.start_date,
            RevenueEntry.date <= request.end_date
        )
    )
    manual_revenue = manual_revenue_result.scalar() or Decimal("0.00")

    # Get Newbook revenue for tracked GL accounts
    newbook_revenue_result = await db.execute(
        select(func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= request.start_date,
            NewbookDailyRevenue.date <= request.end_date,
            NewbookGLAccount.is_tracked == True
        )
    )
    newbook_revenue = newbook_revenue_result.scalar() or Decimal("0.00")

    # Total revenue combines manual entries and Newbook data
    total_revenue = manual_revenue + newbook_revenue

    # Get total costs from confirmed invoices
    costs_result = await db.execute(
        select(func.sum(Invoice.total))
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= request.start_date,
            Invoice.invoice_date <= request.end_date,
            Invoice.status == InvoiceStatus.CONFIRMED,
            Invoice.total.isnot(None)
        )
    )
    total_costs = costs_result.scalar() or Decimal("0.00")

    # Calculate GP
    gp_amount = total_revenue - total_costs
    gp_percentage = (gp_amount / total_revenue * 100) if total_revenue > 0 else Decimal("0.00")

    # Category breakdown for costs
    category_result = await db.execute(
        select(Invoice.category, func.sum(Invoice.total))
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= request.start_date,
            Invoice.invoice_date <= request.end_date,
            Invoice.status == InvoiceStatus.CONFIRMED,
            Invoice.total.isnot(None)
        )
        .group_by(Invoice.category)
    )
    category_breakdown = {
        cat or "uncategorized": float(amount)
        for cat, amount in category_result.all()
    }

    return GPReportResponse(
        start_date=request.start_date,
        end_date=request.end_date,
        total_revenue=total_revenue,
        total_costs=total_costs,
        gp_amount=gp_amount,
        gp_percentage=round(gp_percentage, 2),
        category_breakdown=category_breakdown,
        newbook_revenue=newbook_revenue if newbook_revenue > 0 else None,
        manual_revenue=manual_revenue if manual_revenue > 0 else None
    )


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get dashboard summary with current and previous period GP"""
    today = date.today()

    # Current week (Monday to today)
    current_start = today - timedelta(days=today.weekday())
    current_end = today

    # Previous week
    prev_start = current_start - timedelta(days=7)
    prev_end = current_start - timedelta(days=1)

    async def calc_period_gp(start: date, end: date) -> GPReportResponse | None:
        from models.line_item import LineItem
        from sqlalchemy import or_

        # Manual revenue entries
        manual_rev_result = await db.execute(
            select(func.sum(RevenueEntry.amount))
            .where(
                RevenueEntry.kitchen_id == current_user.kitchen_id,
                RevenueEntry.date >= start,
                RevenueEntry.date <= end
            )
        )
        manual_revenue = manual_rev_result.scalar() or Decimal("0.00")

        # Newbook revenue for tracked GL accounts
        newbook_rev_result = await db.execute(
            select(func.sum(NewbookDailyRevenue.amount_net))
            .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
            .where(
                NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
                NewbookDailyRevenue.date >= start,
                NewbookDailyRevenue.date <= end,
                NewbookGLAccount.is_tracked == True
            )
        )
        newbook_revenue = newbook_rev_result.scalar() or Decimal("0.00")

        # Total revenue
        revenue = manual_revenue + newbook_revenue

        # Costs - stock items only (exclude non-stock)
        cost_result = await db.execute(
            select(func.sum(LineItem.amount))
            .join(Invoice, LineItem.invoice_id == Invoice.id)
            .where(
                Invoice.kitchen_id == current_user.kitchen_id,
                Invoice.invoice_date >= start,
                Invoice.invoice_date <= end,
                Invoice.status == InvoiceStatus.CONFIRMED,
                LineItem.amount.isnot(None),
                or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
            )
        )
        costs = cost_result.scalar() or Decimal("0.00")

        if revenue == 0 and costs == 0:
            return None

        gp_amount = revenue - costs
        gp_pct = (gp_amount / revenue * 100) if revenue > 0 else Decimal("0.00")

        return GPReportResponse(
            start_date=start,
            end_date=end,
            total_revenue=revenue,
            total_costs=costs,
            gp_amount=gp_amount,
            gp_percentage=round(gp_pct, 2),
            category_breakdown={},
            newbook_revenue=newbook_revenue if newbook_revenue > 0 else None,
            manual_revenue=manual_revenue if manual_revenue > 0 else None
        )

    # Recent invoices count (last 7 days)
    recent_result = await db.execute(
        select(func.count(Invoice.id))
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.created_at >= today - timedelta(days=7)
        )
    )
    recent_invoices = recent_result.scalar() or 0

    # Pending review count
    pending_result = await db.execute(
        select(func.count(Invoice.id))
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.status == InvoiceStatus.PROCESSED
        )
    )
    pending_review = pending_result.scalar() or 0

    return DashboardResponse(
        current_period=await calc_period_gp(current_start, current_end),
        previous_period=await calc_period_gp(prev_start, prev_end),
        recent_invoices=recent_invoices,
        pending_review=pending_review
    )


@router.get("/purchases/weekly", response_model=WeeklyPurchasesResponse)
async def get_weekly_purchases(
    week_offset: int = 0,  # 0 = current week, -1 = last week, etc.
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get weekly purchases organized by supplier and date for table view"""
    from models.supplier import Supplier
    from collections import defaultdict

    today = date.today()
    # Calculate week start (Monday) with offset
    week_start = today - timedelta(days=today.weekday()) + timedelta(weeks=week_offset)
    week_end = week_start + timedelta(days=6)
    dates = [week_start + timedelta(days=i) for i in range(7)]

    # Get all invoices for the week (all statuses, matched or not)
    # Fetch all recent invoices and filter in Python for reliable date handling
    result = await db.execute(
        select(Invoice)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
        )
        .order_by(Invoice.invoice_date.desc().nullslast())
    )
    all_invoices = result.scalars().all()

    # Filter to invoices in the week range, using invoice_date or created_at as fallback
    invoices = []
    for inv in all_invoices:
        inv_date = inv.invoice_date or inv.created_at.date()
        if week_start <= inv_date <= week_end:
            invoices.append(inv)

    # Get all suppliers for name lookup
    supplier_result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == current_user.kitchen_id)
    )
    suppliers_map = {s.id: s.name for s in supplier_result.scalars().all()}

    # Organize invoices by supplier
    supplier_invoices: dict[tuple, list] = defaultdict(list)  # (supplier_id, name, is_unmatched) -> invoices

    for inv in invoices:
        if inv.supplier_id:
            key = (inv.supplier_id, suppliers_map.get(inv.supplier_id, "Unknown"), False)
        else:
            # Unmatched - use vendor_name or "Unknown Supplier"
            vendor = inv.vendor_name or "Unknown Supplier"
            key = (None, vendor, True)
        supplier_invoices[key].append(inv)

    # Calculate week total
    week_total = sum(inv.total or Decimal("0") for inv in invoices)

    # Build supplier rows
    supplier_rows = []
    for (supplier_id, supplier_name, is_unmatched), invs in sorted(
        supplier_invoices.items(), key=lambda x: (x[0][2], x[0][1].lower())  # Matched first, then alphabetical
    ):
        invoices_by_date: dict[str, list[PurchaseInvoice]] = defaultdict(list)
        row_total = Decimal("0")

        for inv in invs:
            # Use invoice_date if available, otherwise use created_at date
            inv_date = inv.invoice_date or inv.created_at.date()
            date_str = inv_date.isoformat()
            invoices_by_date[date_str].append(PurchaseInvoice(
                id=inv.id,
                invoice_number=inv.invoice_number,
                total=inv.total,
                supplier_match_type=inv.supplier_match_type
            ))
            row_total += inv.total or Decimal("0")

        percentage = (row_total / week_total * 100) if week_total > 0 else Decimal("0")

        supplier_rows.append(SupplierRow(
            supplier_id=supplier_id,
            supplier_name=supplier_name,
            is_unmatched=is_unmatched,
            invoices_by_date=dict(invoices_by_date),
            total=row_total,
            percentage=round(percentage, 1)
        ))

    # Calculate daily totals
    daily_totals = {}
    for d in dates:
        date_str = d.isoformat()
        daily_totals[date_str] = sum(
            inv.total or Decimal("0")
            for inv in invoices
            if (inv.invoice_date or inv.created_at.date()).isoformat() == date_str
        )

    return WeeklyPurchasesResponse(
        week_start=week_start,
        week_end=week_end,
        dates=dates,
        suppliers=supplier_rows,
        daily_totals=daily_totals,
        week_total=week_total
    )


@router.get("/purchases/monthly", response_model=MonthlyPurchasesResponse)
async def get_monthly_purchases(
    year: int | None = None,
    month: int | None = None,  # 1-12
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get monthly purchases organized by week, supplier, and date for calendar view"""
    from models.supplier import Supplier
    from models.line_item import LineItem
    from collections import defaultdict
    from calendar import monthrange, month_name as calendar_month_name

    # Default to current month
    today = date.today()
    year = year or today.year
    month = month or today.month

    # Get first and last day of month
    _, days_in_month = monthrange(year, month)
    month_start = date(year, month, 1)
    month_end = date(year, month, days_in_month)

    # Get all invoices for the month with their line items
    result = await db.execute(
        select(Invoice)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
        )
        .options(selectinload(Invoice.line_items))
        .order_by(Invoice.invoice_date.desc().nullslast())
    )
    all_invoices = result.scalars().all()

    # Filter to invoices in the month range
    invoices = []
    for inv in all_invoices:
        inv_date = inv.invoice_date or inv.created_at.date()
        if month_start <= inv_date <= month_end:
            invoices.append(inv)

    # Get all suppliers for name lookup
    supplier_result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == current_user.kitchen_id)
    )
    suppliers_map = {s.id: s.name for s in supplier_result.scalars().all()}

    # Helper to calculate stock values for an invoice
    def calc_stock_values(inv: Invoice) -> tuple[Decimal, Decimal]:
        """Returns (net_stock, gross_stock) for an invoice"""
        net_stock = Decimal("0")
        if inv.line_items:
            for item in inv.line_items:
                if not (item.is_non_stock or False):
                    item_net = item.amount or Decimal("0")
                    net_stock += item_net

        # Calculate gross_stock by applying invoice's VAT ratio to net_stock
        # (since line items often don't have individual tax_amount)
        if net_stock > 0 and inv.net_total and inv.total and inv.net_total > 0:
            vat_ratio = inv.total / inv.net_total
            gross_stock = (net_stock * vat_ratio).quantize(Decimal("0.01"))
        else:
            gross_stock = net_stock

        return net_stock, gross_stock

    # Build invoice data with stock values
    invoice_data = {}
    for inv in invoices:
        net_stock, gross_stock = calc_stock_values(inv)
        inv_date = inv.invoice_date or inv.created_at.date()
        invoice_data[inv.id] = {
            "inv": inv,
            "date": inv_date,
            "net_stock": net_stock,
            "gross_stock": gross_stock,
        }

    # Organize by supplier
    supplier_invoices: dict[tuple, list] = defaultdict(list)  # (supplier_id, name, is_unmatched) -> invoice ids
    for inv_id, data in invoice_data.items():
        inv = data["inv"]
        if inv.supplier_id:
            key = (inv.supplier_id, suppliers_map.get(inv.supplier_id, "Unknown"), False)
        else:
            vendor = inv.vendor_name or "Unknown Supplier"
            key = (None, vendor, True)
        supplier_invoices[key].append(inv_id)

    # Get ordered list of all suppliers (matched first, then alphabetical)
    all_supplier_keys = sorted(
        supplier_invoices.keys(),
        key=lambda x: (x[2], x[1].lower())  # is_unmatched, then name
    )
    all_suppliers = [name for (_, name, _) in all_supplier_keys]

    # Calculate month total
    month_total = sum(data["net_stock"] for data in invoice_data.values())

    # Build weeks - find all weeks that overlap with the month
    weeks_data = []

    # Find first Monday on or before month start
    first_monday = month_start - timedelta(days=month_start.weekday())

    current_week_start = first_monday
    while current_week_start <= month_end:
        week_end = current_week_start + timedelta(days=6)
        week_dates = [current_week_start + timedelta(days=i) for i in range(7)]

        # Build supplier rows for this week (maintain consistent order)
        # First pass: collect data and calculate week_total
        week_total = Decimal("0")
        week_daily_totals: dict[str, Decimal] = defaultdict(Decimal)
        supplier_data_list: list[tuple] = []  # (supplier_key, invoices_by_date, supplier_week_total)

        for supplier_key in all_supplier_keys:
            supplier_id, supplier_name, is_unmatched = supplier_key
            inv_ids = supplier_invoices.get(supplier_key, [])

            invoices_by_date: dict[str, list[MonthlyPurchaseInvoice]] = defaultdict(list)
            supplier_week_total = Decimal("0")

            for inv_id in inv_ids:
                data = invoice_data[inv_id]
                inv = data["inv"]
                inv_date = data["date"]

                # Only include if in this week
                if current_week_start <= inv_date <= week_end:
                    date_str = inv_date.isoformat()
                    invoices_by_date[date_str].append(MonthlyPurchaseInvoice(
                        id=inv.id,
                        invoice_number=inv.invoice_number,
                        invoice_date=inv.invoice_date,
                        total=inv.total,
                        net_total=inv.net_total,
                        net_stock=data["net_stock"],
                        gross_stock=data["gross_stock"],
                        supplier_match_type=inv.supplier_match_type
                    ))
                    supplier_week_total += data["net_stock"]
                    week_daily_totals[date_str] += data["net_stock"]

            week_total += supplier_week_total
            supplier_data_list.append((supplier_key, dict(invoices_by_date), supplier_week_total))

        # Second pass: calculate percentages using week_total
        week_supplier_rows = []
        for supplier_key, invoices_by_date, supplier_week_total in supplier_data_list:
            supplier_id, supplier_name, is_unmatched = supplier_key
            percentage = (supplier_week_total / week_total * 100) if week_total > 0 else Decimal("0")

            week_supplier_rows.append(MonthlySupplierRow(
                supplier_id=supplier_id,
                supplier_name=supplier_name,
                is_unmatched=is_unmatched,
                invoices_by_date=invoices_by_date,
                total_net_stock=supplier_week_total,
                percentage=round(percentage, 1)
            ))

        weeks_data.append(WeekData(
            week_start=current_week_start,
            week_end=week_end,
            dates=week_dates,
            suppliers=week_supplier_rows,
            daily_totals=dict(week_daily_totals),
            week_total=week_total
        ))

        current_week_start += timedelta(days=7)

    # Calculate daily totals for entire month
    monthly_daily_totals: dict[str, Decimal] = defaultdict(Decimal)
    for data in invoice_data.values():
        date_str = data["date"].isoformat()
        monthly_daily_totals[date_str] += data["net_stock"]

    return MonthlyPurchasesResponse(
        year=year,
        month=month,
        month_name=calendar_month_name[month],
        weeks=weeks_data,
        all_suppliers=all_suppliers,
        daily_totals=dict(monthly_daily_totals),
        month_total=month_total
    )


@router.get("/purchases/range", response_model=DateRangePurchasesResponse)
async def get_purchases_by_range(
    from_date: date,
    to_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get purchases organized by week for a custom date range"""
    from models.supplier import Supplier
    from models.line_item import LineItem
    from collections import defaultdict

    # Validate date range
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date must be before or equal to to_date")

    # Build period label
    if from_date.year == to_date.year:
        if from_date.month == to_date.month:
            period_label = f"{from_date.strftime('%b %d')} - {to_date.strftime('%d, %Y')}"
        else:
            period_label = f"{from_date.strftime('%b %d')} - {to_date.strftime('%b %d, %Y')}"
    else:
        period_label = f"{from_date.strftime('%b %d, %Y')} - {to_date.strftime('%b %d, %Y')}"

    # Get all invoices for the range with their line items
    result = await db.execute(
        select(Invoice)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
        )
        .options(selectinload(Invoice.line_items))
        .order_by(Invoice.invoice_date.desc().nullslast())
    )
    all_invoices = result.scalars().all()

    # Filter to invoices in the date range
    invoices = []
    for inv in all_invoices:
        inv_date = inv.invoice_date or inv.created_at.date()
        if from_date <= inv_date <= to_date:
            invoices.append(inv)

    # Get all suppliers for name lookup
    supplier_result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == current_user.kitchen_id)
    )
    suppliers_map = {s.id: s.name for s in supplier_result.scalars().all()}

    # Helper to calculate stock values for an invoice
    def calc_stock_values(inv: Invoice) -> tuple[Decimal, Decimal]:
        """Returns (net_stock, gross_stock) for an invoice"""
        net_stock = Decimal("0")
        if inv.line_items:
            for item in inv.line_items:
                if not (item.is_non_stock or False):
                    item_net = item.amount or Decimal("0")
                    net_stock += item_net

        # Calculate gross_stock by applying invoice's VAT ratio to net_stock
        if net_stock > 0 and inv.net_total and inv.total and inv.net_total > 0:
            vat_ratio = inv.total / inv.net_total
            gross_stock = (net_stock * vat_ratio).quantize(Decimal("0.01"))
        else:
            gross_stock = net_stock

        return net_stock, gross_stock

    # Build invoice data with stock values
    invoice_data = {}
    for inv in invoices:
        net_stock, gross_stock = calc_stock_values(inv)
        inv_date = inv.invoice_date or inv.created_at.date()
        invoice_data[inv.id] = {
            "inv": inv,
            "date": inv_date,
            "net_stock": net_stock,
            "gross_stock": gross_stock,
        }

    # Organize by supplier
    supplier_invoices: dict[tuple, list] = defaultdict(list)
    for inv_id, data in invoice_data.items():
        inv = data["inv"]
        if inv.supplier_id:
            key = (inv.supplier_id, suppliers_map.get(inv.supplier_id, "Unknown"), False)
        else:
            vendor = inv.vendor_name or "Unknown Supplier"
            key = (None, vendor, True)
        supplier_invoices[key].append(inv_id)

    # Get ordered list of all suppliers (matched first, then alphabetical)
    all_supplier_keys = sorted(
        supplier_invoices.keys(),
        key=lambda x: (x[2], x[1].lower())
    )
    all_suppliers = [name for (_, name, _) in all_supplier_keys]

    # Calculate period total
    period_total = sum(data["net_stock"] for data in invoice_data.values())

    # Build weeks - find all weeks that overlap with the date range
    weeks_data = []

    # Find first Monday on or before from_date
    first_monday = from_date - timedelta(days=from_date.weekday())

    current_week_start = first_monday
    while current_week_start <= to_date:
        week_end = current_week_start + timedelta(days=6)
        week_dates = [current_week_start + timedelta(days=i) for i in range(7)]

        # Build supplier rows for this week
        week_total = Decimal("0")
        week_daily_totals: dict[str, Decimal] = defaultdict(Decimal)
        supplier_data_list: list[tuple] = []

        for supplier_key in all_supplier_keys:
            supplier_id, supplier_name, is_unmatched = supplier_key
            inv_ids = supplier_invoices.get(supplier_key, [])

            invoices_by_date: dict[str, list[MonthlyPurchaseInvoice]] = defaultdict(list)
            supplier_week_total = Decimal("0")

            for inv_id in inv_ids:
                data = invoice_data[inv_id]
                inv = data["inv"]
                inv_date = data["date"]

                # Only include if in this week
                if current_week_start <= inv_date <= week_end:
                    date_str = inv_date.isoformat()
                    invoices_by_date[date_str].append(MonthlyPurchaseInvoice(
                        id=inv.id,
                        invoice_number=inv.invoice_number,
                        invoice_date=inv.invoice_date,
                        total=inv.total,
                        net_total=inv.net_total,
                        net_stock=data["net_stock"],
                        gross_stock=data["gross_stock"],
                        supplier_match_type=inv.supplier_match_type
                    ))
                    supplier_week_total += data["net_stock"]
                    week_daily_totals[date_str] += data["net_stock"]

            week_total += supplier_week_total
            supplier_data_list.append((supplier_key, dict(invoices_by_date), supplier_week_total))

        # Calculate percentages
        week_supplier_rows = []
        for supplier_key, invoices_by_date, supplier_week_total in supplier_data_list:
            supplier_id, supplier_name, is_unmatched = supplier_key
            percentage = (supplier_week_total / week_total * 100) if week_total > 0 else Decimal("0")

            week_supplier_rows.append(MonthlySupplierRow(
                supplier_id=supplier_id,
                supplier_name=supplier_name,
                is_unmatched=is_unmatched,
                invoices_by_date=invoices_by_date,
                total_net_stock=supplier_week_total,
                percentage=round(percentage, 1)
            ))

        weeks_data.append(WeekData(
            week_start=current_week_start,
            week_end=week_end,
            dates=week_dates,
            suppliers=week_supplier_rows,
            daily_totals=dict(week_daily_totals),
            week_total=week_total
        ))

        current_week_start += timedelta(days=7)

    # Calculate daily totals for entire period
    period_daily_totals: dict[str, Decimal] = defaultdict(Decimal)
    for data in invoice_data.values():
        date_str = data["date"].isoformat()
        period_daily_totals[date_str] += data["net_stock"]

    return DateRangePurchasesResponse(
        from_date=from_date,
        to_date=to_date,
        period_label=period_label,
        weeks=weeks_data,
        all_suppliers=all_suppliers,
        daily_totals=dict(period_daily_totals),
        period_total=period_total
    )


class MonthlyGPResponse(BaseModel):
    """Response for monthly GP calculation"""
    year: int
    month: int
    month_name: str
    net_food_sales: Decimal       # Newbook revenue + manual entries
    net_food_purchases: Decimal   # Confirmed invoices net_total sum
    gross_profit: Decimal         # Sales - Purchases
    gross_profit_percent: Decimal # (GP / Sales) * 100


class SupplierBreakdown(BaseModel):
    """Supplier purchase breakdown for period"""
    supplier_id: int | None
    supplier_name: str
    net_purchases: Decimal
    percentage: Decimal


class GLAccountBreakdown(BaseModel):
    """GL account revenue breakdown for period"""
    gl_account_id: int
    gl_account_name: str
    net_revenue: Decimal
    percentage: Decimal


class DateRangeGPResponse(BaseModel):
    """Response for date range GP calculation"""
    from_date: date
    to_date: date
    period_label: str             # Human-readable label like "Dec 18 - Jan 17, 2026"
    net_food_sales: Decimal       # Newbook revenue + manual entries
    net_food_purchases: Decimal   # Confirmed invoices net_total sum
    gross_profit: Decimal         # Sales - Purchases
    gross_profit_percent: Decimal # (GP / Sales) * 100
    supplier_breakdown: list[SupplierBreakdown] = []
    gl_account_breakdown: list[GLAccountBreakdown] = []


@router.get("/gp/range", response_model=DateRangeGPResponse)
async def get_gp_by_range(
    from_date: date,
    to_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get GP calculation for a custom date range (inclusive)"""
    from models.line_item import LineItem
    from sqlalchemy import or_

    # Validate date range
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date must be before or equal to to_date")

    # Build period label
    if from_date.year == to_date.year:
        if from_date.month == to_date.month:
            period_label = f"{from_date.strftime('%b %d')} - {to_date.strftime('%d, %Y')}"
        else:
            period_label = f"{from_date.strftime('%b %d')} - {to_date.strftime('%b %d, %Y')}"
    else:
        period_label = f"{from_date.strftime('%b %d, %Y')} - {to_date.strftime('%b %d, %Y')}"

    # Get Newbook revenue for tracked GL accounts
    newbook_revenue_result = await db.execute(
        select(func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= from_date,
            NewbookDailyRevenue.date <= to_date,
            NewbookGLAccount.is_tracked == True
        )
    )
    newbook_revenue = newbook_revenue_result.scalar() or Decimal("0.00")

    # Get manual revenue entries for period
    manual_revenue_result = await db.execute(
        select(func.sum(RevenueEntry.amount))
        .where(
            RevenueEntry.kitchen_id == current_user.kitchen_id,
            RevenueEntry.date >= from_date,
            RevenueEntry.date <= to_date
        )
    )
    manual_revenue = manual_revenue_result.scalar() or Decimal("0.00")

    # Total net food sales
    net_food_sales = newbook_revenue + manual_revenue

    # Get net purchases from confirmed invoices - stock items only (exclude non-stock)
    purchases_result = await db.execute(
        select(func.sum(LineItem.amount))
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= from_date,
            Invoice.invoice_date <= to_date,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
    )
    net_food_purchases = purchases_result.scalar() or Decimal("0.00")

    # Calculate GP
    gross_profit = net_food_sales - net_food_purchases
    gross_profit_percent = (gross_profit / net_food_sales * 100) if net_food_sales > 0 else Decimal("0.00")

    # Get supplier breakdown for purchases
    from models.supplier import Supplier
    supplier_result = await db.execute(
        select(Invoice.supplier_id, Supplier.name, func.sum(LineItem.amount))
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .outerjoin(Supplier, Invoice.supplier_id == Supplier.id)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= from_date,
            Invoice.invoice_date <= to_date,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
        .group_by(Invoice.supplier_id, Supplier.name)
        .order_by(func.sum(LineItem.amount).desc())
    )
    supplier_rows = supplier_result.all()
    supplier_breakdown = []
    for supplier_id, supplier_name, total in supplier_rows:
        if total and total > 0:
            pct = (total / net_food_purchases * 100) if net_food_purchases > 0 else Decimal("0")
            supplier_breakdown.append(SupplierBreakdown(
                supplier_id=supplier_id,
                supplier_name=supplier_name or "Unmatched",
                net_purchases=total,
                percentage=round(pct, 1)
            ))

    # Get GL account breakdown for revenue
    gl_result = await db.execute(
        select(NewbookGLAccount.id, NewbookGLAccount.gl_name, func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= from_date,
            NewbookDailyRevenue.date <= to_date,
            NewbookGLAccount.is_tracked == True
        )
        .group_by(NewbookGLAccount.id, NewbookGLAccount.gl_name)
        .order_by(func.sum(NewbookDailyRevenue.amount_net).desc())
    )
    gl_rows = gl_result.all()
    gl_breakdown = []
    for gl_id, gl_name, total in gl_rows:
        if total:  # Include all non-zero values (including negative discounts)
            pct = (total / newbook_revenue * 100) if newbook_revenue > 0 else Decimal("0")
            gl_breakdown.append(GLAccountBreakdown(
                gl_account_id=gl_id,
                gl_account_name=gl_name or "Unknown",
                net_revenue=total,
                percentage=round(pct, 1)
            ))

    return DateRangeGPResponse(
        from_date=from_date,
        to_date=to_date,
        period_label=period_label,
        net_food_sales=net_food_sales,
        net_food_purchases=net_food_purchases,
        gross_profit=gross_profit,
        gross_profit_percent=round(gross_profit_percent, 1),
        supplier_breakdown=supplier_breakdown,
        gl_account_breakdown=gl_breakdown
    )


class DailyDataPoint(BaseModel):
    """Single day's data for charting"""
    date: date
    net_sales: Decimal
    net_purchases: Decimal
    occupancy: int | None = None  # Night total occupancy (from Newbook when available)
    lunch_covers: int | None = None  # Placeholder for resos integration
    dinner_covers: int | None = None  # Placeholder for resos integration
    total_covers: int | None = None  # Placeholder for resos integration


class DailyGPChartResponse(BaseModel):
    """Response for daily GP chart data"""
    from_date: date
    to_date: date
    data: list[DailyDataPoint]


@router.get("/gp/daily", response_model=DailyGPChartResponse)
async def get_daily_gp_data(
    from_date: date,
    to_date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get daily net sales and purchases for charting"""
    from models.line_item import LineItem
    from models.resos import ResosDailyStats, ResosBooking
    from sqlalchemy import or_, and_
    from datetime import timedelta

    # Validate date range
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date must be before or equal to to_date")

    # Get daily Newbook revenue (grouped by date)
    newbook_daily = await db.execute(
        select(NewbookDailyRevenue.date, func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= from_date,
            NewbookDailyRevenue.date <= to_date,
            NewbookGLAccount.is_tracked == True
        )
        .group_by(NewbookDailyRevenue.date)
    )
    newbook_by_date = {row[0]: row[1] or Decimal("0") for row in newbook_daily.all()}

    # Get daily manual revenue entries (grouped by date)
    manual_daily = await db.execute(
        select(RevenueEntry.date, func.sum(RevenueEntry.amount))
        .where(
            RevenueEntry.kitchen_id == current_user.kitchen_id,
            RevenueEntry.date >= from_date,
            RevenueEntry.date <= to_date
        )
        .group_by(RevenueEntry.date)
    )
    manual_by_date = {row[0]: row[1] or Decimal("0") for row in manual_daily.all()}

    # Get daily purchases from confirmed invoices (grouped by invoice_date)
    purchases_daily = await db.execute(
        select(Invoice.invoice_date, func.sum(LineItem.amount))
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= from_date,
            Invoice.invoice_date <= to_date,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
        .group_by(Invoice.invoice_date)
    )
    purchases_by_date = {row[0]: row[1] or Decimal("0") for row in purchases_daily.all()}

    # Get Resos booking data (covers by service period)
    resos_daily = await db.execute(
        select(ResosDailyStats)
        .where(
            and_(
                ResosDailyStats.kitchen_id == current_user.kitchen_id,
                ResosDailyStats.date >= from_date,
                ResosDailyStats.date <= to_date
            )
        )
    )
    resos_stats = {stat.date: stat for stat in resos_daily.scalars().all()}

    # Build daily data points for the entire range
    data_points = []
    current_date = from_date
    while current_date <= to_date:
        net_sales = (newbook_by_date.get(current_date, Decimal("0")) +
                     manual_by_date.get(current_date, Decimal("0")))
        net_purchases = purchases_by_date.get(current_date, Decimal("0"))

        # Extract Resos covers if available
        lunch_covers = None
        dinner_covers = None
        total_covers = None

        if current_date in resos_stats:
            stat = resos_stats[current_date]
            total_covers = stat.total_covers

            # Extract lunch and dinner covers from service_breakdown
            if stat.service_breakdown:
                for service in stat.service_breakdown:
                    period_name = service.get('period', '').lower()
                    covers = service.get('covers', 0)

                    if 'lunch' in period_name:
                        lunch_covers = covers
                    elif 'dinner' in period_name:
                        dinner_covers = covers

        data_points.append(DailyDataPoint(
            date=current_date,
            net_sales=net_sales,
            net_purchases=net_purchases,
            lunch_covers=lunch_covers,
            dinner_covers=dinner_covers,
            total_covers=total_covers
        ))
        current_date += timedelta(days=1)

    return DailyGPChartResponse(
        from_date=from_date,
        to_date=to_date,
        data=data_points
    )


@router.get("/gp/monthly", response_model=MonthlyGPResponse)
async def get_monthly_gp(
    year: int | None = None,
    month: int | None = None,  # 1-12
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get monthly GP calculation with sales and purchases breakdown"""
    from calendar import monthrange, month_name as calendar_month_name

    # Default to current month
    today = date.today()
    year = year or today.year
    month = month or today.month

    # Get first and last day of month
    _, days_in_month = monthrange(year, month)
    month_start = date(year, month, 1)
    month_end = date(year, month, days_in_month)

    # Get Newbook revenue for tracked GL accounts
    newbook_revenue_result = await db.execute(
        select(func.sum(NewbookDailyRevenue.amount_net))
        .join(NewbookGLAccount, NewbookDailyRevenue.gl_account_id == NewbookGLAccount.id)
        .where(
            NewbookDailyRevenue.kitchen_id == current_user.kitchen_id,
            NewbookDailyRevenue.date >= month_start,
            NewbookDailyRevenue.date <= month_end,
            NewbookGLAccount.is_tracked == True
        )
    )
    newbook_revenue = newbook_revenue_result.scalar() or Decimal("0.00")

    # Get manual revenue entries for period
    manual_revenue_result = await db.execute(
        select(func.sum(RevenueEntry.amount))
        .where(
            RevenueEntry.kitchen_id == current_user.kitchen_id,
            RevenueEntry.date >= month_start,
            RevenueEntry.date <= month_end
        )
    )
    manual_revenue = manual_revenue_result.scalar() or Decimal("0.00")

    # Total net food sales
    net_food_sales = newbook_revenue + manual_revenue

    # Get net purchases from confirmed invoices - stock items only (exclude non-stock)
    from models.line_item import LineItem
    from sqlalchemy import or_

    purchases_result = await db.execute(
        select(func.sum(LineItem.amount))
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= month_start,
            Invoice.invoice_date <= month_end,
            Invoice.status == InvoiceStatus.CONFIRMED,
            LineItem.amount.isnot(None),
            or_(LineItem.is_non_stock == False, LineItem.is_non_stock.is_(None))
        )
    )
    net_food_purchases = purchases_result.scalar() or Decimal("0.00")

    # Calculate GP
    gross_profit = net_food_sales - net_food_purchases
    gross_profit_percent = (gross_profit / net_food_sales * 100) if net_food_sales > 0 else Decimal("0.00")

    return MonthlyGPResponse(
        year=year,
        month=month,
        month_name=calendar_month_name[month],
        net_food_sales=net_food_sales,
        net_food_purchases=net_food_purchases,
        gross_profit=gross_profit,
        gross_profit_percent=round(gross_profit_percent, 1)
    )


# ============ Top Sellers Models ============

class TopSellerItem(BaseModel):
    """Individual top seller item"""
    item_name: str
    qty: int
    revenue: Decimal


class PackageFavoriteItem(BaseModel):
    """Package guest favorite item (qty only)"""
    item_name: str
    qty: int


class CategoryTopSellers(BaseModel):
    """Top sellers for a single category"""
    category: str  # "Starters", "Mains", "Desserts", etc.
    top_by_qty: list[TopSellerItem]  # Top 10 by quantity
    top_by_revenue: list[TopSellerItem]  # Top 10 by revenue


class TopSellersResponse(BaseModel):
    """Response for top sellers data"""
    from_date: date
    to_date: date
    source: str = "newbook"  # "sambapos" or "newbook"
    # SambaPOS category-based format
    categories: list[CategoryTopSellers] = []
    # Legacy Newbook format (flat lists)
    top_by_qty: list[TopSellerItem] = []
    top_by_revenue: list[TopSellerItem] = []
    package_favorites: list[PackageFavoriteItem] = []
    total_charges_processed: int = 0
    total_items_aggregated: int = 0


def parse_charge_description(description: str) -> tuple[int, str] | None:
    """
    Parse Newbook charge description to extract qty and item name.

    Format: "Ticket: 22900 - 1 x Venison Bourguignon"
    Returns: (qty, item_name) or None if cannot parse
    """
    import re

    if not description:
        return None

    # Try pattern: "Ticket: XXXXX - N x Item Name"
    # Also handle variations without ticket number
    patterns = [
        r'Ticket:\s*\d+\s*-\s*(\d+)\s*x\s*(.+)',  # Ticket: 22900 - 1 x Item
        r'^(\d+)\s*x\s*(.+)',  # 1 x Item (no ticket prefix)
        r'-\s*(\d+)\s*x\s*(.+)',  # - 1 x Item
    ]

    for pattern in patterns:
        match = re.search(pattern, description, re.IGNORECASE)
        if match:
            try:
                qty = int(match.group(1))
                item_name = match.group(2).strip()
                # Clean up item name - remove trailing punctuation and whitespace
                item_name = re.sub(r'[\s,;.]+$', '', item_name)
                if item_name and qty > 0:
                    return (qty, item_name)
            except (ValueError, IndexError):
                continue

    return None


@router.get("/gp/top-sellers", response_model=TopSellersResponse)
async def get_top_sellers(
    from_date: date,
    to_date: date,
    limit: int = 10,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get top selling items for a date range.

    If SambaPOS is configured, fetches data from SambaPOS database with category breakdowns.
    Otherwise falls back to Newbook charges with flat lists.

    Returns top 10 items by quantity and top 10 by revenue (per category for SambaPOS).
    """
    from models.settings import KitchenSettings
    from models.newbook import NewbookGLAccount
    from services.newbook_api import NewbookAPIClient, NewbookAPIError
    from services.sambapos_api import SambaPOSClient
    from collections import defaultdict
    import logging
    logger = logging.getLogger(__name__)

    # Validate date range
    if from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date must be before or equal to to_date")

    # Get settings
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=400, detail="Settings not configured")

    # Check if SambaPOS is configured - use it if available
    if all([
        settings.sambapos_db_host,
        settings.sambapos_db_name,
        settings.sambapos_db_username,
        settings.sambapos_db_password
    ]):
        # Use SambaPOS data source
        logger.info(f"Top sellers: Using SambaPOS data source for {from_date} to {to_date}")

        # Get tracked categories
        tracked_categories = []
        if settings.sambapos_tracked_categories:
            tracked_categories = [c.strip() for c in settings.sambapos_tracked_categories.split(',') if c.strip()]

        # Get excluded items
        excluded_items = []
        if settings.sambapos_excluded_items:
            excluded_items = [i.strip() for i in settings.sambapos_excluded_items.split('|') if i.strip()]

        if not tracked_categories:
            # Return empty response if no categories configured
            return TopSellersResponse(
                from_date=from_date,
                to_date=to_date,
                source="sambapos",
                categories=[]
            )

        try:
            client = SambaPOSClient(
                host=settings.sambapos_db_host,
                port=settings.sambapos_db_port or 1433,
                database=settings.sambapos_db_name,
                username=settings.sambapos_db_username,
                password=settings.sambapos_db_password
            )

            # Get top sellers by quantity and by revenue (excluding configured GroupCodes)
            top_by_qty = await client.get_top_sellers(from_date, to_date, tracked_categories, limit, excluded_categories=excluded_items if excluded_items else None)
            top_by_revenue = await client.get_top_sellers_by_revenue(from_date, to_date, tracked_categories, limit, excluded_categories=excluded_items if excluded_items else None)

            # Build category response in order of tracked_categories
            categories_response = []
            for cat_name in tracked_categories:
                qty_items = top_by_qty.get(cat_name, [])
                rev_items = top_by_revenue.get(cat_name, [])

                categories_response.append(CategoryTopSellers(
                    category=cat_name,
                    top_by_qty=[
                        TopSellerItem(item_name=item["item_name"], qty=item["qty"], revenue=item["revenue"])
                        for item in qty_items
                    ],
                    top_by_revenue=[
                        TopSellerItem(item_name=item["item_name"], qty=item["qty"], revenue=item["revenue"])
                        for item in rev_items
                    ]
                ))

            return TopSellersResponse(
                from_date=from_date,
                to_date=to_date,
                source="sambapos",
                categories=categories_response
            )

        except Exception as e:
            logger.error(f"SambaPOS top sellers failed: {e}")
            raise HTTPException(status_code=400, detail=f"SambaPOS query failed: {str(e)}")

    # Fallback to Newbook if SambaPOS not configured
    if not settings.newbook_api_username:
        raise HTTPException(status_code=400, detail="Neither SambaPOS nor Newbook credentials configured")

    # Get tracked GL accounts for this kitchen (food sales accounts)
    gl_result = await db.execute(
        select(NewbookGLAccount).where(
            NewbookGLAccount.kitchen_id == current_user.kitchen_id,
            NewbookGLAccount.is_tracked == True
        )
    )
    tracked_accounts = gl_result.scalars().all()

    if not tracked_accounts:
        return TopSellersResponse(
            from_date=from_date,
            to_date=to_date,
            top_by_qty=[],
            top_by_revenue=[],
            total_charges_processed=0,
            total_items_aggregated=0
        )

    # Build set of tracked GL account IDs (as strings)
    tracked_gl_ids = {acc.gl_account_id for acc in tracked_accounts}

    # Fetch charges from Newbook
    try:
        async with NewbookAPIClient(
            username=settings.newbook_api_username,
            password=settings.newbook_api_password,
            api_key=settings.newbook_api_key,
            region=settings.newbook_api_region or "au",
            instance_id=settings.newbook_instance_id
        ) as client:
            charges = await client.get_charges_list(from_date, to_date)
    except NewbookAPIError as e:
        raise HTTPException(status_code=400, detail=f"Newbook API error: {e.message}")

    # Aggregate items - separate tracking for regular vs package/supplement
    import re
    import logging
    logger = logging.getLogger(__name__)

    regular_items: dict[str, dict] = defaultdict(lambda: {"qty": 0, "revenue": Decimal("0")})
    package_items: dict[str, int] = defaultdict(int)  # qty only for package/supplement
    total_processed = 0
    total_voided = 0
    total_wrong_gl = 0
    total_unparsed = 0
    sample_unparsed = []
    sample_charges = []

    logger.info(f"Top sellers: Starting with {len(charges)} total charges, {len(tracked_gl_ids)} tracked GL IDs: {tracked_gl_ids}")

    for charge in charges:
        # Log first few charges to see structure
        if len(sample_charges) < 5:
            sample_charges.append({
                "gl_account_id": charge.get("gl_account_id"),
                "description": charge.get("description"),
                "voided_when": charge.get("voided_when"),
                "voided_by": charge.get("voided_by"),
            })

        # Skip voided charges
        voided_when = charge.get("voided_when")
        voided_by = charge.get("voided_by", "0")

        # Check if voided - voided_when can be None, empty string, or actual date
        # voided_by is "0" when not voided
        if voided_when or (voided_by and voided_by != "0"):
            total_voided += 1
            continue

        # Filter to tracked GL accounts only
        gl_account_id = charge.get("gl_account_id", "")
        if gl_account_id not in tracked_gl_ids:
            total_wrong_gl += 1
            continue

        total_processed += 1

        # Parse description to get qty and item name
        description = charge.get("description", "")
        parsed = parse_charge_description(description)

        if parsed:
            qty, item_name = parsed
            amount = charge.get("amount_ex_tax", Decimal("0"))

            # Check for [Package] or [Supplement] suffix
            is_package = bool(re.search(r'\[(package|supplement)\]', item_name, re.IGNORECASE))

            # Strip [Package] or [Supplement] suffix
            item_name = re.sub(r'\s*\[(package|supplement)\]\s*', '', item_name, flags=re.IGNORECASE)

            # Normalize item name: lowercase, remove extra spaces
            item_name = " ".join(item_name.lower().split())

            if is_package:
                # Track package items separately (qty only)
                package_items[item_name] += qty
            else:
                # Regular item - track qty and revenue
                regular_items[item_name]["qty"] += qty
                regular_items[item_name]["revenue"] += amount
        else:
            total_unparsed += 1
            if len(sample_unparsed) < 10:
                sample_unparsed.append(description)

    # Calculate average prices from regular sales
    avg_prices: dict[str, Decimal] = {}
    for name, data in regular_items.items():
        if data["qty"] > 0:
            avg_prices[name] = data["revenue"] / data["qty"]

    # Combine regular + package for main top sellers
    # For package items, use average price from regular sales if available
    all_item_names = set(regular_items.keys()) | set(package_items.keys())
    combined_items: dict[str, dict] = {}

    for name in all_item_names:
        reg_qty = regular_items.get(name, {}).get("qty", 0)
        pkg_qty = package_items.get(name, 0)
        total_qty = reg_qty + pkg_qty

        # Revenue: regular revenue + (package qty * avg price if available)
        reg_revenue = regular_items.get(name, {}).get("revenue", Decimal("0"))
        if name in avg_prices and pkg_qty > 0:
            estimated_pkg_revenue = avg_prices[name] * pkg_qty
            total_revenue = reg_revenue + estimated_pkg_revenue
        else:
            total_revenue = reg_revenue

        combined_items[name] = {"qty": total_qty, "revenue": total_revenue}

    logger.info(f"Top sellers: processed {total_processed} charges, {len(regular_items)} regular items, {len(package_items)} package items, {len(combined_items)} combined")

    # Sort and get top items from combined
    items_list = [
        {"name": name, "qty": data["qty"], "revenue": data["revenue"]}
        for name, data in combined_items.items()
    ]

    # Top by quantity
    top_by_qty = sorted(items_list, key=lambda x: x["qty"], reverse=True)[:limit]

    # Top by revenue
    top_by_revenue = sorted(items_list, key=lambda x: x["revenue"], reverse=True)[:limit]

    # Package favorites (qty only, from package_items)
    package_favorites_list = sorted(
        [{"name": name, "qty": qty} for name, qty in package_items.items()],
        key=lambda x: x["qty"],
        reverse=True
    )[:limit]

    # Title case helper for display
    def title_case(s: str) -> str:
        return " ".join(word.capitalize() for word in s.split())

    return TopSellersResponse(
        from_date=from_date,
        to_date=to_date,
        source="newbook",
        top_by_qty=[
            TopSellerItem(item_name=title_case(item["name"]), qty=item["qty"], revenue=item["revenue"])
            for item in top_by_qty
        ],
        top_by_revenue=[
            TopSellerItem(item_name=title_case(item["name"]), qty=item["qty"], revenue=item["revenue"])
            for item in top_by_revenue
        ],
        package_favorites=[
            PackageFavoriteItem(item_name=title_case(item["name"]), qty=item["qty"])
            for item in package_favorites_list
        ],
        total_charges_processed=total_processed,
        total_items_aggregated=len(combined_items)
    )
