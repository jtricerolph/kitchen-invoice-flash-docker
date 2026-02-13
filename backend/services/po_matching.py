"""
Purchase Order matching service — finds pending POs for an invoice,
scores match confidence, and handles link/unlink operations.
"""
from datetime import timedelta
from decimal import Decimal
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from models.purchase_order import PurchaseOrder
from models.invoice import Invoice


async def find_matching_pos(
    db: AsyncSession,
    kitchen_id: int,
    supplier_id: int,
    invoice_date=None,
    invoice_total=None,
) -> list[dict]:
    """Find pending POs for a supplier, ordered by match confidence."""
    q = (
        select(PurchaseOrder)
        .where(
            PurchaseOrder.kitchen_id == kitchen_id,
            PurchaseOrder.supplier_id == supplier_id,
            PurchaseOrder.status.in_(["DRAFT", "PENDING"]),
        )
        .options(selectinload(PurchaseOrder.line_items))
        .order_by(PurchaseOrder.order_date.desc())
    )
    result = await db.execute(q)
    pos = result.scalars().all()

    matches = []
    for po in pos:
        confidence = calculate_match_confidence(po, invoice_date, invoice_total)
        matches.append({
            "po_id": po.id,
            "order_date": po.order_date.isoformat() if po.order_date else None,
            "total_amount": float(po.total_amount) if po.total_amount else None,
            "order_reference": po.order_reference,
            "status": po.status,
            "order_type": po.order_type,
            "confidence": round(confidence, 2),
        })

    # Sort by confidence descending
    matches.sort(key=lambda m: m["confidence"], reverse=True)
    return matches


def calculate_match_confidence(po: PurchaseOrder, invoice_date=None, invoice_total=None) -> float:
    """Score 0-1: supplier already matched (+0.4), date proximity (+0.3), amount similarity (+0.3)."""
    score = 0.0

    # Supplier match is guaranteed since we filter by supplier_id — grant base score
    score += 0.4

    # Date proximity: full marks if same day, degrades over 7 days
    if invoice_date and po.order_date:
        try:
            from datetime import date as date_type
            if isinstance(invoice_date, str):
                inv_date = date_type.fromisoformat(invoice_date)
            else:
                inv_date = invoice_date
            days_apart = abs((inv_date - po.order_date).days)
            if days_apart <= 7:
                score += 0.3 * (1 - days_apart / 7)
        except (ValueError, TypeError):
            pass

    # Amount similarity: full marks if within 5%, degrades to 0 at 50% difference
    if invoice_total is not None and po.total_amount:
        try:
            inv_total = float(invoice_total)
            po_total = float(po.total_amount)
            if po_total > 0:
                pct_diff = abs(inv_total - po_total) / po_total
                if pct_diff <= 0.05:
                    score += 0.3
                elif pct_diff < 0.5:
                    score += 0.3 * (1 - pct_diff / 0.5)
        except (ValueError, TypeError):
            pass

    return score


async def link_po_to_invoice(
    db: AsyncSession, po_id: int, invoice_id: int, kitchen_id: int, user_id: int
) -> PurchaseOrder:
    """Set PO status=LINKED, linked_invoice_id=invoice_id."""
    result = await db.execute(
        select(PurchaseOrder)
        .where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.kitchen_id == kitchen_id,
        )
        .options(
            selectinload(PurchaseOrder.line_items),
            selectinload(PurchaseOrder.supplier),
            selectinload(PurchaseOrder.created_by_user),
        )
    )
    po = result.scalar_one_or_none()
    if not po:
        return None

    # Verify invoice exists
    inv_result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == kitchen_id,
        )
    )
    if not inv_result.scalar_one_or_none():
        return None

    po.status = "LINKED"
    po.linked_invoice_id = invoice_id
    po.updated_by = user_id
    await db.commit()
    return po


async def unlink_po(
    db: AsyncSession, po_id: int, kitchen_id: int, user_id: int
) -> PurchaseOrder:
    """Reset PO status=PENDING, linked_invoice_id=None."""
    result = await db.execute(
        select(PurchaseOrder)
        .where(
            PurchaseOrder.id == po_id,
            PurchaseOrder.kitchen_id == kitchen_id,
        )
        .options(
            selectinload(PurchaseOrder.line_items),
            selectinload(PurchaseOrder.supplier),
            selectinload(PurchaseOrder.created_by_user),
        )
    )
    po = result.scalar_one_or_none()
    if not po:
        return None

    po.status = "PENDING"
    po.linked_invoice_id = None
    po.updated_by = user_id
    await db.commit()
    return po
