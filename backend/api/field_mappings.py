from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.field_mapping import (
    FieldMapping,
    AZURE_INVOICE_FIELDS,
    AZURE_LINE_ITEM_FIELDS,
    TARGET_INVOICE_FIELDS,
    TARGET_LINE_ITEM_FIELDS
)
from auth.jwt import get_current_user

router = APIRouter()


class FieldMappingResponse(BaseModel):
    id: int
    supplier_id: int | None
    source_field: str
    target_field: str
    field_type: str
    transform: str
    priority: int

    class Config:
        from_attributes = True


class FieldMappingCreate(BaseModel):
    supplier_id: Optional[int] = None
    source_field: str
    target_field: str
    field_type: str = "invoice"
    transform: str = "direct"
    priority: int = 0


class FieldMappingUpdate(BaseModel):
    source_field: Optional[str] = None
    target_field: Optional[str] = None
    field_type: Optional[str] = None
    transform: Optional[str] = None
    priority: Optional[int] = None


class FieldOptionsResponse(BaseModel):
    azure_invoice_fields: list[str]
    azure_line_item_fields: list[str]
    target_invoice_fields: list[str]
    target_line_item_fields: list[str]


@router.get("/options", response_model=FieldOptionsResponse)
async def get_field_options():
    """Get available field names for creating mappings"""
    return FieldOptionsResponse(
        azure_invoice_fields=AZURE_INVOICE_FIELDS,
        azure_line_item_fields=AZURE_LINE_ITEM_FIELDS,
        target_invoice_fields=TARGET_INVOICE_FIELDS,
        target_line_item_fields=TARGET_LINE_ITEM_FIELDS
    )


@router.get("/", response_model=list[FieldMappingResponse])
async def list_field_mappings(
    supplier_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List field mappings for the current kitchen, optionally filtered by supplier"""
    query = select(FieldMapping).where(
        FieldMapping.kitchen_id == current_user.kitchen_id
    )

    if supplier_id is not None:
        # Get mappings for specific supplier OR global (supplier_id=null)
        query = query.where(
            (FieldMapping.supplier_id == supplier_id) |
            (FieldMapping.supplier_id.is_(None))
        )

    query = query.order_by(FieldMapping.priority.desc(), FieldMapping.id)

    result = await db.execute(query)
    mappings = result.scalars().all()

    return [
        FieldMappingResponse(
            id=m.id,
            supplier_id=m.supplier_id,
            source_field=m.source_field,
            target_field=m.target_field,
            field_type=m.field_type,
            transform=m.transform,
            priority=m.priority
        )
        for m in mappings
    ]


@router.post("/", response_model=FieldMappingResponse)
async def create_field_mapping(
    mapping: FieldMappingCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new field mapping"""
    # Validate target field
    valid_targets = (
        TARGET_INVOICE_FIELDS if mapping.field_type == "invoice"
        else TARGET_LINE_ITEM_FIELDS
    )
    if mapping.target_field not in valid_targets:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid target field. Valid options: {valid_targets}"
        )

    new_mapping = FieldMapping(
        kitchen_id=current_user.kitchen_id,
        supplier_id=mapping.supplier_id,
        source_field=mapping.source_field,
        target_field=mapping.target_field,
        field_type=mapping.field_type,
        transform=mapping.transform,
        priority=mapping.priority
    )

    db.add(new_mapping)
    await db.commit()
    await db.refresh(new_mapping)

    return FieldMappingResponse(
        id=new_mapping.id,
        supplier_id=new_mapping.supplier_id,
        source_field=new_mapping.source_field,
        target_field=new_mapping.target_field,
        field_type=new_mapping.field_type,
        transform=new_mapping.transform,
        priority=new_mapping.priority
    )


@router.patch("/{mapping_id}", response_model=FieldMappingResponse)
async def update_field_mapping(
    mapping_id: int,
    update: FieldMappingUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update a field mapping"""
    result = await db.execute(
        select(FieldMapping).where(
            FieldMapping.id == mapping_id,
            FieldMapping.kitchen_id == current_user.kitchen_id
        )
    )
    mapping = result.scalar_one_or_none()
    if not mapping:
        raise HTTPException(status_code=404, detail="Field mapping not found")

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(mapping, field, value)

    await db.commit()
    await db.refresh(mapping)

    return FieldMappingResponse(
        id=mapping.id,
        supplier_id=mapping.supplier_id,
        source_field=mapping.source_field,
        target_field=mapping.target_field,
        field_type=mapping.field_type,
        transform=mapping.transform,
        priority=mapping.priority
    )


@router.delete("/{mapping_id}")
async def delete_field_mapping(
    mapping_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a field mapping"""
    result = await db.execute(
        select(FieldMapping).where(
            FieldMapping.id == mapping_id,
            FieldMapping.kitchen_id == current_user.kitchen_id
        )
    )
    mapping = result.scalar_one_or_none()
    if not mapping:
        raise HTTPException(status_code=404, detail="Field mapping not found")

    await db.delete(mapping)
    await db.commit()

    return {"message": "Field mapping deleted"}
