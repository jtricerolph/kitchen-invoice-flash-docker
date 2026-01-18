from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, Text, Integer, BigInteger
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class BackupHistory(Base):
    """Track backup history for each kitchen"""
    __tablename__ = "backup_history"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Backup metadata
    backup_type: Mapped[str] = mapped_column(String(20))  # "manual", "scheduled"
    destination: Mapped[str] = mapped_column(String(20))  # "local", "nextcloud", "smb"
    status: Mapped[str] = mapped_column(String(20))  # "running", "success", "failed"

    # File information
    filename: Mapped[str] = mapped_column(String(255))  # e.g., "backup_kitchen1_20260115_120000.zip"
    file_path: Mapped[str] = mapped_column(String(500))  # Full path to backup file
    file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    # Statistics
    invoice_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    file_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Timing
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Error tracking
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # User who triggered (null for scheduled)
    triggered_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    triggered_by_user: Mapped[Optional["User"]] = relationship("User")


# Forward references
from .user import Kitchen, User
