import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from database import engine, Base

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
from api import invoices, suppliers, reports, settings, field_mappings, newbook, sambapos, backup, search, resos, calendar_events, residents_table_chart, disputes, credit_notes, public, logbook, imap, support, kds, budget, cover_overrides, purchase_orders, cost_distributions
from auth.routes import router as auth_router
from migrations.add_invoice_features import run_migration
from migrations.add_newbook_tables import run_migration as run_newbook_migration
from migrations.add_line_item_search import run_migration as run_search_migration
from migrations.add_sambapos_settings import run_migration as run_sambapos_migration
from migrations.add_sambapos_excluded_items import run_migration as run_sambapos_excluded_migration
from migrations.add_admin_restricted_pages import run_migration as run_admin_pages_migration
from migrations.add_nextcloud_backup import run_migration as run_nextcloud_backup_migration
from migrations.add_price_settings import run_migration as run_price_settings_migration
from migrations.add_resos_integration import run_migration as run_resos_migration
from migrations.add_calendar_events import run_migration as run_calendar_events_migration
from migrations.add_resos_upcoming_sync import run_migration as run_resos_upcoming_sync_migration
from migrations.add_newbook_upcoming_sync import run_migration as run_newbook_upcoming_sync_migration
from migrations.add_residents_table_chart import run_migration as run_residents_table_chart_migration
from migrations.add_rooms_breakdown import run_migration as run_rooms_breakdown_migration
from migrations.add_invoice_disputes import run_migration as run_disputes_migration
from migrations.add_awaiting_replacement_status import run_migration as run_awaiting_replacement_migration
from migrations.add_new_status import run_migration as run_new_status_migration
from migrations.add_dispute_attachment_public_hash import run_migration as run_dispute_attachment_hash_migration
from migrations.add_logbook import run_migration as run_logbook_migration
from migrations.add_imap_integration import run_migration as run_imap_migration
from migrations.add_support_request import run_migration as run_support_migration
from migrations.add_pdf_annotation_settings import run_migration as run_pdf_annotation_settings_migration
from migrations.add_linked_dispute import run_migration as run_linked_dispute_migration
from migrations.add_ocr_post_processing import run_migration as run_ocr_post_processing_migration
from migrations.add_ocr_weight_setting import run_migration as run_ocr_weight_setting_migration
from migrations.add_kds_tables import run_migration as run_kds_migration
from migrations.add_kds_course_flow import run_migration as run_kds_course_flow_migration
from migrations.add_kds_order_tracking import run_migration as run_kds_order_tracking_migration
from migrations.add_kds_bookings_refresh import run_migration as run_kds_bookings_refresh_migration
from migrations.add_budget_settings import migrate as run_budget_settings_migration
from migrations.add_cover_overrides import migrate as run_cover_overrides_migration
from migrations.add_purchase_orders import migrate as run_purchase_orders_migration
from migrations.add_supplier_po_fields import migrate as run_supplier_po_fields_migration
from migrations.add_kitchen_details import migrate as run_kitchen_details_migration
from migrations.add_cost_distributions import migrate as run_cost_distributions_migration
from scheduler import start_scheduler, stop_scheduler
from services.signalr_listener import start_signalr_listener, stop_signalr_listener

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Create database tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Run migrations for new columns on existing tables
    try:
        await run_migration()
        logger.info("Database migrations completed")
    except Exception as e:
        logger.warning(f"Migration warning (may be expected): {e}")

    # Run Newbook migrations
    try:
        await run_newbook_migration()
        logger.info("Newbook migrations completed")
    except Exception as e:
        logger.warning(f"Newbook migration warning (may be expected): {e}")

    # Run line item search migrations (pg_trgm extension and index)
    try:
        await run_search_migration()
        logger.info("Line item search migrations completed")
    except Exception as e:
        logger.warning(f"Line item search migration warning (may be expected): {e}")

    # Run SambaPOS migrations
    try:
        await run_sambapos_migration()
        logger.info("SambaPOS migrations completed")
    except Exception as e:
        logger.warning(f"SambaPOS migration warning (may be expected): {e}")

    # Run SambaPOS excluded items migration
    try:
        await run_sambapos_excluded_migration()
        logger.info("SambaPOS excluded items migration completed")
    except Exception as e:
        logger.warning(f"SambaPOS excluded items migration warning (may be expected): {e}")

    # Run admin restricted pages migration
    try:
        await run_admin_pages_migration()
        logger.info("Admin restricted pages migration completed")
    except Exception as e:
        logger.warning(f"Admin restricted pages migration warning (may be expected): {e}")

    # Run Nextcloud/Backup migration
    try:
        await run_nextcloud_backup_migration()
        logger.info("Nextcloud/Backup migration completed")
    except Exception as e:
        logger.warning(f"Nextcloud/Backup migration warning (may be expected): {e}")

    # Run price settings migration
    try:
        await run_price_settings_migration()
        logger.info("Price settings migration completed")
    except Exception as e:
        logger.warning(f"Price settings migration warning (may be expected): {e}")

    # Run Resos integration migration
    try:
        await run_resos_migration()
        logger.info("Resos integration migration completed")
    except Exception as e:
        logger.warning(f"Resos integration migration warning (may be expected): {e}")

    # Run Calendar events migration
    try:
        await run_calendar_events_migration()
        logger.info("Calendar events migration completed")
    except Exception as e:
        logger.warning(f"Calendar events migration warning (may be expected): {e}")

    # Run Resos upcoming sync migration
    try:
        await run_resos_upcoming_sync_migration()
        logger.info("Resos upcoming sync migration completed")
    except Exception as e:
        logger.warning(f"Resos upcoming sync migration warning (may be expected): {e}")

    # Run Newbook upcoming sync migration
    try:
        await run_newbook_upcoming_sync_migration()
        logger.info("Newbook upcoming sync migration completed")
    except Exception as e:
        logger.warning(f"Newbook upcoming sync migration warning (may be expected): {e}")

    # Run residents table chart migration
    try:
        await run_residents_table_chart_migration()
        logger.info("Residents table chart migration completed")
    except Exception as e:
        logger.warning(f"Residents table chart migration warning (may be expected): {e}")

    # Run rooms breakdown migration
    try:
        await run_rooms_breakdown_migration()
        logger.info("Rooms breakdown migration completed")
    except Exception as e:
        logger.warning(f"Rooms breakdown migration warning (may be expected): {e}")

    # Run invoice disputes migration
    try:
        await run_disputes_migration()
        logger.info("Invoice disputes migration completed")
    except Exception as e:
        logger.warning(f"Invoice disputes migration warning (may be expected): {e}")

    # Run awaiting replacement status migration
    try:
        await run_awaiting_replacement_migration()
        logger.info("Awaiting replacement status migration completed")
    except Exception as e:
        logger.warning(f"Awaiting replacement status migration warning (may be expected): {e}")

    # Run NEW status migration
    try:
        await run_new_status_migration()
        logger.info("NEW status migration completed")
    except Exception as e:
        logger.warning(f"NEW status migration warning (may be expected): {e}")

    # Run dispute attachment public hash migration
    try:
        await run_dispute_attachment_hash_migration()
        logger.info("Dispute attachment public hash migration completed")
    except Exception as e:
        logger.warning(f"Dispute attachment public hash migration warning (may be expected): {e}")

    # Run logbook migration
    try:
        await run_logbook_migration()
        logger.info("Logbook migration completed")
    except Exception as e:
        logger.warning(f"Logbook migration warning (may be expected): {e}")

    # Run IMAP integration migration
    try:
        await run_imap_migration()
        logger.info("IMAP integration migration completed")
    except Exception as e:
        logger.warning(f"IMAP integration migration warning (may be expected): {e}")

    # Run support request migration
    try:
        await run_support_migration()
        logger.info("Support request migration completed")
    except Exception as e:
        logger.warning(f"Support request migration warning (may be expected): {e}")

    # Run PDF annotation settings migration
    try:
        await run_pdf_annotation_settings_migration()
        logger.info("PDF annotation settings migration completed")
    except Exception as e:
        logger.warning(f"PDF annotation settings migration warning (may be expected): {e}")

    # Run linked dispute migration
    try:
        await run_linked_dispute_migration()
        logger.info("Linked dispute migration completed")
    except Exception as e:
        logger.warning(f"Linked dispute migration warning (may be expected): {e}")

    # Run OCR post-processing settings migration
    try:
        await run_ocr_post_processing_migration()
        logger.info("OCR post-processing migration completed")
    except Exception as e:
        logger.warning(f"OCR post-processing migration warning (may be expected): {e}")

    # Run OCR weight setting migration
    try:
        await run_ocr_weight_setting_migration()
        logger.info("OCR weight setting migration completed")
    except Exception as e:
        logger.warning(f"OCR weight setting migration warning (may be expected): {e}")

    # Run KDS migration
    try:
        await run_kds_migration()
        logger.info("KDS migration completed")
    except Exception as e:
        logger.warning(f"KDS migration warning (may be expected): {e}")

    # Run KDS course flow migration
    try:
        await run_kds_course_flow_migration()
        logger.info("KDS course flow migration completed")
    except Exception as e:
        logger.warning(f"KDS course flow migration warning (may be expected): {e}")

    # Run KDS order tracking migration
    try:
        await run_kds_order_tracking_migration()
        logger.info("KDS order tracking migration completed")
    except Exception as e:
        logger.warning(f"KDS order tracking migration warning (may be expected): {e}")

    # Run KDS bookings refresh migration
    try:
        await run_kds_bookings_refresh_migration()
        logger.info("KDS bookings refresh migration completed")
    except Exception as e:
        logger.warning(f"KDS bookings refresh migration warning (may be expected): {e}")

    # Run budget settings migration
    try:
        await run_budget_settings_migration()
        logger.info("Budget settings migration completed")
    except Exception as e:
        logger.warning(f"Budget settings migration warning (may be expected): {e}")

    # Run cover overrides migration
    try:
        await run_cover_overrides_migration()
        logger.info("Cover overrides migration completed")
    except Exception as e:
        logger.warning(f"Cover overrides migration warning (may be expected): {e}")

    # Run purchase orders migration
    try:
        await run_purchase_orders_migration()
        logger.info("Purchase orders migration completed")
    except Exception as e:
        logger.warning(f"Purchase orders migration warning (may be expected): {e}")

    # Run supplier PO fields migration
    try:
        await run_supplier_po_fields_migration()
        logger.info("Supplier PO fields migration completed")
    except Exception as e:
        logger.warning(f"Supplier PO fields migration warning (may be expected): {e}")

    # Run kitchen details migration
    try:
        await run_kitchen_details_migration()
        logger.info("Kitchen details migration completed")
    except Exception as e:
        logger.warning(f"Kitchen details migration warning (may be expected): {e}")

    # Run cost distributions migration
    try:
        await run_cost_distributions_migration()
        logger.info("Cost distributions migration completed")
    except Exception as e:
        logger.warning(f"Cost distributions migration warning (may be expected): {e}")

    # Start the scheduler for daily sync jobs
    start_scheduler()

    # Start SignalR listener for real-time KDS updates
    try:
        await start_signalr_listener()
        logger.info("SignalR listener started")
    except Exception as e:
        logger.warning(f"SignalR listener failed to start (KDS will use polling): {e}")

    yield
    # Shutdown: Clean up resources
    await stop_signalr_listener()
    stop_scheduler()
    await engine.dispose()


app = FastAPI(
    title="Kitchen Invoice Flash",
    description="OCR-powered invoice processing for kitchen GP estimation",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth_router, prefix="/auth", tags=["Authentication"])
app.include_router(invoices.router, prefix="/api/invoices", tags=["Invoices"])
app.include_router(disputes.router, prefix="/api/disputes", tags=["Disputes"])
app.include_router(credit_notes.router, prefix="/api/credit-notes", tags=["Credit Notes"])
app.include_router(suppliers.router, prefix="/api/suppliers", tags=["Suppliers"])
app.include_router(reports.router, prefix="/api/reports", tags=["Reports"])
app.include_router(settings.router, prefix="/api/settings", tags=["Settings"])
app.include_router(field_mappings.router, prefix="/api/field-mappings", tags=["Field Mappings"])
app.include_router(newbook.router, prefix="/api/newbook", tags=["Newbook"])
app.include_router(sambapos.router, prefix="/api/sambapos", tags=["SambaPOS"])
app.include_router(backup.router, prefix="/api/backup", tags=["Backup"])
app.include_router(search.router, tags=["Search"])
app.include_router(resos.router, prefix="/api/resos", tags=["Resos"])
app.include_router(calendar_events.router, prefix="/api/calendar-events", tags=["Calendar Events"])
app.include_router(residents_table_chart.router, prefix="/api", tags=["Residents Table Chart"])
app.include_router(public.router, prefix="/api/public", tags=["Public"])
app.include_router(logbook.router, prefix="/api", tags=["Logbook"])
app.include_router(imap.router, prefix="/api", tags=["IMAP"])
app.include_router(support.router, prefix="/api", tags=["Support"])
app.include_router(kds.router, prefix="/api/kds", tags=["KDS"])
app.include_router(budget.router, prefix="/api/budget", tags=["Budget"])
app.include_router(cover_overrides.router, prefix="/api/cover-overrides", tags=["Cover Overrides"])
app.include_router(purchase_orders.router, prefix="/api/purchase-orders", tags=["Purchase Orders"])
app.include_router(cost_distributions.router, prefix="/api/cost-distributions", tags=["Cost Distributions"])


@app.get("/")
async def root():
    return {
        "message": "Kitchen Invoice Flash API",
        "docs": "/docs",
        "health": "/health"
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy"}
