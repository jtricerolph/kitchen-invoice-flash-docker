from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import String, DateTime, ForeignKey, Numeric, Integer, Text, Boolean, Date, CheckConstraint, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class MenuSection(Base):
    """Groupings for recipes and dishes (section_type: 'recipe' | 'dish')"""
    __tablename__ = "menu_sections"
    __table_args__ = (UniqueConstraint("kitchen_id", "name", "section_type", name="uq_menu_sections_kitchen_name_type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    section_type: Mapped[str] = mapped_column(String(20), nullable=False, default="recipe")  # "recipe" | "dish"
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    recipes: Mapped[List["Recipe"]] = relationship("Recipe", back_populates="menu_section")


class Recipe(Base):
    """Component recipes and dishes"""
    __tablename__ = "recipes"
    __table_args__ = (UniqueConstraint("kitchen_id", "name", name="uq_recipes_kitchen_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    recipe_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "component" | "dish"
    menu_section_id: Mapped[Optional[int]] = mapped_column(ForeignKey("menu_sections.id", ondelete="SET NULL"), nullable=True, index=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    batch_portions: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    batch_output_type: Mapped[str] = mapped_column(String(20), nullable=False, default="portions")  # "portions" | "bulk"
    batch_yield_qty: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 3), nullable=True)
    batch_yield_unit: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # g, kg, ml, ltr
    prep_time_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    cook_time_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    gross_sell_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2), nullable=True)
    kds_menu_item_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)  # Phase 7: KDS link
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    menu_section: Mapped[Optional["MenuSection"]] = relationship("MenuSection", back_populates="recipes")
    created_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[created_by])
    ingredients: Mapped[List["RecipeIngredient"]] = relationship("RecipeIngredient", back_populates="recipe", cascade="all, delete-orphan")
    sub_recipes: Mapped[List["RecipeSubRecipe"]] = relationship("RecipeSubRecipe", back_populates="parent_recipe", foreign_keys="RecipeSubRecipe.parent_recipe_id", cascade="all, delete-orphan")
    used_in_recipes: Mapped[List["RecipeSubRecipe"]] = relationship("RecipeSubRecipe", foreign_keys="RecipeSubRecipe.child_recipe_id")
    steps: Mapped[List["RecipeStep"]] = relationship("RecipeStep", back_populates="recipe", cascade="all, delete-orphan")
    images: Mapped[List["RecipeImage"]] = relationship("RecipeImage", back_populates="recipe", cascade="all, delete-orphan")
    flags: Mapped[List["RecipeFlag"]] = relationship("RecipeFlag", back_populates="recipe", cascade="all, delete-orphan")
    change_log: Mapped[List["RecipeChangeLog"]] = relationship("RecipeChangeLog", back_populates="recipe", cascade="all, delete-orphan")
    cost_snapshots: Mapped[List["RecipeCostSnapshot"]] = relationship("RecipeCostSnapshot", back_populates="recipe", cascade="all, delete-orphan")


class RecipeIngredient(Base):
    """Ingredients used in a recipe"""
    __tablename__ = "recipe_ingredients"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id", ondelete="RESTRICT"), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    unit: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # override display unit (e.g. kg when std is g)
    yield_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("100.00"))
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="ingredients")
    ingredient: Mapped["Ingredient"] = relationship("Ingredient")


class RecipeSubRecipe(Base):
    """Sub-recipes used in a recipe (max 5 levels deep)"""
    __tablename__ = "recipe_sub_recipes"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    child_recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="RESTRICT"), nullable=False, index=True)
    portions_needed: Mapped[Decimal] = mapped_column(Numeric(10, 3), nullable=False)
    portions_needed_unit: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # override unit (e.g. ml when child yields ltr)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        CheckConstraint("parent_recipe_id != child_recipe_id", name="chk_no_self_reference"),
    )

    # Relationships
    parent_recipe: Mapped["Recipe"] = relationship("Recipe", foreign_keys=[parent_recipe_id], back_populates="sub_recipes")
    child_recipe: Mapped["Recipe"] = relationship("Recipe", foreign_keys=[child_recipe_id], overlaps="used_in_recipes")


class RecipeStep(Base):
    """Cooking instructions"""
    __tablename__ = "recipe_steps"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    step_number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    image_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    duration_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="steps")


class RecipeImage(Base):
    """General recipe/plating photos"""
    __tablename__ = "recipe_images"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)
    caption: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    image_type: Mapped[str] = mapped_column(String(20), default="general")  # "general" | "plating" | "method"
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    uploaded_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="images")
    uploaded_by_user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[uploaded_by])


class RecipeChangeLog(Base):
    """Recipe change history"""
    __tablename__ = "recipe_change_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False)
    change_summary: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="change_log")
    user: Mapped[Optional["User"]] = relationship("User", foreign_keys=[user_id])


class RecipeCostSnapshot(Base):
    """Cost trending over time (upsert: one snapshot per recipe per day)"""
    __tablename__ = "recipe_cost_snapshots"
    __table_args__ = (UniqueConstraint("recipe_id", "snapshot_date", name="uq_recipe_cost_snapshots_recipe_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    cost_per_portion: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)
    total_cost: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False)
    trigger_source: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe", back_populates="cost_snapshots")


class RecipeTextFlagDismissal(Base):
    """Tracks dismissed allergen keyword suggestions from recipe-level text fields"""
    __tablename__ = "recipe_text_flag_dismissals"
    __table_args__ = (UniqueConstraint("recipe_id", "food_flag_id", name="uq_recipe_text_flag_dismissals_recipe_flag"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id", ondelete="CASCADE"), nullable=False, index=True)
    food_flag_id: Mapped[int] = mapped_column(ForeignKey("food_flags.id", ondelete="CASCADE"), nullable=False, index=True)
    dismissed_by_name: Mapped[str] = mapped_column(String(100), nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    matched_keyword: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    recipe: Mapped["Recipe"] = relationship("Recipe")
    food_flag: Mapped["FoodFlag"] = relationship("FoodFlag")


# Forward references
from .user import Kitchen, User
from .ingredient import Ingredient
from .food_flag import RecipeFlag, FoodFlag
