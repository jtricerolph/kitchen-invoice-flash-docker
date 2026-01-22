from datetime import datetime, date
from decimal import Decimal
from sqlalchemy import String, DateTime, Date, ForeignKey, Numeric, Boolean, Text, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class NewbookGLAccount(Base):
    """GL Accounts fetched from Newbook API"""
    __tablename__ = "newbook_gl_accounts"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    # Newbook GL Account identifiers
    gl_account_id: Mapped[str] = mapped_column(String(50), nullable=False)  # Newbook's internal ID
    gl_code: Mapped[str | None] = mapped_column(String(50), nullable=True)  # Account code
    gl_name: Mapped[str] = mapped_column(String(255), nullable=False)  # Account name/description
    gl_type: Mapped[str | None] = mapped_column(String(100), nullable=True)  # Account type from Newbook

    # Group info for categorization
    gl_group_id: Mapped[str | None] = mapped_column(String(50), nullable=True)  # Parent group ID
    gl_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)  # Parent group name (e.g., "FNB - Food & Beverage")

    # User selection
    is_tracked: Mapped[bool] = mapped_column(Boolean, default=False)  # User selected for revenue tracking
    display_order: Mapped[int] = mapped_column(Integer, default=0)  # Order in reports

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_gl_accounts")
    daily_revenue: Mapped[list["NewbookDailyRevenue"]] = relationship(
        "NewbookDailyRevenue", back_populates="gl_account", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'gl_account_id', name='uq_newbook_gl_account'),
    )


class NewbookDailyRevenue(Base):
    """Daily revenue amounts per GL account from Newbook"""
    __tablename__ = "newbook_daily_revenue"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    gl_account_id: Mapped[int] = mapped_column(ForeignKey("newbook_gl_accounts.id"), nullable=False)

    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    amount_net: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)  # Net/exc tax amount
    amount_gross: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # Gross/inc tax (if available)

    # Sync metadata
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_daily_revenue")
    gl_account: Mapped["NewbookGLAccount"] = relationship("NewbookGLAccount", back_populates="daily_revenue")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'gl_account_id', 'date', name='uq_newbook_revenue_per_day'),
    )


class NewbookDailyOccupancy(Base):
    """Daily occupancy and meal allocation data from Newbook"""
    __tablename__ = "newbook_daily_occupancy"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # Occupancy metrics
    total_rooms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    occupied_rooms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    occupancy_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    total_guests: Mapped[int | None] = mapped_column(Integer, nullable=True)  # People count

    # Meal allocation data (from booking inventory items)
    breakfast_allocation_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    breakfast_allocation_netvalue: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    dinner_allocation_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dinner_allocation_netvalue: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)

    # Arrival tracking (for cross-referencing with Resos table bookings)
    arrival_count: Mapped[int | None] = mapped_column(Integer, nullable=True)  # Number of bookings arriving this day
    arrival_booking_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # List of booking IDs arriving
    arrival_booking_details: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # Full arrival details with booking refs

    # Room-level breakdown (JSONB array) - array of {room_number, booking_id, is_dbb, is_package} for each occupied room
    rooms_breakdown: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Room-level details for residents table chart (DEPRECATED - use rooms_breakdown instead)
    room_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    booking_id: Mapped[str | None] = mapped_column(String(100), nullable=True)  # Newbook booking reference
    guest_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_dbb: Mapped[bool] = mapped_column(Boolean, default=False)  # Dinner Bed & Breakfast
    is_package: Mapped[bool] = mapped_column(Boolean, default=False)  # Package deal

    # Forecast indicator
    is_forecast: Mapped[bool] = mapped_column(Boolean, default=False)  # True for future booked dates

    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_daily_occupancy")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'date', name='uq_newbook_occupancy_per_day'),
    )


class NewbookSyncLog(Base):
    """Log of Newbook sync operations"""
    __tablename__ = "newbook_sync_log"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    sync_type: Mapped[str] = mapped_column(String(50), nullable=False)  # 'gl_accounts', 'revenue', 'occupancy'
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    status: Mapped[str] = mapped_column(String(20), default="running")  # running, success, failed
    records_fetched: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Date range for the sync (for revenue/occupancy)
    date_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_to: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_sync_logs")


class NewbookRoomCategory(Base):
    """Room types/categories aggregated from Newbook API (site_list)"""
    __tablename__ = "newbook_room_categories"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)

    # Room type identifiers (aggregated from site_list)
    site_id: Mapped[str] = mapped_column(String(50), nullable=False)  # Type name as ID
    site_name: Mapped[str] = mapped_column(String(255), nullable=False)  # Type name (e.g., "Standard Room")
    site_type: Mapped[str | None] = mapped_column(String(100), nullable=True)  # Same as site_name

    # Room count of this type
    room_count: Mapped[int] = mapped_column(Integer, default=0)  # Number of rooms of this type

    # User selection - included in occupancy/guest calculations
    is_included: Mapped[bool] = mapped_column(Boolean, default=True)  # Include in occupancy calcs
    display_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="newbook_room_categories")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'site_id', name='uq_newbook_room_category'),
    )


# Forward reference
from .user import Kitchen
