"""
Models for cover override and forecast snapshot tables.

Tables:
- cover_overrides: Per-day per-period cover overrides (lunch/dinner)
- forecast_snapshots: Per-day per-period snapshot of forecast at snapshot time
- forecast_week_snapshots: Weekly revenue totals at snapshot time
- spend_rate_overrides: Per-week per-period spend rate overrides
"""
from sqlalchemy import Column, Integer, String, Numeric, Date, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.sql import func
from database import Base


class CoverOverride(Base):
    __tablename__ = "cover_overrides"

    id = Column(Integer, primary_key=True)
    kitchen_id = Column(Integer, ForeignKey("kitchens.id"), nullable=False)
    override_date = Column(Date, nullable=False)
    period = Column(String(20), nullable=False)  # 'lunch' or 'dinner'
    override_covers = Column(Integer, nullable=False)  # target total covers (0 = expect zero)
    original_forecast = Column(Integer)  # snapshot at creation time
    original_otb = Column(Integer)  # snapshot at creation time
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, server_default=func.now())
    updated_by = Column(Integer, ForeignKey("users.id"))
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("kitchen_id", "override_date", "period", name="uq_cover_override_date_period"),
    )


class ForecastSnapshot(Base):
    __tablename__ = "forecast_snapshots"

    id = Column(Integer, primary_key=True)
    kitchen_id = Column(Integer, ForeignKey("kitchens.id"), nullable=False)
    snapshot_date = Column(Date, nullable=False)  # the forecasted date
    period = Column(String(20), nullable=False)  # 'breakfast', 'lunch', or 'dinner'
    forecast_covers = Column(Integer, nullable=False)  # total forecast (otb+pickup)
    otb_covers = Column(Integer, nullable=False)  # OTB at snapshot time
    food_spend = Column(Numeric(10, 2))  # food spend per cover (net ex VAT)
    drinks_spend = Column(Numeric(10, 2))  # drinks spend per cover (net ex VAT)
    forecast_dry_revenue = Column(Numeric(10, 2))  # forecast dry revenue for this day/period
    week_start = Column(Date, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("kitchen_id", "snapshot_date", "period", name="uq_forecast_snapshot_date_period"),
    )


class ForecastWeekSnapshot(Base):
    __tablename__ = "forecast_week_snapshots"

    id = Column(Integer, primary_key=True)
    kitchen_id = Column(Integer, ForeignKey("kitchens.id"), nullable=False)
    week_start = Column(Date, nullable=False)
    total_forecast_revenue = Column(Numeric(12, 2))  # total dry revenue for the week
    total_otb_revenue = Column(Numeric(12, 2))  # OTB-only revenue for the week
    gp_target = Column(Numeric(5, 2))  # GP target % at snapshot time
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("kitchen_id", "week_start", name="uq_forecast_week_snapshot"),
    )


class SpendRateOverride(Base):
    __tablename__ = "spend_rate_overrides"

    id = Column(Integer, primary_key=True)
    kitchen_id = Column(Integer, ForeignKey("kitchens.id"), nullable=False)
    week_start = Column(Date, nullable=False)
    period = Column(String(20), nullable=False)  # 'breakfast', 'lunch', or 'dinner'
    food_spend = Column(Numeric(10, 2))  # overridden food spend per cover (NULL = use snapshot/API)
    drinks_spend = Column(Numeric(10, 2))  # overridden drinks spend per cover (NULL = use snapshot/API)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, server_default=func.now())
    updated_by = Column(Integer, ForeignKey("users.id"))
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("kitchen_id", "week_start", "period", name="uq_spend_rate_override"),
    )
