from datetime import datetime
from typing import Optional, List
from sqlalchemy import String, DateTime, ForeignKey, Integer, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class FoodFlagCategory(Base):
    """Configurable flag category types (Allergy, Dietary, etc.)"""
    __tablename__ = "food_flag_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    propagation_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "contains" | "suitable_for"
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    flags: Mapped[List["FoodFlag"]] = relationship("FoodFlag", back_populates="category", cascade="all, delete-orphan")


class FoodFlag(Base):
    """Individual flags within categories (Gluten, Milk, Vegetarian, etc.)"""
    __tablename__ = "food_flags"

    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("food_flag_categories.id", ondelete="CASCADE"), nullable=False, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    code: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # Short code: "Gl", "Mi", "V"
    icon: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    category: Mapped["FoodFlagCategory"] = relationship("FoodFlagCategory", back_populates="flags")


class LineItemFlag(Base):
    """Flags on supplier line items (data entry mechanism, triggers latching)"""
    __tablename__ = "line_item_flags"

    id: Mapped[int] = mapped_column(primary_key=True)
    line_item_id: Mapped[int] = mapped_column(ForeignKey("line_items.id", ondelete="CASCADE"), nullable=False, index=True)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False)
    flagged_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    line_item: Mapped["LineItem"] = relationship("LineItem")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")
    flagged_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[flagged_by])


class RecipeFlag(Base):
    """Flag state on recipes (manual additions + override state)"""
    __tablename__ = "recipe_flags"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False)
    source_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "auto" | "manual"
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    excludable_on_request: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="flags")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")


class RecipeFlagOverride(Base):
    """Audit log for flag changes (mandatory notes)"""
    __tablename__ = "recipe_flag_overrides"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False)
    action: Mapped[str] = mapped_column(String(20), nullable=False)  # "deactivated" | "reactivated" | "set_excludable" | "unset_excludable"
    note: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")
    user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[user_id])


# Forward references
from .user import Kitchen, User
from .line_item import LineItem
from .recipe import Recipe
