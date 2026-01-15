from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base
import enum


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
    total: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)

    # OCR metadata
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)
    ocr_raw_text: Mapped[str] = mapped_column(Text, nullable=True)
    ocr_confidence: Mapped[float] = mapped_column(Numeric(5, 4), nullable=True)  # 0.0000 to 1.0000

    # Status tracking
    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus),
        default=InvoiceStatus.PENDING
    )

    # Category for GP breakdown (e.g., "food", "supplies", "beverages")
    category: Mapped[str] = mapped_column(String(50), nullable=True, default="food")

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="invoices")
    supplier: Mapped["Supplier"] = relationship("Supplier", back_populates="invoices")


# Forward references
from .user import Kitchen
from .supplier import Supplier
