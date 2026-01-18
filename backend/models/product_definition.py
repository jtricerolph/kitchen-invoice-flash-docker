from datetime import datetime
from decimal import Decimal
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class ProductDefinition(Base):
    """
    Stores persistent portion/pack size definitions for products.
    When a product appears on a new invoice, these definitions are auto-applied
    so staff don't need to re-enter portions_per_unit every time.
    """
    __tablename__ = "product_definitions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(
        ForeignKey("kitchens.id"),
        nullable=False,
        index=True
    )
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("suppliers.id"),
        nullable=True,  # Can be null for kitchen-wide definitions
        index=True
    )

    # Product identification
    product_code: Mapped[str] = mapped_column(String(100), nullable=True)
    description_pattern: Mapped[str] = mapped_column(String(255), nullable=True)  # For fuzzy matching

    # Pack size info (can override OCR-parsed values)
    pack_quantity: Mapped[int] = mapped_column(Integer, nullable=True)
    unit_size: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=True)
    unit_size_type: Mapped[str] = mapped_column(String(10), nullable=True)  # g, kg, ml, ltr, oz, cl

    # Portion info (the key persistent data)
    portions_per_unit: Mapped[int] = mapped_column(Integer, nullable=True)
    portion_description: Mapped[str] = mapped_column(String(100), nullable=True)  # e.g., "250ml glass", "50g serving"

    # Saved by metadata - who saved this definition and from which invoice
    saved_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"),
        nullable=True
    )
    source_invoice_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("invoices.id", ondelete="SET NULL"),
        nullable=True
    )

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    supplier: Mapped["Supplier"] = relationship("Supplier")
    saved_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[saved_by_user_id])
    source_invoice: Mapped[Optional["Invoice"]] = relationship("Invoice", foreign_keys=[source_invoice_id])

    # Unique constraint: one definition per product_code per supplier per kitchen
    __table_args__ = (
        UniqueConstraint('kitchen_id', 'supplier_id', 'product_code', name='uix_product_definition'),
    )


from .user import Kitchen, User
from .supplier import Supplier
from .invoice import Invoice
