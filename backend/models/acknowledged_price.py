"""
AcknowledgedPrice model for tracking user-acknowledged price changes.

When a price change is detected and flagged, users can acknowledge it
to prevent it from being repeatedly flagged.
"""
from datetime import datetime
from decimal import Decimal
from sqlalchemy import ForeignKey, String, Text, Numeric, DateTime, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class AcknowledgedPrice(Base):
    """Tracks acknowledged price changes for line items."""
    __tablename__ = "acknowledged_prices"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"))
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"))

    # Product identification (same logic as line item consolidation)
    product_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # The acknowledged price point
    acknowledged_price: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    acknowledged_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    acknowledged_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    # Which invoice triggered this acknowledgement
    source_invoice_id: Mapped[int | None] = mapped_column(ForeignKey("invoices.id"), nullable=True)
    source_line_item_id: Mapped[int | None] = mapped_column(ForeignKey("line_items.id"), nullable=True)

    # Relationships
    kitchen = relationship("Kitchen", backref="acknowledged_prices")
    supplier = relationship("Supplier", backref="acknowledged_prices")
    acknowledged_by_user = relationship("User", backref="acknowledged_prices")
    source_invoice = relationship("Invoice", backref="acknowledged_prices")

    # Unique constraint: one acknowledged price per product per supplier per kitchen
    __table_args__ = (
        UniqueConstraint(
            'kitchen_id', 'supplier_id', 'product_code', 'description',
            name='uix_acknowledged_price'
        ),
    )

    def __repr__(self):
        return f"<AcknowledgedPrice {self.id}: {self.product_code or self.description} @ {self.acknowledged_price}>"
