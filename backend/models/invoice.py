from datetime import datetime, date
from decimal import Decimal
from typing import Optional, TYPE_CHECKING
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, Enum, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
import enum

if TYPE_CHECKING:
    from .line_item import LineItem


class InvoiceStatus(str, enum.Enum):
    PENDING = "pending"           # Uploaded, awaiting OCR
    PROCESSED = "processed"       # OCR complete, awaiting review
    REVIEWED = "reviewed"         # User has reviewed/corrected
    CONFIRMED = "confirmed"       # Confirmed and included in GP


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), nullable=True)

    # Extracted data
    invoice_number: Mapped[str] = mapped_column(String(100), nullable=True)
    invoice_date: Mapped[date] = mapped_column(Date, nullable=True)
    total: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)  # Gross total (inc. VAT)
    net_total: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)  # Net total (exc. VAT)
    vendor_name: Mapped[str] = mapped_column(String(255), nullable=True)  # OCR-extracted vendor name

    # Document type and order tracking
    document_type: Mapped[str] = mapped_column(String(50), nullable=True, default="invoice")
    order_number: Mapped[str] = mapped_column(String(100), nullable=True)

    # Duplicate detection
    duplicate_status: Mapped[str] = mapped_column(String(50), nullable=True)
    duplicate_of_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True
    )
    related_document_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True
    )

    # OCR metadata
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)
    ocr_raw_text: Mapped[str] = mapped_column(Text, nullable=True)
    ocr_raw_json: Mapped[str] = mapped_column(Text, nullable=True)  # Full Azure response JSON for debugging/remapping
    ocr_confidence: Mapped[float] = mapped_column(Numeric(5, 4), nullable=True)

    # Status tracking
    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus),
        default=InvoiceStatus.PENDING
    )

    # Category for GP breakdown
    category: Mapped[str] = mapped_column(String(50), nullable=True, default="food")

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="invoices")
    supplier: Mapped["Supplier"] = relationship("Supplier", back_populates="invoices")
    line_items: Mapped[list["LineItem"]] = relationship(
        "LineItem",
        back_populates="invoice",
        cascade="all, delete-orphan",
        order_by="LineItem.line_number"
    )

    # Self-referential relationships for duplicate tracking
    duplicate_of: Mapped[Optional["Invoice"]] = relationship(
        "Invoice",
        remote_side=[id],
        foreign_keys=[duplicate_of_id],
        uselist=False
    )
    related_document: Mapped[Optional["Invoice"]] = relationship(
        "Invoice",
        remote_side=[id],
        foreign_keys=[related_document_id],
        uselist=False
    )


# Forward references
from .user import Kitchen
from .supplier import Supplier
from .line_item import LineItem
