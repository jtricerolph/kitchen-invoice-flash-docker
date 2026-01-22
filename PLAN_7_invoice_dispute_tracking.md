# Plan 7: Invoice Dispute Tracking System

## Current State

### Existing Invoice Management
**Files:**
- `backend/models/invoices.py` - Invoice database model
- `backend/api/invoices.py` - Invoice CRUD endpoints
- `frontend/src/pages/Invoices.tsx` - Invoice list view

Current invoice fields:
- `invoice_number`, `supplier_id`, `invoice_date`
- `total_amount`, `tax_amount`
- `status` (pending, approved, processed)
- Line items with products and quantities

**What's Missing:**
- No dispute/issue tracking
- No price dispute logging
- No shortage documentation
- No error correction workflow
- No credit note linkage

## Problem Statement

**User Request:**
> "log disputed invoices for tracking price queries, shorts, errors, resolution status, dashboard widget for it"

**Real-World Scenarios:**

1. **Price Discrepancy:**
   - Invoice shows €3.50/kg for tomatoes
   - Contract price is €2.80/kg
   - Need to: Flag issue, email supplier, track response, link credit note

2. **Short Delivery:**
   - Ordered 20kg flour, received 15kg
   - Invoice charges for 20kg
   - Need to: Document shortage, request credit, track resolution

3. **Wrong Product:**
   - Ordered "Chicken Breast, Free Range"
   - Received "Chicken Breast, Standard"
   - Different price point, quality issue

4. **Quality Issue:**
   - Spoiled produce delivered
   - Return required, credit needed
   - Document photos, correspondence

5. **Calculation Error:**
   - Line item totals incorrect
   - Tax calculated wrong
   - Invoice total doesn't match order

**Goals:**
1. **Log Disputes:** Record issues with invoices/line items
2. **Track Status:** Open, In Progress, Resolved, Closed
3. **Document Evidence:** Attach emails, photos, delivery notes
4. **Link Credit Notes:** Connect disputes to resolutions
5. **Dashboard Widget:** Show open disputes at a glance
6. **Reporting:** Analyze dispute patterns by supplier

## Architecture

### Data Model

```
┌─────────────────────────────────────────────────────┐
│                  Invoice                            │
│  - id, invoice_number, supplier_id                  │
│  - total_amount, status                             │
└─────────────────────────────────────────────────────┘
                       │
                       │ 1:many
                       ▼
┌─────────────────────────────────────────────────────┐
│              InvoiceDispute                         │
│  - id, invoice_id, dispute_type                     │
│  - status, priority                                 │
│  - disputed_amount, expected_amount                 │
│  - description, resolution_notes                    │
│  - opened_by, opened_at                             │
│  - resolved_at, resolved_by                         │
└─────────────────────────────────────────────────────┘
           │                           │
           │ 1:many                    │ 1:many
           ▼                           ▼
┌──────────────────────┐    ┌──────────────────────┐
│ DisputeLineItem      │    │ DisputeAttachment    │
│ - line_item_id       │    │ - file_path          │
│ - quantity_ordered   │    │ - file_type          │
│ - quantity_received  │    │ - description        │
│ - price_quoted       │    │ - uploaded_at        │
│ - price_charged      │    └──────────────────────┘
└──────────────────────┘
           │
           │ many:1
           ▼
┌──────────────────────┐
│    CreditNote        │
│ - id, invoice_id     │
│ - dispute_id         │
│ - credit_amount      │
│ - credit_date        │
│ - reference_number   │
└──────────────────────┘
```

### Dispute Workflow

```
┌──────────────────┐
│   Create Invoice │
│   & Review       │
└────────┬─────────┘
         │
         ▼
   ┌─────────────┐
   │ Issue Found?│
   └─────┬───────┘
         │ Yes
         ▼
┌──────────────────┐      ┌──────────────────┐
│  Log Dispute     │──────┤  Add Evidence    │
│  - Type          │      │  - Photos        │
│  - Amount        │      │  - Emails        │
│  - Description   │      │  - Delivery Note │
└────────┬─────────┘      └──────────────────┘
         │
         ▼
┌──────────────────┐
│ Contact Supplier │
│ - Email          │
│ - Phone          │
│ - Portal         │
└────────┬─────────┘
         │
         ▼
   ┌───────────────┐
   │ Supplier      │
   │ Responds?     │
   └───┬───────────┘
       │
       ├─────────Yes─────────┐
       │                     │
       ▼                     ▼
┌──────────────┐      ┌──────────────┐
│ Credit Note  │      │ Partial      │
│ Issued       │      │ Resolution   │
└──────┬───────┘      └──────┬───────┘
       │                     │
       └──────────┬──────────┘
                  │
                  ▼
           ┌──────────────┐
           │ Link Credit  │
           │ to Dispute   │
           └──────┬───────┘
                  │
                  ▼
           ┌──────────────┐
           │ Close Dispute│
           └──────────────┘
```

## Implementation Plan

### Phase 1: Database Schema

#### 1.1 Create Dispute Models

**File:** `backend/models/disputes.py` (NEW)

```python
from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Boolean, Text, Integer, Enum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
import enum


class DisputeType(str, enum.Enum):
    PRICE_DISCREPANCY = "price_discrepancy"
    SHORT_DELIVERY = "short_delivery"
    WRONG_PRODUCT = "wrong_product"
    QUALITY_ISSUE = "quality_issue"
    CALCULATION_ERROR = "calculation_error"
    MISSING_ITEMS = "missing_items"
    DAMAGED_GOODS = "damaged_goods"
    OTHER = "other"


class DisputeStatus(str, enum.Enum):
    OPEN = "open"
    CONTACTED = "contacted"
    IN_PROGRESS = "in_progress"
    AWAITING_CREDIT = "awaiting_credit"
    RESOLVED = "resolved"
    CLOSED = "closed"
    ESCALATED = "escalated"


class DisputePriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class InvoiceDispute(Base):
    """Disputes/issues raised against invoices"""
    __tablename__ = "invoice_disputes"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), nullable=False, index=True)

    # Dispute classification
    dispute_type: Mapped[DisputeType] = mapped_column(Enum(DisputeType), nullable=False, index=True)
    status: Mapped[DisputeStatus] = mapped_column(Enum(DisputeStatus), default=DisputeStatus.OPEN, index=True)
    priority: Mapped[DisputePriority] = mapped_column(Enum(DisputePriority), default=DisputePriority.MEDIUM)

    # Financial impact
    disputed_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)  # What was charged
    expected_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # What should be charged
    difference_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)  # Disputed - Expected

    # Description
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    resolution_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Supplier communication
    supplier_contacted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    supplier_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    supplier_contact_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Resolution
    credit_note_id: Mapped[int | None] = mapped_column(ForeignKey("credit_notes.id"), nullable=True)
    resolved_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # Actual credit received

    # Audit trail
    opened_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Metadata
    reference_number: Mapped[str | None] = mapped_column(String(100), nullable=True)  # Internal tracking number
    tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # ["urgent", "recurring_issue", etc.]

    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="invoice_disputes")
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="disputes")
    opened_by_user: Mapped["User"] = relationship("User", foreign_keys=[opened_by])
    resolved_by_user: Mapped["User"] = relationship("User", foreign_keys=[resolved_by])
    closed_by_user: Mapped["User"] = relationship("User", foreign_keys=[closed_by])
    credit_note: Mapped["CreditNote"] = relationship("CreditNote", back_populates="dispute")
    line_items: Mapped[list["DisputeLineItem"]] = relationship(
        "DisputeLineItem", back_populates="dispute", cascade="all, delete-orphan"
    )
    attachments: Mapped[list["DisputeAttachment"]] = relationship(
        "DisputeAttachment", back_populates="dispute", cascade="all, delete-orphan"
    )
    activity_log: Mapped[list["DisputeActivity"]] = relationship(
        "DisputeActivity", back_populates="dispute", cascade="all, delete-orphan"
    )


class DisputeLineItem(Base):
    """Specific line items that are disputed"""
    __tablename__ = "dispute_line_items"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    dispute_id: Mapped[int] = mapped_column(ForeignKey("invoice_disputes.id"), nullable=False, index=True)
    invoice_line_item_id: Mapped[int | None] = mapped_column(ForeignKey("invoice_line_items.id"), nullable=True)

    # Product details
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    product_code: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Quantity dispute
    quantity_ordered: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    quantity_received: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)
    quantity_difference: Mapped[Decimal | None] = mapped_column(Numeric(10, 3), nullable=True)

    # Price dispute
    unit_price_quoted: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    unit_price_charged: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    price_difference: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    # Line total
    total_charged: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    total_expected: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    dispute: Mapped["InvoiceDispute"] = relationship("InvoiceDispute", back_populates="line_items")
    invoice_line_item: Mapped["InvoiceLineItem"] = relationship("InvoiceLineItem")


class DisputeAttachment(Base):
    """Supporting documents for disputes (photos, emails, delivery notes)"""
    __tablename__ = "dispute_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    dispute_id: Mapped[int] = mapped_column(ForeignKey("invoice_disputes.id"), nullable=False, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    # File details
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_type: Mapped[str] = mapped_column(String(50), nullable=False)  # image/jpeg, application/pdf, message/rfc822
    file_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    # Categorization
    attachment_type: Mapped[str] = mapped_column(String(50), nullable=False)  # photo, email, delivery_note, credit_note, other
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)

    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    dispute: Mapped["InvoiceDispute"] = relationship("InvoiceDispute", back_populates="attachments")
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    uploaded_by_user: Mapped["User"] = relationship("User")


class DisputeActivity(Base):
    """Activity log for dispute tracking (timeline of actions)"""
    __tablename__ = "dispute_activity"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    dispute_id: Mapped[int] = mapped_column(ForeignKey("invoice_disputes.id"), nullable=False, index=True)

    # Activity details
    activity_type: Mapped[str] = mapped_column(String(50), nullable=False)  # created, status_change, contacted_supplier, note_added, etc.
    description: Mapped[str] = mapped_column(Text, nullable=False)

    # Old/new values for changes
    old_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    new_value: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    # Relationships
    dispute: Mapped["InvoiceDispute"] = relationship("InvoiceDispute", back_populates="activity_log")
    created_by_user: Mapped["User"] = relationship("User")


class CreditNote(Base):
    """Credit notes issued by suppliers (resolves disputes)"""
    __tablename__ = "credit_notes"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), nullable=False, index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), nullable=False)

    # Credit note details
    credit_note_number: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    credit_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    credit_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Document
    pdf_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Audit
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="credit_notes")
    supplier: Mapped["Supplier"] = relationship("Supplier")
    created_by_user: Mapped["User"] = relationship("User")
    dispute: Mapped["InvoiceDispute"] = relationship("InvoiceDispute", back_populates="credit_note", uselist=False)


# Add relationships to existing models:

# In backend/models/invoices.py - Invoice class:
# disputes: Mapped[list["InvoiceDispute"]] = relationship("InvoiceDispute", back_populates="invoice")
# credit_notes: Mapped[list["CreditNote"]] = relationship("CreditNote", back_populates="invoice")

# In backend/models/user.py - Kitchen class:
# invoice_disputes: Mapped[list["InvoiceDispute"]] = relationship("InvoiceDispute", back_populates="kitchen")
```

#### 1.2 Create Migration

**File:** `backend/migrations/add_invoice_disputes.py` (NEW)

```python
import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)

async def run_migration():
    """Create invoice dispute tracking tables"""

    # Enums created by SQLAlchemy

    # Indexes
    create_indexes_sql = [
        """
        CREATE INDEX IF NOT EXISTS idx_disputes_kitchen_status
        ON invoice_disputes(kitchen_id, status, opened_at DESC);
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_disputes_invoice
        ON invoice_disputes(invoice_id);
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_disputes_priority
        ON invoice_disputes(kitchen_id, priority, status);
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice
        ON credit_notes(invoice_id);
        """
    ]

    try:
        async with engine.begin() as conn:
            for sql in create_indexes_sql:
                await conn.execute(text(sql))
            logger.info("Created invoice dispute indexes")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Invoice disputes migration: {e}")

if __name__ == "__main__":
    asyncio.run(run_migration())
```

### Phase 2: Backend API

#### 2.1 Disputes API

**File:** `backend/api/disputes.py` (NEW)

```python
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel
from decimal import Decimal

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.disputes import (
    InvoiceDispute, DisputeLineItem, DisputeAttachment, DisputeActivity,
    CreditNote, DisputeType, DisputeStatus, DisputePriority
)

router = APIRouter(prefix="/disputes", tags=["Disputes"])


# Pydantic Schemas

class DisputeLineItemInput(BaseModel):
    invoice_line_item_id: Optional[int] = None
    product_name: str
    quantity_ordered: Optional[float] = None
    quantity_received: Optional[float] = None
    unit_price_quoted: Optional[float] = None
    unit_price_charged: Optional[float] = None
    total_charged: float
    total_expected: Optional[float] = None
    notes: Optional[str] = None


class CreateDisputeInput(BaseModel):
    invoice_id: int
    dispute_type: DisputeType
    priority: DisputePriority = DisputePriority.MEDIUM
    title: str
    description: str
    disputed_amount: float
    expected_amount: Optional[float] = None
    line_items: List[DisputeLineItemInput] = []
    tags: Optional[List[str]] = None


class UpdateDisputeInput(BaseModel):
    status: Optional[DisputeStatus] = None
    priority: Optional[DisputePriority] = None
    resolution_notes: Optional[str] = None
    supplier_response: Optional[str] = None
    supplier_contact_name: Optional[str] = None


class DisputeResponse(BaseModel):
    id: int
    invoice_id: int
    invoice_number: str
    supplier_name: str
    dispute_type: str
    status: str
    priority: str
    title: str
    description: str
    disputed_amount: float
    expected_amount: Optional[float]
    difference_amount: float
    opened_at: str
    opened_by: str
    resolved_at: Optional[str]
    line_items: List[dict]
    attachments: List[dict]
    activity_log: List[dict]


# Endpoints

@router.get("")
async def get_disputes(
    status: Optional[DisputeStatus] = None,
    priority: Optional[DisputePriority] = None,
    invoice_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> List[DisputeResponse]:
    """Get disputes with filters"""

    query = select(InvoiceDispute).where(
        InvoiceDispute.kitchen_id == current_user.kitchen_id
    )

    if status:
        query = query.where(InvoiceDispute.status == status)

    if priority:
        query = query.where(InvoiceDispute.priority == priority)

    if invoice_id:
        query = query.where(InvoiceDispute.invoice_id == invoice_id)

    query = query.order_by(InvoiceDispute.opened_at.desc())
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    disputes = result.scalars().all()

    return [await _format_dispute(dispute, db) for dispute in disputes]


@router.post("")
async def create_dispute(
    dispute_input: CreateDisputeInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> DisputeResponse:
    """Create new invoice dispute"""

    # Calculate difference
    expected = Decimal(str(dispute_input.expected_amount)) if dispute_input.expected_amount else Decimal(0)
    disputed = Decimal(str(dispute_input.disputed_amount))
    difference = disputed - expected

    # Create dispute
    dispute = InvoiceDispute(
        kitchen_id=current_user.kitchen_id,
        invoice_id=dispute_input.invoice_id,
        dispute_type=dispute_input.dispute_type,
        priority=dispute_input.priority,
        status=DisputeStatus.OPEN,
        title=dispute_input.title,
        description=dispute_input.description,
        disputed_amount=disputed,
        expected_amount=expected if dispute_input.expected_amount else None,
        difference_amount=difference,
        opened_by=current_user.id,
        tags=dispute_input.tags
    )

    db.add(dispute)
    await db.flush()  # Get dispute.id

    # Add line items
    for item_input in dispute_input.line_items:
        line_item = DisputeLineItem(
            dispute_id=dispute.id,
            invoice_line_item_id=item_input.invoice_line_item_id,
            product_name=item_input.product_name,
            quantity_ordered=Decimal(str(item_input.quantity_ordered)) if item_input.quantity_ordered else None,
            quantity_received=Decimal(str(item_input.quantity_received)) if item_input.quantity_received else None,
            quantity_difference=(
                Decimal(str(item_input.quantity_ordered or 0)) - Decimal(str(item_input.quantity_received or 0))
                if item_input.quantity_ordered and item_input.quantity_received else None
            ),
            unit_price_quoted=Decimal(str(item_input.unit_price_quoted)) if item_input.unit_price_quoted else None,
            unit_price_charged=Decimal(str(item_input.unit_price_charged)) if item_input.unit_price_charged else None,
            price_difference=(
                Decimal(str(item_input.unit_price_charged or 0)) - Decimal(str(item_input.unit_price_quoted or 0))
                if item_input.unit_price_quoted and item_input.unit_price_charged else None
            ),
            total_charged=Decimal(str(item_input.total_charged)),
            total_expected=Decimal(str(item_input.total_expected)) if item_input.total_expected else None,
            notes=item_input.notes
        )
        db.add(line_item)

    # Log activity
    activity = DisputeActivity(
        dispute_id=dispute.id,
        activity_type="created",
        description=f"Dispute created: {dispute.title}",
        created_by=current_user.id
    )
    db.add(activity)

    await db.commit()
    await db.refresh(dispute)

    return await _format_dispute(dispute, db)


@router.put("/{dispute_id}")
async def update_dispute(
    dispute_id: int,
    update_input: UpdateDisputeInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update dispute status or details"""

    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()

    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Track changes for activity log
    changes = []

    if update_input.status and update_input.status != dispute.status:
        old_status = dispute.status.value
        dispute.status = update_input.status
        changes.append(f"Status changed from {old_status} to {update_input.status.value}")

        # Auto-set resolved_at when status changes to resolved
        if update_input.status == DisputeStatus.RESOLVED and not dispute.resolved_at:
            dispute.resolved_at = datetime.utcnow()
            dispute.resolved_by = current_user.id

    if update_input.priority and update_input.priority != dispute.priority:
        old_priority = dispute.priority.value
        dispute.priority = update_input.priority
        changes.append(f"Priority changed from {old_priority} to {update_input.priority.value}")

    if update_input.resolution_notes:
        dispute.resolution_notes = update_input.resolution_notes
        changes.append("Resolution notes updated")

    if update_input.supplier_response:
        dispute.supplier_response = update_input.supplier_response
        dispute.supplier_contacted_at = datetime.utcnow()
        changes.append("Supplier response recorded")

    if update_input.supplier_contact_name:
        dispute.supplier_contact_name = update_input.supplier_contact_name

    dispute.updated_at = datetime.utcnow()

    # Log activity
    for change in changes:
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="updated",
            description=change,
            created_by=current_user.id
        )
        db.add(activity)

    await db.commit()

    return {"status": "updated", "changes": changes}


@router.post("/{dispute_id}/attachments")
async def upload_dispute_attachment(
    dispute_id: int,
    file: UploadFile = File(...),
    attachment_type: str = "other",
    description: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload supporting document (photo, email, delivery note)"""

    # Verify dispute exists
    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Save file
    import os
    upload_dir = f"/app/attachments/disputes/kitchen_{current_user.kitchen_id}"
    os.makedirs(upload_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_extension = os.path.splitext(file.filename)[1]
    file_name = f"dispute_{dispute_id}_{timestamp}{file_extension}"
    file_path = f"{upload_dir}/{file_name}"

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Create attachment record
    attachment = DisputeAttachment(
        dispute_id=dispute_id,
        kitchen_id=current_user.kitchen_id,
        file_name=file.filename,
        file_path=file_path,
        file_type=file.content_type,
        file_size_bytes=len(content),
        attachment_type=attachment_type,
        description=description,
        uploaded_by=current_user.id
    )

    db.add(attachment)

    # Log activity
    activity = DisputeActivity(
        dispute_id=dispute_id,
        activity_type="attachment_added",
        description=f"Attachment added: {file.filename}",
        created_by=current_user.id
    )
    db.add(activity)

    await db.commit()

    return {"id": attachment.id, "file_name": file_name}


@router.get("/stats/summary")
async def get_dispute_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get dispute statistics for dashboard widget"""

    # Count by status
    result = await db.execute(
        select(
            InvoiceDispute.status,
            func.count(InvoiceDispute.id).label("count"),
            func.sum(InvoiceDispute.difference_amount).label("total_amount")
        ).where(
            InvoiceDispute.kitchen_id == current_user.kitchen_id
        ).group_by(InvoiceDispute.status)
    )
    status_counts = {row.status.value: {"count": row.count, "amount": float(row.total_amount or 0)} for row in result}

    # Recent disputes
    result = await db.execute(
        select(InvoiceDispute).where(
            InvoiceDispute.kitchen_id == current_user.kitchen_id
        ).order_by(InvoiceDispute.opened_at.desc()).limit(5)
    )
    recent_disputes = result.scalars().all()

    return {
        "status_counts": status_counts,
        "open_count": status_counts.get("open", {}).get("count", 0),
        "total_disputed_amount": sum(s.get("amount", 0) for s in status_counts.values()),
        "recent_disputes": [
            {
                "id": d.id,
                "title": d.title,
                "dispute_type": d.dispute_type.value,
                "amount": float(d.difference_amount),
                "opened_at": d.opened_at.isoformat()
            }
            for d in recent_disputes
        ]
    }


async def _format_dispute(dispute: InvoiceDispute, db: AsyncSession) -> DisputeResponse:
    """Format dispute for API response"""

    # Get invoice details
    from models.invoices import Invoice

    invoice = await db.get(Invoice, dispute.invoice_id)

    return DisputeResponse(
        id=dispute.id,
        invoice_id=dispute.invoice_id,
        invoice_number=invoice.invoice_number,
        supplier_name=invoice.supplier.name,
        dispute_type=dispute.dispute_type.value,
        status=dispute.status.value,
        priority=dispute.priority.value,
        title=dispute.title,
        description=dispute.description,
        disputed_amount=float(dispute.disputed_amount),
        expected_amount=float(dispute.expected_amount) if dispute.expected_amount else None,
        difference_amount=float(dispute.difference_amount),
        opened_at=dispute.opened_at.isoformat(),
        opened_by=dispute.opened_by_user.name,
        resolved_at=dispute.resolved_at.isoformat() if dispute.resolved_at else None,
        line_items=[
            {
                "id": item.id,
                "product_name": item.product_name,
                "quantity_ordered": float(item.quantity_ordered) if item.quantity_ordered else None,
                "quantity_received": float(item.quantity_received) if item.quantity_received else None,
                "total_charged": float(item.total_charged),
                "total_expected": float(item.total_expected) if item.total_expected else None
            }
            for item in dispute.line_items
        ],
        attachments=[
            {
                "id": att.id,
                "file_name": att.file_name,
                "attachment_type": att.attachment_type,
                "description": att.description
            }
            for att in dispute.attachments
        ],
        activity_log=[
            {
                "activity_type": act.activity_type,
                "description": act.description,
                "created_at": act.created_at.isoformat(),
                "created_by": act.created_by_user.name
            }
            for act in dispute.activity_log
        ]
    )
```

### Phase 3: Frontend Implementation

#### 3.1 Dashboard Widget

**File:** `frontend/src/pages/Dashboard.tsx` (UPDATE)

```typescript
// Add disputes widget
const { data: disputeStats } = useQuery({
  queryKey: ['dispute-stats'],
  queryFn: async () => {
    const res = await fetch('/api/disputes/stats/summary', {
      headers: { Authorization: `Bearer ${token}` }
    })
    return res.json()
  }
})

// Render widget
<div style={styles.widget}>
  <h3>⚠️ Invoice Disputes</h3>
  {disputeStats && (
    <>
      <div style={styles.statRow}>
        <span>Open Disputes:</span>
        <strong style={{ color: disputeStats.open_count > 0 ? '#d97706' : 'green' }}>
          {disputeStats.open_count}
        </strong>
      </div>
      <div style={styles.statRow}>
        <span>Total Disputed Amount:</span>
        <strong style={{ color: '#dc2626' }}>
          €{disputeStats.total_disputed_amount.toFixed(2)}
        </strong>
      </div>

      {disputeStats.recent_disputes.length > 0 && (
        <>
          <h4 style={{ marginTop: '1rem', fontSize: '0.9rem' }}>Recent:</h4>
          <ul style={{ fontSize: '0.85rem', paddingLeft: '1.2rem', margin: 0 }}>
            {disputeStats.recent_disputes.slice(0, 3).map((dispute) => (
              <li key={dispute.id}>
                <a href={`/disputes/${dispute.id}`}>
                  {dispute.title} (€{dispute.amount.toFixed(2)})
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        onClick={() => navigate('/disputes')}
        style={styles.viewAllButton}
      >
        View All Disputes →
      </button>
    </>
  )}
</div>
```

#### 3.2 Disputes List Page

**File:** `frontend/src/pages/Disputes.tsx` (NEW)

```typescript
// Full disputes management page with:
// - Filterable list
// - Status badges
// - Create dispute modal
// - Bulk actions

export default function Disputes() {
  // Similar structure to Invoices page
  // Table showing: ID, Invoice #, Supplier, Type, Amount, Status, Opened Date
  // Click row to see detail modal
  // Filters: Status, Priority, Date Range, Supplier
}
```

#### 3.3 Add Dispute Button on Invoice Detail

**File:** `frontend/src/pages/InvoiceDetail.tsx` (UPDATE)

Add "Log Dispute" button to invoice detail page:

```typescript
<button
  onClick={() => setShowDisputeModal(true)}
  style={styles.disputeButton}
>
  ⚠️ Log Dispute
</button>

{showDisputeModal && (
  <CreateDisputeModal
    invoice={invoice}
    onClose={() => setShowDisputeModal(false)}
    onSuccess={() => {
      setShowDisputeModal(false)
      queryClient.invalidateQueries(['disputes'])
    }}
  />
)}
```

## Success Criteria

✅ Users can log disputes from invoice detail page
✅ Disputes tracked by type, status, priority
✅ Financial impact calculated and visible
✅ Photos, emails, delivery notes attachable
✅ Activity timeline shows full dispute history
✅ Dashboard widget shows open dispute count
✅ Credit notes linkable to disputes
✅ Disputes filterable and searchable
✅ Reports show dispute patterns by supplier

## Future Enhancements

1. **Email Integration** - Send dispute emails to suppliers from app
2. **Recurring Issue Detection** - Flag suppliers with high dispute rates
3. **Dispute Templates** - Quick dispute creation for common issues
4. **Batch Disputes** - Log multiple disputes across invoices
5. **Analytics Dashboard** - Dispute trends, supplier scorecards
6. **Automated Reminders** - Follow-up notifications for open disputes
7. **Contract Integration** - Link to price agreements for validation
