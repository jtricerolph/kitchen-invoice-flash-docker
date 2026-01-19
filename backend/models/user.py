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
    settings: Mapped["KitchenSettings"] = relationship("KitchenSettings", back_populates="kitchen", uselist=False)

    # Newbook relationships
    newbook_gl_accounts: Mapped[list["NewbookGLAccount"]] = relationship(
        "NewbookGLAccount", back_populates="kitchen", cascade="all, delete-orphan"
    )
    newbook_daily_revenue: Mapped[list["NewbookDailyRevenue"]] = relationship(
        "NewbookDailyRevenue", back_populates="kitchen", cascade="all, delete-orphan"
    )
    newbook_daily_occupancy: Mapped[list["NewbookDailyOccupancy"]] = relationship(
        "NewbookDailyOccupancy", back_populates="kitchen", cascade="all, delete-orphan"
    )
    newbook_sync_logs: Mapped[list["NewbookSyncLog"]] = relationship(
        "NewbookSyncLog", back_populates="kitchen", cascade="all, delete-orphan"
    )
    newbook_room_categories: Mapped[list["NewbookRoomCategory"]] = relationship(
        "NewbookRoomCategory", back_populates="kitchen", cascade="all, delete-orphan"
    )

    # Resos relationships
    resos_bookings: Mapped[list["ResosBooking"]] = relationship(
        "ResosBooking", back_populates="kitchen", cascade="all, delete-orphan"
    )
    resos_daily_stats: Mapped[list["ResosDailyStats"]] = relationship(
        "ResosDailyStats", back_populates="kitchen", cascade="all, delete-orphan"
    )
    resos_opening_hours: Mapped[list["ResosOpeningHour"]] = relationship(
        "ResosOpeningHour", back_populates="kitchen", cascade="all, delete-orphan"
    )
    resos_sync_logs: Mapped[list["ResosSyncLog"]] = relationship(
        "ResosSyncLog", back_populates="kitchen", cascade="all, delete-orphan"
    )


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
from .settings import KitchenSettings
from .newbook import NewbookGLAccount, NewbookDailyRevenue, NewbookDailyOccupancy, NewbookSyncLog, NewbookRoomCategory
from .resos import ResosBooking, ResosDailyStats, ResosOpeningHour, ResosSyncLog
