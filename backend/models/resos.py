from datetime import datetime, date, time
from sqlalchemy import String, DateTime, Date, Time, ForeignKey, Boolean, Text, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class ResosBooking(Base):
    """Individual booking records from Resos API"""
    __tablename__ = "resos_bookings"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    resos_booking_id: Mapped[str] = mapped_column(String(255), nullable=False)

    # Booking details
    booking_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    booking_time: Mapped[time] = mapped_column(Time, nullable=False)
    people: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False)

    # Guest info (non-PII)
    seating_area: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Custom fields
    hotel_booking_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_hotel_guest: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_dbb: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_package: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    exclude_flag: Mapped[str | None] = mapped_column(String(500), nullable=True)
    allergies: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Notes
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Metadata
    booked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    opening_hour_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    opening_hour_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Flags
    is_flagged: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    flag_reasons: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Sync metadata
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    is_forecast: Mapped[bool] = mapped_column(Boolean, default=False)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="resos_bookings")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'resos_booking_id', name='uq_resos_booking'),
    )


class ResosDailyStats(Base):
    """Aggregated daily booking statistics"""
    __tablename__ = "resos_daily_stats"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # Overall totals
    total_bookings: Mapped[int] = mapped_column(Integer, default=0)
    total_covers: Mapped[int] = mapped_column(Integer, default=0)

    # By service period (JSONB)
    # Format: [{"period": "Lunch", "bookings": 15, "covers": 32}, ...]
    service_breakdown: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Flags
    flagged_booking_count: Mapped[int] = mapped_column(Integer, default=0)

    # Consolidated booking data for quick access (JSONB)
    # Format: [{"time": "19:00", "people": 2, "period": "Dinner", "booked_at": "2026-01-15T10:30:00", "is_flagged": true, "status": "confirmed"}, ...]
    bookings_summary: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Metadata
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    is_forecast: Mapped[bool] = mapped_column(Boolean, default=False)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="resos_daily_stats")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'date', name='uq_resos_daily_stat'),
    )


class ResosOpeningHour(Base):
    """Cached service period definitions from Resos"""
    __tablename__ = "resos_opening_hours"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    resos_opening_hour_id: Mapped[str] = mapped_column(String(255), nullable=False)

    # Period details
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    days_of_week: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Metadata
    is_special: Mapped[bool] = mapped_column(Boolean, default=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="resos_opening_hours")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'resos_opening_hour_id', name='uq_resos_opening_hour'),
    )


class ResosSyncLog(Base):
    """Audit trail for sync operations"""
    __tablename__ = "resos_sync_log"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    sync_type: Mapped[str] = mapped_column(String(50), nullable=False)  # 'forecast', 'historical', 'daily'
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # 'running', 'success', 'failed'

    date_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_to: Mapped[date | None] = mapped_column(Date, nullable=True)

    bookings_fetched: Mapped[int] = mapped_column(Integer, default=0)
    bookings_flagged: Mapped[int] = mapped_column(Integer, default=0)

    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="resos_sync_logs")
