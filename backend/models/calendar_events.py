from datetime import datetime, date
from sqlalchemy import String, DateTime, ForeignKey, Text, Date, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class CalendarEvent(Base):
    """Calendar events, reminders, and notes"""
    __tablename__ = "calendar_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"))
    event_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)  # reminder, event, note
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    creator: Mapped["User"] = relationship("User")


# Forward references
from .user import Kitchen, User
