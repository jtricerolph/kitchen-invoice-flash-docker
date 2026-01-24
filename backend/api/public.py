"""
Public API endpoints - NO AUTHENTICATION REQUIRED.

These endpoints are designed for sharing with external parties (e.g., suppliers)
via hash-based URLs that don't require login.
"""
import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from fastapi import Depends

from database import get_db
from models.dispute import DisputeAttachment
from models.settings import KitchenSettings
from services.nextcloud_service import NextcloudService

router = APIRouter()


@router.get("/attachments/{public_hash}")
async def get_public_attachment(
    public_hash: str,
    db: AsyncSession = Depends(get_db)
):
    """
    View a dispute attachment publicly via its hash.

    This endpoint does NOT require authentication, allowing suppliers
    to view attached images/documents via shareable links in emails.
    """
    # Find attachment by public hash
    result = await db.execute(
        select(DisputeAttachment).where(DisputeAttachment.public_hash == public_hash)
    )
    attachment = result.scalar_one_or_none()

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get file content
    content = None

    # Try local file first
    if attachment.file_storage_location == "local" and attachment.file_path:
        if os.path.exists(attachment.file_path):
            with open(attachment.file_path, 'rb') as f:
                content = f.read()

    # Try Nextcloud if local not found
    if content is None and attachment.file_storage_location == "nextcloud" and attachment.nextcloud_path:
        # Get kitchen settings for Nextcloud credentials
        settings_result = await db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == attachment.kitchen_id)
        )
        settings = settings_result.scalar_one_or_none()

        if settings and settings.nextcloud_enabled:
            nc = NextcloudService(
                settings.nextcloud_host,
                settings.nextcloud_username,
                settings.nextcloud_password,
                ""
            )
            success, nc_content = await nc.download_file(attachment.nextcloud_path)
            await nc.close()

            if success:
                content = nc_content

    if content is None:
        raise HTTPException(status_code=404, detail="File not found")

    # Determine if browser should display inline or download
    # Images and PDFs display inline, others download
    inline_types = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf'
    ]

    disposition = "inline" if attachment.file_type in inline_types else "attachment"

    return Response(
        content=content,
        media_type=attachment.file_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{attachment.file_name}"',
            "Cache-Control": "private, max-age=3600"  # Cache for 1 hour
        }
    )


@router.get("/attachments/{public_hash}/info")
async def get_public_attachment_info(
    public_hash: str,
    db: AsyncSession = Depends(get_db)
):
    """
    Get attachment metadata without downloading the file.
    Useful for email previews or link unfurling.
    """
    result = await db.execute(
        select(DisputeAttachment).where(DisputeAttachment.public_hash == public_hash)
    )
    attachment = result.scalar_one_or_none()

    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    return {
        "file_name": attachment.file_name,
        "file_type": attachment.file_type,
        "file_size_bytes": attachment.file_size_bytes,
        "attachment_type": attachment.attachment_type,
        "description": attachment.description,
        "uploaded_at": attachment.uploaded_at.isoformat() if attachment.uploaded_at else None
    }
