"""
Backup management API endpoints.
"""
import os
import tempfile
import shutil
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from models.backup import BackupHistory
from auth.jwt import get_current_user
from services.backup_service import BackupService

router = APIRouter()


# ============ Pydantic Models ============

class BackupSettingsResponse(BaseModel):
    backup_frequency: str | None
    backup_retention_count: int
    backup_destination: str | None
    backup_time: str | None
    backup_nextcloud_path: str | None
    backup_smb_host: str | None
    backup_smb_share: str | None
    backup_smb_username: str | None
    backup_smb_password_set: bool
    backup_smb_path: str | None
    backup_last_run_at: str | None
    backup_last_status: str | None
    backup_last_error: str | None

    class Config:
        from_attributes = True


class BackupSettingsUpdate(BaseModel):
    backup_frequency: str | None = None  # "daily", "weekly", "manual"
    backup_retention_count: int | None = None
    backup_destination: str | None = None  # "local", "nextcloud", "smb"
    backup_time: str | None = None  # "HH:MM"
    backup_nextcloud_path: str | None = None
    backup_smb_host: str | None = None
    backup_smb_share: str | None = None
    backup_smb_username: str | None = None
    backup_smb_password: str | None = None
    backup_smb_path: str | None = None


class BackupHistoryResponse(BaseModel):
    id: int
    backup_type: str
    destination: str
    status: str
    filename: str
    file_size_bytes: int | None
    invoice_count: int | None
    file_count: int | None
    started_at: str
    completed_at: str | None
    error_message: str | None
    triggered_by_username: str | None

    class Config:
        from_attributes = True


class BackupCreateResponse(BaseModel):
    message: str
    status: str
    backup_id: int | None = None


class BackupRestoreResponse(BaseModel):
    status: str
    message: str


# ============ Settings Endpoints ============

@router.get("/settings", response_model=BackupSettingsResponse)
async def get_backup_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get backup settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        return BackupSettingsResponse(
            backup_frequency="manual",
            backup_retention_count=7,
            backup_destination="local",
            backup_time="03:00",
            backup_nextcloud_path="/Backups",
            backup_smb_host=None,
            backup_smb_share=None,
            backup_smb_username=None,
            backup_smb_password_set=False,
            backup_smb_path="/backups",
            backup_last_run_at=None,
            backup_last_status=None,
            backup_last_error=None
        )

    return BackupSettingsResponse(
        backup_frequency=settings.backup_frequency,
        backup_retention_count=settings.backup_retention_count,
        backup_destination=settings.backup_destination,
        backup_time=settings.backup_time,
        backup_nextcloud_path=settings.backup_nextcloud_path,
        backup_smb_host=settings.backup_smb_host,
        backup_smb_share=settings.backup_smb_share,
        backup_smb_username=settings.backup_smb_username,
        backup_smb_password_set=bool(settings.backup_smb_password),
        backup_smb_path=settings.backup_smb_path,
        backup_last_run_at=settings.backup_last_run_at.isoformat() if settings.backup_last_run_at else None,
        backup_last_status=settings.backup_last_status,
        backup_last_error=settings.backup_last_error
    )


@router.patch("/settings", response_model=BackupSettingsResponse)
async def update_backup_settings(
    update: BackupSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update backup settings"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == 'backup_smb_password' and value:
            setattr(settings, field, value)
        elif value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return BackupSettingsResponse(
        backup_frequency=settings.backup_frequency,
        backup_retention_count=settings.backup_retention_count,
        backup_destination=settings.backup_destination,
        backup_time=settings.backup_time,
        backup_nextcloud_path=settings.backup_nextcloud_path,
        backup_smb_host=settings.backup_smb_host,
        backup_smb_share=settings.backup_smb_share,
        backup_smb_username=settings.backup_smb_username,
        backup_smb_password_set=bool(settings.backup_smb_password),
        backup_smb_path=settings.backup_smb_path,
        backup_last_run_at=settings.backup_last_run_at.isoformat() if settings.backup_last_run_at else None,
        backup_last_status=settings.backup_last_status,
        backup_last_error=settings.backup_last_error
    )


# ============ Backup Operations ============

async def _run_backup_task(db: AsyncSession, kitchen_id: int, user_id: int):
    """Background task to run backup"""
    backup_service = BackupService(db, kitchen_id)
    await backup_service.create_backup(user_id=user_id, backup_type="manual")


@router.post("/create", response_model=BackupCreateResponse)
async def create_backup(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Trigger a manual backup"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    # Run backup synchronously for now to get immediate feedback
    backup_service = BackupService(db, current_user.kitchen_id)
    success, message, backup = await backup_service.create_backup(
        user_id=current_user.id,
        backup_type="manual"
    )

    if not success:
        raise HTTPException(status_code=500, detail=message)

    return BackupCreateResponse(
        message=message,
        status="success",
        backup_id=backup.id if backup else None
    )


@router.get("/history", response_model=list[BackupHistoryResponse])
async def list_backups(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List backup history"""
    backup_service = BackupService(db, current_user.kitchen_id)
    backups = await backup_service.list_backups()

    return [
        BackupHistoryResponse(
            id=b.id,
            backup_type=b.backup_type,
            destination=b.destination,
            status=b.status,
            filename=b.filename,
            file_size_bytes=b.file_size_bytes,
            invoice_count=b.invoice_count,
            file_count=b.file_count,
            started_at=b.started_at.isoformat(),
            completed_at=b.completed_at.isoformat() if b.completed_at else None,
            error_message=b.error_message,
            triggered_by_username=b.triggered_by_user.name if b.triggered_by_user else None
        )
        for b in backups
    ]


@router.post("/{backup_id}/restore", response_model=BackupRestoreResponse)
async def restore_backup(
    backup_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Restore from a backup"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    backup_service = BackupService(db, current_user.kitchen_id)
    success, message = await backup_service.restore_backup(backup_id)

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return BackupRestoreResponse(status="success", message=message)


@router.delete("/{backup_id}")
async def delete_backup(
    backup_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a backup"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    backup_service = BackupService(db, current_user.kitchen_id)
    success, message = await backup_service.delete_backup(backup_id)

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {"message": message}


@router.get("/{backup_id}/download")
async def download_backup(
    backup_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Download a backup file"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    backup_service = BackupService(db, current_user.kitchen_id)
    backup = await backup_service.get_backup(backup_id)

    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    if backup.status != "success":
        raise HTTPException(status_code=400, detail="Cannot download failed backup")

    # Handle local backups
    if not backup.file_path.startswith("nextcloud:"):
        if not os.path.exists(backup.file_path):
            raise HTTPException(status_code=404, detail="Backup file not found on disk")

        return FileResponse(
            path=backup.file_path,
            filename=backup.filename,
            media_type="application/zip"
        )

    # Handle Nextcloud backups - download to temp file
    from services.nextcloud_service import NextcloudService

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.nextcloud_host:
        raise HTTPException(status_code=400, detail="Nextcloud not configured")

    nc_path = backup.file_path.replace("nextcloud:", "")
    nc = NextcloudService(
        settings.nextcloud_host,
        settings.nextcloud_username,
        settings.nextcloud_password,
        ""
    )
    success, content = await nc.download_file(nc_path)
    await nc.close()

    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to download from Nextcloud: {content}")

    # Write to temp file and return
    temp_dir = tempfile.mkdtemp()
    temp_path = os.path.join(temp_dir, backup.filename)
    with open(temp_path, 'wb') as f:
        f.write(content)

    return FileResponse(
        path=temp_path,
        filename=backup.filename,
        media_type="application/zip",
        background=lambda: shutil.rmtree(temp_dir, ignore_errors=True)
    )


@router.post("/upload", response_model=BackupRestoreResponse)
async def upload_and_restore_backup(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload a backup file and restore from it"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    if not file.filename.endswith('.zip'):
        raise HTTPException(status_code=400, detail="Only ZIP files are accepted")

    backup_service = BackupService(db, current_user.kitchen_id)
    success, message = await backup_service.restore_from_upload(file)

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return BackupRestoreResponse(status="success", message=message)
