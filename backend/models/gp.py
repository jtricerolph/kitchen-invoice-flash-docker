from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class RevenueEntry(Base):
    """Daily revenue entries for GP calculation"""
    __tablename__ = "revenue_entries"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)

    # Category breakdown (e.g., "food", "beverages", "other")
    category: Mapped[str] = mapped_column(String(50), default="total")

    notes: Mapped[str] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="revenue_entries")


class GPPeriod(Base):
    """Calculated GP for a specific period"""
    __tablename__ = "gp_periods"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Calculated values
    total_revenue: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    total_costs: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    gp_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    gp_percentage: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)

    # Breakdown by category (JSON)
    # {"food": {"revenue": 1000, "cost": 300, "gp": 70}, ...}
    category_breakdown: Mapped[dict | None] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="gp_periods")


# Forward reference
from .user import Kitchen
