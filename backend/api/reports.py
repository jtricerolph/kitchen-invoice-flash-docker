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
