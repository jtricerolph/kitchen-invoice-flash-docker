# Plan 4: Wastage/Transfer/Staff Food Logbook System

## Current State

### Existing Features
The application currently has:
- Invoice processing with Dext integration
- Supplier management
- Product catalog
- Stock tracking via invoices
- SambaPOS integration for sales data

### What's Missing
No system exists for recording:
- Wastage (spoiled, damaged, expired products)
- Transfers between sites/kitchens
- Staff meals (complimentary food usage)
- Petty cash purchases (small items not in Dext)
- Manual quantity adjustments

**Problem:** Stock reconciliation impossible without tracking these non-invoice movements.

## User Requirements

From debug_notes.txt:
> "logbook for wastage/transfer/staff food, a line item search to add manually, and also an option to just upload a petty cash pdf receipt if it's for a petty cash item that bypasses the full dext process"

**Key Features:**
1. **Wastage Entry:** Record items thrown away
2. **Transfer Entry:** Move stock between locations
3. **Staff Food Entry:** Track complimentary meals
4. **Line Item Search:** Find products from catalog
5. **Manual Entry:** Add items not in catalog
6. **Petty Cash Upload:** Quick PDF upload without Dext processing
7. **Historical Log:** View all movements with filters

## Use Cases

### Use Case 1: Record Spoiled Produce
**Actor:** Kitchen Manager
**Flow:**
1. Morning check finds 2kg of spoiled tomatoes
2. Open Wastage Logbook
3. Click "Add Wastage Entry"
4. Search for "tomatoes" in product catalog
5. Select "Tomatoes, Salad, Red (per kg)"
6. Enter quantity: 2
7. Select reason: "Spoiled"
8. Add photo of waste (optional)
9. Add note: "Fridge temperature issue overnight"
10. Save entry

**Result:** Stock reduced by 2kg tomatoes, wastage report shows €6.50 loss

### Use Case 2: Transfer to Sister Site
**Actor:** Operations Manager
**Flow:**
1. Need to send 5kg flour to sister property
2. Open Logbook → Transfers
3. Click "New Transfer"
4. Select destination kitchen from dropdown
5. Search for "flour"
6. Add multiple items to transfer
7. Enter reference number (transfer note #)
8. Save transfer

**Result:** Stock reduced at source kitchen, email notification to destination

### Use Case 3: Staff Meal
**Actor:** Head Chef
**Flow:**
1. Staff ate 3 portions of lasagna for lunch
2. Open Logbook → Staff Food
3. Search "lasagna" (might be in catalog or SambaPOS menu)
4. Enter 3 portions
5. Select staff members (optional)
6. Save

**Result:** Stock reduced, staff food cost tracked

### Use Case 4: Petty Cash Purchase
**Actor:** Kitchen Manager
**Flow:**
1. Bought cleaning supplies at local store for €15
2. Has paper receipt
3. Open Logbook → Petty Cash
4. Click "Upload Receipt"
5. Select PDF/photo of receipt
6. Enter total amount: €15.00
7. Select category: "Cleaning Supplies"
8. Enter brief description
9. Save (skips Dext entirely)

**Result:** Expense recorded, PDF stored, shows in reports

### Use Case 5: Manual Price Adjustment
**Actor:** Accountant
**Flow:**
1. Discover invoice price error: tomatoes charged €3/kg instead of €2.50/kg
2. Open Logbook → Manual Adjustments
3. Search invoice line item
4. Record adjustment: -€0.50/kg
5. Enter reason: "Price correction - invoice error"
6. Link to original invoice
7. Save

**Result:** Cost corrected in reports, audit trail maintained

## Architecture

### Data Model

```
┌─────────────────────────────────────────────────────┐
│              LogbookEntry (Base)                    │
│  - id, kitchen_id, entry_date, entry_type           │
│  - created_by, created_at                           │
│  - notes, reference_number                          │
└─────────────────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
        ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Wastage    │ │   Transfer   │ │ Staff Food   │ │  Petty Cash  │
│              │ │              │ │              │ │              │
│ - reason     │ │ - dest_id    │ │ - staff_ids  │ │ - pdf_path   │
│ - photo_path │ │ - status     │ │ - meal_type  │ │ - category   │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

Each entry type has:
┌─────────────────────────────────────────────────────┐
│            LogbookLineItem                          │
│  - entry_id, product_id                             │
│  - quantity, unit_price, total_cost                 │
│  - product_name (denormalized)                      │
└─────────────────────────────────────────────────────┘
```

### Component Architecture

```
Frontend:
┌──────────────────────────────────────────┐
│  Wastage Logbook Page                    │
│  ├─ Entry Type Tabs (Wastage/Transfer/   │
│  │                     Staff/Petty Cash)  │
│  ├─ Entry List (filterable, searchable)  │
│  ├─ Add Entry Modal                      │
│  │  ├─ Product Search (autocomplete)     │
│  │  ├─ Quantity Input                    │
│  │  ├─ Photo Upload (optional)           │
│  │  └─ Notes                             │
│  └─ Entry Detail View                    │
└──────────────────────────────────────────┘

Backend:
┌──────────────────────────────────────────┐
│  /api/logbook                            │
│  ├─ GET /entries (list with filters)     │
│  ├─ POST /entries/wastage                │
│  ├─ POST /entries/transfer               │
│  ├─ POST /entries/staff-food             │
│  ├─ POST /entries/petty-cash             │
│  ├─ GET /entries/{id}                    │
│  ├─ PUT /entries/{id}                    │
│  └─ DELETE /entries/{id}                 │
└──────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Database Schema

#### 1.1 Create Logbook Tables

**File:** `backend/models/logbook.py` (NEW)

```python
from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Boolean, Text, Integer, UniqueConstraint, Index, Enum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
import enum

class EntryType(str, enum.Enum):
    WASTAGE = "wastage"
    TRANSFER = "transfer"
    STAFF_FOOD = "staff_food"
    PETTY_CASH = "petty_cash"
    MANUAL_ADJUSTMENT = "manual_adjustment"

class WastageReason(str, enum.Enum):
    SPOILED = "spoiled"
    DAMAGED = "damaged"
    EXPIRED = "expired"
    OVERPRODUCTION = "overproduction"
    QUALITY_ISSUE = "quality_issue"
    OTHER = "other"

class TransferStatus(str, enum.Enum):
    PENDING = "pending"
    IN_TRANSIT = "in_transit"
    RECEIVED = "received"
    CANCELLED = "cancelled"

class LogbookEntry(Base):
    """Base table for all logbook entries"""
    __tablename__ = "logbook_entries"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Entry metadata
    entry_type: Mapped[EntryType] = mapped_column(Enum(EntryType), nullable=False, index=True)
    entry_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    reference_number: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # Type-specific data (stored as JSONB for flexibility)
    type_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default={})

    # Common fields
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0.0)  # Calculated from line items

    # Audit fields
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Soft delete
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="logbook_entries")
    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by])
    line_items: Mapped[list["LogbookLineItem"]] = relationship(
        "LogbookLineItem", back_populates="entry", cascade="all, delete-orphan"
    )
    attachments: Mapped[list["LogbookAttachment"]] = relationship(
        "LogbookAttachment", back_populates="entry", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index('idx_logbook_kitchen_date', 'kitchen_id', 'entry_date'),
        Index('idx_logbook_type', 'kitchen_id', 'entry_type', 'entry_date'),
    )


class LogbookLineItem(Base):
    """Line items for logbook entries (products/items)"""
    __tablename__ = "logbook_line_items"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("logbook_entries.id"), nullable=False, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Product reference (nullable for manual entries)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)

    # Product details (denormalized for historical accuracy)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    supplier_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Quantity and cost
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(50), nullable=True)  # kg, litres, each
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    total_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # Additional data
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    entry: Mapped["LogbookEntry"] = relationship("LogbookEntry", back_populates="line_items")
    product: Mapped["Product"] = relationship("Product")
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")


class LogbookAttachment(Base):
    """Photos and PDFs attached to logbook entries"""
    __tablename__ = "logbook_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    entry_id: Mapped[int] = mapped_column(ForeignKey("logbook_entries.id"), nullable=False, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # File details
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)  # Relative path in storage
    file_type: Mapped[str] = mapped_column(String(50), nullable=False)  # image/jpeg, application/pdf
    file_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    # Metadata
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    entry: Mapped["LogbookEntry"] = relationship("LogbookEntry", back_populates="attachments")
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    uploaded_by_user: Mapped["User"] = relationship("User")


# Relationships to add to existing models:

# In backend/models/user.py - Kitchen class:
# logbook_entries: Mapped[list["LogbookEntry"]] = relationship("LogbookEntry", back_populates="kitchen")

# In backend/models/user.py - User class:
# logbook_entries_created: Mapped[list["LogbookEntry"]] = relationship("LogbookEntry", foreign_keys="LogbookEntry.created_by")
```

#### 1.2 Create Migration

**File:** `backend/migrations/add_logbook.py` (NEW)

```python
import asyncio
import logging
from sqlalchemy import text
from database import engine

logger = logging.getLogger(__name__)

async def run_migration():
    """Create logbook tables"""

    create_enum_sql = """
    DO $$ BEGIN
        CREATE TYPE entry_type AS ENUM (
            'wastage', 'transfer', 'staff_food', 'petty_cash', 'manual_adjustment'
        );
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
        CREATE TYPE wastage_reason AS ENUM (
            'spoiled', 'damaged', 'expired', 'overproduction', 'quality_issue', 'other'
        );
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;

    DO $$ BEGIN
        CREATE TYPE transfer_status AS ENUM (
            'pending', 'in_transit', 'received', 'cancelled'
        );
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;
    """

    # Tables created by SQLAlchemy Base.metadata.create_all()

    try:
        async with engine.begin() as conn:
            await conn.execute(text(create_enum_sql))
            logger.info("Created logbook enums")

            # Tables will be created by SQLAlchemy
            logger.info("Logbook migration completed")
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise
        logger.warning(f"Logbook migration: {e}")

if __name__ == "__main__":
    asyncio.run(run_migration())
```

### Phase 2: Backend API

#### 2.1 Create Logbook API

**File:** `backend/api/logbook.py` (NEW)

```python
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func
from datetime import date, datetime
from typing import Optional, List
from pydantic import BaseModel
from decimal import Decimal

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.logbook import (
    LogbookEntry, LogbookLineItem, LogbookAttachment,
    EntryType, WastageReason, TransferStatus
)
from models.products import Product

router = APIRouter(prefix="/logbook", tags=["Logbook"])


# Pydantic Schemas

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
    status: TransferStatus
    line_items: List[LineItemInput]
    notes: Optional[str] = None
    reference_number: Optional[str] = None


class StaffFoodEntryInput(BaseModel):
    entry_date: date
    meal_type: str  # breakfast, lunch, dinner, snack
    staff_ids: Optional[List[int]] = None
    line_items: List[LineItemInput]
    notes: Optional[str] = None


class PettyCashEntryInput(BaseModel):
    entry_date: date
    category: str
    total_amount: float
    description: str
    notes: Optional[str] = None


class ManualAdjustmentInput(BaseModel):
    entry_date: date
    adjustment_reason: str
    original_invoice_id: Optional[int] = None
    line_items: List[LineItemInput]
    notes: Optional[str] = None


class LogbookEntryResponse(BaseModel):
    id: int
    entry_type: str
    entry_date: str
    reference_number: Optional[str]
    total_cost: float
    notes: Optional[str]
    type_data: dict
    created_by: int
    created_at: str
    line_items: List[dict]
    attachments: List[dict]


# Endpoints

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

    query = select(LogbookEntry).where(
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
        query = query.join(LogbookLineItem).where(
            or_(
                LogbookEntry.notes.ilike(f"%{search}%"),
                LogbookEntry.reference_number.ilike(f"%{search}%"),
                LogbookLineItem.product_name.ilike(f"%{search}%")
            )
        )

    query = query.order_by(LogbookEntry.entry_date.desc(), LogbookEntry.created_at.desc())
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    entries = result.scalars().all()

    return [
        LogbookEntryResponse(
            id=entry.id,
            entry_type=entry.entry_type.value,
            entry_date=entry.entry_date.isoformat(),
            reference_number=entry.reference_number,
            total_cost=float(entry.total_cost),
            notes=entry.notes,
            type_data=entry.type_data,
            created_by=entry.created_by,
            created_at=entry.created_at.isoformat(),
            line_items=[
                {
                    "id": item.id,
                    "product_name": item.product_name,
                    "quantity": float(item.quantity),
                    "unit": item.unit,
                    "unit_price": float(item.unit_price) if item.unit_price else None,
                    "total_cost": float(item.total_cost)
                }
                for item in entry.line_items
            ],
            attachments=[
                {
                    "id": att.id,
                    "file_name": att.file_name,
                    "file_path": att.file_path,
                    "file_type": att.file_type
                }
                for att in entry.attachments
            ]
        )
        for entry in entries
    ]


@router.post("/wastage")
async def create_wastage_entry(
    entry_input: WastageEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create wastage entry"""

    # Create entry
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

    # Add line items
    total_cost = Decimal(0)
    for item_input in entry_input.line_items:
        line_item = LogbookLineItem(
            entry_id=entry.id,
            kitchen_id=current_user.kitchen_id,
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

    entry.total_cost = total_cost
    await db.commit()
    await db.refresh(entry)

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/transfer")
async def create_transfer_entry(
    entry_input: TransferEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create transfer entry"""

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

    total_cost = Decimal(0)
    for item_input in entry_input.line_items:
        line_item = LogbookLineItem(
            entry_id=entry.id,
            kitchen_id=current_user.kitchen_id,
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

    entry.total_cost = total_cost
    await db.commit()
    await db.refresh(entry)

    # TODO: Send notification to destination kitchen

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/staff-food")
async def create_staff_food_entry(
    entry_input: StaffFoodEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create staff food entry"""

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.STAFF_FOOD,
        entry_date=entry_input.entry_date,
        notes=entry_input.notes,
        type_data={
            "meal_type": entry_input.meal_type,
            "staff_ids": entry_input.staff_ids or []
        },
        created_by=current_user.id
    )

    db.add(entry)
    await db.flush()

    total_cost = Decimal(0)
    for item_input in entry_input.line_items:
        line_item = LogbookLineItem(
            entry_id=entry.id,
            kitchen_id=current_user.kitchen_id,
            product_id=item_input.product_id,
            product_name=item_input.product_name,
            quantity=Decimal(str(item_input.quantity)),
            unit=item_input.unit,
            unit_price=Decimal(str(item_input.unit_price)) if item_input.unit_price else None,
            total_cost=Decimal(str(item_input.total_cost))
        )
        db.add(line_item)
        total_cost += line_item.total_cost

    entry.total_cost = total_cost
    await db.commit()
    await db.refresh(entry)

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/petty-cash")
async def create_petty_cash_entry(
    entry_input: PettyCashEntryInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LogbookEntryResponse:
    """Create petty cash entry"""

    entry = LogbookEntry(
        kitchen_id=current_user.kitchen_id,
        entry_type=EntryType.PETTY_CASH,
        entry_date=entry_input.entry_date,
        notes=entry_input.notes,
        type_data={
            "category": entry_input.category,
            "description": entry_input.description
        },
        total_cost=Decimal(str(entry_input.total_amount)),
        created_by=current_user.id
    )

    db.add(entry)
    await db.commit()
    await db.refresh(entry)

    return await get_logbook_entry(entry.id, current_user, db)


@router.post("/{entry_id}/attachments")
async def upload_attachment(
    entry_id: int,
    file: UploadFile = File(...),
    description: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload photo or PDF to logbook entry"""

    # Verify entry exists and belongs to user's kitchen
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

    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/heic", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"File type {file.content_type} not allowed")

    # Save file
    import os
    upload_dir = f"/app/attachments/logbook/kitchen_{current_user.kitchen_id}"
    os.makedirs(upload_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_extension = os.path.splitext(file.filename)[1]
    file_name = f"entry_{entry_id}_{timestamp}{file_extension}"
    file_path = f"{upload_dir}/{file_name}"

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Create attachment record
    attachment = LogbookAttachment(
        entry_id=entry_id,
        kitchen_id=current_user.kitchen_id,
        file_name=file.filename,
        file_path=file_path,
        file_type=file.content_type,
        file_size_bytes=len(content),
        description=description,
        uploaded_by=current_user.id
    )

    db.add(attachment)
    await db.commit()

    return {"id": attachment.id, "file_name": file_name}


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

    return LogbookEntryResponse(
        id=entry.id,
        entry_type=entry.entry_type.value,
        entry_date=entry.entry_date.isoformat(),
        reference_number=entry.reference_number,
        total_cost=float(entry.total_cost),
        notes=entry.notes,
        type_data=entry.type_data,
        created_by=entry.created_by,
        created_at=entry.created_at.isoformat(),
        line_items=[
            {
                "id": item.id,
                "product_id": item.product_id,
                "product_name": item.product_name,
                "product_code": item.product_code,
                "supplier_name": item.supplier_name,
                "quantity": float(item.quantity),
                "unit": item.unit,
                "unit_price": float(item.unit_price) if item.unit_price else None,
                "total_cost": float(item.total_cost),
                "notes": item.notes
            }
            for item in entry.line_items
        ],
        attachments=[
            {
                "id": att.id,
                "file_name": att.file_name,
                "file_path": att.file_path,
                "file_type": att.file_type,
                "file_size_bytes": att.file_size_bytes,
                "description": att.description,
                "uploaded_at": att.uploaded_at.isoformat()
            }
            for att in entry.attachments
        ]
    )


@router.put("/{entry_id}")
async def update_logbook_entry(
    entry_id: int,
    notes: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update logbook entry (limited fields)"""

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

    if notes is not None:
        entry.notes = notes

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

    return {"status": "deleted"}


@router.get("/products/search")
async def search_products(
    query: str,
    limit: int = 20,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Search products for line item entry"""

    result = await db.execute(
        select(Product).where(
            and_(
                Product.kitchen_id == current_user.kitchen_id,
                or_(
                    Product.name.ilike(f"%{query}%"),
                    Product.product_code.ilike(f"%{query}%")
                )
            )
        ).limit(limit)
    )
    products = result.scalars().all()

    return [
        {
            "id": p.id,
            "name": p.name,
            "product_code": p.product_code,
            "supplier_name": p.supplier.name if p.supplier else None,
            "unit": p.unit,
            "last_price": float(p.last_price) if p.last_price else None
        }
        for p in products
    ]
```

### Phase 3: Frontend Implementation

#### 3.1 Logbook Page

**File:** `frontend/src/pages/WastageLogbook.tsx` (NEW)

```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../App'

type EntryType = 'wastage' | 'transfer' | 'staff_food' | 'petty_cash' | 'manual_adjustment'

interface LogbookEntry {
  id: number
  entry_type: string
  entry_date: string
  reference_number?: string
  total_cost: number
  notes?: string
  type_data: Record<string, any>
  created_at: string
  line_items: LineItem[]
  attachments: Attachment[]
}

interface LineItem {
  id: number
  product_name: string
  quantity: number
  unit?: string
  unit_price?: number
  total_cost: number
}

interface Attachment {
  id: number
  file_name: string
  file_path: string
  file_type: string
}

export default function WastageLogbook() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const [selectedType, setSelectedType] = useState<EntryType>('wastage')
  const [showAddModal, setShowAddModal] = useState(false)
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])

  const { data: entries, isLoading } = useQuery<LogbookEntry[]>({
    queryKey: ['logbook-entries', selectedType, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({
        entry_type: selectedType,
        date_from: dateFrom,
        date_to: dateTo
      })
      const res = await fetch(`/api/logbook?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error('Failed to fetch entries')
      return res.json()
    },
    staleTime: 2 * 60 * 1000
  })

  return (
    <div style={styles.container}>
      <h1>Wastage & Adjustments Logbook</h1>

      {/* Type Tabs */}
      <div style={styles.tabs}>
        <button
          onClick={() => setSelectedType('wastage')}
          style={{
            ...styles.tab,
            ...(selectedType === 'wastage' ? styles.tabActive : {})
          }}
        >
          Wastage
        </button>
        <button
          onClick={() => setSelectedType('transfer')}
          style={{
            ...styles.tab,
            ...(selectedType === 'transfer' ? styles.tabActive : {})
          }}
        >
          Transfers
        </button>
        <button
          onClick={() => setSelectedType('staff_food')}
          style={{
            ...styles.tab,
            ...(selectedType === 'staff_food' ? styles.tabActive : {})
          }}
        >
          Staff Food
        </button>
        <button
          onClick={() => setSelectedType('petty_cash')}
          style={{
            ...styles.tab,
            ...(selectedType === 'petty_cash' ? styles.tabActive : {})
          }}
        >
          Petty Cash
        </button>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={styles.input}
        />
        <span style={{ margin: '0 0.5rem' }}>to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={styles.input}
        />
        <button onClick={() => setShowAddModal(true)} style={styles.addButton}>
          + Add {selectedType.replace('_', ' ')} Entry
        </button>
      </div>

      {/* Entries List */}
      {isLoading ? (
        <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>
      ) : entries && entries.length > 0 ? (
        <div style={styles.entriesList}>
          {entries.map((entry) => (
            <div key={entry.id} style={styles.entryCard}>
              <div style={styles.entryHeader}>
                <div>
                  <strong>{entry.entry_date}</strong>
                  {entry.reference_number && (
                    <span style={{ marginLeft: '1rem', color: '#666' }}>
                      Ref: {entry.reference_number}
                    </span>
                  )}
                </div>
                <div style={styles.costBadge}>
                  €{entry.total_cost.toFixed(2)}
                </div>
              </div>

              <div style={styles.entryBody}>
                {entry.line_items.map((item, idx) => (
                  <div key={idx} style={styles.lineItem}>
                    <span>{item.product_name}</span>
                    <span style={{ color: '#666' }}>
                      {item.quantity} {item.unit || ''}
                    </span>
                    <span>€{item.total_cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>

              {entry.notes && (
                <div style={styles.notes}>
                  <em>{entry.notes}</em>
                </div>
              )}

              {entry.attachments.length > 0 && (
                <div style={styles.attachments}>
                  {entry.attachments.map((att) => (
                    <span key={att.id} style={styles.attachmentBadge}>
                      📎 {att.file_name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
          No entries found for this period
        </div>
      )}

      {/* Add Entry Modal */}
      {showAddModal && (
        <AddEntryModal
          entryType={selectedType}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false)
            queryClient.invalidateQueries({ queryKey: ['logbook-entries'] })
          }}
        />
      )}
    </div>
  )
}

// Styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '1200px',
    margin: '0 auto'
  },
  tabs: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '1.5rem',
    borderBottom: '2px solid #e0e0e0'
  },
  tab: {
    padding: '0.75rem 1.5rem',
    background: 'none',
    border: 'none',
    borderBottom: '3px solid transparent',
    cursor: 'pointer',
    fontSize: '1rem',
    color: '#666'
  },
  tabActive: {
    color: '#667eea',
    borderBottomColor: '#667eea',
    fontWeight: '600'
  },
  filters: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '1.5rem',
    gap: '1rem'
  },
  input: {
    padding: '0.5rem',
    border: '1px solid #ddd',
    borderRadius: '4px'
  },
  addButton: {
    marginLeft: 'auto',
    padding: '0.75rem 1.5rem',
    background: '#667eea',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: '500'
  },
  entriesList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem'
  },
  entryCard: {
    background: 'white',
    padding: '1.5rem',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
  },
  entryHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '1rem',
    paddingBottom: '0.75rem',
    borderBottom: '1px solid #eee'
  },
  costBadge: {
    padding: '0.25rem 0.75rem',
    background: '#fff3cd',
    borderRadius: '4px',
    fontWeight: '600' as const
  },
  entryBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.5rem'
  },
  lineItem: {
    display: 'grid',
    gridTemplateColumns: '2fr 1fr 1fr',
    gap: '1rem',
    padding: '0.5rem',
    background: '#f9f9f9',
    borderRadius: '4px'
  },
  notes: {
    marginTop: '1rem',
    padding: '0.75rem',
    background: '#f0f0f0',
    borderRadius: '4px',
    color: '#666'
  },
  attachments: {
    marginTop: '1rem',
    display: 'flex',
    gap: '0.5rem'
  },
  attachmentBadge: {
    padding: '0.25rem 0.5rem',
    background: '#e7f5ff',
    borderRadius: '4px',
    fontSize: '0.85rem'
  }
}
```

*(AddEntryModal component would be a separate complex component with product search, quantity input, photo upload, etc.)*

### Phase 4: Reporting Integration

Add logbook entries to existing reports:
- Include wastage costs in cost of goods sold
- Show staff food as separate line item
- Display transfer amounts in multi-site reports
- Petty cash in expense reports

## Success Criteria

✅ Users can log wastage with photos
✅ Transfers recorded and destination notified
✅ Staff food tracked by meal type
✅ Petty cash receipts uploaded without Dext
✅ Product search autocomplete functional
✅ Manual entry for non-catalog items
✅ Historical log filterable by type, date, product
✅ Reports include logbook adjustments
✅ Mobile-friendly for quick entry on-site

## Future Enhancements

1. **Barcode Scanning** - Scan products to add quickly
2. **Recurring Entries** - Templates for regular staff meals
3. **Analytics Dashboard** - Wastage trends, top wasted items
4. **Approval Workflow** - Manager approval for high-value entries
5. **Integration with Stock System** - Auto-adjust stock levels
6. **Budget Tracking** - Wastage allowances and alerts
