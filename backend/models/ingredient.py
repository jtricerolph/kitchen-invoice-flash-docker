from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Integer, Text, Boolean, Date, UniqueConstraint, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class IngredientCategory(Base):
    """Configurable ingredient groupings (Dairy, Meat, Produce, etc.)"""
    __tablename__ = "ingredient_categories"
    __table_args__ = (UniqueConstraint("kitchen_id", "name", name="uq_ingredient_categories_kitchen_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    ingredients: Mapped[List["Ingredient"]] = relationship("Ingredient", back_populates="category")


class Ingredient(Base):
    """Canonical ingredient library entry"""
    __tablename__ = "ingredients"
    __table_args__ = (UniqueConstraint("kitchen_id", "name", name="uq_ingredients_kitchen_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category_id: Mapped[Optional[int]] = mapped_column(ForeignKey("ingredient_categories.id", ondelete="SET NULL"), nullable=True, index=True)
    standard_unit: Mapped[str] = mapped_column(String(20), nullable=False)  # g, kg, ml, ltr, each
    yield_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("100.00"))
    manual_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 6), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    flags_assessed: Mapped[bool] = mapped_column(Boolean, default=False)  # True when user has reviewed flags (even if none apply)
    is_prepackaged: Mapped[bool] = mapped_column(Boolean, default=False)  # manufactured/pre-made product
    is_free: Mapped[bool] = mapped_column(Boolean, default=False)  # free item (e.g. water) — skip price warnings
    product_ingredients: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # ingredients list from product label (OCR or manual)
    label_image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)  # stored label photo path
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    category: Mapped[Optional["IngredientCategory"]] = relationship("IngredientCategory", back_populates="ingredients")
    created_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[created_by])
    sources: Mapped[List["IngredientSource"]] = relationship("IngredientSource", back_populates="ingredient", cascade="all, delete-orphan")
    flags: Mapped[List["IngredientFlag"]] = relationship("IngredientFlag", back_populates="ingredient", cascade="all, delete-orphan")
    flag_nones: Mapped[List["IngredientFlagNone"]] = relationship("IngredientFlagNone", cascade="all, delete-orphan")
    flag_dismissals: Mapped[List["IngredientFlagDismissal"]] = relationship("IngredientFlagDismissal", cascade="all, delete-orphan")


class IngredientSource(Base):
    """Maps supplier products to ingredients with unit conversion and price tracking"""
    __tablename__ = "ingredient_sources"
    __table_args__ = (UniqueConstraint("kitchen_id", "ingredient_id", "supplier_id", "product_code", name="uq_ingredient_sources_kitchen_ing_sup_code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), nullable=False, index=True)
    product_code: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    description_pattern: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    description_aliases: Mapped[Optional[list]] = mapped_column(JSON, default=list)

    # Pack/conversion data
    pack_quantity: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    unit_size: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 3), nullable=True)
    unit_size_type: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)

    # Price tracking (auto-updated from most recent matched line item)
    latest_unit_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2), nullable=True)
    latest_invoice_id: Mapped[Optional[int]] = mapped_column(ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True)
    latest_invoice_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    price_per_std_unit: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 6), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    ingredient: Mapped["Ingredient"] = relationship("Ingredient", back_populates="sources")
    supplier: Mapped["Supplier"] = relationship("Supplier")
    latest_invoice: Mapped[Optional["Invoice"]] = relationship("Invoice", foreign_keys=[latest_invoice_id])


class IngredientFlag(Base):
    """Canonical flag assignments on ingredients (latching from line items)"""
    __tablename__ = "ingredient_flags"
    __table_args__ = (UniqueConstraint("ingredient_id", "food_flag_id", name="uq_ingredient_flags_ing_flag"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False, index=True)
    flagged_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")  # "manual" | "latched"
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    ingredient: Mapped["Ingredient"] = relationship("Ingredient", back_populates="flags")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")
    flagged_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[flagged_by])


class IngredientFlagNone(Base):
    """Tracks 'None apply' per ingredient per flag category (for required categories)"""
    __tablename__ = "ingredient_flag_nones"
    __table_args__ = (UniqueConstraint("ingredient_id", "category_id", name="uq_ingredient_flag_nones_ing_cat"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("food_flag_categories.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    ingredient: Mapped["Ingredient"] = relationship("Ingredient")
    category: Mapped["FoodFlagCategory"] = relationship("FoodFlagCategory")


class IngredientFlagDismissal(Base):
    """Tracks dismissed allergen suggestions per ingredient+flag with accountability"""
    __tablename__ = "ingredient_flag_dismissals"
    __table_args__ = (UniqueConstraint("ingredient_id", "food_flag_id", name="uq_ingredient_flag_dismissals_ing_flag"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False, index=True)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False, index=True)
    dismissed_by_name: Mapped[str] = mapped_column(String(100), nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    matched_keyword: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    ingredient: Mapped["Ingredient"] = relationship("Ingredient")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")


# Forward references
from .user import Kitchen, User
from .supplier import Supplier
from .invoice import Invoice
from .food_flag import FoodFlag, FoodFlagCategory
