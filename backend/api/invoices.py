import os
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
import aiofiles

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from auth.jwt import get_current_user
from ocr.extractor import process_invoice_image

router = APIRouter()

DATA_DIR = "/app/data"


class InvoiceResponse(BaseModel):
    id: int
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None
    supplier_id: int | None
    status: str
    category: str | None
    ocr_confidence: float | None
    image_path: str
    created_at: str

    class Config:
        from_attributes = True


class InvoiceUpdate(BaseModel):
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    total: Optional[Decimal] = None
    supplier_id: Optional[int] = None
    category: Optional[str] = None
    status: Optional[str] = None


class InvoiceListResponse(BaseModel):
    invoices: list[InvoiceResponse]
    total: int


@router.post("/upload", response_model=InvoiceResponse)
async def upload_invoice(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload an invoice image for OCR processing"""
    # Validate file type
    allowed_types = ["image/jpeg", "image/png", "image/webp", "image/heic"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"File type not allowed. Allowed: {allowed_types}"
        )

    # Generate unique filename
    ext = file.filename.split(".")[-1] if file.filename else "jpg"
    filename = f"{uuid.uuid4()}.{ext}"
    filepath = os.path.join(DATA_DIR, str(current_user.kitchen_id), filename)

    # Ensure directory exists
    os.makedirs(os.path.dirname(filepath), exist_ok=True)

    # Save file
    async with aiofiles.open(filepath, "wb") as f:
        content = await file.read()
        await f.write(content)

    # Create invoice record
    invoice = Invoice(
        kitchen_id=current_user.kitchen_id,
        image_path=filepath,
        status=InvoiceStatus.PENDING
    )
    db.add(invoice)
    await db.commit()
    await db.refresh(invoice)

    # Process OCR in background
    background_tasks.add_task(
        process_invoice_background,
        invoice.id,
        filepath,
        current_user.kitchen_id
    )

    return InvoiceResponse(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        total=invoice.total,
        supplier_id=invoice.supplier_id,
        status=invoice.status.value,
        category=invoice.category,
        ocr_confidence=float(invoice.ocr_confidence) if invoice.ocr_confidence else None,
        image_path=invoice.image_path,
        created_at=invoice.created_at.isoformat()
    )


async def process_invoice_background(invoice_id: int, image_path: str, kitchen_id: int):
    """Background task to process invoice OCR"""
    from database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        try:
            # Run OCR extraction
            result = await process_invoice_image(image_path, kitchen_id, db)

            # Update invoice with extracted data
            stmt = select(Invoice).where(Invoice.id == invoice_id)
            db_result = await db.execute(stmt)
            invoice = db_result.scalar_one()

            invoice.invoice_number = result.get("invoice_number")
            invoice.invoice_date = result.get("invoice_date")
            invoice.total = result.get("total")
            invoice.supplier_id = result.get("supplier_id")
            invoice.ocr_raw_text = result.get("raw_text")
            invoice.ocr_confidence = result.get("confidence")
            invoice.status = InvoiceStatus.PROCESSED

            await db.commit()
        except Exception as e:
            print(f"OCR processing error for invoice {invoice_id}: {e}")
            # Mark as processed with error
            stmt = select(Invoice).where(Invoice.id == invoice_id)
            db_result = await db.execute(stmt)
            invoice = db_result.scalar_one()
            invoice.status = InvoiceStatus.PROCESSED
            invoice.ocr_raw_text = f"Error: {str(e)}"
            await db.commit()


@router.get("/", response_model=InvoiceListResponse)
async def list_invoices(
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List invoices for the current kitchen"""
    query = select(Invoice).where(Invoice.kitchen_id == current_user.kitchen_id)

    if status:
        query = query.where(Invoice.status == status)

    query = query.order_by(Invoice.created_at.desc()).offset(offset).limit(limit)

    result = await db.execute(query)
    invoices = result.scalars().all()

    # Get total count
    count_query = select(Invoice).where(Invoice.kitchen_id == current_user.kitchen_id)
    if status:
        count_query = count_query.where(Invoice.status == status)
    count_result = await db.execute(count_query)
    total = len(count_result.scalars().all())

    return InvoiceListResponse(
        invoices=[
            InvoiceResponse(
                id=inv.id,
                invoice_number=inv.invoice_number,
                invoice_date=inv.invoice_date,
                total=inv.total,
                supplier_id=inv.supplier_id,
                status=inv.status.value,
                category=inv.category,
                ocr_confidence=float(inv.ocr_confidence) if inv.ocr_confidence else None,
                image_path=inv.image_path,
                created_at=inv.created_at.isoformat()
            )
            for inv in invoices
        ],
        total=total
    )


@router.get("/{invoice_id}", response_model=InvoiceResponse)
async def get_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a single invoice by ID"""
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()

    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    return InvoiceResponse(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        total=invoice.total,
        supplier_id=invoice.supplier_id,
        status=invoice.status.value,
        category=invoice.category,
        ocr_confidence=float(invoice.ocr_confidence) if invoice.ocr_confidence else None,
        image_path=invoice.image_path,
        created_at=invoice.created_at.isoformat()
    )


@router.get("/{invoice_id}/image")
async def get_invoice_image(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get the invoice image file"""
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()

    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="Image file not found")

    # Determine media type from extension
    ext = invoice.image_path.split(".")[-1].lower()
    media_types = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "heic": "image/heic",
    }
    media_type = media_types.get(ext, "image/jpeg")

    return FileResponse(invoice.image_path, media_type=media_type)


@router.patch("/{invoice_id}", response_model=InvoiceResponse)
async def update_invoice(
    invoice_id: int,
    update: InvoiceUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update invoice data (for manual corrections)"""
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()

    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == "status" and value:
            setattr(invoice, field, InvoiceStatus(value))
        else:
            setattr(invoice, field, value)

    await db.commit()
    await db.refresh(invoice)

    return InvoiceResponse(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        total=invoice.total,
        supplier_id=invoice.supplier_id,
        status=invoice.status.value,
        category=invoice.category,
        ocr_confidence=float(invoice.ocr_confidence) if invoice.ocr_confidence else None,
        image_path=invoice.image_path,
        created_at=invoice.created_at.isoformat()
    )


@router.delete("/{invoice_id}")
async def delete_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete an invoice"""
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()

    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Delete image file
    if os.path.exists(invoice.image_path):
        os.remove(invoice.image_path)

    await db.delete(invoice)
    await db.commit()

    return {"message": "Invoice deleted"}
