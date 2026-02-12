from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # Alternative names for this supplier (for OCR matching)
    # Example: ["US Foods Inc", "USF", "U.S. Foods"]
    aliases: Mapped[Optional[list]] = mapped_column(JSON, default=list)

    # Template configuration for OCR extraction patterns
    # Example: {"invoice_number": "INV-\\d+", "date": "\\d{2}/\\d{2}/\\d{4}", "total": "Total:\\s*£?([\\d,]+\\.\\d{2})"}
    template_config: Mapped[dict] = mapped_column(JSON, default=dict)

    # Identifier patterns to auto-detect this supplier from invoices
    # Example: {"keywords": ["Sysco", "SYSCO FOODS"], "logo_hash": "abc123"}
    identifier_config: Mapped[dict] = mapped_column(JSON, default=dict)

    # Skip sending invoices from this supplier to Dext
    skip_dext: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="suppliers")
    invoices: Mapped[list["Invoice"]] = relationship("Invoice", back_populates="supplier")
    purchase_orders: Mapped[list["PurchaseOrder"]] = relationship("PurchaseOrder", back_populates="supplier")


# Forward reference
from .user import Kitchen
from .invoice import Invoice
from .purchase_order import PurchaseOrder
