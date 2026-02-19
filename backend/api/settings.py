from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.settings import KitchenSettings
from auth.jwt import get_current_user

router = APIRouter()


class SettingsResponse(BaseModel):
    azure_endpoint: str | None
    azure_key_set: bool  # Don't expose the actual key, just whether it's set
    currency_symbol: str
    date_format: str
    high_quantity_threshold: int
    # SMTP settings
    smtp_host: str | None
    smtp_port: int | None
    smtp_username: str | None
    smtp_password_set: bool  # Don't expose the actual password
    smtp_use_tls: bool
    smtp_from_email: str | None
    smtp_from_name: str | None
    support_email: str | None
    # Dext integration
    dext_email: str | None
    dext_include_notes: bool
    dext_include_non_stock: bool
    dext_auto_send_enabled: bool
    dext_manual_send_enabled: bool
    dext_include_annotations: bool
    # PDF annotation settings
    pdf_annotations_enabled: bool
    pdf_preview_show_annotations: bool
    # OCR post-processing options
    ocr_clean_product_codes: bool
    ocr_filter_subtotal_rows: bool
    ocr_use_weight_as_quantity: bool
    # Cost distribution settings
    cost_distribution_max_days: int
    # LLM settings — see LLM-MANIFEST.md for removal instructions
    llm_enabled: bool = False
    anthropic_api_key_set: bool = False  # Don't expose the actual key
    llm_model: str | None = None
    llm_confidence_threshold: float | None = None
    llm_monthly_token_limit: int = 500000
    llm_features_enabled: dict | None = None

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    azure_endpoint: str | None = None
    azure_key: str | None = None
    currency_symbol: str | None = None
    date_format: str | None = None
    high_quantity_threshold: int | None = None
    # SMTP settings
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_username: str | None = None
    smtp_password: str | None = None  # Only set if provided
    smtp_use_tls: bool | None = None
    smtp_from_email: str | None = None
    smtp_from_name: str | None = None
    support_email: str | None = None
    # Dext integration
    dext_email: str | None = None
    dext_include_notes: bool | None = None
    dext_include_non_stock: bool | None = None
    dext_auto_send_enabled: bool | None = None
    dext_manual_send_enabled: bool | None = None
    dext_include_annotations: bool | None = None
    # PDF annotation settings
    pdf_annotations_enabled: bool | None = None
    pdf_preview_show_annotations: bool | None = None
    # OCR post-processing options
    ocr_clean_product_codes: bool | None = None
    ocr_filter_subtotal_rows: bool | None = None
    ocr_use_weight_as_quantity: bool | None = None
    # Cost distribution settings
    cost_distribution_max_days: int | None = None
    # LLM settings — see LLM-MANIFEST.md for removal instructions
    llm_enabled: bool | None = None
    anthropic_api_key: str | None = None  # Only set if provided
    llm_model: str | None = None
    llm_confidence_threshold: float | None = None
    llm_monthly_token_limit: int | None = None
    llm_features_enabled: dict | None = None


@router.get("/", response_model=SettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current kitchen settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        # Create default settings if none exist
        settings = KitchenSettings(
            kitchen_id=current_user.kitchen_id,
            currency_symbol="£",
            date_format="DD/MM/YYYY"
        )
        db.add(settings)
        await db.commit()
        await db.refresh(settings)

    return _build_settings_response(settings)


def _build_settings_response(settings: KitchenSettings) -> SettingsResponse:
    """Build SettingsResponse from a KitchenSettings model instance."""
    return SettingsResponse(
        azure_endpoint=settings.azure_endpoint,
        azure_key_set=bool(settings.azure_key),
        currency_symbol=settings.currency_symbol,
        date_format=settings.date_format,
        high_quantity_threshold=settings.high_quantity_threshold,
        # SMTP settings
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_username=settings.smtp_username,
        smtp_password_set=bool(settings.smtp_password),
        smtp_use_tls=settings.smtp_use_tls,
        smtp_from_email=settings.smtp_from_email,
        smtp_from_name=settings.smtp_from_name,
        support_email=settings.support_email,
        # Dext integration
        dext_email=settings.dext_email,
        dext_include_notes=settings.dext_include_notes,
        dext_include_non_stock=settings.dext_include_non_stock,
        dext_auto_send_enabled=settings.dext_auto_send_enabled,
        dext_manual_send_enabled=settings.dext_manual_send_enabled,
        dext_include_annotations=settings.dext_include_annotations,
        # PDF annotation settings
        pdf_annotations_enabled=settings.pdf_annotations_enabled,
        pdf_preview_show_annotations=settings.pdf_preview_show_annotations,
        # OCR post-processing options
        ocr_clean_product_codes=settings.ocr_clean_product_codes,
        ocr_filter_subtotal_rows=settings.ocr_filter_subtotal_rows,
        ocr_use_weight_as_quantity=settings.ocr_use_weight_as_quantity,
        cost_distribution_max_days=settings.cost_distribution_max_days,
        # LLM settings — see LLM-MANIFEST.md for removal instructions
        llm_enabled=settings.llm_enabled,
        anthropic_api_key_set=bool(settings.anthropic_api_key),
        llm_model=settings.llm_model,
        llm_confidence_threshold=float(settings.llm_confidence_threshold) if settings.llm_confidence_threshold else None,
        llm_monthly_token_limit=settings.llm_monthly_token_limit,
        llm_features_enabled=settings.llm_features_enabled,
    )


@router.patch("/", response_model=SettingsResponse)
async def update_settings(
    update: SettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update kitchen settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return _build_settings_response(settings)


@router.post("/test-azure")
async def test_azure_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test Azure Document Intelligence connection"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.azure_endpoint or not settings.azure_key:
        raise HTTPException(
            status_code=400,
            detail="Azure credentials not configured"
        )

    try:
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential

        client = DocumentAnalysisClient(
            endpoint=settings.azure_endpoint,
            credential=AzureKeyCredential(settings.azure_key)
        )
        # Simple connection test - this will validate credentials
        # The actual analysis would happen during invoice processing
        return {"status": "success", "message": "Azure connection successful"}
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Azure connection failed: {str(e)}"
        )


@router.post("/test-smtp")
async def test_smtp_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test SMTP connection with current settings"""
    from services.email_service import EmailService

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.smtp_host or not settings.smtp_from_email:
        raise HTTPException(
            status_code=400,
            detail="SMTP not fully configured. Please set SMTP host and from email."
        )

    email_service = EmailService(settings)
    success, message = email_service.test_connection()

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {"status": "success", "message": message}


# ============ Kitchen Details Endpoints ============

class KitchenDetailsResponse(BaseModel):
    kitchen_display_name: str | None = None
    kitchen_address_line1: str | None = None
    kitchen_address_line2: str | None = None
    kitchen_city: str | None = None
    kitchen_postcode: str | None = None
    kitchen_phone: str | None = None
    kitchen_email: str | None = None


class KitchenDetailsUpdate(BaseModel):
    kitchen_display_name: str | None = None
    kitchen_address_line1: str | None = None
    kitchen_address_line2: str | None = None
    kitchen_city: str | None = None
    kitchen_postcode: str | None = None
    kitchen_phone: str | None = None
    kitchen_email: str | None = None


@router.get("/kitchen-details", response_model=KitchenDetailsResponse)
async def get_kitchen_details(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get kitchen details for PO letterhead"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        return KitchenDetailsResponse()

    return KitchenDetailsResponse(
        kitchen_display_name=settings.kitchen_display_name,
        kitchen_address_line1=settings.kitchen_address_line1,
        kitchen_address_line2=settings.kitchen_address_line2,
        kitchen_city=settings.kitchen_city,
        kitchen_postcode=settings.kitchen_postcode,
        kitchen_phone=settings.kitchen_phone,
        kitchen_email=settings.kitchen_email,
    )


@router.patch("/kitchen-details", response_model=KitchenDetailsResponse)
async def update_kitchen_details(
    update: KitchenDetailsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update kitchen details for PO letterhead"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return KitchenDetailsResponse(
        kitchen_display_name=settings.kitchen_display_name,
        kitchen_address_line1=settings.kitchen_address_line1,
        kitchen_address_line2=settings.kitchen_address_line2,
        kitchen_city=settings.kitchen_city,
        kitchen_postcode=settings.kitchen_postcode,
        kitchen_phone=settings.kitchen_phone,
        kitchen_email=settings.kitchen_email,
    )


# ============ Page Restrictions Endpoints ============

class PageRestrictionsResponse(BaseModel):
    restricted_pages: list[str]


class PageRestrictionsUpdate(BaseModel):
    restricted_pages: list[str]


@router.get("/page-restrictions", response_model=PageRestrictionsResponse)
async def get_page_restrictions(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get list of pages restricted to admin users only"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        return PageRestrictionsResponse(restricted_pages=[])

    # Parse comma-separated list
    restricted = []
    if settings.admin_restricted_pages:
        restricted = [p.strip() for p in settings.admin_restricted_pages.split(',') if p.strip()]

    return PageRestrictionsResponse(restricted_pages=restricted)


@router.patch("/page-restrictions", response_model=PageRestrictionsResponse)
async def update_page_restrictions(
    update: PageRestrictionsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update list of pages restricted to admin users only (admin only)"""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="Only admins can modify page restrictions"
        )

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    # Store as comma-separated string
    settings.admin_restricted_pages = ','.join(update.restricted_pages) if update.restricted_pages else None

    await db.commit()

    return PageRestrictionsResponse(restricted_pages=update.restricted_pages)


# ============ Nextcloud Settings Endpoints ============

class NextcloudSettingsResponse(BaseModel):
    nextcloud_host: str | None
    nextcloud_username: str | None
    nextcloud_password_set: bool
    nextcloud_base_path: str | None
    nextcloud_enabled: bool
    nextcloud_delete_local: bool

    class Config:
        from_attributes = True


class NextcloudSettingsUpdate(BaseModel):
    nextcloud_host: str | None = None
    nextcloud_username: str | None = None
    nextcloud_password: str | None = None
    nextcloud_base_path: str | None = None
    nextcloud_enabled: bool | None = None
    nextcloud_delete_local: bool | None = None


class NextcloudStatsResponse(BaseModel):
    pending_count: int
    archived_count: int
    local_count: int
    nextcloud_enabled: bool
    nextcloud_configured: bool


class NextcloudArchiveResponse(BaseModel):
    success_count: int
    failed_count: int
    errors: list[str]


@router.get("/nextcloud", response_model=NextcloudSettingsResponse)
async def get_nextcloud_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get Nextcloud settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        return NextcloudSettingsResponse(
            nextcloud_host=None,
            nextcloud_username=None,
            nextcloud_password_set=False,
            nextcloud_base_path="/Kitchen Invoices",
            nextcloud_enabled=False,
            nextcloud_delete_local=False
        )

    return NextcloudSettingsResponse(
        nextcloud_host=settings.nextcloud_host,
        nextcloud_username=settings.nextcloud_username,
        nextcloud_password_set=bool(settings.nextcloud_password),
        nextcloud_base_path=settings.nextcloud_base_path,
        nextcloud_enabled=settings.nextcloud_enabled,
        nextcloud_delete_local=settings.nextcloud_delete_local
    )


@router.patch("/nextcloud", response_model=NextcloudSettingsResponse)
async def update_nextcloud_settings(
    update: NextcloudSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update Nextcloud settings"""
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
        # Map 'nextcloud_password' to the model field
        if field == 'nextcloud_password' and value:
            setattr(settings, field, value)
        elif value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return NextcloudSettingsResponse(
        nextcloud_host=settings.nextcloud_host,
        nextcloud_username=settings.nextcloud_username,
        nextcloud_password_set=bool(settings.nextcloud_password),
        nextcloud_base_path=settings.nextcloud_base_path,
        nextcloud_enabled=settings.nextcloud_enabled,
        nextcloud_delete_local=settings.nextcloud_delete_local
    )


@router.post("/nextcloud/test")
async def test_nextcloud_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test Nextcloud WebDAV connection"""
    from services.nextcloud_service import NextcloudService

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
        raise HTTPException(status_code=400, detail="Nextcloud not fully configured")

    nc = NextcloudService(
        settings.nextcloud_host,
        settings.nextcloud_username,
        settings.nextcloud_password,
        settings.nextcloud_base_path
    )

    success, message = await nc.test_connection()
    await nc.close()

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {"status": "success", "message": message}


@router.get("/nextcloud/stats", response_model=NextcloudStatsResponse)
async def get_nextcloud_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get Nextcloud archive statistics"""
    from services.file_archival_service import FileArchivalService

    archival_service = FileArchivalService(db, current_user.kitchen_id)
    stats = await archival_service.get_archive_stats()

    return NextcloudStatsResponse(**stats)


@router.post("/nextcloud/archive-all", response_model=NextcloudArchiveResponse)
async def archive_all_pending(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Manually archive all pending invoices to Nextcloud"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    from services.file_archival_service import FileArchivalService

    archival_service = FileArchivalService(db, current_user.kitchen_id)
    success_count, failed_count, errors = await archival_service.archive_all_pending()

    return NextcloudArchiveResponse(
        success_count=success_count,
        failed_count=failed_count,
        errors=errors
    )


@router.post("/nextcloud/archive/{invoice_id}")
async def archive_single_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Archive a single invoice to Nextcloud (for testing)"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    from models.invoice import Invoice
    from services.file_archival_service import FileArchivalService

    # Get the invoice
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()

    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    if invoice.file_storage_location == "nextcloud":
        return {"status": "skipped", "message": "Invoice already archived to Nextcloud"}

    # Check Nextcloud config
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()

    if not settings or not all([settings.nextcloud_host, settings.nextcloud_username, settings.nextcloud_password]):
        raise HTTPException(status_code=400, detail="Nextcloud not fully configured")

    archival_service = FileArchivalService(db, current_user.kitchen_id)
    success, message = await archival_service.archive_invoice_file(invoice)

    if not success:
        raise HTTPException(status_code=500, detail=message)

    return {"status": "success", "message": message, "nextcloud_path": invoice.nextcloud_path}


# ============ API Access Endpoints ============

class ApiAccessResponse(BaseModel):
    api_key: str | None
    api_key_enabled: bool


class ApiAccessUpdate(BaseModel):
    api_key_enabled: bool


@router.get("/api-access", response_model=ApiAccessResponse)
async def get_api_access(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get API access settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        return ApiAccessResponse(api_key=None, api_key_enabled=False)

    return ApiAccessResponse(
        api_key=settings.api_key,
        api_key_enabled=settings.api_key_enabled,
    )


@router.patch("/api-access", response_model=ApiAccessResponse)
async def update_api_access(
    update: ApiAccessUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update API access settings (enable/disable)"""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    settings.api_key_enabled = update.api_key_enabled

    await db.commit()
    await db.refresh(settings)

    return ApiAccessResponse(
        api_key=settings.api_key,
        api_key_enabled=settings.api_key_enabled,
    )


@router.post("/api-access/regenerate")
async def regenerate_api_key(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Generate or regenerate the API key"""
    import secrets

    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    new_key = secrets.token_urlsafe(32)
    settings.api_key = new_key
    settings.api_key_enabled = True

    await db.commit()
    await db.refresh(settings)

    return {"api_key": new_key, "api_key_enabled": True}


# ============ LLM Usage Stats Endpoints ============
# LLM FEATURE — see LLM-MANIFEST.md for removal instructions


class LlmUsageStatsResponse(BaseModel):
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    cache_entries_this_month: int = 0


@router.get("/llm-usage", response_model=LlmUsageStatsResponse)
async def get_llm_usage(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get aggregated LLM usage stats for the current month"""
    from services.llm_service import get_usage_stats

    stats = await get_usage_stats(db, current_user.kitchen_id)
    return LlmUsageStatsResponse(**stats)


@router.post("/test-llm")
async def test_llm_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test Anthropic API connection with current settings"""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.anthropic_api_key:
        raise HTTPException(
            status_code=400,
            detail="Anthropic API key not configured"
        )

    if not settings.llm_enabled:
        raise HTTPException(
            status_code=400,
            detail="LLM features are disabled. Enable them in Settings first."
        )

    try:
        import anthropic
        from services.llm_service import DEFAULT_LLM_MODEL
        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        response = await client.messages.create(
            model=settings.llm_model or DEFAULT_LLM_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": "Say 'ok'"}],
        )
        return {"status": "success", "message": f"Connection successful. Model: {response.model}"}
    except anthropic.AuthenticationError:
        raise HTTPException(status_code=400, detail="Authentication failed — check your API key")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Connection failed: {str(e)}")


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
@router.get("/llm-models")
async def get_llm_models(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fetch available models from Anthropic API."""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = result.scalar_one_or_none()

    if not settings or not settings.anthropic_api_key:
        return {"models": [], "default": None, "error": "No API key configured"}

    from services.llm_service import list_available_models, DEFAULT_LLM_MODEL
    models = await list_available_models(settings.anthropic_api_key)

    return {
        "models": models,
        "default": DEFAULT_LLM_MODEL,
        "current": settings.llm_model or DEFAULT_LLM_MODEL,
    }
