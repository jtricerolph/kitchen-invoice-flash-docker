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
from api import invoices, suppliers, reports, settings, field_mappings, newbook, sambapos, backup, search, resos, calendar_events
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
from scheduler import start_scheduler, stop_scheduler

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

    # Start the scheduler for daily sync jobs
    start_scheduler()

    yield
    # Shutdown: Clean up resources
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
