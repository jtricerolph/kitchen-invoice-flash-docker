"""
Logbook API for wastage, transfers, staff food, and manual adjustments.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func
from sqlalchemy.orm import selectinload
from datetime import date, datetime
from typing import Optional, List
from pydantic import BaseModel
from decimal import Decimal
import os
import logging

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.logbook import (
    LogbookEntry, LogbookLineItem, LogbookAttachment,
    EntryType, WastageReason, TransferStatus
)
# from models.products import Product  # TODO: Add Product model

router = APIRouter(prefix="/logbook", tags=["Logbook"])
logger = logging.getLogger(__name__)


# ============ Pydantic Schemas ============

class LineItemInput(BaseModel):
    product_id: Optional[int] = None
    product_name: str
    product_code: Optional[str] = None
    supplier_name: Optional[str] = None
    quantity: float
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    total_cost: float
    notes: Optional[str] = None


class WastageEntryInput(BaseModel):
    entry_date: date
    reason: WastageReason
    line_items: List[LineItemInput]
    notes: Optional[str] = None
    reference_number: Optional[str] = None


class TransferEntryInput(BaseModel):
    entry_date: date
    destination_kitchen_id: int
    status: TransferStatus = TransferStatus.PENDING
    line_items: List[LineItemInput]
    notes: Optional[str] = None
    reference_number: Optional[str] = None


class StaffFoodEntryInput(BaseModel):
    entry_date: date
    meal_type: str  # breakfast, lunch, dinner, snack
    staff_count: Optional[int] = None
    line_items: List[LineItemInput]
    notes: Optional[str] = None


class ManualAdjustmentInput(BaseModel):
    entry_date: date
    adjustment_reason: str
    original_invoice_id: Optional[int] = None
    line_items: List[LineItemInput]
    notes: Optional[str] = None
    reference_number: Optional[str] = None


class LineItemResponse(BaseModel):
    id: int
    product_id: Optional[int]
    product_name: str
    product_code: Optional[str]
    supplier_name: Optional[str]
    quantity: float
    unit: Optional[str]
    unit_price: Optional[float]
    total_cost: float
    notes: Optional[str]


class AttachmentResponse(BaseModel):
    id: int
    file_name: str
    file_path: str
    file_type: str
    file_size_bytes: int
    description: Optional[str]
    uploaded_at: str


class LogbookEntryResponse(BaseModel):
    id: int
    entry_type: str
    entry_date: str
    reference_number: Optional[str]
    total_cost: float
    notes: Optional[str]
    type_data: dict
    created_by: int
    created_by_name: Optional[str]
    created_at: str
    line_items: List[LineItemResponse]
    attachments: List[AttachmentResponse]


class LogbookSummary(BaseModel):
    total_entries: int
    total_cost: float
    by_type: dict


# ============ Helper Functions ============

def build_entry_response(entry: LogbookEntry) -> LogbookEntryResponse:
    """Convert LogbookEntry model to response"""
    return LogbookEntryResponse(
        id=entry.id,
        entry_type=entry.entry_type.value,
        entry_date=entry.entry_date.isoformat(),
        reference_number=entry.reference_number,
        total_cost=float(entry.total_cost),
        notes=entry.notes,
        type_data=entry.type_data or {},
        created_by=entry.created_by,
        created_by_name=entry.created_by_user.name if entry.created_by_user else None,
        created_at=entry.created_at.isoformat(),
        line_items=[
            LineItemResponse(
                id=item.id,
                product_id=item.product_id,
                product_name=item.product_name,
                product_code=item.product_code,
                supplier_name=item.supplier_name,
                quantity=float(item.quantity),
                unit=item.unit,
                unit_price=float(item.unit_price) if item.unit_price else None,
                total_cost=float(item.total_cost),
                notes=item.notes
            )
            for item in entry.line_items
        ],
        attachments=[
            AttachmentResponse(
                id=att.id,
                file_name=att.file_name,
                file_path=att.file_path,
                file_type=att.file_type,
                file_size_bytes=att.file_size_bytes,
                description=att.description,
                uploaded_at=att.uploaded_at.isoformat()
            )
            for att in entry.attachments
        ]
    )


async def create_line_items(
    db: AsyncSession,
    entry_id: int,
    kitchen_id: int,
    items: List[LineItemInput]
) -> Decimal:
    """Create line items for an entry and return total cost"""
    total_cost = Decimal(0)

    for item_input in items:
        line_item = LogbookLineItem(
            entry_id=entry_id,
            kitchen_id=kitchen_id,
            product_id=item_input.product_id,
            product_name=item_input.product_name,
            product_code=item_input.product_code,
            supplier_name=item_input.supplier_name,
            quantity=Decimal(str(item_input.quantity)),
            unit=item_input.unit,
            unit_price=Decimal(str(item_input.unit_price)) if item_input.unit_price else None,
            total_cost=Decimal(str(item_input.total_cost)),
            notes=item_input.notes
        )
        db.add(line_item)
        total_cost += line_item.total_cost

    return total_cost


# ============ Endpoints ============

@router.get("")
async def get_logbook_entries(
    entry_type: Optional[EntryType] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> List[LogbookEntryResponse]:
    """Get logbook entries with filters"""

    query = select(LogbookEntry).options(
        selectinload(LogbookEntry.line_items),
        selectinload(LogbookEntry.attachments),
        selectinload(LogbookEntry.created_by_user)
    ).where(
        and_(
            LogbookEntry.kitchen_id == current_user.kitchen_id,
            LogbookEntry.is_deleted == False
        )
    )

    if entry_type:
        query = query.where(LogbookEntry.entry_type == entry_type)

    if date_from:
        query = query.where(LogbookEntry.entry_date >= date_from)

    if date_to:
        query = query.where(LogbookEntry.entry_date <= date_to)

    if search:
        # Search in notes, reference number, and line item product names
        query = query.outerjoin(LogbookLineItem).where(
            or_(
                LogbookEntry.notes.ilike(f"%{search}%"),
                LogbookEntry.reference_number.ilike(f"%{search}%"),
                LogbookLineItem.product_name.ilike(f"%{search}%")
            )
        ).distinct()

    query = query.order_by(LogbookEntry.entry_date.desc(), LogbookEntry.created_at.desc())
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    entries = result.scalars().unique().all()

    return [build_entry_response(entry) for entry in entries]


@router.get("/summary")
async def get_logbook_summary(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookSummary:
    """Get summary statistics for logbook entries"""

    query = select(
        LogbookEntry.entry_type,
        func.count(LogbookEntry.id).label('count'),
        func.sum(LogbookEntry.total_cost).label('total')
    ).where(
        and_(
            LogbookEntry.kitchen_id == current_user.kitchen_id,
            LogbookEntry.is_deleted == False
        )
    ).group_by(LogbookEntry.entry_type)

    if date_from:
        query = query.where(LogbookEntry.entry_date >= date_from)

    if date_to:
        query = query.where(LogbookEntry.entry_date <= date_to)

    result = await db.execute(query)
    rows = result.all()

    by_type = {}
    total_entries = 0
    total_cost = Decimal(0)

    for row in rows:
        entry_type, count, cost = row
        by_type[entry_type.value] = {
            'count': count,
            'total_cost': float(cost or 0)
        }
        total_entries += count
        total_cost += cost or 0

    return LogbookSummary(
        total_entries=total_entries,
        total_cost=float(total_cost),
        by_type=by_type
    )


@router.get("/daily-stats")
async def get_daily_logbook_stats(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    entry_type: Optional[EntryType] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get daily logbook statistics for a date range (for purchases chart integration)"""

    query = select(
        LogbookEntry.entry_date,
        LogbookEntry.entry_type,
        func.count(LogbookEntry.id).label("count"),
        func.sum(LogbookEntry.total_cost).label("total_cost")
    ).where(
        and_(
            LogbookEntry.kitchen_id == current_user.kitchen_id,
            LogbookEntry.is_deleted == False
        )
    )

    if date_from:
        query = query.where(LogbookEntry.entry_date >= date_from)
    if date_to:
        query = query.where(LogbookEntry.entry_date <= date_to)
    if entry_type:
        query = query.where(LogbookEntry.entry_type == entry_type)

    query = query.group_by(LogbookEntry.entry_date, LogbookEntry.entry_type)
    query = query.order_by(LogbookEntry.entry_date)

    result = await db.execute(query)
    rows = result.all()

    # Group by date, then by type
    daily_stats = {}
    for row in rows:
        date_str = row.entry_date.isoformat()
        if date_str not in daily_stats:
            daily_stats[date_str] = {}
        daily_stats[date_str][row.entry_type.value] = {
            "count": row.count,
            "total_cost": float(row.total_cost or 0)
        }

    return {"daily_stats": daily_stats}


@router.get("/{entry_id}")
async def get_logbook_entry(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Get single logbook entry with details"""

    result = await db.execute(
        select(LogbookEntry).where(
            and_(
                LogbookEntry.id == entry_id,
                LogbookEntry.kitchen_id == current_user.kitchen_id,
                LogbookEntry.is_deleted == False
            )
        )
    )
    entry = result.scalar_one_or_none()

    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")

    return build_entry_response(entry)


@router.post("/wastage")
async def create_wastage_entry(
    entry_input: WastageEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create wastage entry"""

    if not entry_input.line_items:
        raise HTTPException(status_code=400, detail="At least one line item is required")

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.WASTAGE,
        entry_date=entry_input.entry_date,
        reference_number=entry_input.reference_number,
        notes=entry_input.notes,
        type_data={"reason": entry_input.reason.value},
        created_by=current_user.id
    )

    db.add(entry)
    await db.flush()  # Get entry.id

    total_cost = await create_line_items(db, entry.id, current_user.kitchen_id, entry_input.line_items)
    entry.total_cost = total_cost

    await db.commit()
    await db.refresh(entry)

    logger.info(f"Created wastage entry {entry.id} for kitchen {current_user.kitchen_id}, cost: {total_cost}")

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/transfer")
async def create_transfer_entry(
    entry_input: TransferEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create transfer entry"""

    if not entry_input.line_items:
        raise HTTPException(status_code=400, detail="At least one line item is required")

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.TRANSFER,
        entry_date=entry_input.entry_date,
        reference_number=entry_input.reference_number,
        notes=entry_input.notes,
        type_data={
            "destination_kitchen_id": entry_input.destination_kitchen_id,
            "status": entry_input.status.value
        },
        created_by=current_user.id
    )

    db.add(entry)
    await db.flush()

    total_cost = await create_line_items(db, entry.id, current_user.kitchen_id, entry_input.line_items)
    entry.total_cost = total_cost

    await db.commit()
    await db.refresh(entry)

    logger.info(f"Created transfer entry {entry.id} for kitchen {current_user.kitchen_id} -> {entry_input.destination_kitchen_id}")

    # TODO: Send notification to destination kitchen

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/staff-food")
async def create_staff_food_entry(
    entry_input: StaffFoodEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create staff food entry"""

    if not entry_input.line_items:
        raise HTTPException(status_code=400, detail="At least one line item is required")

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.STAFF_FOOD,
        entry_date=entry_input.entry_date,
        notes=entry_input.notes,
        type_data={
            "meal_type": entry_input.meal_type,
            "staff_count": entry_input.staff_count
        },
        created_by=current_user.id
    )

    db.add(entry)
    await db.flush()

    total_cost = await create_line_items(db, entry.id, current_user.kitchen_id, entry_input.line_items)
    entry.total_cost = total_cost

    await db.commit()
    await db.refresh(entry)

    logger.info(f"Created staff food entry {entry.id} for kitchen {current_user.kitchen_id}, meal: {entry_input.meal_type}")

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/manual-adjustment")
async def create_manual_adjustment_entry(
    entry_input: ManualAdjustmentInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create manual adjustment entry"""

    if not entry_input.line_items:
        raise HTTPException(status_code=400, detail="At least one line item is required")

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.MANUAL_ADJUSTMENT,
        entry_date=entry_input.entry_date,
        reference_number=entry_input.reference_number,
        notes=entry_input.notes,
        type_data={
            "adjustment_reason": entry_input.adjustment_reason,
            "original_invoice_id": entry_input.original_invoice_id
        },
        created_by=current_user.id
    )

    db.add(entry)
    await db.flush()

    total_cost = await create_line_items(db, entry.id, current_user.kitchen_id, entry_input.line_items)
    entry.total_cost = total_cost

    await db.commit()
    await db.refresh(entry)

    logger.info(f"Created manual adjustment entry {entry.id} for kitchen {current_user.kitchen_id}")

    return await get_logbook_entry(entry.id, current_user, db)


@router.patch("/{entry_id}")
async def update_logbook_entry(
    entry_id: int,
    notes: Optional[str] = None,
    reference_number: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update logbook entry (limited fields)"""

    result = await db.execute(
        select(LogbookEntry).where(
            and_(
                LogbookEntry.id == entry_id,
                LogbookEntry.kitchen_id == current_user.kitchen_id,
                LogbookEntry.is_deleted == False
            )
        )
    )
    entry = result.scalar_one_or_none()

    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")

    if notes is not None:
        entry.notes = notes

    if reference_number is not None:
        entry.reference_number = reference_number

    entry.updated_at = datetime.utcnow()
    await db.commit()

    return {"status": "updated"}


@router.delete("/{entry_id}")
async def delete_logbook_entry(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Soft delete logbook entry"""

    result = await db.execute(
        select(LogbookEntry).where(
            and_(
                LogbookEntry.id == entry_id,
                LogbookEntry.kitchen_id == current_user.kitchen_id
            )
        )
    )
    entry = result.scalar_one_or_none()

    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")

    entry.is_deleted = True
    entry.updated_at = datetime.utcnow()
    await db.commit()

    logger.info(f"Deleted logbook entry {entry_id} for kitchen {current_user.kitchen_id}")

    return {"status": "deleted"}


@router.post("/{entry_id}/attachments")
async def upload_attachment(
    entry_id: int,
    file: UploadFile = File(...),
    description: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload photo or document to logbook entry"""

    # Verify entry exists and belongs to user's kitchen
    result = await db.execute(
        select(LogbookEntry).where(
            and_(
                LogbookEntry.id == entry_id,
                LogbookEntry.kitchen_id == current_user.kitchen_id,
                LogbookEntry.is_deleted == False
            )
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")

    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/heic", "image/webp", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"File type {file.content_type} not allowed. Allowed: {allowed_types}")

    # Save file
    upload_dir = f"/app/attachments/logbook/kitchen_{current_user.kitchen_id}"
    os.makedirs(upload_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_extension = os.path.splitext(file.filename)[1] if file.filename else ".jpg"
    file_name = f"entry_{entry_id}_{timestamp}{file_extension}"
    file_path = f"{upload_dir}/{file_name}"

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Create attachment record
    attachment = LogbookAttachment(
        entry_id=entry_id,
        kitchen_id=current_user.kitchen_id,
        file_name=file.filename or file_name,
        file_path=file_path,
        file_type=file.content_type,
        file_size_bytes=len(content),
        description=description,
        uploaded_by=current_user.id
    )

    db.add(attachment)
    await db.commit()

    logger.info(f"Uploaded attachment {attachment.id} to entry {entry_id}")

    return {
        "id": attachment.id,
        "file_name": attachment.file_name,
        "file_path": attachment.file_path
    }


@router.delete("/{entry_id}/attachments/{attachment_id}")
async def delete_attachment(
    entry_id: int,
    attachment_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete attachment from logbook entry"""

    result = await db.execute(
        select(LogbookAttachment).where(
            and_(
                LogbookAttachment.id == attachment_id,
                LogbookAttachment.entry_id == entry_id,
                LogbookAttachment.kitchen_id == current_user.kitchen_id
            )
        )
    )
    attachment = result.scalar_one_or_none()

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Delete file from disk
    if os.path.exists(attachment.file_path):
        os.remove(attachment.file_path)

    await db.delete(attachment)
    await db.commit()

    return {"status": "deleted"}


@router.get("/products/search")
async def search_products(
    query: str,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Search products from invoice line items for logbook entry"""
    from models.line_item import LineItem
    from models.invoice import Invoice
    from models.supplier import Supplier

    # Search line items from invoices for this kitchen
    # Get distinct products with most recent price
    result = await db.execute(
        select(
            LineItem.description,
            LineItem.product_code,
            LineItem.unit,
            LineItem.unit_price,
            Supplier.name.label('supplier_name')
        )
        .join(Invoice, LineItem.invoice_id == Invoice.id)
        .outerjoin(Supplier, Invoice.supplier_id == Supplier.id)
        .where(
            and_(
                Invoice.kitchen_id == current_user.kitchen_id,
                or_(
                    LineItem.description.ilike(f"%{query}%"),
                    LineItem.product_code.ilike(f"%{query}%")
                )
            )
        )
        .order_by(Invoice.invoice_date.desc())
        .limit(limit * 3)  # Get more to allow for deduplication
    )
    rows = result.all()

    # Deduplicate by description, keeping first (most recent) price
    seen = set()
    products = []
    for row in rows:
        key = (row.description or '').lower()
        if key and key not in seen:
            seen.add(key)
            products.append({
                "id": 0,  # No persistent product ID
                "name": row.description,
                "product_code": row.product_code,
                "supplier_name": row.supplier_name,
                "unit": row.unit,
                "last_price": float(row.unit_price) if row.unit_price else None
            })
            if len(products) >= limit:
                break

    return products
