"""
Logbook models for tracking wastage, transfers, staff food, and manual adjustments.
"""
from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Boolean, Text, Integer, Index, Enum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
import enum


class EntryType(str, enum.Enum):
    WASTAGE = "wastage"
    TRANSFER = "transfer"
    STAFF_FOOD = "staff_food"
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
    # Wastage: {reason: "spoiled"}
    # Transfer: {destination_kitchen_id: 2, status: "pending"}
    # Staff food: {meal_type: "lunch", staff_count: 3}
    # Manual adjustment: {adjustment_reason: "...", original_invoice_id: 123}
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
        "LogbookLineItem", back_populates="entry", cascade="all, delete-orphan", lazy="selectin"
    )
    attachments: Mapped[list["LogbookAttachment"]] = relationship(
        "LogbookAttachment", back_populates="entry", cascade="all, delete-orphan", lazy="selectin"
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
    # TODO: Add ForeignKey when Product model is created
    product_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Product details (denormalized for historical accuracy)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    supplier_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Quantity and cost
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(50), nullable=True)  # kg, litres, each
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    total_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # Additional data
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    entry: Mapped["LogbookEntry"] = relationship("LogbookEntry", back_populates="line_items")
    # product: Mapped["Product"] = relationship("Product", lazy="selectin")  # TODO: Add Product model
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")


class LogbookAttachment(Base):
    """Photos and documents attached to logbook entries"""
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


# Forward references
from .user import Kitchen, User
