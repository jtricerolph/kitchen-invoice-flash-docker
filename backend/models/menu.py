from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Integer, Text, Boolean, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class Menu(Base):
    """Named menus (e.g., 'Dinner Menu', 'Sunday Lunch')"""
    __tablename__ = "menus"
    __table_args__ = (UniqueConstraint("kitchen_id", "name", name="uq_menus_kitchen_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # customer-facing subtitle
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # internal staff comments
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    divisions: Mapped[List["MenuDivision"]] = relationship("MenuDivision", back_populates="menu", cascade="all, delete-orphan")
    items: Mapped[List["MenuItem"]] = relationship("MenuItem", back_populates="menu", cascade="all, delete-orphan")


class MenuDivision(Base):
    """Sections within a specific menu (per-menu, not shared)"""
    __tablename__ = "menu_divisions"
    __table_args__ = (UniqueConstraint("menu_id", "name", name="uq_menu_divisions_menu_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    menu_id: Mapped[int] = mapped_column(ForeignKey("menus.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    # Relationships
    menu: Mapped["Menu"] = relationship("Menu", back_populates="divisions")
    items: Mapped[List["MenuItem"]] = relationship("MenuItem", back_populates="division", cascade="all, delete-orphan")


class MenuItem(Base):
    """Published dishes on a menu"""
    __tablename__ = "menu_items"
    __table_args__ = (UniqueConstraint("menu_id", "recipe_id", name="uq_menu_items_menu_recipe"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    menu_id: Mapped[int] = mapped_column(ForeignKey("menus.id", ondelete="CASCADE"), nullable=False, index=True)
    division_id: Mapped[int] = mapped_column(ForeignKey("menu_divisions.id", ondelete="CASCADE"), nullable=False, index=True)
    recipe_id: Mapped[Optional[int]] = mapped_column(ForeignKey("recipes.id", ondelete="SET NULL"), nullable=True, index=True)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    price: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    snapshot_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    confirmed_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    confirmed_by_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    uploaded_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)

    # Relationships
    menu: Mapped["Menu"] = relationship("Menu", back_populates="items")
    division: Mapped["MenuDivision"] = relationship("MenuDivision", back_populates="items")
    recipe: Mapped[Optional["Recipe"]] = relationship("Recipe")
    confirmed_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[confirmed_by_user_id])
    uploaded_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[uploaded_by])


# Forward references
from .user import Kitchen, User
from .recipe import Recipe
