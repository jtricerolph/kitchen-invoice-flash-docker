from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, DateTime, ForeignKey, Text, Boolean, Numeric, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class KitchenSettings(Base):
    """Kitchen-level settings including OCR and Newbook configuration"""
    __tablename__ = "kitchen_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), unique=True)

    # Azure Document Intelligence settings
    azure_endpoint: Mapped[str | None] = mapped_column(String(500), nullable=True)
    azure_key: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Newbook API settings
    newbook_api_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    newbook_api_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_api_region: Mapped[str | None] = mapped_column(String(10), nullable=True)  # au, ap, eu, us
    newbook_instance_id: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Newbook sync configuration
    newbook_last_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    newbook_auto_sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # Newbook allocation GL mapping (CSV-style, e.g. "4100,4101,4102")
    newbook_breakfast_gl_codes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_dinner_gl_codes: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # VAT rates for calculating net from gross (e.g., 0.10 for 10% VAT)
    newbook_breakfast_vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4), nullable=True, default=Decimal("0.10"))
    newbook_dinner_vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4), nullable=True, default=Decimal("0.10"))

    # SambaPOS MSSQL Connection
    sambapos_db_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sambapos_db_port: Mapped[int | None] = mapped_column(Integer, nullable=True, default=1433)
    sambapos_db_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sambapos_db_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sambapos_db_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # SambaPOS tracked categories (comma-separated list, order preserved for display)
    sambapos_tracked_categories: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # SambaPOS excluded menu items (comma-separated list of menu item names to exclude from reports)
    sambapos_excluded_items: Mapped[str | None] = mapped_column(Text, nullable=True)

    # SMTP email configuration
    smtp_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_port: Mapped[int | None] = mapped_column(Integer, nullable=True, default=587)
    smtp_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    smtp_from_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_from_name: Mapped[str | None] = mapped_column(String(255), nullable=True, default="Kitchen Invoice System")

    # Dext integration
    dext_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dext_include_notes: Mapped[bool] = mapped_column(Boolean, default=True)
    dext_include_non_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    dext_auto_send_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    dext_manual_send_enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # Nextcloud settings
    nextcloud_host: Mapped[str | None] = mapped_column(String(500), nullable=True)
    nextcloud_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    nextcloud_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    nextcloud_base_path: Mapped[str | None] = mapped_column(String(500), nullable=True, default="/Kitchen Invoices")
    nextcloud_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    nextcloud_delete_local: Mapped[bool] = mapped_column(Boolean, default=False)  # Delete local file after successful archive

    # Backup settings
    backup_frequency: Mapped[str | None] = mapped_column(String(20), nullable=True, default="manual")  # daily, weekly, manual
    backup_retention_count: Mapped[int] = mapped_column(Integer, default=7)
    backup_destination: Mapped[str | None] = mapped_column(String(20), nullable=True, default="local")  # local, nextcloud, smb
    backup_time: Mapped[str | None] = mapped_column(String(5), nullable=True, default="03:00")

    # Nextcloud backup path (when backup_destination = "nextcloud")
    backup_nextcloud_path: Mapped[str | None] = mapped_column(String(500), nullable=True, default="/Backups")

    # SMB backup settings (used when backup_destination = "smb")
    backup_smb_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    backup_smb_share: Mapped[str | None] = mapped_column(String(255), nullable=True)
    backup_smb_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    backup_smb_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    backup_smb_path: Mapped[str | None] = mapped_column(String(500), nullable=True, default="/backups")

    # Last backup tracking
    backup_last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    backup_last_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    backup_last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # General settings
    currency_symbol: Mapped[str] = mapped_column(String(5), default="£")
    date_format: Mapped[str] = mapped_column(String(20), default="DD/MM/YYYY")

    # Warning thresholds
    high_quantity_threshold: Mapped[int] = mapped_column(default=100)  # Warn if qty > this value

    # Price change detection settings
    price_change_lookback_days: Mapped[int] = mapped_column(Integer, default=30)  # Days to look back for price comparison
    price_change_amber_threshold: Mapped[int] = mapped_column(Integer, default=10)  # % change for amber warning
    price_change_red_threshold: Mapped[int] = mapped_column(Integer, default=20)  # % change for red alert

    # Admin-only page restrictions (comma-separated list of page paths, e.g., "/settings,/suppliers")
    admin_restricted_pages: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="settings")


# Forward reference
from .user import Kitchen
