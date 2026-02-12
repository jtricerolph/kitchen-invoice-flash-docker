"""
Purchase Order models for pre-allocating budget spend.
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, Integer, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), nullable=False)
    order_date: Mapped[date] = mapped_column(Date, nullable=False)
    order_type: Mapped[str] = mapped_column(String(20), nullable=False)  # 'itemised' or 'single_value'
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="DRAFT")
    total_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    order_reference: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    attachment_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    attachment_original_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    linked_invoice_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True
    )

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    supplier: Mapped["Supplier"] = relationship("Supplier", back_populates="purchase_orders")
    linked_invoice: Mapped[Optional["Invoice"]] = relationship("Invoice", foreign_keys=[linked_invoice_id])
    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by])
    updated_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[updated_by])
    line_items: Mapped[list["PurchaseOrderLineItem"]] = relationship(
        "PurchaseOrderLineItem",
        back_populates="purchase_order",
        cascade="all, delete-orphan",
        order_by="PurchaseOrderLineItem.line_number",
        lazy="selectin",
    )

    __table_args__ = (
        Index("idx_po_kitchen_date", "kitchen_id", "order_date"),
        Index("idx_po_kitchen_supplier", "kitchen_id", "supplier_id"),
        Index("idx_po_kitchen_status", "kitchen_id", "status"),
    )


class PurchaseOrderLineItem(Base):
    __tablename__ = "purchase_order_line_items"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    product_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    product_code: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    unit: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_number: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # 'search' or 'manual'
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    purchase_order: Mapped["PurchaseOrder"] = relationship("PurchaseOrder", back_populates="line_items")
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")


# Forward references
from .user import Kitchen, User
from .supplier import Supplier
from .invoice import Invoice
