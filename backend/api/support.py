"""
Support Request API

Handles user support requests with page screenshots.
"""
import base64
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from auth.jwt import get_current_user
from models.user import User, Kitchen
from models.settings import KitchenSettings
from services.email_service import EmailService
from sqlalchemy import select

router = APIRouter()
logger = logging.getLogger(__name__)


class SupportRequest(BaseModel):
    """Support request payload"""
    description: str
    screenshot: str  # Base64 encoded PNG
    page_url: str
    browser_info: str | None = None


class SupportResponse(BaseModel):
    """Support request response"""
    success: bool
    message: str


def generate_support_email_html(
    user_name: str,
    user_email: str,
    kitchen_name: str,
    description: str,
    page_url: str,
    browser_info: str | None,
    timestamp: datetime
) -> str:
    """Generate HTML email body for support request"""
    return f"""
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; color: #333; line-height: 1.6; }}
            .header {{ background-color: #e94560; color: white; padding: 20px; }}
            .content {{ padding: 20px; }}
            .meta {{ background: #f5f5f5; padding: 15px; border-radius: 6px; margin-bottom: 20px; }}
            .meta p {{ margin: 5px 0; }}
            .label {{ font-weight: bold; color: #666; }}
            .description {{ background: #fffbcc; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; }}
            .screenshot-note {{ color: #666; font-style: italic; margin-top: 20px; }}
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Support Request</h2>
        </div>
        <div class="content">
            <div class="meta">
                <p><span class="label">From:</span> {user_name} ({user_email})</p>
                <p><span class="label">Kitchen:</span> {kitchen_name}</p>
                <p><span class="label">Page URL:</span> {page_url}</p>
                <p><span class="label">Timestamp:</span> {timestamp.strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
                {f'<p><span class="label">Browser:</span> {browser_info}</p>' if browser_info else ''}
            </div>

            <h3>Issue Description</h3>
            <div class="description">
                <p>{description.replace(chr(10), '<br>')}</p>
            </div>

            <p class="screenshot-note">A screenshot of the page is attached to this email.</p>
        </div>
    </body>
    </html>
    """


@router.post("/support/request", response_model=SupportResponse)
async def submit_support_request(
    request: SupportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Submit a support request with page screenshot.

    The screenshot is sent as an email attachment to the configured support email.
    """
    # Get kitchen settings
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        raise HTTPException(status_code=404, detail="Kitchen settings not found")

    # Check if support email is configured
    if not settings.support_email:
        raise HTTPException(
            status_code=400,
            detail="Support email not configured. Please contact your administrator."
        )

    # Check if SMTP is configured
    if not settings.smtp_host or not settings.smtp_from_email:
        raise HTTPException(
            status_code=400,
            detail="Email settings not configured. Please contact your administrator."
        )

    # Fetch kitchen name explicitly to avoid lazy loading issues
    kitchen_result = await db.execute(
        select(Kitchen).where(Kitchen.id == current_user.kitchen_id)
    )
    kitchen = kitchen_result.scalar_one_or_none()
    kitchen_name = kitchen.name if kitchen else "Unknown Kitchen"

    try:
        # Decode screenshot from base64
        # Remove data URL prefix if present
        screenshot_data = request.screenshot
        if screenshot_data.startswith('data:'):
            screenshot_data = screenshot_data.split(',', 1)[1]

        screenshot_bytes = base64.b64decode(screenshot_data)

        # Generate email
        timestamp = datetime.utcnow()
        html_body = generate_support_email_html(
            user_name=current_user.name,
            user_email=current_user.email,
            kitchen_name=kitchen_name,
            description=request.description,
            page_url=request.page_url,
            browser_info=request.browser_info,
            timestamp=timestamp
        )

        # Create email subject
        subject = f"Support Request from {current_user.name} - {kitchen_name}"

        # Send email with screenshot attachment
        email_service = EmailService(settings)
        filename = f"screenshot_{timestamp.strftime('%Y%m%d_%H%M%S')}.png"

        success = email_service.send_email(
            to_email=settings.support_email,
            subject=subject,
            html_body=html_body,
            attachments=[(filename, screenshot_bytes)]
        )

        if success:
            logger.info(f"Support request sent from {current_user.name} to {settings.support_email}")
            return SupportResponse(
                success=True,
                message="Support request sent successfully. We'll get back to you soon."
            )
        else:
            logger.error(f"Failed to send support request email")
            raise HTTPException(
                status_code=500,
                detail="Failed to send support request. Please try again later."
            )

    except base64.binascii.Error:
        raise HTTPException(status_code=400, detail="Invalid screenshot data")
    except Exception as e:
        logger.error(f"Support request error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/support/enabled")
async def check_support_enabled(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Check if support requests are enabled (support email configured).
    Returns whether the support button should be shown.
    """
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    enabled = bool(
        settings and
        settings.support_email and
        settings.smtp_host and
        settings.smtp_from_email
    )

    return {"enabled": enabled}
