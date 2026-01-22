"""
Dispute tracking models for invoice issues.

Handles:
- Invoice disputes (price discrepancies, short deliveries, quality issues, etc.)
- Dispute line items (specific products in dispute)
- Dispute attachments (photos, emails, delivery notes)
- Dispute activity log (audit trail)
- Credit notes (supplier credits for resolving disputes)
"""
from datetime import datetime, date
from decimal import Decimal
import enum
from typing import TYPE_CHECKING

from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, Integer, Enum as SQLEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base

if TYPE_CHECKING:
    from models.user import User, Kitchen
    from models.invoice import Invoice
    from models.line_item import LineItem
    from models.supplier import Supplier


class DisputeType(str, enum.Enum):
    """Types of disputes that can be raised"""
    PRICE_DISCREPANCY = "price_discrepancy"
    SHORT_DELIVERY = "short_delivery"
    WRONG_PRODUCT = "wrong_product"
    QUALITY_ISSUE = "quality_issue"
    CALCULATION_ERROR = "calculation_error"
    MISSING_ITEMS = "missing_items"
    DAMAGED_GOODS = "damaged_goods"
    OTHER = "other"


class DisputeStatus(str, enum.Enum):
    """Dispute workflow statuses"""
    NEW = "NEW"  # Initial state (no action taken yet)
    OPEN = "OPEN"  # Legacy - migrated to NEW
    CONTACTED = "CONTACTED"  # Supplier has been contacted
    IN_PROGRESS = "IN_PROGRESS"  # Actively being worked on
    AWAITING_CREDIT = "AWAITING_CREDIT"  # Waiting for credit note
    AWAITING_REPLACEMENT = "AWAITING_REPLACEMENT"  # Waiting for replacement goods
    RESOLVED = "RESOLVED"  # Dispute resolved
    CLOSED = "CLOSED"  # Dispute closed
    ESCALATED = "ESCALATED"  # Escalated to manager/higher authority


class DisputePriority(str, enum.Enum):
    """Dispute priority levels"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class InvoiceDispute(Base):
    """Main dispute record for tracking invoice issues"""
    __tablename__ = "invoice_disputes"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), nullable=False, index=True)

    # Dispute classification
    dispute_type: Mapped[DisputeType] = mapped_column(SQLEnum(DisputeType), nullable=False, index=True)
    status: Mapped[DisputeStatus] = mapped_column(SQLEnum(DisputeStatus), default=DisputeStatus.NEW, index=True)
    priority: Mapped[DisputePriority] = mapped_column(SQLEnum(DisputePriority), default=DisputePriority.MEDIUM)

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
    credit_note: Mapped["CreditNote"] = relationship("CreditNote", back_populates="dispute", uselist=False)
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
    invoice_line_item_id: Mapped[int | None] = mapped_column(ForeignKey("line_items.id"), nullable=True)

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
    invoice_line_item: Mapped["LineItem"] = relationship("LineItem")


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

    # File storage (following Invoice model pattern)
    file_storage_location: Mapped[str] = mapped_column(String(20), default="local")  # "local" or "nextcloud"
    nextcloud_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

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

    # Document storage (following Invoice model pattern)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_storage_location: Mapped[str] = mapped_column(String(20), default="local")  # "local" or "nextcloud"
    nextcloud_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    original_local_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Audit
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="credit_notes")
    supplier: Mapped["Supplier"] = relationship("Supplier")
    created_by_user: Mapped["User"] = relationship("User")
    dispute: Mapped["InvoiceDispute"] = relationship("InvoiceDispute", back_populates="credit_note", uselist=False)
