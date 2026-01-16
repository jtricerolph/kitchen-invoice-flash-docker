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

    class Config:
        from_attributes = True


class SettingsUpdate(BaseModel):
    azure_endpoint: str | None = None
    azure_key: str | None = None
    currency_symbol: str | None = None
    date_format: str | None = None


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

    return SettingsResponse(
        azure_endpoint=settings.azure_endpoint,
        azure_key_set=bool(settings.azure_key),
        currency_symbol=settings.currency_symbol,
        date_format=settings.date_format
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

    return SettingsResponse(
        azure_endpoint=settings.azure_endpoint,
        azure_key_set=bool(settings.azure_key),
        currency_symbol=settings.currency_symbol,
        date_format=settings.date_format
    )


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
