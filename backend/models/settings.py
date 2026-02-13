from datetime import datetime
from decimal import Decimal
from sqlalchemy import String, DateTime, ForeignKey, Text, Boolean, Numeric, Integer
from sqlalchemy.dialects.postgresql import JSONB
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

    # OCR post-processing options
    ocr_clean_product_codes: Mapped[bool] = mapped_column(Boolean, default=False)  # Strip section headers from product codes
    ocr_filter_subtotal_rows: Mapped[bool] = mapped_column(Boolean, default=False)  # Filter subtotal/total rows from line items
    ocr_use_weight_as_quantity: Mapped[bool] = mapped_column(Boolean, default=False)  # For KG items, use weight as quantity when it matches total

    # Newbook API settings
    newbook_api_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    newbook_api_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_api_region: Mapped[str | None] = mapped_column(String(10), nullable=True)  # au, ap, eu, us
    newbook_instance_id: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Newbook sync configuration
    newbook_last_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    newbook_auto_sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Separate sync interval for next 7 days (in minutes, default 15)
    newbook_upcoming_sync_interval: Mapped[int] = mapped_column(Integer, default=15)
    newbook_upcoming_sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    newbook_last_upcoming_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Newbook allocation GL mapping (CSV-style, e.g. "4100,4101,4102")
    newbook_breakfast_gl_codes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    newbook_dinner_gl_codes: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # VAT rates for calculating net from gross (e.g., 0.10 for 10% VAT)
    newbook_breakfast_vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4), nullable=True, default=Decimal("0.10"))
    newbook_dinner_vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 4), nullable=True, default=Decimal("0.10"))

    # Resos API Configuration
    resos_api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    resos_last_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resos_auto_sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Separate sync interval for next 7 days (in minutes, default 15)
    resos_upcoming_sync_interval: Mapped[int] = mapped_column(Integer, default=15)
    resos_upcoming_sync_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    resos_last_upcoming_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Resos Flagging Configuration
    resos_large_group_threshold: Mapped[int] = mapped_column(Integer, default=8)
    resos_note_keywords: Mapped[str | None] = mapped_column(Text, nullable=True)  # Pipe-separated: "birthday|anniversary|proposal"
    resos_allergy_keywords: Mapped[str | None] = mapped_column(Text, nullable=True)  # Pipe-separated: "gluten|dairy|nut|shellfish"

    # Resos Custom Field & Period Mapping
    resos_custom_field_mapping: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # Format: {"booking_number": "field_id_123", ...}
    resos_opening_hours_mapping: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # Format: [{"resos_id": "abc123", "display_name": "Lunch", "actual_end": "14:30"}, ...]

    # Resos SambaPOS Integration
    resos_restaurant_table_entities: Mapped[str | None] = mapped_column(Text, nullable=True)  # Comma-separated entity names

    # Manual Breakfast Configuration (not in Resos)
    resos_enable_manual_breakfast: Mapped[bool] = mapped_column(Boolean, default=False)
    # Format: [{"day": 1, "start": "07:00", "end": "11:00"}, ...] where day: 1=Monday, 7=Sunday
    resos_manual_breakfast_periods: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Resos Flag Icon Mapping (customizable icons for each flag type)
    # Format: {"allergies": "🦀", "large_group": "⚠️", "birthday": "🎂", "anniversary": "💍", ...}
    resos_flag_icon_mapping: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Resos Arrival Widget Service Filter (filter arrivals widget by service type from mapping)
    resos_arrival_widget_service_filter: Mapped[str | None] = mapped_column(String(50), nullable=True)  # service_type: breakfast/lunch/dinner/other

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
    # Phase 8.1: GL code configuration for food/beverage split
    sambapos_food_gl_codes: Mapped[str | None] = mapped_column(Text, nullable=True)  # Comma-separated GL codes for food items
    sambapos_beverage_gl_codes: Mapped[str | None] = mapped_column(Text, nullable=True)  # Comma-separated GL codes for beverage items

    # SMTP email configuration
    smtp_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_port: Mapped[int | None] = mapped_column(Integer, nullable=True, default=587)
    smtp_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    smtp_from_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    smtp_from_name: Mapped[str | None] = mapped_column(String(255), nullable=True, default="Kitchen Invoice System")

    # Support request email (where screenshot reports are sent)
    support_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Dext integration
    dext_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dext_include_notes: Mapped[bool] = mapped_column(Boolean, default=True)
    dext_include_non_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    dext_auto_send_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    dext_manual_send_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    dext_include_annotations: Mapped[bool] = mapped_column(Boolean, default=True)  # Include PDF annotations when sending to Dext

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

    # IMAP Email Inbox settings
    imap_host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    imap_port: Mapped[int | None] = mapped_column(Integer, nullable=True, default=993)
    imap_use_ssl: Mapped[bool] = mapped_column(Boolean, default=True)
    imap_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    imap_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    imap_folder: Mapped[str | None] = mapped_column(String(255), nullable=True, default="INBOX")
    imap_poll_interval: Mapped[int] = mapped_column(Integer, default=15)  # minutes
    imap_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    imap_confidence_threshold: Mapped[Decimal | None] = mapped_column(Numeric(3, 2), nullable=True, default=Decimal("0.50"))
    imap_last_sync: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # General settings
    currency_symbol: Mapped[str] = mapped_column(String(5), default="£")
    date_format: Mapped[str] = mapped_column(String(20), default="DD/MM/YYYY")

    # Warning thresholds
    high_quantity_threshold: Mapped[int] = mapped_column(default=100)  # Warn if qty > this value

    # PDF annotation settings
    pdf_annotations_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # Enable adding annotations to PDFs
    pdf_preview_show_annotations: Mapped[bool] = mapped_column(Boolean, default=True)  # Show annotations in preview window

    # Price change detection settings
    price_change_lookback_days: Mapped[int] = mapped_column(Integer, default=30)  # Days to look back for price comparison
    price_change_amber_threshold: Mapped[int] = mapped_column(Integer, default=10)  # % change for amber warning
    price_change_red_threshold: Mapped[int] = mapped_column(Integer, default=20)  # % change for red alert

    # Admin-only page restrictions (comma-separated list of page paths, e.g., "/settings,/suppliers")
    admin_restricted_pages: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Forecast API integration (Spend Budget feature)
    forecast_api_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    forecast_api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Budget settings
    budget_gp_target: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True, default=Decimal("65.00"))
    budget_lookback_weeks: Mapped[int] = mapped_column(Integer, default=4)

    # KDS (Kitchen Display System) settings
    kds_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    kds_graphql_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    kds_graphql_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kds_graphql_password: Mapped[str | None] = mapped_column(String(500), nullable=True)
    kds_graphql_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kds_poll_interval_seconds: Mapped[int] = mapped_column(Integer, default=6000)
    kds_timer_green_seconds: Mapped[int] = mapped_column(Integer, default=300)
    kds_timer_amber_seconds: Mapped[int] = mapped_column(Integer, default=600)
    kds_timer_red_seconds: Mapped[int] = mapped_column(Integer, default=900)
    kds_course_order: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=["Starters", "Mains", "Desserts"])
    kds_show_completed_for_seconds: Mapped[int] = mapped_column(Integer, default=30)

    # Away timer thresholds (time since food sent to table - "eating" phase)
    kds_away_timer_green_seconds: Mapped[int] = mapped_column(Integer, default=600)   # 10 minutes
    kds_away_timer_amber_seconds: Mapped[int] = mapped_column(Integer, default=900)   # 15 minutes
    kds_away_timer_red_seconds: Mapped[int] = mapped_column(Integer, default=1200)    # 20 minutes
    kds_bookings_refresh_seconds: Mapped[int] = mapped_column(Integer, default=60)

    # Cost distribution settings
    cost_distribution_max_days: Mapped[int] = mapped_column(Integer, default=90)

    # Kitchen details (for PO letterhead)
    kitchen_display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kitchen_address_line1: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kitchen_address_line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
    kitchen_city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    kitchen_postcode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    kitchen_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    kitchen_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen", back_populates="settings")


# Forward reference
from .user import Kitchen
