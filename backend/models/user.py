from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class Kitchen(Base):
    __tablename__ = "kitchens"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    users: Mapped[list["User"]] = relationship("User", back_populates="kitchen")
    suppliers: Mapped[list["Supplier"]] = relationship("Supplier", back_populates="kitchen")
    invoices: Mapped[list["Invoice"]] = relationship("Invoice", back_populates="kitchen")
    revenue_entries: Mapped[list["RevenueEntry"]] = relationship("RevenueEntry", back_populates="kitchen")
    gp_periods: Mapped[list["GPPeriod"]] = relationship("GPPeriod", back_populates="kitchen")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="users")


# Forward references for relationships
from .supplier import Supplier
from .invoice import Invoice
from .gp import RevenueEntry, GPPeriod
