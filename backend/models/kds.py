"""
KDS (Kitchen Display System) Models

Local state tracking for kitchen orders, course bumping, and display.
"""

from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Text, Boolean, Integer, Float
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class KDSTicket(Base):
    """
    Local tracking of SambaPOS tickets for KDS display.

    Stores the current state of each ticket being displayed on KDS,
    including course progress and timing.
    """
    __tablename__ = "kds_tickets"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), index=True)

    # SambaPOS ticket reference
    sambapos_ticket_id: Mapped[int] = mapped_column(Integer, index=True)
    sambapos_ticket_uid: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ticket_number: Mapped[str] = mapped_column(String(50))

    # Ticket info from SambaPOS
    table_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    covers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_amount: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Timing
    received_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_sambapos_update: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Local state tracking
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_bumped: Mapped[bool] = mapped_column(Boolean, default=False)  # Fully bumped/completed
    bumped_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Current course state (which courses have been bumped)
    # Format: {"Starters": {"bumped": true, "bumped_at": "2025-01-25T12:00:00"}, ...}
    course_states: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)

    # Cached order data (refreshed on each poll)
    orders_data: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Order IDs captured at ticket creation (for detecting +ADDITION orders later)
    initial_order_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    course_bumps: Mapped[list["KDSCourseBump"]] = relationship("KDSCourseBump", back_populates="ticket", cascade="all, delete-orphan")


class KDSCourseBump(Base):
    """
    Track individual course bumps for audit trail.

    Records when each course was bumped for a ticket.
    """
    __tablename__ = "kds_course_bumps"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("kds_tickets.id", ondelete="CASCADE"), index=True)

    course_name: Mapped[str] = mapped_column(String(100))  # e.g., "Starters", "Mains", "Desserts"
    action: Mapped[str] = mapped_column(String(20), default="sent")  # "away" or "sent"
    bumped_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    bumped_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    # Time since previous course bump (for analytics)
    time_since_previous_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Relationships
    ticket: Mapped["KDSTicket"] = relationship("KDSTicket", back_populates="course_bumps")
    bumped_by: Mapped["User"] = relationship("User")


# Forward references
from .user import Kitchen, User
