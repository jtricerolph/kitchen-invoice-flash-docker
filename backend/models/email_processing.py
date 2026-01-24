"""
Email processing log model for tracking IMAP email inbox sync.
"""
from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Integer, Boolean, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class EmailProcessingLog(Base):
    """Track processed emails to prevent re-processing"""
    __tablename__ = "email_processing_log"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False, index=True)

    # Email identification (RFC 2822 Message-ID)
    message_id: Mapped[str] = mapped_column(String(500), nullable=False, index=True)

    # Email metadata for audit trail
    email_subject: Mapped[str | None] = mapped_column(String(500), nullable=True)
    email_from: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Processing results
    attachments_count: Mapped[int] = mapped_column(Integer, default=0)
    invoices_created: Mapped[int] = mapped_column(Integer, default=0)
    confident_invoices: Mapped[int] = mapped_column(Integer, default=0)

    # Status tracking
    marked_as_read: Mapped[bool] = mapped_column(Boolean, default=False)
    processing_status: Mapped[str] = mapped_column(String(50), default="pending")  # pending, success, failed, skipped
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Invoice IDs created from this email
    invoice_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    processed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="email_processing_logs")

    __table_args__ = (
        UniqueConstraint('kitchen_id', 'message_id', name='uq_email_message_id'),
    )


# Forward reference
from .user import Kitchen
