from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class KitchenSettings(Base):
    """Kitchen-level settings including OCR configuration"""
    __tablename__ = "kitchen_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), unique=True)

    # Azure Document Intelligence settings
    azure_endpoint: Mapped[str | None] = mapped_column(String(500), nullable=True)
    azure_key: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # OCR provider selection
    ocr_provider: Mapped[str] = mapped_column(String(50), default="azure")  # "azure" or "paddle"

    # General settings
    currency_symbol: Mapped[str] = mapped_column(String(5), default="£")
    date_format: Mapped[str] = mapped_column(String(20), default="DD/MM/YYYY")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="settings")


# Forward reference
from .user import Kitchen
