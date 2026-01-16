import os
import uuid
import logging
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
import aiofiles

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.line_item import LineItem
from auth.jwt import get_current_user
from ocr.extractor import process_invoice_image
from services.duplicate_detector import DuplicateDetector

router = APIRouter()
logger = logging.getLogger(__name__)

DATA_DIR = "/app/data"


# Response Models
class LineItemResponse(BaseModel):
    id: int
    description: str | None
    quantity: float | None
    unit_price: float | None
    amount: float | None
    product_code: str | None
    line_number: int
    is_non_stock: bool

    class Config:
        from_attributes = True


class LineItemCreate(BaseModel):
    description: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    amount: Optional[float] = None
    product_code: Optional[str] = None
    is_non_stock: bool = False


class LineItemUpdate(BaseModel):
    description: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    amount: Optional[float] = None
    product_code: Optional[str] = None
    is_non_stock: Optional[bool] = None


class DuplicateInfo(BaseModel):
    id: int
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None
    supplier_id: int | None
    document_type: str | None
    duplicate_type: str  # "firm_duplicate", "possible_duplicate", "related_document"


class InvoiceResponse(BaseModel):
    id: int
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None
    net_total: Decimal | None
    stock_total: Decimal | None  # Sum of stock items only (non non-stock)
    supplier_id: int | None
    supplier_name: str | None
    supplier_match_type: str | None  # "exact", "fuzzy", or null - for highlighting fuzzy matches
    vendor_name: str | None  # OCR-extracted vendor name (before supplier matching)
    status: str
    category: str | None
    ocr_confidence: float | None
    image_path: str
    created_at: str
    # New fields
    document_type: str | None
    order_number: str | None
    duplicate_status: str | None
    duplicate_of_id: int | None

    class Config:
        from_attributes = True


class InvoiceUpdate(BaseModel):
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    total: Optional[Decimal] = None
    net_total: Optional[Decimal] = None
    supplier_id: Optional[int] = None
    category: Optional[str] = None
    status: Optional[str] = None
    # New fields
    document_type: Optional[str] = None
    order_number: Optional[str] = None


class InvoiceListResponse(BaseModel):
    invoices: list[InvoiceResponse]
    total: int


class DuplicateCompareResponse(BaseModel):
    current_invoice: InvoiceResponse
    firm_duplicate: InvoiceResponse | None
    possible_duplicates: list[InvoiceResponse]
    related_documents: list[InvoiceResponse]


# Helper function
async def get_invoice_or_404(
    invoice_id: int,
    current_user: User,
    db: AsyncSession
) -> Invoice:
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice


def invoice_to_response(invoice: Invoice, supplier_name: str | None = None, line_items: list | None = None) -> InvoiceResponse:
    from sqlalchemy import inspect

    # Get supplier name from relationship if not provided
    insp = inspect(invoice)
    if supplier_name is None and 'supplier' in insp.dict and invoice.supplier:
        supplier_name = invoice.supplier.name

    # Calculate stock_total from line items (sum of items where is_non_stock=False)
    stock_total = None
    if line_items is not None:
        stock_items = [item for item in line_items if not (item.is_non_stock or False)]
        if stock_items:
            stock_total = sum(item.amount or Decimal("0") for item in stock_items)
    elif 'line_items' in insp.dict and invoice.line_items:
        stock_items = [item for item in invoice.line_items if not (item.is_non_stock or False)]
        if stock_items:
            stock_total = sum(item.amount or Decimal("0") for item in stock_items)

    return InvoiceResponse(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        total=invoice.total,
        net_total=invoice.net_total,
        stock_total=stock_total,
        supplier_id=invoice.supplier_id,
        supplier_name=supplier_name,
        supplier_match_type=invoice.supplier_match_type,
        vendor_name=invoice.vendor_name,
        status=invoice.status.value,
        category=invoice.category,
        ocr_confidence=float(invoice.ocr_confidence) if invoice.ocr_confidence else None,
        image_path=invoice.image_path,
        created_at=invoice.created_at.isoformat(),
        document_type=invoice.document_type,
        order_number=invoice.order_number,
        duplicate_status=invoice.duplicate_status,
        duplicate_of_id=invoice.duplicate_of_id
    )


# Invoice endpoints
@router.post("/upload", response_model=InvoiceResponse)
async def upload_invoice(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload an invoice image or PDF for OCR processing"""
    allowed_types = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"File type not allowed. Allowed: {allowed_types}"
        )

    ext = file.filename.split(".")[-1] if file.filename else "jpg"
    filename = f"{uuid.uuid4()}.{ext}"
    filepath = os.path.join(DATA_DIR, str(current_user.kitchen_id), filename)

    os.makedirs(os.path.dirname(filepath), exist_ok=True)

    async with aiofiles.open(filepath, "wb") as f:
        content = await file.read()
        await f.write(content)

    invoice = Invoice(
        kitchen_id=current_user.kitchen_id,
        image_path=filepath,
        status=InvoiceStatus.PENDING
    )
    db.add(invoice)
    await db.commit()
    await db.refresh(invoice)

    background_tasks.add_task(
        process_invoice_background,
        invoice.id,
        filepath,
        current_user.kitchen_id
    )

    return invoice_to_response(invoice)


async def process_invoice_background(invoice_id: int, image_path: str, kitchen_id: int):
    """Background task to process invoice OCR, save line items, and detect duplicates"""
    from database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        try:
            result = await process_invoice_image(image_path, kitchen_id, db)

            stmt = select(Invoice).where(Invoice.id == invoice_id)
            db_result = await db.execute(stmt)
            invoice = db_result.scalar_one()

            # Update basic fields
            invoice.invoice_number = result.get("invoice_number")
            invoice.invoice_date = result.get("invoice_date")
            invoice.total = result.get("total")
            invoice.net_total = result.get("net_total")
            invoice.supplier_id = result.get("supplier_id")
            invoice.supplier_match_type = result.get("supplier_match_type")
            invoice.vendor_name = result.get("vendor_name")
            invoice.ocr_raw_text = result.get("raw_text")
            invoice.ocr_confidence = result.get("confidence")
            invoice.document_type = result.get("document_type", "invoice")
            invoice.order_number = result.get("order_number")

            # Store raw Azure JSON for debugging/remapping
            raw_json = result.get("raw_json")
            if raw_json:
                import json
                invoice.ocr_raw_json = json.dumps(raw_json)

            # Save line items
            line_items = result.get("line_items", [])
            for idx, item_data in enumerate(line_items):
                line_item = LineItem(
                    invoice_id=invoice.id,
                    description=item_data.get("description"),
                    quantity=Decimal(str(item_data["quantity"])) if item_data.get("quantity") else None,
                    unit_price=Decimal(str(item_data["unit_price"])) if item_data.get("unit_price") else None,
                    amount=Decimal(str(item_data["amount"])) if item_data.get("amount") else None,
                    product_code=item_data.get("product_code"),
                    line_number=idx
                )
                db.add(line_item)

            await db.commit()
            await db.refresh(invoice)

            # Run duplicate detection
            detector = DuplicateDetector(db, kitchen_id)
            duplicates = await detector.check_duplicates(invoice)

            if duplicates["firm_duplicate"]:
                invoice.duplicate_status = "firm_duplicate"
                invoice.duplicate_of_id = duplicates["firm_duplicate"].id
            elif duplicates["possible_duplicates"]:
                invoice.duplicate_status = "possible_duplicate"
                invoice.duplicate_of_id = duplicates["possible_duplicates"][0].id

            if duplicates["related_documents"]:
                invoice.related_document_id = duplicates["related_documents"][0].id

            invoice.status = InvoiceStatus.PROCESSED
            await db.commit()

            logger.info(f"Invoice {invoice_id} processed: number={invoice.invoice_number}, "
                        f"duplicate_status={invoice.duplicate_status}")

        except Exception as e:
            logger.error(f"OCR processing error for invoice {invoice_id}: {e}")
            stmt = select(Invoice).where(Invoice.id == invoice_id)
            db_result = await db.execute(stmt)
            invoice = db_result.scalar_one()
            invoice.status = InvoiceStatus.PROCESSED
            invoice.ocr_raw_text = f"Error: {str(e)}"
            await db.commit()


@router.get("/", response_model=InvoiceListResponse)
async def list_invoices(
    status: Optional[str] = None,
    supplier_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List invoices for the current kitchen with optional filters"""
    from sqlalchemy.orm import selectinload

    query = select(Invoice).options(
        selectinload(Invoice.supplier),
        selectinload(Invoice.line_items)
    ).where(Invoice.kitchen_id == current_user.kitchen_id)

    if status:
        query = query.where(Invoice.status == status)
    if supplier_id:
        query = query.where(Invoice.supplier_id == supplier_id)
    if date_from:
        query = query.where(Invoice.invoice_date >= date_from)
    if date_to:
        query = query.where(Invoice.invoice_date <= date_to)

    query = query.order_by(Invoice.created_at.desc()).offset(offset).limit(limit)

    result = await db.execute(query)
    invoices = result.scalars().all()

    # Count query with same filters
    count_query = select(func.count(Invoice.id)).where(Invoice.kitchen_id == current_user.kitchen_id)
    if status:
        count_query = count_query.where(Invoice.status == status)
    if supplier_id:
        count_query = count_query.where(Invoice.supplier_id == supplier_id)
    if date_from:
        count_query = count_query.where(Invoice.invoice_date >= date_from)
    if date_to:
        count_query = count_query.where(Invoice.invoice_date <= date_to)
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return InvoiceListResponse(
        invoices=[invoice_to_response(inv) for inv in invoices],
        total=total
    )


@router.get("/{invoice_id}", response_model=InvoiceResponse)
async def get_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a single invoice by ID"""
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(Invoice).options(
            selectinload(Invoice.supplier),
            selectinload(Invoice.line_items)
        ).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice_to_response(invoice)


@router.get("/{invoice_id}/image")
async def get_invoice_image(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get the invoice image or PDF file (requires auth header)"""
    from starlette.responses import Response

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="File not found")

    ext = invoice.image_path.split(".")[-1].lower()
    media_types = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "heic": "image/heic",
        "pdf": "application/pdf",
    }
    media_type = media_types.get(ext, "application/octet-stream")

    # Read file and return with headers that work through remote proxies
    with open(invoice.image_path, "rb") as f:
        content = f.read()

    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "max-age=3600",
        }
    )


@router.get("/{invoice_id}/file")
async def get_invoice_file(
    invoice_id: int,
    token: str,
    db: AsyncSession = Depends(get_db)
):
    """Get invoice file (image or PDF) with token in query param - works through proxies"""
    from auth.jwt import get_current_user_from_token
    from starlette.responses import Response

    # Verify token and get user
    current_user = await get_current_user_from_token(token, db)
    if not current_user:
        raise HTTPException(status_code=401, detail="Invalid token")

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="File not found")

    ext = invoice.image_path.split(".")[-1].lower()
    media_types = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "heic": "image/heic",
        "pdf": "application/pdf",
    }
    media_type = media_types.get(ext, "application/octet-stream")

    # Read file and return with headers that allow embedding through proxies
    with open(invoice.image_path, "rb") as f:
        content = f.read()

    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": "inline",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Frame-Options": "SAMEORIGIN",
            "Content-Security-Policy": "frame-ancestors 'self'",
            "Cache-Control": "no-cache",
        }
    )


@router.get("/{invoice_id}/pdf")
async def get_invoice_pdf(
    invoice_id: int,
    token: str,
    db: AsyncSession = Depends(get_db)
):
    """Get invoice PDF with token in query param (for iframe embedding) - DEPRECATED, use /file"""
    from auth.jwt import get_current_user_from_token
    from starlette.responses import Response

    # Verify token and get user
    current_user = await get_current_user_from_token(token, db)
    if not current_user:
        raise HTTPException(status_code=401, detail="Invalid token")

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="File not found")

    # Read file and return with headers that allow iframe/object embedding through proxies
    with open(invoice.image_path, "rb") as f:
        content = f.read()

    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "no-cache",
        }
    )


@router.patch("/{invoice_id}", response_model=InvoiceResponse)
async def update_invoice(
    invoice_id: int,
    update: InvoiceUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update invoice data (for manual corrections)"""
    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field == "status" and value:
            setattr(invoice, field, InvoiceStatus(value))
        else:
            setattr(invoice, field, value)

    await db.commit()
    await db.refresh(invoice)

    return invoice_to_response(invoice)


@router.delete("/{invoice_id}")
async def delete_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete an invoice"""
    from sqlalchemy import update

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    # Clear any references from other invoices pointing to this one
    await db.execute(
        update(Invoice)
        .where(Invoice.duplicate_of_id == invoice_id)
        .values(duplicate_of_id=None, duplicate_status=None)
    )
    await db.execute(
        update(Invoice)
        .where(Invoice.related_document_id == invoice_id)
        .values(related_document_id=None)
    )

    if os.path.exists(invoice.image_path):
        os.remove(invoice.image_path)

    await db.delete(invoice)
    await db.commit()

    return {"message": "Invoice deleted"}


# Duplicate detection endpoint
@router.get("/{invoice_id}/duplicates", response_model=DuplicateCompareResponse)
async def get_invoice_duplicates(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get duplicate comparison info for an invoice"""
    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    detector = DuplicateDetector(db, current_user.kitchen_id)
    duplicates = await detector.check_duplicates(invoice)

    return DuplicateCompareResponse(
        current_invoice=invoice_to_response(invoice),
        firm_duplicate=invoice_to_response(duplicates["firm_duplicate"]) if duplicates["firm_duplicate"] else None,
        possible_duplicates=[invoice_to_response(d) for d in duplicates["possible_duplicates"]],
        related_documents=[invoice_to_response(d) for d in duplicates["related_documents"]]
    )


# Line item endpoints
@router.get("/{invoice_id}/line-items", response_model=list[LineItemResponse])
async def get_line_items(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get line items for an invoice"""
    await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem)
        .where(LineItem.invoice_id == invoice_id)
        .order_by(LineItem.line_number)
    )
    items = result.scalars().all()

    return [
        LineItemResponse(
            id=item.id,
            description=item.description,
            quantity=float(item.quantity) if item.quantity else None,
            unit_price=float(item.unit_price) if item.unit_price else None,
            amount=float(item.amount) if item.amount else None,
            product_code=item.product_code,
            line_number=item.line_number,
            is_non_stock=item.is_non_stock or False
        )
        for item in items
    ]


@router.post("/{invoice_id}/line-items", response_model=LineItemResponse)
async def add_line_item(
    invoice_id: int,
    item: LineItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Add a new line item to an invoice"""
    await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(func.max(LineItem.line_number))
        .where(LineItem.invoice_id == invoice_id)
    )
    max_num = result.scalar() or -1

    line_item = LineItem(
        invoice_id=invoice_id,
        description=item.description,
        quantity=Decimal(str(item.quantity)) if item.quantity else None,
        unit_price=Decimal(str(item.unit_price)) if item.unit_price else None,
        amount=Decimal(str(item.amount)) if item.amount else None,
        product_code=item.product_code,
        line_number=max_num + 1,
        is_non_stock=item.is_non_stock
    )
    db.add(line_item)
    await db.commit()
    await db.refresh(line_item)

    return LineItemResponse(
        id=line_item.id,
        description=line_item.description,
        quantity=float(line_item.quantity) if line_item.quantity else None,
        unit_price=float(line_item.unit_price) if line_item.unit_price else None,
        amount=float(line_item.amount) if line_item.amount else None,
        product_code=line_item.product_code,
        line_number=line_item.line_number,
        is_non_stock=line_item.is_non_stock or False
    )


@router.patch("/{invoice_id}/line-items/{item_id}", response_model=LineItemResponse)
async def update_line_item(
    invoice_id: int,
    item_id: int,
    update: LineItemUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update a line item"""
    await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem).where(
            LineItem.id == item_id,
            LineItem.invoice_id == invoice_id
        )
    )
    line_item = result.scalar_one_or_none()
    if not line_item:
        raise HTTPException(status_code=404, detail="Line item not found")

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if value is not None and field in ["quantity", "unit_price", "amount"]:
            setattr(line_item, field, Decimal(str(value)))
        else:
            setattr(line_item, field, value)

    await db.commit()
    await db.refresh(line_item)

    return LineItemResponse(
        id=line_item.id,
        description=line_item.description,
        quantity=float(line_item.quantity) if line_item.quantity else None,
        unit_price=float(line_item.unit_price) if line_item.unit_price else None,
        amount=float(line_item.amount) if line_item.amount else None,
        product_code=line_item.product_code,
        line_number=line_item.line_number,
        is_non_stock=line_item.is_non_stock or False
    )


@router.delete("/{invoice_id}/line-items/{item_id}")
async def delete_line_item(
    invoice_id: int,
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a line item"""
    await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem).where(
            LineItem.id == item_id,
            LineItem.invoice_id == invoice_id
        )
    )
    line_item = result.scalar_one_or_none()
    if not line_item:
        raise HTTPException(status_code=404, detail="Line item not found")

    await db.delete(line_item)
    await db.commit()

    return {"message": "Line item deleted"}


# Raw OCR data endpoint
@router.get("/{invoice_id}/ocr-data")
async def get_invoice_ocr_data(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get the raw OCR data (text and JSON) for an invoice"""
    import json as json_module

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    raw_json = None
    if invoice.ocr_raw_json:
        try:
            raw_json = json_module.loads(invoice.ocr_raw_json)
        except json_module.JSONDecodeError:
            raw_json = None

    return {
        "invoice_id": invoice.id,
        "raw_text": invoice.ocr_raw_text,
        "raw_json": raw_json,
        "confidence": float(invoice.ocr_confidence) if invoice.ocr_confidence else None
    }


@router.post("/reprocess-all")
async def reprocess_all_invoices(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Reprocess all non-confirmed invoices through OCR.
    Clears existing extracted data and line items, then re-runs OCR processing.
    """
    # Get all non-confirmed invoices
    result = await db.execute(
        select(Invoice).where(
            Invoice.kitchen_id == current_user.kitchen_id,
            Invoice.status != InvoiceStatus.CONFIRMED
        )
    )
    invoices = result.scalars().all()
    count = len(invoices)

    if count == 0:
        return {"message": "No invoices to reprocess", "count": 0}

    # Queue each invoice for reprocessing
    for invoice in invoices:
        # Clear existing line items
        await db.execute(
            select(LineItem).where(LineItem.invoice_id == invoice.id)
        )
        # Delete line items for this invoice
        from sqlalchemy import delete
        await db.execute(
            delete(LineItem).where(LineItem.invoice_id == invoice.id)
        )

        # Reset invoice status to pending
        invoice.status = InvoiceStatus.PENDING
        invoice.supplier_id = None
        invoice.supplier_match_type = None
        invoice.invoice_number = None
        invoice.invoice_date = None
        invoice.total = None
        invoice.net_total = None
        invoice.vendor_name = None
        invoice.ocr_raw_text = None
        invoice.ocr_raw_json = None
        invoice.ocr_confidence = None
        invoice.document_type = None
        invoice.order_number = None
        invoice.duplicate_status = None
        invoice.duplicate_of_id = None

        # Queue background processing
        background_tasks.add_task(
            process_invoice_background,
            invoice.id,
            invoice.image_path,
            current_user.kitchen_id
        )

    await db.commit()

    return {"message": f"Queued {count} invoices for reprocessing", "count": count}
