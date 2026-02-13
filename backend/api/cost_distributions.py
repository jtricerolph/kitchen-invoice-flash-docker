"""
Cost Distribution API endpoints — create, view, settle early, cancel,
and weekly summaries for budget page integration.
"""
import logging
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, delete
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, field_serializer

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.line_item import LineItem
from models.supplier import Supplier
from models.settings import KitchenSettings
from models.cost_distribution import (
    CostDistribution,
    CostDistributionLineSelection,
    CostDistributionEntry,
    DistributionStatus,
    DistributionMethod,
)
from auth.jwt import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class LineSelectionIn(BaseModel):
    line_item_id: int
    selected_quantity: Decimal


class CostDistributionCreate(BaseModel):
    invoice_id: int
    method: str  # "OFFSET" or "DISTRIBUTE"
    notes: Optional[str] = None
    line_selections: list[LineSelectionIn]
    # For OFFSET
    target_date: Optional[date] = None
    # For DISTRIBUTE
    days_of_week: Optional[list[int]] = None  # 0=Mon, 6=Sun (Python weekday())
    num_weeks: Optional[int] = None
    start_date: Optional[date] = None


class CostDistributionUpdate(BaseModel):
    notes: Optional[str] = None


class SettleEarlyRequest(BaseModel):
    entry_date: date
    amount: Optional[Decimal] = None  # null = settle all


# ── Response schemas ──────────────────────────────────────────────────────────

class LineSelectionOut(BaseModel):
    id: int
    line_item_id: int
    description: Optional[str] = None
    original_quantity: Optional[Decimal] = None
    selected_quantity: Decimal
    unit_price: Decimal
    distributed_value: Decimal

    @field_serializer('selected_quantity', 'unit_price', 'distributed_value', 'original_quantity')
    def ser(self, v: Optional[Decimal]) -> Optional[float]:
        return float(v) if v is not None else None


class EntryOut(BaseModel):
    id: int
    entry_date: date
    amount: Decimal
    is_source_offset: bool
    is_overpay: bool

    @field_serializer('amount')
    def ser_amount(self, v: Decimal) -> float:
        return float(v)


class CostDistributionOut(BaseModel):
    id: int
    invoice_id: int
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    supplier_name: Optional[str] = None
    status: str
    method: str
    notes: Optional[str]
    total_distributed_value: Decimal
    remaining_balance: Decimal
    source_date: date
    created_by_name: Optional[str] = None
    created_at: str
    line_selections: list[LineSelectionOut] = []
    entries: list[EntryOut] = []

    @field_serializer('total_distributed_value', 'remaining_balance')
    def ser_dec(self, v: Decimal) -> float:
        return float(v)


class LineItemAvailability(BaseModel):
    id: int
    description: Optional[str]
    unit: Optional[str]
    quantity: Optional[Decimal]
    unit_price: Optional[Decimal]
    amount: Optional[Decimal]
    is_non_stock: bool
    already_distributed_qty: Decimal
    available_qty: Decimal

    @field_serializer('quantity', 'unit_price', 'amount', 'already_distributed_qty', 'available_qty')
    def ser(self, v: Optional[Decimal]) -> Optional[float]:
        return float(v) if v is not None else None


class InvoiceAvailabilityOut(BaseModel):
    invoice_id: int
    invoice_number: Optional[str]
    invoice_date: Optional[date]
    supplier_name: Optional[str]
    line_items: list[LineItemAvailability] = []


class WeeklyDistributionRow(BaseModel):
    distribution_id: int
    title: str  # Compact: "dd/mm/yy - Supplier"
    supplier_name: Optional[str] = None
    invoice_number: Optional[str] = None
    source_date_str: str = ""  # dd/mm/yy
    summary: str = ""  # e.g. "£200 laid away to 28/02/26" or "£200 distributed over 4 weeks"
    notes: Optional[str] = None
    invoice_id: int
    entries_by_date: dict[str, float]
    total_distributed_value: float
    remaining_balance: float
    bf_balance: float  # Outstanding at start of this week
    cf_balance: float  # Outstanding at end of this week
    status: str


class WeeklyDistributionsOut(BaseModel):
    week_start: date
    week_end: date
    distributions: list[WeeklyDistributionRow] = []
    daily_totals: dict[str, float] = {}
    bf_balance: float
    cf_balance: float
    week_total: float


# ── Helper functions ──────────────────────────────────────────────────────────

def _generate_target_dates(
    method: str,
    target_date: Optional[date],
    days_of_week: Optional[list[int]],
    num_weeks: Optional[int],
    start_date: Optional[date],
) -> list[date]:
    """Generate target dates based on distribution method."""
    if method == DistributionMethod.OFFSET.value:
        if not target_date:
            raise HTTPException(400, "target_date required for OFFSET method")
        return [target_date]

    if method == DistributionMethod.DISTRIBUTE.value:
        if not days_of_week or not num_weeks or not start_date:
            raise HTTPException(400, "days_of_week, num_weeks, and start_date required for DISTRIBUTE method")
        if not days_of_week:
            raise HTTPException(400, "At least one day of week must be selected")
        if num_weeks < 1:
            raise HTTPException(400, "num_weeks must be at least 1")

        dates = []
        for week in range(num_weeks):
            week_start = start_date + timedelta(weeks=week)
            for day_offset in range(7):
                d = week_start + timedelta(days=day_offset)
                if d.weekday() in days_of_week:
                    dates.append(d)

        # Deduplicate and sort (in case start_date is mid-week)
        dates = sorted(set(dates))
        if not dates:
            raise HTTPException(400, "No target dates generated from the selected days and weeks")
        return dates

    raise HTTPException(400, f"Invalid method: {method}")


def _distribute_amount(total: Decimal, count: int) -> list[Decimal]:
    """Distribute a total amount evenly across count entries. Last entry absorbs rounding."""
    if count == 0:
        return []
    per_entry = (total / count).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    amounts = [per_entry] * count
    # Adjust last entry to absorb rounding difference
    distributed_sum = per_entry * (count - 1)
    amounts[-1] = total - distributed_sum
    return amounts


async def _get_already_distributed_qty(
    db: AsyncSession, line_item_id: int, exclude_distribution_id: Optional[int] = None
) -> Decimal:
    """Get total quantity already distributed for a line item from ACTIVE distributions."""
    query = (
        select(func.coalesce(func.sum(CostDistributionLineSelection.selected_quantity), 0))
        .join(CostDistribution, CostDistributionLineSelection.distribution_id == CostDistribution.id)
        .where(
            CostDistributionLineSelection.line_item_id == line_item_id,
            CostDistribution.status == DistributionStatus.ACTIVE.value,
        )
    )
    if exclude_distribution_id:
        query = query.where(CostDistribution.id != exclude_distribution_id)
    result = await db.execute(query)
    return Decimal(str(result.scalar() or 0))


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/invoice/{invoice_id}/availability", response_model=InvoiceAvailabilityOut)
async def get_invoice_availability(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get line items available for distribution from an invoice."""
    invoice = await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.line_items))
        .where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id,
        )
    )
    invoice = invoice.scalar_one_or_none()
    if not invoice:
        raise HTTPException(404, "Invoice not found")
    if invoice.status != InvoiceStatus.CONFIRMED:
        raise HTTPException(400, "Only CONFIRMED invoices can be distributed")
    if invoice.document_type == "credit_note":
        raise HTTPException(400, "Credit notes cannot be distributed")

    supplier_name = None
    if invoice.supplier_id:
        supplier = await db.execute(
            select(Supplier).where(Supplier.id == invoice.supplier_id)
        )
        supplier = supplier.scalar_one_or_none()
        if supplier:
            supplier_name = supplier.name

    items = []
    for li in invoice.line_items:
        already = await _get_already_distributed_qty(db, li.id)
        original_qty = li.quantity or Decimal("0")
        available = max(Decimal("0"), original_qty - already)
        items.append(LineItemAvailability(
            id=li.id,
            description=li.description,
            unit=li.unit,
            quantity=li.quantity,
            unit_price=li.unit_price,
            amount=li.amount,
            is_non_stock=li.is_non_stock or False,
            already_distributed_qty=already,
            available_qty=available,
        ))

    return InvoiceAvailabilityOut(
        invoice_id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        supplier_name=supplier_name or invoice.vendor_name,
        line_items=items,
    )


@router.post("/", response_model=CostDistributionOut)
async def create_cost_distribution(
    data: CostDistributionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new cost distribution."""
    # Validate invoice
    invoice = await db.execute(
        select(Invoice)
        .options(selectinload(Invoice.line_items))
        .where(
            Invoice.id == data.invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id,
        )
    )
    invoice = invoice.scalar_one_or_none()
    if not invoice:
        raise HTTPException(404, "Invoice not found")
    if invoice.status != InvoiceStatus.CONFIRMED:
        raise HTTPException(400, "Only CONFIRMED invoices can be distributed")
    if invoice.document_type == "credit_note":
        raise HTTPException(400, "Credit notes cannot be distributed")
    if not invoice.invoice_date:
        raise HTTPException(400, "Invoice must have a date to be distributed")

    # Validate method
    if data.method not in [m.value for m in DistributionMethod]:
        raise HTTPException(400, f"Invalid method: {data.method}")

    # Get settings for max_days validation
    settings = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = settings.scalar_one_or_none()
    max_days = settings.cost_distribution_max_days if settings else 90

    # Generate target dates
    target_dates = _generate_target_dates(
        data.method, data.target_date, data.days_of_week, data.num_weeks, data.start_date
    )

    # Validate max days
    today = date.today()
    max_allowed_date = today + timedelta(days=max_days)
    for td in target_dates:
        if td > max_allowed_date:
            raise HTTPException(
                400,
                f"Target date {td} exceeds maximum of {max_days} days into the future ({max_allowed_date})"
            )

    # Build line item map
    line_item_map = {li.id: li for li in invoice.line_items}

    # Validate line selections and calculate totals
    if not data.line_selections:
        raise HTTPException(400, "At least one line item must be selected")

    total_distributed_value = Decimal("0")
    selections_data = []

    for sel in data.line_selections:
        li = line_item_map.get(sel.line_item_id)
        if not li:
            raise HTTPException(400, f"Line item {sel.line_item_id} not found on invoice")
        if li.is_non_stock:
            raise HTTPException(400, f"Non-stock item '{li.description}' cannot be distributed")
        if sel.selected_quantity <= 0:
            raise HTTPException(400, "Selected quantity must be greater than 0")

        # Check available quantity
        already = await _get_already_distributed_qty(db, li.id)
        original_qty = li.quantity or Decimal("0")
        available = original_qty - already
        if sel.selected_quantity > available:
            raise HTTPException(
                400,
                f"Requested qty {sel.selected_quantity} exceeds available {available} for '{li.description}'"
            )

        unit_price = li.unit_price or Decimal("0")
        distributed_value = (sel.selected_quantity * unit_price).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        total_distributed_value += distributed_value
        selections_data.append({
            "line_item_id": li.id,
            "selected_quantity": sel.selected_quantity,
            "unit_price": unit_price,
            "distributed_value": distributed_value,
        })

    if total_distributed_value <= 0:
        raise HTTPException(400, "Total distributed value must be greater than 0")

    # Create the distribution header
    distribution = CostDistribution(
        kitchen_id=current_user.kitchen_id,
        invoice_id=invoice.id,
        status=DistributionStatus.ACTIVE.value,
        method=data.method,
        notes=data.notes,
        total_distributed_value=total_distributed_value,
        remaining_balance=total_distributed_value,
        source_date=invoice.invoice_date,
        created_by=current_user.id,
    )
    db.add(distribution)
    await db.flush()  # Get the distribution ID

    # Create line selections
    for sel_data in selections_data:
        selection = CostDistributionLineSelection(
            distribution_id=distribution.id,
            **sel_data,
        )
        db.add(selection)

    # Create source offset entry (negative on invoice date)
    source_entry = CostDistributionEntry(
        distribution_id=distribution.id,
        kitchen_id=current_user.kitchen_id,
        entry_date=invoice.invoice_date,
        amount=-total_distributed_value,
        is_source_offset=True,
        is_overpay=False,
    )
    db.add(source_entry)

    # Create target entries
    entry_amounts = _distribute_amount(total_distributed_value, len(target_dates))
    for td, amt in zip(target_dates, entry_amounts):
        entry = CostDistributionEntry(
            distribution_id=distribution.id,
            kitchen_id=current_user.kitchen_id,
            entry_date=td,
            amount=amt,
            is_source_offset=False,
            is_overpay=False,
        )
        db.add(entry)

    await db.commit()
    await db.refresh(distribution)

    return await _build_distribution_response(db, distribution)


@router.get("/weekly", response_model=WeeklyDistributionsOut)
async def get_weekly_distributions(
    week_start: date,
    week_end: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get all cost distributions relevant to a week view for the budget page."""
    kitchen_id = current_user.kitchen_id

    # Get ALL active distributions (even if no entries this week) to prevent gaming
    # Also include COMPLETED distributions that have entries in this week period
    active_dists = await db.execute(
        select(CostDistribution)
        .options(
            selectinload(CostDistribution.entries),
            selectinload(CostDistribution.invoice),
        )
        .where(
            CostDistribution.kitchen_id == kitchen_id,
            CostDistribution.status == DistributionStatus.ACTIVE.value,
        )
        .order_by(CostDistribution.id)
    )
    active_dists = active_dists.scalars().all()

    # Completed distributions that have entries within the viewed week
    completed_dists = await db.execute(
        select(CostDistribution)
        .options(
            selectinload(CostDistribution.entries),
            selectinload(CostDistribution.invoice),
        )
        .where(
            CostDistribution.kitchen_id == kitchen_id,
            CostDistribution.status == DistributionStatus.COMPLETED.value,
            CostDistribution.id.in_(
                select(CostDistributionEntry.distribution_id)
                .where(
                    CostDistributionEntry.kitchen_id == kitchen_id,
                    CostDistributionEntry.entry_date >= week_start,
                    CostDistributionEntry.entry_date <= week_end,
                )
            ),
        )
        .order_by(CostDistribution.id)
    )
    completed_dists = completed_dists.scalars().all()

    # Merge — active first, then completed with entries in period
    seen_ids = {d.id for d in active_dists}
    distributions = list(active_dists)
    for d in completed_dists:
        if d.id not in seen_ids:
            distributions.append(d)

    rows = []
    daily_totals: dict[str, Decimal] = defaultdict(Decimal)
    bf_balance = Decimal("0")
    week_total = Decimal("0")

    for dist in distributions:
        # Get supplier name
        supplier_name = None
        if dist.invoice:
            if dist.invoice.supplier_id:
                supplier = await db.execute(
                    select(Supplier).where(Supplier.id == dist.invoice.supplier_id)
                )
                supplier = supplier.scalar_one_or_none()
                if supplier:
                    supplier_name = supplier.name
            if not supplier_name:
                supplier_name = dist.invoice.vendor_name

        invoice_num = dist.invoice.invoice_number if dist.invoice else None
        source_date_short = dist.source_date.strftime("%d/%m/%y") if dist.source_date else ""
        title = f"{source_date_short} - {supplier_name or 'Unknown'}"

        # Build summary text
        total_val = f"£{float(dist.total_distributed_value):.2f}"
        target_entries = [e for e in dist.entries if not e.is_source_offset and not e.is_overpay]
        if dist.method == "OFFSET" and target_entries:
            target_date = target_entries[0].entry_date.strftime("%d/%m/%y")
            summary = f"{total_val} laid away to {target_date}"
        elif target_entries:
            # DISTRIBUTE: count unique days of week and number of weeks
            target_dates = sorted(set(e.entry_date for e in target_entries))
            if len(target_dates) > 1:
                first, last = target_dates[0], target_dates[-1]
                num_weeks = max(1, ((last - first).days // 7) + 1)
                dow_set = set(d.strftime("%a") for d in target_dates)
                days_str = ",".join(sorted(dow_set, key=lambda x: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].index(x)))
                summary = f"{total_val} distributed {days_str} over {num_weeks} weeks"
            else:
                summary = f"{total_val} distributed to {target_dates[0].strftime('%d/%m/%y')}"
        else:
            summary = f"{total_val} distributed"

        # Get entries for this week (including source offset so user sees the deduction)
        entries_by_date: dict[str, float] = {}
        for entry in dist.entries:
            if week_start <= entry.entry_date <= week_end:
                date_key = entry.entry_date.isoformat()
                entries_by_date[date_key] = entries_by_date.get(date_key, 0) + float(entry.amount)
                daily_totals[date_key] += entry.amount
                week_total += entry.amount

        # Per-distribution BF/CF as net running balance:
        # BF = sum of ALL entries (including source offset) before this week
        # CF = BF + sum of ALL entries within this week
        # e.g. new distribution: BF=0, source deducts -£200, CF=-£200
        # next week: BF=-£200, positives bring it toward 0
        dist_bf = sum(
            e.amount for e in dist.entries
            if e.entry_date < week_start
        )
        entries_this_week = sum(
            e.amount for e in dist.entries
            if week_start <= e.entry_date <= week_end
        )
        dist_cf = dist_bf + entries_this_week

        # Only include distributions that are relevant to this period:
        # has a non-zero BF or CF, or has entries in this week
        if dist_bf == 0 and dist_cf == 0 and not entries_by_date:
            continue

        bf_balance += dist_bf

        rows.append(WeeklyDistributionRow(
            distribution_id=dist.id,
            title=title,
            supplier_name=supplier_name,
            invoice_number=invoice_num,
            source_date_str=source_date_short,
            summary=summary,
            notes=dist.notes,
            invoice_id=dist.invoice_id,
            entries_by_date=entries_by_date,
            total_distributed_value=float(dist.total_distributed_value),
            remaining_balance=float(dist.remaining_balance),
            bf_balance=float(dist_bf),
            cf_balance=float(dist_cf),
            status=dist.status,
        ))

    cf_balance = bf_balance + week_total

    return WeeklyDistributionsOut(
        week_start=week_start,
        week_end=week_end,
        distributions=rows,
        daily_totals={k: float(v) for k, v in daily_totals.items()},
        bf_balance=float(bf_balance),
        cf_balance=float(cf_balance),
        week_total=float(week_total),
    )


@router.get("/{distribution_id}", response_model=CostDistributionOut)
async def get_cost_distribution(
    distribution_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a single cost distribution with line selections and entries."""
    distribution = await db.execute(
        select(CostDistribution)
        .options(
            selectinload(CostDistribution.line_selections).selectinload(CostDistributionLineSelection.line_item),
            selectinload(CostDistribution.entries),
        )
        .where(
            CostDistribution.id == distribution_id,
            CostDistribution.kitchen_id == current_user.kitchen_id,
        )
    )
    distribution = distribution.scalar_one_or_none()
    if not distribution:
        raise HTTPException(404, "Cost distribution not found")

    return await _build_distribution_response(db, distribution)


@router.put("/{distribution_id}", response_model=CostDistributionOut)
async def update_cost_distribution(
    distribution_id: int,
    data: CostDistributionUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update notes on an existing distribution."""
    distribution = await db.execute(
        select(CostDistribution)
        .options(
            selectinload(CostDistribution.line_selections).selectinload(CostDistributionLineSelection.line_item),
            selectinload(CostDistribution.entries),
        )
        .where(
            CostDistribution.id == distribution_id,
            CostDistribution.kitchen_id == current_user.kitchen_id,
        )
    )
    distribution = distribution.scalar_one_or_none()
    if not distribution:
        raise HTTPException(404, "Cost distribution not found")
    if distribution.status != DistributionStatus.ACTIVE.value:
        raise HTTPException(400, "Can only update ACTIVE distributions")

    if data.notes is not None:
        distribution.notes = data.notes

    await db.commit()
    await db.refresh(distribution)

    return await _build_distribution_response(db, distribution)


@router.delete("/{distribution_id}")
async def cancel_cost_distribution(
    distribution_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a cost distribution. Non-admin restricted to distributions
    where the source (invoice) date is within 14 days."""
    distribution = await db.execute(
        select(CostDistribution).where(
            CostDistribution.id == distribution_id,
            CostDistribution.kitchen_id == current_user.kitchen_id,
        )
    )
    distribution = distribution.scalar_one_or_none()
    if not distribution:
        raise HTTPException(404, "Cost distribution not found")
    if distribution.status == DistributionStatus.CANCELLED.value:
        raise HTTPException(400, "Distribution is already cancelled")

    # Anti-gaming: non-admin cannot cancel distributions where the source
    # date is more than 14 days in the past (cost would silently revert to
    # the old invoice date and could be overlooked)
    if not current_user.is_admin:
        min_allowed_date = date.today() - timedelta(days=14)
        if distribution.source_date < min_allowed_date:
            raise HTTPException(
                400,
                f"Cannot cancel — invoice date {distribution.source_date} is more than 14 days ago. Ask an admin."
            )

    from datetime import datetime
    distribution.status = DistributionStatus.CANCELLED.value
    distribution.cancelled_by = current_user.id
    distribution.cancelled_at = datetime.utcnow()

    await db.commit()
    return {"message": "Cost distribution cancelled", "id": distribution_id}


@router.post("/{distribution_id}/settle-early", response_model=CostDistributionOut)
async def settle_early(
    distribution_id: int,
    data: SettleEarlyRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Settle a distribution early by moving remaining balance to a chosen date."""
    distribution = await db.execute(
        select(CostDistribution)
        .options(
            selectinload(CostDistribution.line_selections).selectinload(CostDistributionLineSelection.line_item),
            selectinload(CostDistribution.entries),
        )
        .where(
            CostDistribution.id == distribution_id,
            CostDistribution.kitchen_id == current_user.kitchen_id,
        )
    )
    distribution = distribution.scalar_one_or_none()
    if not distribution:
        raise HTTPException(404, "Cost distribution not found")
    if distribution.status != DistributionStatus.ACTIVE.value:
        raise HTTPException(400, "Can only settle ACTIVE distributions")

    today = date.today()

    # Anti-gaming: non-admin cannot settle more than 14 days in the past
    if not current_user.is_admin:
        min_allowed_date = today - timedelta(days=14)
        if data.entry_date < min_allowed_date:
            raise HTTPException(
                400,
                f"Cannot settle more than 14 days in the past. Earliest allowed: {min_allowed_date}"
            )

    # Calculate entries from the settle date onwards — these get replaced by the single
    # settle entry. Using entry_date (not today) so that settling for yesterday correctly
    # consolidates yesterday's entry + all future entries into the chosen date.
    settable_entries = [
        e for e in distribution.entries
        if not e.is_source_offset and not e.is_overpay and e.entry_date >= data.entry_date
    ]
    settable_total = sum(e.amount for e in settable_entries)

    if settable_total <= 0:
        raise HTTPException(400, "No entries to settle from the chosen date onwards")

    settle_amount = data.amount if data.amount is not None else settable_total
    if settle_amount <= 0:
        raise HTTPException(400, "Settle amount must be greater than 0")
    if settle_amount > settable_total:
        raise HTTPException(400, f"Settle amount {settle_amount} exceeds settable entries total {settable_total}")

    # Delete all entries from the settle date onwards
    for entry in settable_entries:
        await db.delete(entry)

    # Create settle entry on the chosen date
    overpay_entry = CostDistributionEntry(
        distribution_id=distribution.id,
        kitchen_id=current_user.kitchen_id,
        entry_date=data.entry_date,
        amount=settle_amount,
        is_source_offset=False,
        is_overpay=True,
    )
    db.add(overpay_entry)

    # Update remaining_balance: what's left unaccounted
    new_remaining = settable_total - settle_amount
    distribution.remaining_balance = new_remaining

    # If fully settled, mark as completed
    if new_remaining <= 0:
        distribution.status = DistributionStatus.COMPLETED.value
        distribution.remaining_balance = Decimal("0")

    await db.commit()
    await db.refresh(distribution)

    return await _build_distribution_response(db, distribution)


# ── Response builder helper ───────────────────────────────────────────────────

async def _build_distribution_response(
    db: AsyncSession, distribution: CostDistribution
) -> CostDistributionOut:
    """Build the full response object for a cost distribution."""
    # Get invoice info
    invoice = await db.execute(
        select(Invoice).where(Invoice.id == distribution.invoice_id)
    )
    invoice = invoice.scalar_one_or_none()

    supplier_name = None
    if invoice and invoice.supplier_id:
        supplier = await db.execute(
            select(Supplier).where(Supplier.id == invoice.supplier_id)
        )
        supplier = supplier.scalar_one_or_none()
        if supplier:
            supplier_name = supplier.name
    if not supplier_name and invoice:
        supplier_name = invoice.vendor_name

    # Get creator name
    creator = await db.execute(
        select(User).where(User.id == distribution.created_by)
    )
    creator = creator.scalar_one_or_none()

    # Build line selections with line item details
    line_selections = []
    for sel in distribution.line_selections:
        li = sel.line_item if hasattr(sel, 'line_item') and sel.line_item else None
        if not li:
            li_result = await db.execute(select(LineItem).where(LineItem.id == sel.line_item_id))
            li = li_result.scalar_one_or_none()

        line_selections.append(LineSelectionOut(
            id=sel.id,
            line_item_id=sel.line_item_id,
            description=li.description if li else None,
            original_quantity=li.quantity if li else None,
            selected_quantity=sel.selected_quantity,
            unit_price=sel.unit_price,
            distributed_value=sel.distributed_value,
        ))

    entries = [
        EntryOut(
            id=e.id,
            entry_date=e.entry_date,
            amount=e.amount,
            is_source_offset=e.is_source_offset,
            is_overpay=e.is_overpay,
        )
        for e in distribution.entries
    ]

    return CostDistributionOut(
        id=distribution.id,
        invoice_id=distribution.invoice_id,
        invoice_number=invoice.invoice_number if invoice else None,
        invoice_date=invoice.invoice_date if invoice else None,
        supplier_name=supplier_name,
        status=distribution.status,
        method=distribution.method,
        notes=distribution.notes,
        total_distributed_value=distribution.total_distributed_value,
        remaining_balance=distribution.remaining_balance,
        source_date=distribution.source_date,
        created_by_name=creator.name if creator else None,
        created_at=distribution.created_at.isoformat() if distribution.created_at else "",
        line_selections=line_selections,
        entries=entries,
    )
