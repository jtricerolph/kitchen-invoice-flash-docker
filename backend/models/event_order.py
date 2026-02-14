from datetime import datetime, date
from typing import Optional, List
from sqlalchemy import String, DateTime, ForeignKey, Integer, Text, Date
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class EventOrder(Base):
    """Function/event ordering (select recipes x quantities -> generate shopping list)"""
    __tablename__ = "event_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    event_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")  # DRAFT | FINALISED | ORDERED
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    created_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[created_by])
    items: Mapped[List["EventOrderItem"]] = relationship("EventOrderItem", back_populates="event_order", cascade="all, delete-orphan")


class EventOrderItem(Base):
    """Recipes and quantities for an event"""
    __tablename__ = "event_order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_order_id: Mapped[int] = mapped_column(ForeignKey("event_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="RESTRICT"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    # Relationships
    event_order: Mapped["EventOrder"] = relationship("EventOrder", back_populates="items")
    recipe: Mapped["Recipe"] = relationship("Recipe")


# Forward references
from .user import Kitchen, User
from .recipe import Recipe
