"""
Purchase Order API endpoints — full CRUD, attachment, product search, budget view,
preview (HTML), and email sending.
"""
import os
import uuid
import logging
from datetime import date
from decimal import Decimal
from typing import Optional
from html import escape as html_escape

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func, delete
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, field_serializer

from database import get_db
from models.user import User, Kitchen
from models.purchase_order import PurchaseOrder, PurchaseOrderLineItem
from models.supplier import Supplier
from models.settings import KitchenSettings
from models.line_item import LineItem
from models.invoice import Invoice
from auth.jwt import get_current_user, get_current_user_from_token
from services.email_service import EmailService

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOAD_DIR = "data/po_attachments"

# ── Pydantic schemas ──────────────────────────────────────────────────────────

class LineItemIn(BaseModel):
    product_id: Optional[int] = None
    product_code: Optional[str] = None
    description: str
    unit: Optional[str] = None
    unit_price: Decimal
    quantity: Decimal
    total: Decimal
    line_number: int = 0
    source: str = "manual"


class PurchaseOrderCreate(BaseModel):
    supplier_id: int
    order_date: date
    order_type: str  # 'itemised' or 'single_value'
    total_amount: Optional[Decimal] = None
    order_reference: Optional[str] = None
    notes: Optional[str] = None
    status: str = "DRAFT"
    line_items: list[LineItemIn] = []


class PurchaseOrderUpdate(BaseModel):
    supplier_id: Optional[int] = None
    order_date: Optional[date] = None
    order_type: Optional[str] = None
    total_amount: Optional[Decimal] = None
    order_reference: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    line_items: Optional[list[LineItemIn]] = None


class StatusUpdate(BaseModel):
    status: str


class LineItemOut(BaseModel):
    id: int
    product_id: Optional[int]
    product_code: Optional[str]
    description: str
    unit: Optional[str]
    unit_price: Decimal
    quantity: Decimal
    total: Decimal
    line_number: int
    source: str

    @field_serializer('unit_price', 'quantity', 'total')
    def ser(self, v: Decimal) -> float:
        return float(v)


class PurchaseOrderOut(BaseModel):
    id: int
    kitchen_id: int
    supplier_id: int
    supplier_name: Optional[str] = None
    order_date: date
    order_type: str
    status: str
    total_amount: Optional[Decimal]
    order_reference: Optional[str]
    notes: Optional[str]
    attachment_path: Optional[str]
    attachment_original_name: Optional[str]
    linked_invoice_id: Optional[int]
    created_by: int
    created_by_name: Optional[str] = None
    created_at: str
    updated_at: str
    line_items: list[LineItemOut] = []

    @field_serializer('total_amount')
    def ser_amount(self, v: Optional[Decimal]) -> Optional[float]:
        return float(v) if v is not None else None


class BudgetPO(BaseModel):
    id: int
    order_type: str
    status: str
    total_amount: Optional[float]
    order_reference: Optional[str]

# ── Helpers ───────────────────────────────────────────────────────────────────

def po_to_out(po: PurchaseOrder) -> PurchaseOrderOut:
    return PurchaseOrderOut(
        id=po.id,
        kitchen_id=po.kitchen_id,
        supplier_id=po.supplier_id,
        supplier_name=po.supplier.name if po.supplier else None,
        order_date=po.order_date,
        order_type=po.order_type,
        status=po.status,
        total_amount=po.total_amount,
        order_reference=po.order_reference,
        notes=po.notes,
        attachment_path=po.attachment_path,
        attachment_original_name=po.attachment_original_name,
        linked_invoice_id=po.linked_invoice_id,
        created_by=po.created_by,
        created_by_name=po.created_by_user.name if po.created_by_user else None,
        created_at=po.created_at.isoformat() if po.created_at else "",
        updated_at=po.updated_at.isoformat() if po.updated_at else "",
        line_items=[
            LineItemOut(
                id=li.id,
                product_id=li.product_id,
                product_code=li.product_code,
                description=li.description,
                unit=li.unit,
                unit_price=li.unit_price,
                quantity=li.quantity,
                total=li.total,
                line_number=li.line_number,
                source=li.source,
            )
            for li in (po.line_items or [])
        ],
    )


def _calc_itemised_total(items: list[LineItemIn]) -> Decimal:
    return sum((i.total for i in items), Decimal("0"))


async def _load_po(db: AsyncSession, po_id: int, kitchen_id: int) -> PurchaseOrder:
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
        raise HTTPException(status_code=404, detail="Purchase order not found")
    return po


# ── CRUD Endpoints ────────────────────────────────────────────────────────────

@router.post("/", response_model=PurchaseOrderOut)
async def create_purchase_order(
    data: PurchaseOrderCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate supplier belongs to this kitchen
    sup = await db.execute(
        select(Supplier).where(
            Supplier.id == data.supplier_id,
            Supplier.kitchen_id == current_user.kitchen_id,
        )
    )
    if not sup.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Invalid supplier")

    total = data.total_amount if data.order_type == "single_value" else _calc_itemised_total(data.line_items)

    po = PurchaseOrder(
        kitchen_id=current_user.kitchen_id,
        supplier_id=data.supplier_id,
        order_date=data.order_date,
        order_type=data.order_type,
        status=data.status if data.status in ("DRAFT", "PENDING") else "DRAFT",
        total_amount=total,
        order_reference=data.order_reference,
        notes=data.notes,
        created_by=current_user.id,
        updated_by=current_user.id,
    )
    db.add(po)
    await db.flush()

    for idx, li in enumerate(data.line_items):
        db.add(PurchaseOrderLineItem(
            purchase_order_id=po.id,
            kitchen_id=current_user.kitchen_id,
            product_id=li.product_id,
            product_code=li.product_code,
            description=li.description,
            unit=li.unit,
            unit_price=li.unit_price,
            quantity=li.quantity,
            total=li.total,
            line_number=li.line_number or idx,
            source=li.source,
        ))

    await db.commit()
    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


@router.get("/", response_model=list[PurchaseOrderOut])
async def list_purchase_orders(
    status: Optional[str] = None,
    supplier_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = 100,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(PurchaseOrder)
        .where(PurchaseOrder.kitchen_id == current_user.kitchen_id)
        .options(
            selectinload(PurchaseOrder.line_items),
            selectinload(PurchaseOrder.supplier),
            selectinload(PurchaseOrder.created_by_user),
        )
        .order_by(PurchaseOrder.order_date.desc(), PurchaseOrder.id.desc())
    )

    if status:
        statuses = [s.strip().upper() for s in status.split(",")]
        q = q.where(PurchaseOrder.status.in_(statuses))
    if supplier_id:
        q = q.where(PurchaseOrder.supplier_id == supplier_id)
    if date_from:
        q = q.where(PurchaseOrder.order_date >= date_from)
    if date_to:
        q = q.where(PurchaseOrder.order_date <= date_to)

    q = q.offset(offset).limit(limit)
    result = await db.execute(q)
    return [po_to_out(po) for po in result.scalars().all()]


@router.get("/products/search")
async def search_products_for_po(
    query: str,
    supplier_id: Optional[int] = None,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Search products from invoice line items, optionally filtered by supplier."""
    q = (
        select(
            LineItem.description,
            LineItem.product_code,
            LineItem.unit,
            LineItem.unit_price,
            Supplier.name.label("supplier_name"),
            Invoice.supplier_id.label("sup_id"),
        )
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .outerjoin(Supplier, Invoice.supplier_id == Supplier.id)
        .where(
            and_(
                Invoice.kitchen_id == current_user.kitchen_id,
                or_(
                    LineItem.description.ilike(f"%{query}%"),
                    LineItem.product_code.ilike(f"%{query}%"),
                ),
            )
        )
        .order_by(Invoice.invoice_date.desc())
    )

    if supplier_id:
        q = q.where(Invoice.supplier_id == supplier_id)

    q = q.limit(limit * 3)
    result = await db.execute(q)
    rows = result.all()

    seen: set[str] = set()
    products = []
    for row in rows:
        key = (row.description or "").lower()
        if key and key not in seen:
            seen.add(key)
            products.append({
                "id": 0,
                "name": row.description,
                "product_code": row.product_code,
                "supplier_name": row.supplier_name,
                "unit": row.unit,
                "last_price": float(row.unit_price) if row.unit_price else None,
            })
            if len(products) >= limit:
                break

    return products


@router.get("/by-date")
async def get_pos_by_date(
    week_start: date,
    week_end: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """POs grouped by supplier_id → date for budget table integration."""
    result = await db.execute(
        select(PurchaseOrder)
        .where(
            PurchaseOrder.kitchen_id == current_user.kitchen_id,
            PurchaseOrder.status.in_(["DRAFT", "PENDING"]),
            PurchaseOrder.order_date >= week_start,
            PurchaseOrder.order_date <= week_end,
        )
        .options(selectinload(PurchaseOrder.line_items))
    )
    pos = result.scalars().all()

    grouped: dict[int, dict[str, list]] = {}
    for po in pos:
        sid = po.supplier_id
        ds = po.order_date.isoformat()
        if sid not in grouped:
            grouped[sid] = {}
        if ds not in grouped[sid]:
            grouped[sid][ds] = []
        grouped[sid][ds].append(BudgetPO(
            id=po.id,
            order_type=po.order_type,
            status=po.status,
            total_amount=float(po.total_amount) if po.total_amount else None,
            order_reference=po.order_reference,
        ).model_dump())

    return grouped


@router.get("/{po_id}", response_model=PurchaseOrderOut)
async def get_purchase_order(
    po_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return po_to_out(await _load_po(db, po_id, current_user.kitchen_id))


@router.put("/{po_id}", response_model=PurchaseOrderOut)
async def update_purchase_order(
    po_id: int,
    data: PurchaseOrderUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    po = await _load_po(db, po_id, current_user.kitchen_id)

    if po.status in ("LINKED", "CLOSED", "CANCELLED"):
        raise HTTPException(status_code=400, detail=f"Cannot edit PO with status {po.status}")

    if data.supplier_id is not None:
        po.supplier_id = data.supplier_id
    if data.order_date is not None:
        po.order_date = data.order_date
    if data.order_type is not None:
        po.order_type = data.order_type
    if data.order_reference is not None:
        po.order_reference = data.order_reference
    if data.notes is not None:
        po.notes = data.notes
    if data.status is not None and data.status in ("DRAFT", "PENDING"):
        po.status = data.status

    # Replace line items if provided
    if data.line_items is not None:
        await db.execute(
            delete(PurchaseOrderLineItem).where(
                PurchaseOrderLineItem.purchase_order_id == po.id
            )
        )
        for idx, li in enumerate(data.line_items):
            db.add(PurchaseOrderLineItem(
                purchase_order_id=po.id,
                kitchen_id=current_user.kitchen_id,
                product_id=li.product_id,
                product_code=li.product_code,
                description=li.description,
                unit=li.unit,
                unit_price=li.unit_price,
                quantity=li.quantity,
                total=li.total,
                line_number=li.line_number or idx,
                source=li.source,
            ))

    # Recalculate total
    if po.order_type == "single_value":
        if data.total_amount is not None:
            po.total_amount = data.total_amount
    else:
        items = data.line_items if data.line_items is not None else []
        po.total_amount = _calc_itemised_total(items) if items else po.total_amount

    po.updated_by = current_user.id
    await db.commit()
    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


@router.delete("/{po_id}")
async def delete_purchase_order(
    po_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    po = await _load_po(db, po_id, current_user.kitchen_id)
    allowed_statuses = ("DRAFT", "CANCELLED", "PENDING") if current_user.is_admin else ("DRAFT", "CANCELLED")
    if po.status not in allowed_statuses:
        raise HTTPException(status_code=400, detail="Only DRAFT or CANCELLED POs can be deleted")

    await db.delete(po)
    await db.commit()
    return {"ok": True}


@router.put("/{po_id}/status", response_model=PurchaseOrderOut)
async def update_po_status(
    po_id: int,
    data: StatusUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    po = await _load_po(db, po_id, current_user.kitchen_id)
    allowed = {
        "DRAFT": ["PENDING", "CANCELLED"],
        "PENDING": ["DRAFT", "CLOSED", "CANCELLED"],
        "LINKED": ["CLOSED"],
        "CLOSED": [],
        "CANCELLED": ["DRAFT"],
    }
    if data.status not in allowed.get(po.status, []):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot change status from {po.status} to {data.status}",
        )
    po.status = data.status
    po.updated_by = current_user.id
    await db.commit()
    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


# ── Attachment ────────────────────────────────────────────────────────────────

@router.post("/{po_id}/attachment", response_model=PurchaseOrderOut)
async def upload_attachment(
    po_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    po = await _load_po(db, po_id, current_user.kitchen_id)
    os.makedirs(UPLOAD_DIR, exist_ok=True)

    ext = os.path.splitext(file.filename or "file")[1]
    filename = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    contents = await file.read()
    with open(filepath, "wb") as f:
        f.write(contents)

    po.attachment_path = filepath
    po.attachment_original_name = file.filename
    po.updated_by = current_user.id
    await db.commit()
    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


@router.delete("/{po_id}/attachment", response_model=PurchaseOrderOut)
async def remove_attachment(
    po_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    po = await _load_po(db, po_id, current_user.kitchen_id)
    if po.attachment_path and os.path.exists(po.attachment_path):
        os.remove(po.attachment_path)
    po.attachment_path = None
    po.attachment_original_name = None
    po.updated_by = current_user.id
    await db.commit()
    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


# ── Preview & Email ──────────────────────────────────────────────────────────

def _build_po_html(po: PurchaseOrder, kitchen: KitchenSettings, currency: str = "£") -> str:
    """Generate a clean HTML page for PO preview / email body."""
    supplier = po.supplier
    esc = html_escape

    # Kitchen letterhead
    kitchen_name = esc(kitchen.kitchen_display_name or "")
    addr_parts = [
        kitchen.kitchen_address_line1,
        kitchen.kitchen_address_line2,
        kitchen.kitchen_city,
        kitchen.kitchen_postcode,
    ]
    addr_html = "<br>".join(esc(p) for p in addr_parts if p)
    kitchen_phone = esc(kitchen.kitchen_phone or "")
    kitchen_email = esc(kitchen.kitchen_email or "")

    # Supplier details
    supplier_name = esc(supplier.name) if supplier else "Unknown"
    account_number = esc(supplier.account_number or "") if supplier else ""

    # PO metadata
    po_number = f"PO-{po.id}"
    order_date = po.order_date.strftime("%d/%m/%Y") if po.order_date else ""
    notes = esc(po.notes or "").replace("\n", "<br>") if po.notes else ""

    # Line items table
    items_html = ""
    if po.order_type == "itemised" and po.line_items:
        rows = ""
        for li in sorted(po.line_items, key=lambda x: x.line_number):
            rows += f"""<tr>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;">{esc(li.product_code or "")}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;">{esc(li.description or "")}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;">{esc(li.unit or "")}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;">{currency}{li.unit_price:.2f}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;">{li.quantity:g}</td>
                <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right;">{currency}{li.total:.2f}</td>
            </tr>"""
        items_html = f"""
        <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:14px;">
            <thead>
                <tr style="background:#f5f5f5;">
                    <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ccc;">Code</th>
                    <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ccc;">Description</th>
                    <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #ccc;">Unit</th>
                    <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ccc;">Price</th>
                    <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ccc;">Qty</th>
                    <th style="padding:8px 10px;text-align:right;border-bottom:2px solid #ccc;">Total</th>
                </tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>"""
    elif po.order_type == "single_value":
        items_html = f"""
        <div style="margin-top:20px;padding:12px;background:#f9f9f9;border-radius:6px;">
            <strong>Order Value:</strong> {currency}{float(po.total_amount or 0):.2f}
            {f'<br><strong>Order Ref:</strong> {esc(po.order_reference)}' if po.order_reference else ''}
        </div>"""

    total_amount = float(po.total_amount or 0)

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Purchase Order {po_number}</title>
<style>
    body {{ font-family: Arial, Helvetica, sans-serif; color: #333; margin: 0; padding: 0; }}
    .page {{ max-width: 800px; margin: 20px auto; padding: 40px; }}
    @media print {{
        body {{ margin: 0; }}
        .page {{ max-width: 100%; margin: 0; padding: 20px; }}
        .no-print {{ display: none !important; }}
    }}
</style>
</head>
<body>
<div class="page">
    <!-- Letterhead -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;padding-bottom:20px;border-bottom:3px solid #1a1a2e;">
        <div>
            <h1 style="margin:0;color:#1a1a2e;font-size:22px;">{kitchen_name}</h1>
            <div style="margin-top:6px;font-size:13px;color:#666;line-height:1.5;">{addr_html}</div>
            {f'<div style="margin-top:4px;font-size:13px;color:#666;">Tel: {kitchen_phone}</div>' if kitchen_phone else ''}
            {f'<div style="font-size:13px;color:#666;">{kitchen_email}</div>' if kitchen_email else ''}
        </div>
        <div style="text-align:right;">
            <h2 style="margin:0;color:#1a1a2e;font-size:24px;">PURCHASE ORDER</h2>
            <div style="margin-top:8px;font-size:16px;font-weight:bold;color:#555;">{po_number}</div>
        </div>
    </div>

    <!-- PO Details -->
    <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
        <div>
            <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Supplier</div>
            <div style="font-size:16px;font-weight:bold;margin-top:4px;">{supplier_name}</div>
            {f'<div style="font-size:13px;color:#666;margin-top:2px;">Account: {account_number}</div>' if account_number else ''}
        </div>
        <div style="text-align:right;">
            <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Date</div>
            <div style="font-size:16px;font-weight:bold;margin-top:4px;">{order_date}</div>
            <div style="font-size:13px;color:#666;margin-top:2px;">Status: {po.status}</div>
        </div>
    </div>

    <!-- Items -->
    {items_html}

    <!-- Total -->
    <div style="text-align:right;margin-top:16px;padding:12px 10px;border-top:2px solid #1a1a2e;font-size:18px;">
        <strong>Total: {currency}{total_amount:.2f}</strong>
    </div>

    <!-- Notes -->
    {f'<div style="margin-top:20px;padding:12px;background:#fffef0;border-left:3px solid #e6c200;border-radius:4px;font-size:13px;"><strong>Notes:</strong><br>{notes}</div>' if notes else ''}

    <!-- Print button (hidden on print) -->
    <div class="no-print" style="margin-top:30px;text-align:center;">
        <button onclick="window.print()" style="padding:10px 24px;background:#1a1a2e;color:white;border:none;border-radius:6px;font-size:14px;cursor:pointer;">
            Print / Save PDF
        </button>
    </div>
</div>
</body>
</html>"""


@router.get("/{po_id}/preview")
async def preview_purchase_order(
    po_id: int,
    token: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Return a print-friendly HTML preview of the purchase order (query-param auth)."""
    if not token:
        raise HTTPException(status_code=401, detail="Token required — use ?token=your_jwt_token")
    current_user = await get_current_user_from_token(token, db)
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    po = await _load_po(db, po_id, current_user.kitchen_id)

    # Load kitchen settings for letterhead
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    kitchen = settings_result.scalar_one_or_none()
    if not kitchen:
        kitchen = KitchenSettings(kitchen_id=current_user.kitchen_id)

    currency = kitchen.currency_symbol or "£"
    html = _build_po_html(po, kitchen, currency)
    return HTMLResponse(content=html)


@router.post("/{po_id}/send-email")
async def send_po_email(
    po_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Email the PO to the supplier's order_email address."""
    po = await _load_po(db, po_id, current_user.kitchen_id)

    # Validate supplier has an order email
    if not po.supplier or not po.supplier.order_email:
        raise HTTPException(status_code=400, detail="Supplier does not have an order email address configured")

    # Load kitchen settings for SMTP + letterhead
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    kitchen = settings_result.scalar_one_or_none()
    if not kitchen or not kitchen.smtp_host or not kitchen.smtp_from_email:
        raise HTTPException(status_code=400, detail="SMTP email is not configured in Settings")

    currency = kitchen.currency_symbol or "£"
    html = _build_po_html(po, kitchen, currency)

    po_number = f"PO-{po.id}"
    kitchen_name = kitchen.kitchen_display_name or "Kitchen"
    subject = f"Purchase Order {po_number} from {kitchen_name}"

    email_service = EmailService(kitchen)
    success = email_service.send_email(
        to_email=po.supplier.order_email,
        subject=subject,
        html_body=html,
        plain_body=f"Please find attached Purchase Order {po_number}. Total: {currency}{float(po.total_amount or 0):.2f}",
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to send email. Check SMTP settings.")

    # Update status to PENDING if currently DRAFT
    if po.status == "DRAFT":
        po.status = "PENDING"
        po.updated_by = current_user.id
        await db.commit()

    return {"ok": True, "message": f"PO emailed to {po.supplier.order_email}", "new_status": po.status}


# ── Invoice Matching ─────────────────────────────────────────────────────────

class LinkRequest(BaseModel):
    invoice_id: int


@router.get("/matching/for-invoice")
async def get_matching_pos(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Find pending POs that match a given invoice (by supplier)."""
    from services.po_matching import find_matching_pos

    # Load the invoice
    inv_result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id,
        )
    )
    invoice = inv_result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    if not invoice.supplier_id:
        return {"matches": [], "linked_po": None}

    # Check if invoice already has a linked PO
    linked_result = await db.execute(
        select(PurchaseOrder)
        .where(
            PurchaseOrder.kitchen_id == current_user.kitchen_id,
            PurchaseOrder.linked_invoice_id == invoice_id,
            PurchaseOrder.status == "LINKED",
        )
        .options(
            selectinload(PurchaseOrder.supplier),
            selectinload(PurchaseOrder.line_items),
        )
    )
    linked_po = linked_result.scalar_one_or_none()

    if linked_po:
        return {
            "matches": [],
            "linked_po": {
                "po_id": linked_po.id,
                "order_date": linked_po.order_date.isoformat() if linked_po.order_date else None,
                "total_amount": float(linked_po.total_amount) if linked_po.total_amount else None,
                "order_reference": linked_po.order_reference,
                "status": linked_po.status,
                "order_type": linked_po.order_type,
            },
        }

    # Find matching POs
    matches = await find_matching_pos(
        db,
        kitchen_id=current_user.kitchen_id,
        supplier_id=invoice.supplier_id,
        invoice_date=invoice.invoice_date,
        invoice_total=invoice.total,
    )

    return {"matches": matches, "linked_po": None}


@router.post("/{po_id}/link", response_model=PurchaseOrderOut)
async def link_po_to_invoice(
    po_id: int,
    data: LinkRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Link a PO to an invoice. Sets PO status to LINKED."""
    from services.po_matching import link_po_to_invoice as do_link

    po = await do_link(db, po_id, data.invoice_id, current_user.kitchen_id, current_user.id)
    if not po:
        raise HTTPException(status_code=404, detail="PO or invoice not found")

    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))


@router.post("/{po_id}/unlink", response_model=PurchaseOrderOut)
async def unlink_po_from_invoice(
    po_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unlink a PO from its invoice. Returns PO to PENDING status."""
    from services.po_matching import unlink_po as do_unlink

    po = await do_unlink(db, po_id, current_user.kitchen_id, current_user.id)
    if not po:
        raise HTTPException(status_code=404, detail="PO not found")

    return po_to_out(await _load_po(db, po.id, current_user.kitchen_id))
