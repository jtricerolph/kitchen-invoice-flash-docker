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
from api import invoices, suppliers, reports, settings
from auth.routes import router as auth_router
from migrations.add_invoice_features import run_migration

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

    yield
    # Shutdown: Clean up resources
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
