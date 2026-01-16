from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.supplier import Supplier
from auth.jwt import get_current_user

router = APIRouter()


class SupplierCreate(BaseModel):
    name: str
    aliases: list[str] = []
    template_config: dict = {}
    identifier_config: dict = {}


class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    template_config: Optional[dict] = None
    identifier_config: Optional[dict] = None


class SupplierResponse(BaseModel):
    id: int
    name: str
    aliases: list[str]
    template_config: dict
    identifier_config: dict
    created_at: str

    class Config:
        from_attributes = True


@router.post("/", response_model=SupplierResponse)
async def create_supplier(
    request: SupplierCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new supplier with extraction templates"""
    supplier = Supplier(
        kitchen_id=current_user.kitchen_id,
        name=request.name,
        aliases=request.aliases,
        template_config=request.template_config,
        identifier_config=request.identifier_config
    )
    db.add(supplier)
    await db.commit()
    await db.refresh(supplier)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        created_at=supplier.created_at.isoformat()
    )


@router.get("/", response_model=list[SupplierResponse])
async def list_suppliers(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all suppliers for the current kitchen"""
    result = await db.execute(
        select(Supplier)
        .where(Supplier.kitchen_id == current_user.kitchen_id)
        .order_by(Supplier.name)
    )
    suppliers = result.scalars().all()

    return [
        SupplierResponse(
            id=s.id,
            name=s.name,
            aliases=s.aliases or [],
            template_config=s.template_config,
            identifier_config=s.identifier_config,
            created_at=s.created_at.isoformat()
        )
        for s in suppliers
    ]


@router.get("/{supplier_id}", response_model=SupplierResponse)
async def get_supplier(
    supplier_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a supplier by ID"""
    result = await db.execute(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.kitchen_id == current_user.kitchen_id
        )
    )
    supplier = result.scalar_one_or_none()

    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        created_at=supplier.created_at.isoformat()
    )


@router.patch("/{supplier_id}", response_model=SupplierResponse)
async def update_supplier(
    supplier_id: int,
    update: SupplierUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update a supplier's template configuration"""
    result = await db.execute(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.kitchen_id == current_user.kitchen_id
        )
    )
    supplier = result.scalar_one_or_none()

    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(supplier, field, value)

    await db.commit()
    await db.refresh(supplier)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        created_at=supplier.created_at.isoformat()
    )


@router.delete("/{supplier_id}")
async def delete_supplier(
    supplier_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a supplier"""
    result = await db.execute(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.kitchen_id == current_user.kitchen_id
        )
    )
    supplier = result.scalar_one_or_none()

    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    await db.delete(supplier)
    await db.commit()

    return {"message": "Supplier deleted"}


class AddAliasRequest(BaseModel):
    alias: str


@router.post("/{supplier_id}/aliases", response_model=SupplierResponse)
async def add_supplier_alias(
    supplier_id: int,
    request: AddAliasRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Add an alias to a supplier for better matching"""
    result = await db.execute(
        select(Supplier).where(
            Supplier.id == supplier_id,
            Supplier.kitchen_id == current_user.kitchen_id
        )
    )
    supplier = result.scalar_one_or_none()

    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    alias = request.alias.strip()
    if not alias:
        raise HTTPException(status_code=400, detail="Alias cannot be empty")

    # Add alias if not already present
    current_aliases = supplier.aliases or []
    if alias not in current_aliases:
        current_aliases.append(alias)
        supplier.aliases = current_aliases
        await db.commit()
        await db.refresh(supplier)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        created_at=supplier.created_at.isoformat()
    )
