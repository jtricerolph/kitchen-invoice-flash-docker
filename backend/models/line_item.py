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
    description: Mapped[str] = mapped_column(Text, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=True)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=True)
    product_code: Mapped[str] = mapped_column(String(100), nullable=True)

    # Ordering for display
    line_number: Mapped[int] = mapped_column(Integer, default=0)

    # Non-stock flag (excluded from GP calculations)
    is_non_stock: Mapped[bool] = mapped_column(Boolean, default=False)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationship
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="line_items")


from .invoice import Invoice
