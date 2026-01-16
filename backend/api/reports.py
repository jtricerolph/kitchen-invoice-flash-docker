from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.gp import RevenueEntry, GPPeriod
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
    # Get total revenue for period
    revenue_result = await db.execute(
        select(func.sum(RevenueEntry.amount))
        .where(
            RevenueEntry.kitchen_id == current_user.kitchen_id,
            RevenueEntry.date >= request.start_date,
            RevenueEntry.date <= request.end_date
        )
    )
    total_revenue = revenue_result.scalar() or Decimal("0.00")

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
        category_breakdown=category_breakdown
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
        # Revenue
        rev_result = await db.execute(
            select(func.sum(RevenueEntry.amount))
            .where(
                RevenueEntry.kitchen_id == current_user.kitchen_id,
                RevenueEntry.date >= start,
                RevenueEntry.date <= end
            )
        )
        revenue = rev_result.scalar() or Decimal("0.00")

        # Costs
        cost_result = await db.execute(
            select(func.sum(Invoice.total))
            .where(
                Invoice.kitchen_id == current_user.kitchen_id,
                Invoice.invoice_date >= start,
                Invoice.invoice_date <= end,
                Invoice.status == InvoiceStatus.CONFIRMED,
                Invoice.total.isnot(None)
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
            category_breakdown={}
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
    result = await db.execute(
        select(Invoice)
        .where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.invoice_date >= week_start,
            Invoice.invoice_date <= week_end,
            Invoice.invoice_date.isnot(None)
        )
        .order_by(Invoice.invoice_date)
    )
    invoices = result.scalars().all()

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
            date_str = inv.invoice_date.isoformat()
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
            if inv.invoice_date and inv.invoice_date.isoformat() == date_str
        )

    return WeeklyPurchasesResponse(
        week_start=week_start,
        week_end=week_end,
        dates=dates,
        suppliers=supplier_rows,
        daily_totals=daily_totals,
        week_total=week_total
    )
