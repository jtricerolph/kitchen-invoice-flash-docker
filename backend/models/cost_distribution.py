"""
Cost Distribution models for spreading/offsetting invoice costs to future dates.
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional
import enum
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, Integer, Index, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class DistributionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class DistributionMethod(str, enum.Enum):
    OFFSET = "OFFSET"           # Single date offset
    DISTRIBUTE = "DISTRIBUTE"   # Spread over DOW pattern


class CostDistribution(Base):
    """Header record for a cost distribution / cost spreading"""
    __tablename__ = "cost_distributions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), nullable=False)

    # Distribution metadata
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=DistributionStatus.ACTIVE.value)
    method: Mapped[str] = mapped_column(String(20), nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Financial totals
    total_distributed_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    remaining_balance: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    # Source offset date (= invoice.invoice_date)
    source_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Audit
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    cancelled_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    cancelled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    invoice: Mapped["Invoice"] = relationship("Invoice", back_populates="cost_distributions")
    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by])
    cancelled_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[cancelled_by])
    line_selections: Mapped[list["CostDistributionLineSelection"]] = relationship(
        "CostDistributionLineSelection",
        back_populates="distribution",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    entries: Mapped[list["CostDistributionEntry"]] = relationship(
        "CostDistributionEntry",
        back_populates="distribution",
        cascade="all, delete-orphan",
        order_by="CostDistributionEntry.entry_date",
        lazy="selectin",
    )

    __table_args__ = (
        Index("idx_cd_kitchen_status", "kitchen_id", "status"),
        Index("idx_cd_kitchen_invoice", "kitchen_id", "invoice_id"),
        Index("idx_cd_source_date", "kitchen_id", "source_date"),
    )


class CostDistributionLineSelection(Base):
    """Records which invoice line items (and what qty) are included in a distribution"""
    __tablename__ = "cost_distribution_line_selections"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    distribution_id: Mapped[int] = mapped_column(
        ForeignKey("cost_distributions.id", ondelete="CASCADE"), nullable=False
    )
    line_item_id: Mapped[int] = mapped_column(
        ForeignKey("line_items.id"), nullable=False
    )

    # How much of this line item is distributed
    selected_quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)  # Snapshot at creation
    distributed_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)  # qty * unit_price

    # Relationships
    distribution: Mapped["CostDistribution"] = relationship(
        "CostDistribution", back_populates="line_selections"
    )
    line_item: Mapped["LineItem"] = relationship("LineItem")


class CostDistributionEntry(Base):
    """Individual date entry in a cost distribution schedule"""
    __tablename__ = "cost_distribution_entries"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    distribution_id: Mapped[int] = mapped_column(
        ForeignKey("cost_distributions.id", ondelete="CASCADE"), nullable=False
    )
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    entry_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    # Negative amount on source_date (offset from invoice), positive on target dates

    is_source_offset: Mapped[bool] = mapped_column(Boolean, default=False)
    # True for the source_date entry (negative), False for target entries (positive)

    is_overpay: Mapped[bool] = mapped_column(Boolean, default=False)
    # True if this entry was created via settle early

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    distribution: Mapped["CostDistribution"] = relationship(
        "CostDistribution", back_populates="entries"
    )
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")

    __table_args__ = (
        Index("idx_cde_kitchen_date", "kitchen_id", "entry_date"),
        Index("idx_cde_distribution", "distribution_id", "entry_date"),
    )


# Forward references
from .user import Kitchen, User
from .invoice import Invoice
from .line_item import LineItem
