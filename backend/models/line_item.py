from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Integer, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class LineItem(Base):
    __tablename__ = "line_items"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"),
        nullable=False,
        index=True
    )

    # Core fields from Azure extraction
    product_code: Mapped[str] = mapped_column(String(100), nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    description_alt: Mapped[str] = mapped_column(Text, nullable=True)  # Alternative description (Azure content vs value mismatch)
    unit: Mapped[str] = mapped_column(String(50), nullable=True)  # Unit of measure (UN, Box, KG, etc.)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=True)  # Delivered quantity
    order_quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=True)  # Ordered quantity
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)
    tax_rate: Mapped[str] = mapped_column(String(50), nullable=True)  # VAT rate (ZERO, 20.00, No VAT, etc.)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)  # VAT amount
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)  # Net line total

    # Ordering for display
    line_number: Mapped[int] = mapped_column(Integer, default=0)

    # Non-stock flag (excluded from GP calculations)
    is_non_stock: Mapped[bool] = mapped_column(Boolean, default=False)

    # Raw OCR content for this line item (used for pack size parsing)
    raw_content: Mapped[str] = mapped_column(Text, nullable=True)

    # Pack size fields (parsed from raw_content or manually edited)
    pack_quantity: Mapped[int] = mapped_column(Integer, nullable=True)  # e.g., 120 for "120x15g"
    unit_size: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=True)  # e.g., 15 for "120x15g"
    unit_size_type: Mapped[str] = mapped_column(String(10), nullable=True)  # e.g., "g", "kg", "ml", "ltr"
    portions_per_unit: Mapped[int] = mapped_column(Integer, nullable=True)  # User-editable servings per unit (null = not defined)

    # Calculated cost fields
    cost_per_item: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=True)  # unit_price / pack_quantity
    cost_per_portion: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=True)  # unit_price / (pack_quantity * portions_per_unit)

    # OCR warnings (e.g., "quantity capped from 11112121115 to 999999")
    ocr_warnings: Mapped[str] = mapped_column(Text, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationship
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="line_items")


from .invoice import Invoice
