from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from database import get_db, AsyncSessionLocal
from models.user import User
from models.supplier import Supplier
from models.invoice import Invoice
from auth.jwt import get_current_user
from ocr.parser import identify_supplier

router = APIRouter()


async def rematch_unmatched_invoices(kitchen_id: int):
    """
    Re-run supplier matching for all invoices without a supplier.
    Called after supplier create/update to match previously unmatched invoices.
    """
    async with AsyncSessionLocal() as db:
        # Get all invoices without a supplier that have vendor_name from OCR
        result = await db.execute(
            select(Invoice).where(
                Invoice.kitchen_id == kitchen_id,
                Invoice.supplier_id == None,
                Invoice.vendor_name != None
            )
        )
        invoices = result.scalars().all()

        for invoice in invoices:
            if invoice.vendor_name:
                supplier_id, match_type = await identify_supplier(
                    invoice.vendor_name, kitchen_id, db
                )
                if supplier_id:
                    invoice.supplier_id = supplier_id
                    invoice.supplier_match_type = match_type

        await db.commit()


class SupplierCreate(BaseModel):
    name: str
    aliases: list[str] = []
    template_config: dict = {}
    identifier_config: dict = {}
    skip_dext: bool = False
    order_email: Optional[str] = None
    account_number: Optional[str] = None


class SupplierUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    template_config: Optional[dict] = None
    identifier_config: Optional[dict] = None
    skip_dext: Optional[bool] = None
    order_email: Optional[str] = None
    account_number: Optional[str] = None


class SupplierResponse(BaseModel):
    id: int
    name: str
    aliases: list[str]
    template_config: dict
    identifier_config: dict
    skip_dext: bool
    order_email: Optional[str] = None
    account_number: Optional[str] = None
    created_at: str

    class Config:
        from_attributes = True


@router.post("/", response_model=SupplierResponse)
async def create_supplier(
    request: SupplierCreate,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new supplier with extraction templates"""
    supplier = Supplier(
        kitchen_id=current_user.kitchen_id,
        name=request.name,
        aliases=request.aliases,
        template_config=request.template_config,
        identifier_config=request.identifier_config,
        skip_dext=request.skip_dext,
        order_email=request.order_email,
        account_number=request.account_number,
    )
    db.add(supplier)
    await db.commit()
    await db.refresh(supplier)

    # Rematch unmatched invoices in background
    background_tasks.add_task(rematch_unmatched_invoices, current_user.kitchen_id)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        skip_dext=supplier.skip_dext,
        order_email=supplier.order_email,
        account_number=supplier.account_number,
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
            skip_dext=s.skip_dext,
            order_email=s.order_email,
            account_number=s.account_number,
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
        skip_dext=supplier.skip_dext,
        order_email=supplier.order_email,
        account_number=supplier.account_number,
        created_at=supplier.created_at.isoformat()
    )


@router.patch("/{supplier_id}", response_model=SupplierResponse)
async def update_supplier(
    supplier_id: int,
    update: SupplierUpdate,
    background_tasks: BackgroundTasks,
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

    # Rematch unmatched invoices in background
    background_tasks.add_task(rematch_unmatched_invoices, current_user.kitchen_id)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        skip_dext=supplier.skip_dext,
        order_email=supplier.order_email,
        account_number=supplier.account_number,
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
    invoice_id: Optional[int] = None  # If provided, update this invoice's match type to 'exact'


@router.post("/{supplier_id}/aliases", response_model=SupplierResponse)
async def add_supplier_alias(
    supplier_id: int,
    request: AddAliasRequest,
    background_tasks: BackgroundTasks,
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
    # Create a new list to ensure SQLAlchemy detects the change (JSON columns don't detect in-place mutations)
    current_aliases = list(supplier.aliases or [])
    if alias not in current_aliases:
        current_aliases.append(alias)
        supplier.aliases = current_aliases

    # If invoice_id provided, update that invoice's match type to 'exact'
    if request.invoice_id:
        inv_result = await db.execute(
            select(Invoice).where(
                Invoice.id == request.invoice_id,
                Invoice.kitchen_id == current_user.kitchen_id
            )
        )
        invoice = inv_result.scalar_one_or_none()
        if invoice and invoice.supplier_match_type == 'fuzzy':
            invoice.supplier_match_type = 'exact'

    await db.commit()
    await db.refresh(supplier)

    # Rematch unmatched invoices in background
    background_tasks.add_task(rematch_unmatched_invoices, current_user.kitchen_id)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        aliases=supplier.aliases or [],
        template_config=supplier.template_config,
        identifier_config=supplier.identifier_config,
        skip_dext=supplier.skip_dext,
        order_email=supplier.order_email,
        account_number=supplier.account_number,
        created_at=supplier.created_at.isoformat()
    )


@router.post("/rematch-fuzzy")
async def rematch_fuzzy_invoices(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Clear all fuzzy-matched invoices and re-run supplier matching.
    Use this after updating matching logic to fix incorrect fuzzy matches.
    """
    # Count fuzzy matches before clearing
    count_result = await db.execute(
        select(Invoice).where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.supplier_match_type == "fuzzy"
        )
    )
    fuzzy_invoices = count_result.scalars().all()
    count = len(fuzzy_invoices)

    # Clear supplier assignment for all fuzzy matches
    for invoice in fuzzy_invoices:
        invoice.supplier_id = None
        invoice.supplier_match_type = None

    await db.commit()

    # Re-run matching in background
    background_tasks.add_task(rematch_unmatched_invoices, current_user.kitchen_id)

    return {"message": f"Cleared {count} fuzzy matches. Re-matching in background."}
