"""
IMAP Email Inbox API endpoints for settings and sync control.
"""
import logging
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.settings import KitchenSettings
from models.email_processing import EmailProcessingLog
from services.imap_sync import ImapSyncService

router = APIRouter(prefix="/imap", tags=["IMAP"])
logger = logging.getLogger(__name__)


# ============ Pydantic Schemas ============

class ImapSettingsResponse(BaseModel):
    imap_host: Optional[str]
    imap_port: Optional[int]
    imap_use_ssl: bool
    imap_username: Optional[str]
    imap_password_set: bool  # Don't expose actual password
    imap_folder: Optional[str]
    imap_poll_interval: int
    imap_enabled: bool
    imap_confidence_threshold: Optional[float]
    imap_last_sync: Optional[str]


class ImapSettingsUpdate(BaseModel):
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_use_ssl: Optional[bool] = None
    imap_username: Optional[str] = None
    imap_password: Optional[str] = None  # Only set if provided
    imap_folder: Optional[str] = None
    imap_poll_interval: Optional[int] = None
    imap_enabled: Optional[bool] = None
    imap_confidence_threshold: Optional[float] = None


class ImapTestRequest(BaseModel):
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_use_ssl: Optional[bool] = None
    imap_username: Optional[str] = None
    imap_password: Optional[str] = None


class EmailLogResponse(BaseModel):
    id: int
    message_id: str
    email_subject: Optional[str]
    email_from: Optional[str]
    email_date: Optional[str]
    attachments_count: int
    invoices_created: int
    confident_invoices: int
    marked_as_read: bool
    processing_status: str
    error_message: Optional[str]
    invoice_ids: Optional[list[int]]
    processed_at: str


# ============ Settings Endpoints ============

@router.get("/settings", response_model=ImapSettingsResponse)
async def get_imap_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get IMAP settings (password masked)"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    return ImapSettingsResponse(
        imap_host=settings.imap_host,
        imap_port=settings.imap_port,
        imap_use_ssl=settings.imap_use_ssl,
        imap_username=settings.imap_username,
        imap_password_set=bool(settings.imap_password),
        imap_folder=settings.imap_folder,
        imap_poll_interval=settings.imap_poll_interval,
        imap_enabled=settings.imap_enabled,
        imap_confidence_threshold=float(settings.imap_confidence_threshold) if settings.imap_confidence_threshold else None,
        imap_last_sync=settings.imap_last_sync.isoformat() if settings.imap_last_sync else None
    )


@router.patch("/settings", response_model=ImapSettingsResponse)
async def update_imap_settings(
    update: ImapSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update IMAP settings (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Update only provided fields
    if update.imap_host is not None:
        settings.imap_host = update.imap_host
    if update.imap_port is not None:
        settings.imap_port = update.imap_port
    if update.imap_use_ssl is not None:
        settings.imap_use_ssl = update.imap_use_ssl
    if update.imap_username is not None:
        settings.imap_username = update.imap_username
    if update.imap_password is not None and update.imap_password:
        settings.imap_password = update.imap_password
    if update.imap_folder is not None:
        settings.imap_folder = update.imap_folder
    if update.imap_poll_interval is not None:
        settings.imap_poll_interval = update.imap_poll_interval
    if update.imap_enabled is not None:
        settings.imap_enabled = update.imap_enabled
    if update.imap_confidence_threshold is not None:
        settings.imap_confidence_threshold = Decimal(str(update.imap_confidence_threshold))

    await db.commit()

    return ImapSettingsResponse(
        imap_host=settings.imap_host,
        imap_port=settings.imap_port,
        imap_use_ssl=settings.imap_use_ssl,
        imap_username=settings.imap_username,
        imap_password_set=bool(settings.imap_password),
        imap_folder=settings.imap_folder,
        imap_poll_interval=settings.imap_poll_interval,
        imap_enabled=settings.imap_enabled,
        imap_confidence_threshold=float(settings.imap_confidence_threshold) if settings.imap_confidence_threshold else None,
        imap_last_sync=settings.imap_last_sync.isoformat() if settings.imap_last_sync else None
    )


@router.post("/test-connection")
async def test_imap_connection(
    request: ImapTestRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test IMAP connection with provided or saved settings"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Get current settings
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    # Use provided values or fall back to saved settings
    test_settings = KitchenSettings(
        kitchen_id=current_user.kitchen_id,
        imap_host=request.imap_host or settings.imap_host,
        imap_port=request.imap_port or settings.imap_port or 993,
        imap_use_ssl=request.imap_use_ssl if request.imap_use_ssl is not None else settings.imap_use_ssl,
        imap_username=request.imap_username or settings.imap_username,
        imap_password=request.imap_password or settings.imap_password
    )

    if not test_settings.imap_host or not test_settings.imap_password:
        return {"success": False, "error": "IMAP host and password are required"}

    # Test connection
    sync_service = ImapSyncService(current_user.kitchen_id, db)
    sync_service._settings = test_settings
    result = await sync_service.test_connection()

    return result


@router.post("/sync-now")
async def trigger_manual_sync(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Manually trigger inbox sync (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Get settings
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")

    if not settings.imap_host or not settings.imap_password:
        raise HTTPException(status_code=400, detail="IMAP settings not configured")

    # Run sync
    try:
        sync_service = ImapSyncService(current_user.kitchen_id, db)
        results = await sync_service.process_inbox()
        return {
            "success": True,
            "results": results
        }
    except Exception as e:
        logger.error(f"Manual IMAP sync failed: {e}")
        return {
            "success": False,
            "error": str(e)
        }


# ============ Log Endpoints ============

@router.get("/logs", response_model=list[EmailLogResponse])
async def get_processing_logs(
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get recent email processing logs"""
    result = await db.execute(
        select(EmailProcessingLog)
        .where(EmailProcessingLog.kitchen_id == current_user.kitchen_id)
        .order_by(desc(EmailProcessingLog.processed_at))
        .offset(offset)
        .limit(limit)
    )
    logs = result.scalars().all()

    return [
        EmailLogResponse(
            id=log.id,
            message_id=log.message_id,
            email_subject=log.email_subject,
            email_from=log.email_from,
            email_date=log.email_date.isoformat() if log.email_date else None,
            attachments_count=log.attachments_count,
            invoices_created=log.invoices_created,
            confident_invoices=log.confident_invoices,
            marked_as_read=log.marked_as_read,
            processing_status=log.processing_status,
            error_message=log.error_message,
            invoice_ids=log.invoice_ids,
            processed_at=log.processed_at.isoformat()
        )
        for log in logs
    ]


@router.get("/logs/stats")
async def get_sync_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get sync statistics"""
    from sqlalchemy import func
    from datetime import datetime, timedelta

    now = datetime.utcnow()

    # Last 24 hours
    result_24h = await db.execute(
        select(
            func.count(EmailProcessingLog.id),
            func.sum(EmailProcessingLog.invoices_created),
            func.sum(EmailProcessingLog.confident_invoices)
        ).where(
            EmailProcessingLog.kitchen_id == current_user.kitchen_id,
            EmailProcessingLog.processed_at >= now - timedelta(hours=24)
        )
    )
    stats_24h = result_24h.one()

    # Last 7 days
    result_7d = await db.execute(
        select(
            func.count(EmailProcessingLog.id),
            func.sum(EmailProcessingLog.invoices_created),
            func.sum(EmailProcessingLog.confident_invoices)
        ).where(
            EmailProcessingLog.kitchen_id == current_user.kitchen_id,
            EmailProcessingLog.processed_at >= now - timedelta(days=7)
        )
    )
    stats_7d = result_7d.one()

    # Last 30 days
    result_30d = await db.execute(
        select(
            func.count(EmailProcessingLog.id),
            func.sum(EmailProcessingLog.invoices_created),
            func.sum(EmailProcessingLog.confident_invoices)
        ).where(
            EmailProcessingLog.kitchen_id == current_user.kitchen_id,
            EmailProcessingLog.processed_at >= now - timedelta(days=30)
        )
    )
    stats_30d = result_30d.one()

    return {
        "last_24h": {
            "emails_processed": stats_24h[0] or 0,
            "invoices_created": int(stats_24h[1] or 0),
            "confident_invoices": int(stats_24h[2] or 0)
        },
        "last_7d": {
            "emails_processed": stats_7d[0] or 0,
            "invoices_created": int(stats_7d[1] or 0),
            "confident_invoices": int(stats_7d[2] or 0)
        },
        "last_30d": {
            "emails_processed": stats_30d[0] or 0,
            "invoices_created": int(stats_30d[1] or 0),
            "confident_invoices": int(stats_30d[2] or 0)
        }
    }
