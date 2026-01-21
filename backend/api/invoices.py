import os
import re
import uuid
import logging
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from pydantic import BaseModel
import aiofiles

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.line_item import LineItem
from models.product_definition import ProductDefinition
from auth.jwt import get_current_user
from ocr.extractor import process_invoice_image
from services.duplicate_detector import DuplicateDetector

router = APIRouter()
logger = logging.getLogger(__name__)


def normalize_description(text: str | None) -> str:
    """Normalize description for matching - lowercase, collapse whitespace, strip"""
    if not text:
        return ""
    return " ".join(text.lower().strip().split())

DATA_DIR = "/app/data"


# Response Models
class LineItemResponse(BaseModel):
    id: int
    product_code: str | None
    description: str | None
    unit: str | None
    quantity: float | None
    order_quantity: float | None
    unit_price: float | None
    tax_rate: str | None
    tax_amount: float | None
    amount: float | None
    line_number: int
    is_non_stock: bool
    # Pack size fields
    raw_content: str | None
    pack_quantity: int | None
    unit_size: float | None
    unit_size_type: str | None
    portions_per_unit: int | None  # null = not defined yet
    cost_per_item: float | None
    cost_per_portion: float | None
    # OCR warnings for values that needed correction
    ocr_warnings: str | None
    # Price change detection
    price_change_status: str | None = None  # "consistent", "amber", "red", "no_history", "acknowledged"
    price_change_percent: float | None = None
    previous_price: float | None = None
    # Future price (for old invoices)
    future_price: float | None = None
    future_change_percent: float | None = None

    class Config:
        from_attributes = True


class LineItemCreate(BaseModel):
    product_code: Optional[str] = None
    description: Optional[str] = None
    unit: Optional[str] = None
    quantity: Optional[float] = None
    order_quantity: Optional[float] = None
    unit_price: Optional[float] = None
    tax_rate: Optional[str] = None
    tax_amount: Optional[float] = None
    amount: Optional[float] = None
    is_non_stock: bool = False
    # Pack size fields
    raw_content: Optional[str] = None
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    portions_per_unit: Optional[int] = None  # null = not defined yet
    cost_per_item: Optional[float] = None
    cost_per_portion: Optional[float] = None


class LineItemUpdate(BaseModel):
    product_code: Optional[str] = None
    description: Optional[str] = None
    unit: Optional[str] = None
    quantity: Optional[float] = None
    order_quantity: Optional[float] = None
    unit_price: Optional[float] = None
    tax_rate: Optional[str] = None
    tax_amount: Optional[float] = None
    amount: Optional[float] = None
    is_non_stock: Optional[bool] = None
    # Pack size fields
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    portions_per_unit: Optional[int] = None
    cost_per_item: Optional[float] = None
    cost_per_portion: Optional[float] = None


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
    ocr_raw_text: str | None  # OCR extracted text or error message if processing failed
    image_path: str
    created_at: str
    # New fields
    document_type: str | None
    order_number: str | None
    duplicate_status: str | None
    duplicate_of_id: int | None
    # Dext integration fields
    notes: str | None
    dext_sent_at: str | None  # ISO datetime
    dext_sent_by_username: str | None  # Resolved from relationship

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
    # Dext integration
    notes: Optional[str] = None


class InvoiceListResponse(BaseModel):
    invoices: list[InvoiceResponse]
    total: int


class DuplicateCompareResponse(BaseModel):
    current_invoice: InvoiceResponse
    firm_duplicate: InvoiceResponse | None
    possible_duplicates: list[InvoiceResponse]
    related_documents: list[InvoiceResponse]


# Product Definition Models (for persistent portion/pack data)
class ProductDefinitionResponse(BaseModel):
    id: int
    kitchen_id: int
    supplier_id: int | None
    product_code: str | None
    description_pattern: str | None
    pack_quantity: int | None
    unit_size: float | None
    unit_size_type: str | None
    portions_per_unit: int | None
    portion_description: str | None
    # Saved by metadata
    saved_by_user_id: int | None
    saved_by_username: str | None  # Resolved from saved_by_user relationship
    source_invoice_id: int | None
    source_invoice_number: str | None
    updated_at: str | None  # ISO datetime string

    class Config:
        from_attributes = True


class ProductDefinitionCreate(BaseModel):
    supplier_id: Optional[int] = None
    product_code: Optional[str] = None
    description_pattern: Optional[str] = None
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    portions_per_unit: Optional[int] = None
    portion_description: Optional[str] = None


class ProductDefinitionUpdate(BaseModel):
    pack_quantity: Optional[int] = None
    unit_size: Optional[float] = None
    unit_size_type: Optional[str] = None
    portions_per_unit: Optional[int] = None
    portion_description: Optional[str] = None


# Line Item Search Models
class LineItemSearchRequest(BaseModel):
    query: str
    exclude_invoice_id: Optional[int] = None


class SearchResultItem(BaseModel):
    description: str
    unit_price: float | None
    unit: str | None
    pack_info: str | None
    last_invoice_date: str | None
    invoice_id: int
    similarity: float


class SupplierSearchGroup(BaseModel):
    supplier_id: int | None
    supplier_name: str
    items: list[SearchResultItem]


class LineItemSearchResponse(BaseModel):
    query: str
    extracted_keywords: str
    results: list[SupplierSearchGroup]
    total_matches: int


def extract_search_keywords(description: str, supplier_words: list[str] | None = None) -> str:
    """Extract meaningful keywords from line item description.

    Removes:
    - Pack sizes (12x1L, 120x15g, 6x500ml)
    - Quantity patterns (qty 12, case of 24)
    - Product codes like (L-AG), [SKU-123]
    - Generic terms (case, qty, un, pack, box, each, per, unit, etc.)
    - Standalone numbers and weights
    - Common English stop words (the, a, an, in, etc.)
    - Supplier names and aliases (passed dynamically)
    """
    if not description:
        return ""

    text = description

    # 1. Remove pack size patterns (12x1L, 120x15g, 6x500ml)
    text = re.sub(r'\b\d+\s*x\s*\d+(\.\d+)?\s*(g|kg|ml|ltr|l|oz|cl)?\b', '', text, flags=re.IGNORECASE)

    # 2. Remove quantity patterns (qty 12, case of 24)
    text = re.sub(r'\b(qty|quantity)\s*:?\s*\d+\b', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\bcase\s*(of\s*)?\d+\b', '', text, flags=re.IGNORECASE)

    # 3. Remove product codes like (L-AG), [SKU-123], etc.
    text = re.sub(r'\([A-Z]{1,3}-?[A-Z0-9]{1,5}\)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\[[A-Z0-9-]+\]', '', text, flags=re.IGNORECASE)

    # 4. Remove generic packaging/unit terms
    generic_terms = ['case', 'qty', 'un', 'pack', 'box', 'each', 'per', 'unit', 'pkt', 'bag', 'bottle', 'tin', 'can', 'carton', 'tray', 'portion', 'portions']
    pattern = r'\b(' + '|'.join(generic_terms) + r')\b'
    text = re.sub(pattern, '', text, flags=re.IGNORECASE)

    # 5. Remove standalone numbers and weights (500g, 1.5kg, just "12")
    text = re.sub(r'\b\d+(\.\d+)?\s*(g|kg|ml|ltr|l|oz|cl|lb)?\b', '', text, flags=re.IGNORECASE)

    # 6. Clean up whitespace and special characters
    text = re.sub(r'[^\w\s]', ' ', text)

    # 7. Remove common English stop words
    stop_words = [
        'the', 'a', 'an', 'in', 'on', 'at', 'by', 'for', 'with', 'to', 'of', 'and', 'or',
        'is', 'it', 'as', 'be', 'are', 'was', 'been', 'being', 'have', 'has', 'had',
        'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
        'this', 'that', 'these', 'those', 'from', 'into', 'through', 'during',
        'before', 'after', 'above', 'below', 'between', 'under', 'over'
    ]
    stop_pattern = r'\b(' + '|'.join(stop_words) + r')\b'
    text = re.sub(stop_pattern, '', text, flags=re.IGNORECASE)

    # 8. Remove supplier names and aliases (dynamic list)
    if supplier_words:
        # Escape special regex chars and filter empty strings
        safe_words = [re.escape(w) for w in supplier_words if w and len(w) > 1]
        if safe_words:
            supplier_pattern = r'\b(' + '|'.join(safe_words) + r')\b'
            text = re.sub(supplier_pattern, '', text, flags=re.IGNORECASE)

    # 9. Filter out very short words and collapse whitespace
    words = [w for w in text.split() if len(w) > 1]
    return ' '.join(words).strip()


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

    # Get dext_sent_by_user name from relationship if loaded
    dext_sent_by_username = None
    if 'dext_sent_by_user' in insp.dict and invoice.dext_sent_by_user:
        dext_sent_by_username = invoice.dext_sent_by_user.name

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
        ocr_raw_text=invoice.ocr_raw_text,
        image_path=invoice.image_path,
        created_at=invoice.created_at.isoformat(),
        document_type=invoice.document_type,
        order_number=invoice.order_number,
        duplicate_status=invoice.duplicate_status,
        duplicate_of_id=invoice.duplicate_of_id,
        # Dext integration
        notes=invoice.notes,
        dext_sent_at=invoice.dext_sent_at.isoformat() if invoice.dext_sent_at else None,
        dext_sent_by_username=dext_sent_by_username
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


async def apply_product_definitions(
    line_items: list[dict],
    kitchen_id: int,
    supplier_id: int | None,
    db
) -> list[dict]:
    """
    Apply product definitions to line items.
    Looks up existing definitions and auto-populates portions_per_unit.
    Checks for supplier-specific definitions first, then kitchen-wide (supplier_id=NULL).

    Matching priority:
    1. product_code (exact match)
    2. description_pattern (normalized contains match) - used when no product_code or no code match
    """
    from sqlalchemy import or_

    logger.info(f"apply_product_definitions: kitchen_id={kitchen_id}, supplier_id={supplier_id}, line_items_count={len(line_items)}")

    # Build query to get definitions - supplier-specific OR kitchen-wide (supplier_id IS NULL)
    conditions = [
        ProductDefinition.kitchen_id == kitchen_id,
    ]

    if supplier_id:
        # Get both supplier-specific and kitchen-wide definitions
        conditions.append(
            or_(
                ProductDefinition.supplier_id == supplier_id,
                ProductDefinition.supplier_id.is_(None)
            )
        )
    else:
        # Only get kitchen-wide definitions
        conditions.append(ProductDefinition.supplier_id.is_(None))

    result = await db.execute(
        select(ProductDefinition).where(*conditions)
    )
    all_definitions = result.scalars().all()
    logger.info(f"apply_product_definitions: found {len(all_definitions)} definitions")

    # Build lookup dicts - prefer supplier-specific over kitchen-wide
    # 1. By product_code (for items with codes)
    definitions_by_code = {}
    # 2. By description_pattern (for items without codes, or as fallback)
    definitions_by_desc = []  # List of (normalized_pattern, definition) tuples

    for d in all_definitions:
        # Add to code lookup if has product_code
        if d.product_code:
            if d.product_code in definitions_by_code:
                existing = definitions_by_code[d.product_code]
                if existing.supplier_id and not d.supplier_id:
                    continue  # Keep supplier-specific
            definitions_by_code[d.product_code] = d

        # Add to description lookup if has description_pattern
        if d.description_pattern:
            norm_pattern = normalize_description(d.description_pattern)
            if norm_pattern:
                definitions_by_desc.append((norm_pattern, d))

    # Sort description patterns: prefer supplier-specific first, then by length (longer = more specific)
    definitions_by_desc.sort(key=lambda x: (0 if x[1].supplier_id else 1, -len(x[0])))

    if not definitions_by_code and not definitions_by_desc:
        logger.info("apply_product_definitions: no definitions found after filtering")
        return line_items

    logger.info(f"apply_product_definitions: {len(definitions_by_code)} code definitions, {len(definitions_by_desc)} description definitions")

    def find_definition(item: dict) -> ProductDefinition | None:
        """Find matching definition for a line item"""
        product_code = item.get("product_code")
        description = item.get("description")

        # Priority 1: Match by product_code
        if product_code and product_code in definitions_by_code:
            return definitions_by_code[product_code]

        # Priority 2: Match by description_pattern (for items without codes, or when no code match)
        if description:
            item_desc_norm = normalize_description(description)
            for pattern, defn in definitions_by_desc:
                # Check if pattern is contained in item description
                if pattern in item_desc_norm:
                    return defn

        return None

    for item in line_items:
        defn = find_definition(item)
        if not defn:
            continue

        match_type = "product_code" if item.get("product_code") and item.get("product_code") in definitions_by_code else "description"
        logger.info(f"apply_product_definitions: applying to item (matched by {match_type}): code={item.get('product_code')}, desc={item.get('description', '')[:50]}")

        # Apply portions_per_unit if not already set
        if item.get("portions_per_unit") is None and defn.portions_per_unit:
            item["portions_per_unit"] = defn.portions_per_unit
            # Recalculate cost_per_portion
            if item.get("pack_quantity") and item.get("unit_price"):
                item["cost_per_portion"] = round(
                    item["unit_price"] / (item["pack_quantity"] * defn.portions_per_unit), 4
                )
        # Optionally override pack_quantity if definition has it but OCR didn't find it
        if item.get("pack_quantity") is None and defn.pack_quantity:
            item["pack_quantity"] = defn.pack_quantity
            # Calculate cost_per_item
            if item.get("unit_price"):
                item["cost_per_item"] = round(item["unit_price"] / defn.pack_quantity, 4)
            # Recalculate cost_per_portion now that pack_quantity is available
            if item.get("portions_per_unit") and item.get("unit_price"):
                item["cost_per_portion"] = round(
                    item["unit_price"] / (defn.pack_quantity * item["portions_per_unit"]), 4
                )
        # Apply unit_size and unit_size_type if definition has them but OCR didn't find them
        if item.get("unit_size") is None and defn.unit_size:
            item["unit_size"] = float(defn.unit_size)
        if item.get("unit_size_type") is None and defn.unit_size_type:
            item["unit_size_type"] = defn.unit_size_type

    return line_items


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

            # Delete existing line items before creating new ones
            from sqlalchemy import text
            await db.execute(
                text("DELETE FROM line_items WHERE invoice_id = :invoice_id"),
                {"invoice_id": invoice_id}
            )
            await db.flush()

            # Save line items (apply product definitions for auto-population)
            line_items = result.get("line_items", [])
            supplier_id = result.get("supplier_id")
            # Always try to apply definitions - handles both supplier-specific and kitchen-wide
            line_items = await apply_product_definitions(
                line_items, kitchen_id, supplier_id, db
            )

            for idx, item_data in enumerate(line_items):
                line_item = LineItem(
                    invoice_id=invoice.id,
                    product_code=item_data.get("product_code"),
                    description=item_data.get("description"),
                    unit=item_data.get("unit"),
                    quantity=Decimal(str(item_data["quantity"])) if item_data.get("quantity") else None,
                    order_quantity=Decimal(str(item_data["order_quantity"])) if item_data.get("order_quantity") else None,
                    unit_price=Decimal(str(item_data["unit_price"])) if item_data.get("unit_price") else None,
                    tax_rate=item_data.get("tax_rate"),
                    tax_amount=Decimal(str(item_data["tax_amount"])) if item_data.get("tax_amount") else None,
                    amount=Decimal(str(item_data["amount"])) if item_data.get("amount") else None,
                    line_number=idx,
                    # Pack size fields from OCR extraction + product definitions
                    raw_content=item_data.get("raw_content"),
                    pack_quantity=item_data.get("pack_quantity"),
                    unit_size=Decimal(str(item_data["unit_size"])) if item_data.get("unit_size") else None,
                    unit_size_type=item_data.get("unit_size_type"),
                    portions_per_unit=item_data.get("portions_per_unit"),  # From product definitions
                    cost_per_item=Decimal(str(item_data["cost_per_item"])) if item_data.get("cost_per_item") else None,
                    cost_per_portion=Decimal(str(item_data["cost_per_portion"])) if item_data.get("cost_per_portion") else None,
                    # OCR warnings for values that needed manual review
                    ocr_warnings=item_data.get("ocr_warnings")
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
    """List invoices for the current kitchen with optional filters

    Status filter supports:
    - pending, processed, reviewed, confirmed: filter by specific status
    - pending_confirmation: filter by processed OR reviewed (awaiting confirmation)
    """
    from sqlalchemy.orm import selectinload
    from sqlalchemy import or_

    # Only load supplier for list view - line_items not needed and slows query significantly
    query = select(Invoice).options(
        selectinload(Invoice.supplier)
    ).where(Invoice.kitchen_id == current_user.kitchen_id)

    # Handle special "pending_confirmation" filter (all non-confirmed: pending, processed, reviewed)
    if status == "pending_confirmation":
        query = query.where(or_(
            Invoice.status == InvoiceStatus.PENDING,
            Invoice.status == InvoiceStatus.PROCESSED,
            Invoice.status == InvoiceStatus.REVIEWED
        ))
    elif status:
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
    if status == "pending_confirmation":
        count_query = count_query.where(or_(
            Invoice.status == InvoiceStatus.PENDING,
            Invoice.status == InvoiceStatus.PROCESSED,
            Invoice.status == InvoiceStatus.REVIEWED
        ))
    elif status:
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


@router.post("/line-items/search", response_model=LineItemSearchResponse)
async def search_line_items(
    request: LineItemSearchRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Search line items across all invoices for the kitchen.
    Uses ILIKE keyword matching for search.
    Results grouped by supplier with price comparison info.
    """
    # Fetch supplier names and aliases for keyword extraction
    from models.supplier import Supplier
    supplier_result = await db.execute(
        select(Supplier.name, Supplier.aliases).where(Supplier.kitchen_id == current_user.kitchen_id)
    )
    supplier_rows = supplier_result.fetchall()

    # Build list of supplier words (names + aliases, split into individual words)
    supplier_words = []
    for row in supplier_rows:
        # Add each word from supplier name
        if row.name:
            supplier_words.extend(row.name.lower().split())
        # Add each alias and its words
        if row.aliases:
            for alias in row.aliases:
                if alias:
                    supplier_words.extend(alias.lower().split())
    # Remove duplicates
    supplier_words = list(set(supplier_words))

    # Extract keywords from query
    keywords = extract_search_keywords(request.query, supplier_words) if request.query else request.query

    if not keywords or len(keywords) < 2:
        return LineItemSearchResponse(
            query=request.query,
            extracted_keywords=keywords or "",
            results=[],
            total_matches=0
        )

    # Build ILIKE patterns from keywords - match ANY keyword (OR logic for better results)
    keyword_list = keywords.split()
    like_conditions = " OR ".join([f"LOWER(li.description) LIKE LOWER(:kw{i})" for i in range(len(keyword_list))])

    # Build exclude condition only if exclude_id is provided (avoids asyncpg type inference issue)
    exclude_condition = ""
    if request.exclude_invoice_id is not None:
        exclude_condition = "AND i.id != :exclude_id"

    query = text(f"""
        SELECT DISTINCT ON (i.supplier_id, li.description)
            li.description,
            li.unit_price,
            li.unit,
            li.pack_quantity,
            li.unit_size,
            li.unit_size_type,
            i.invoice_date,
            i.id as invoice_id,
            i.supplier_id,
            s.name as supplier_name
        FROM line_items li
        JOIN invoices i ON li.invoice_id = i.id
        LEFT JOIN suppliers s ON i.supplier_id = s.id
        WHERE i.kitchen_id = :kitchen_id
          AND li.description IS NOT NULL
          AND li.description != ''
          AND ({like_conditions})
          {exclude_condition}
        ORDER BY i.supplier_id, li.description, i.invoice_date DESC
        LIMIT 100
    """)

    params = {
        "kitchen_id": current_user.kitchen_id,
    }
    if request.exclude_invoice_id is not None:
        params["exclude_id"] = request.exclude_invoice_id
    for i, kw in enumerate(keyword_list):
        params[f"kw{i}"] = f"%{kw}%"

    result = await db.execute(query, params)
    rows = result.fetchall()

    # Group results by supplier
    supplier_groups: dict[int | None, SupplierSearchGroup] = {}
    total_matches = 0

    for row in rows:
        supplier_id = row.supplier_id
        supplier_name = row.supplier_name or "Unknown Supplier"

        # Format pack info
        pack_info = None
        if row.pack_quantity and row.unit_size and row.unit_size_type:
            pack_info = f"{row.pack_quantity}x{row.unit_size}{row.unit_size_type}"
        elif row.pack_quantity:
            pack_info = f"{row.pack_quantity} pack"

        # Format invoice date
        last_invoice_date = row.invoice_date.isoformat() if row.invoice_date else None

        item = SearchResultItem(
            description=row.description,
            unit_price=float(row.unit_price) if row.unit_price else None,
            unit=row.unit,
            pack_info=pack_info,
            last_invoice_date=last_invoice_date,
            invoice_id=row.invoice_id,
            similarity=1.0  # ILIKE match (no similarity score available)
        )

        if supplier_id not in supplier_groups:
            supplier_groups[supplier_id] = SupplierSearchGroup(
                supplier_id=supplier_id,
                supplier_name=supplier_name,
                items=[]
            )

        supplier_groups[supplier_id].items.append(item)
        total_matches += 1

    # Sort groups by supplier name
    sorted_groups = sorted(supplier_groups.values(), key=lambda g: g.supplier_name)

    return LineItemSearchResponse(
        query=request.query,
        extracted_keywords=keywords,
        results=sorted_groups,
        total_matches=total_matches
    )


@router.get("/{invoice_id}", response_model=InvoiceResponse)
async def get_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get a single invoice by ID.
    Re-applies latest product definitions to ensure users see current defaults.
    """
    from sqlalchemy.orm import selectinload
    from sqlalchemy import or_

    result = await db.execute(
        select(Invoice).options(
            selectinload(Invoice.supplier),
            selectinload(Invoice.line_items),
            selectinload(Invoice.dext_sent_by_user)
        ).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Re-apply latest product definitions when opening invoice
    # This ensures users always see the most current defaults
    if invoice.supplier_id and invoice.line_items:
        logger.info(f"get_invoice: Re-applying latest product definitions for invoice {invoice_id}")

        # Fetch current product definitions
        conditions = [ProductDefinition.kitchen_id == current_user.kitchen_id]
        conditions.append(
            or_(
                ProductDefinition.supplier_id == invoice.supplier_id,
                ProductDefinition.supplier_id.is_(None)
            )
        )

        result = await db.execute(
            select(ProductDefinition).where(*conditions)
        )
        all_definitions = result.scalars().all()

        if all_definitions:
            # Build lookup dicts
            definitions_by_code = {}
            definitions_by_desc = []

            for d in all_definitions:
                if d.product_code:
                    if d.product_code in definitions_by_code:
                        existing = definitions_by_code[d.product_code]
                        if existing.supplier_id and not d.supplier_id:
                            continue
                    definitions_by_code[d.product_code] = d
                if d.description_pattern:
                    norm_pattern = normalize_description(d.description_pattern)
                    if norm_pattern:
                        definitions_by_desc.append((norm_pattern, d))

            definitions_by_desc.sort(key=lambda x: (0 if x[1].supplier_id else 1, -len(x[0])))

            def find_definition_for_item(item: LineItem) -> ProductDefinition | None:
                if item.product_code and item.product_code in definitions_by_code:
                    return definitions_by_code[item.product_code]
                if item.description:
                    item_desc_norm = normalize_description(item.description)
                    for pattern, defn in definitions_by_desc:
                        if pattern in item_desc_norm:
                            return defn
                return None

            # Apply definitions to line items
            updated_count = 0
            for item in invoice.line_items:
                defn = find_definition_for_item(item)
                if not defn:
                    continue

                # Re-apply portions_per_unit from latest definition
                if defn.portions_per_unit:
                    item.portions_per_unit = defn.portions_per_unit
                    updated_count += 1

                    # Recalculate cost_per_portion
                    if item.pack_quantity and item.unit_price:
                        item.cost_per_portion = Decimal(str(
                            round(float(item.unit_price) / (item.pack_quantity * defn.portions_per_unit), 4)
                        ))

                # Also re-apply pack_quantity if definition has it but line item doesn't
                if item.pack_quantity is None and defn.pack_quantity:
                    item.pack_quantity = defn.pack_quantity
                    if item.unit_price:
                        item.cost_per_item = Decimal(str(round(float(item.unit_price) / defn.pack_quantity, 4)))
                        if item.portions_per_unit:
                            item.cost_per_portion = Decimal(str(
                                round(float(item.unit_price) / (defn.pack_quantity * item.portions_per_unit), 4)
                            ))

                # Re-apply unit_size and unit_size_type if definition has them
                if item.unit_size is None and defn.unit_size:
                    item.unit_size = defn.unit_size
                if item.unit_size_type is None and defn.unit_size_type:
                    item.unit_size_type = defn.unit_size_type

            if updated_count > 0:
                logger.info(f"get_invoice: Re-applied definitions to {updated_count} line items")
                await db.commit()
                await db.refresh(invoice)

    return invoice_to_response(invoice)


@router.get("/{invoice_id}/image")
async def get_invoice_image(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get the invoice image or PDF file (requires auth header)"""
    from starlette.responses import Response
    from services.file_archival_service import FileArchivalService

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    # Use archival service to get file content (handles local and Nextcloud)
    archival_service = FileArchivalService(db, current_user.kitchen_id)
    success, result = await archival_service.get_file_content(invoice)

    if not success:
        raise HTTPException(status_code=404, detail=f"File not found: {result}")

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

    return Response(
        content=result,
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
    from services.file_archival_service import FileArchivalService

    # Verify token and get user
    current_user = await get_current_user_from_token(token, db)
    if not current_user:
        raise HTTPException(status_code=401, detail="Invalid token")

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    # Use archival service to get file content (handles local and Nextcloud)
    archival_service = FileArchivalService(db, current_user.kitchen_id)
    success, result = await archival_service.get_file_content(invoice)

    if not success:
        raise HTTPException(status_code=404, detail=f"File not found: {result}")

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

    return Response(
        content=result,
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
    from sqlalchemy import or_

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    # Track if supplier is being changed
    old_supplier_id = invoice.supplier_id
    update_data = update.model_dump(exclude_unset=True)
    new_supplier_id = update_data.get("supplier_id")
    supplier_changed = new_supplier_id is not None and new_supplier_id != old_supplier_id

    for field, value in update_data.items():
        if field == "status" and value:
            setattr(invoice, field, InvoiceStatus(value))
        else:
            setattr(invoice, field, value)

    await db.commit()
    await db.refresh(invoice)

    # If supplier changed, auto-apply product definitions to line items
    if supplier_changed and new_supplier_id:
        logger.info(f"update_invoice: supplier changed from {old_supplier_id} to {new_supplier_id}, applying definitions")

        # Get all line items for this invoice
        result = await db.execute(
            select(LineItem)
            .where(LineItem.invoice_id == invoice_id)
        )
        line_items = result.scalars().all()

        if line_items:
            # Get definitions for the new supplier (or kitchen-wide)
            conditions = [
                ProductDefinition.kitchen_id == current_user.kitchen_id,
                or_(
                    ProductDefinition.supplier_id == new_supplier_id,
                    ProductDefinition.supplier_id.is_(None)
                )
            ]

            result = await db.execute(
                select(ProductDefinition).where(*conditions)
            )
            all_definitions = result.scalars().all()

            # Build lookup dicts - prefer supplier-specific over kitchen-wide
            definitions_by_code = {}
            definitions_by_desc = []  # List of (normalized_pattern, definition) tuples

            for d in all_definitions:
                if d.product_code:
                    if d.product_code in definitions_by_code:
                        existing = definitions_by_code[d.product_code]
                        if existing.supplier_id and not d.supplier_id:
                            continue
                    definitions_by_code[d.product_code] = d
                if d.description_pattern:
                    norm_pattern = normalize_description(d.description_pattern)
                    if norm_pattern:
                        definitions_by_desc.append((norm_pattern, d))

            # Sort description patterns: prefer supplier-specific first, then by length
            definitions_by_desc.sort(key=lambda x: (0 if x[1].supplier_id else 1, -len(x[0])))

            logger.info(f"update_invoice: found {len(definitions_by_code)} code definitions, {len(definitions_by_desc)} description definitions for supplier {new_supplier_id}")

            def find_definition_for_item(item: LineItem) -> ProductDefinition | None:
                if item.product_code and item.product_code in definitions_by_code:
                    return definitions_by_code[item.product_code]
                if item.description:
                    item_desc_norm = normalize_description(item.description)
                    for pattern, defn in definitions_by_desc:
                        if pattern in item_desc_norm:
                            return defn
                return None

            # Apply definitions to line items
            for item in line_items:
                defn = find_definition_for_item(item)
                if not defn:
                    continue

                match_type = "product_code" if item.product_code and item.product_code in definitions_by_code else "description"
                logger.info(f"update_invoice: applying definition (matched by {match_type}) to item: code={item.product_code}, desc={item.description[:50] if item.description else ''}")

                # Only update if portions_per_unit is not already set
                if item.portions_per_unit is None and defn.portions_per_unit:
                    item.portions_per_unit = defn.portions_per_unit

                    # Recalculate cost_per_portion
                    if item.pack_quantity and item.unit_price:
                        item.cost_per_portion = Decimal(str(
                            round(float(item.unit_price) / (item.pack_quantity * defn.portions_per_unit), 4)
                        ))

                # Also apply pack_quantity if OCR didn't find it
                if item.pack_quantity is None and defn.pack_quantity:
                    item.pack_quantity = defn.pack_quantity
                    if item.unit_price:
                        item.cost_per_item = Decimal(str(
                            round(float(item.unit_price) / defn.pack_quantity, 4)
                        ))
                    if item.portions_per_unit and item.unit_price:
                        item.cost_per_portion = Decimal(str(
                            round(float(item.unit_price) / (defn.pack_quantity * item.portions_per_unit), 4)
                        ))
                # Apply unit_size and unit_size_type if definition has them
                if item.unit_size is None and defn.unit_size:
                    item.unit_size = defn.unit_size
                if item.unit_size_type is None and defn.unit_size_type:
                    item.unit_size_type = defn.unit_size_type

            await db.commit()

    return invoice_to_response(invoice)


@router.delete("/{invoice_id}")
async def delete_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete an invoice"""
    from sqlalchemy import update
    from services.file_archival_service import FileArchivalService

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

    # Handle file deletion (copies to deleted folder if on Nextcloud)
    archival_service = FileArchivalService(db, current_user.kitchen_id)
    await archival_service.handle_invoice_deletion(invoice)

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
    """Get line items for an invoice with price change detection"""
    from services.price_history import PriceHistoryService

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem)
        .where(LineItem.invoice_id == invoice_id)
        .order_by(LineItem.line_number)
    )
    items = result.scalars().all()

    # Initialize price history service for price status calculation
    price_service = PriceHistoryService(db, current_user.kitchen_id)

    responses = []
    for item in items:
        # Calculate price status if item has unit_price and supplier
        price_change_status = None
        price_change_percent = None
        previous_price = None
        future_price = None
        future_change_percent = None

        if item.unit_price and invoice.supplier_id:
            try:
                status = await price_service.get_price_status(
                    supplier_id=invoice.supplier_id,
                    product_code=item.product_code,
                    description=item.description,
                    current_price=item.unit_price,
                    unit=item.unit,
                    current_invoice_id=invoice_id,
                    reference_date=invoice.invoice_date
                )
                price_change_status = status.status
                price_change_percent = status.change_percent
                previous_price = float(status.previous_price) if status.previous_price else None
                future_price = float(status.future_price) if status.future_price else None
                future_change_percent = status.future_change_percent
            except Exception as e:
                logger.warning(f"Failed to get price status for line item {item.id}: {e}")

        responses.append(LineItemResponse(
            id=item.id,
            product_code=item.product_code,
            description=item.description,
            unit=item.unit,
            quantity=float(item.quantity) if item.quantity else None,
            order_quantity=float(item.order_quantity) if item.order_quantity else None,
            unit_price=float(item.unit_price) if item.unit_price else None,
            tax_rate=item.tax_rate,
            tax_amount=float(item.tax_amount) if item.tax_amount else None,
            amount=float(item.amount) if item.amount else None,
            line_number=item.line_number,
            is_non_stock=item.is_non_stock or False,
            raw_content=item.raw_content,
            pack_quantity=item.pack_quantity,
            unit_size=float(item.unit_size) if item.unit_size else None,
            unit_size_type=item.unit_size_type,
            portions_per_unit=item.portions_per_unit,
            cost_per_item=float(item.cost_per_item) if item.cost_per_item else None,
            cost_per_portion=float(item.cost_per_portion) if item.cost_per_portion else None,
            ocr_warnings=item.ocr_warnings,
            price_change_status=price_change_status,
            price_change_percent=price_change_percent,
            previous_price=previous_price,
            future_price=future_price,
            future_change_percent=future_change_percent
        ))

    return responses


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

    # Calculate costs if pack_quantity and unit_price provided
    cost_per_item = None
    cost_per_portion = None
    if item.pack_quantity and item.unit_price:
        cost_per_item = round(item.unit_price / item.pack_quantity, 4)
        # Only calculate cost_per_portion if portions_per_unit is explicitly set
        if item.portions_per_unit:
            cost_per_portion = round(item.unit_price / (item.pack_quantity * item.portions_per_unit), 4)

    line_item = LineItem(
        invoice_id=invoice_id,
        product_code=item.product_code,
        description=item.description,
        unit=item.unit,
        quantity=Decimal(str(item.quantity)) if item.quantity else None,
        order_quantity=Decimal(str(item.order_quantity)) if item.order_quantity else None,
        unit_price=Decimal(str(item.unit_price)) if item.unit_price else None,
        tax_rate=item.tax_rate,
        tax_amount=Decimal(str(item.tax_amount)) if item.tax_amount else None,
        amount=Decimal(str(item.amount)) if item.amount else None,
        line_number=max_num + 1,
        is_non_stock=item.is_non_stock,
        raw_content=item.raw_content,
        pack_quantity=item.pack_quantity,
        unit_size=Decimal(str(item.unit_size)) if item.unit_size else None,
        unit_size_type=item.unit_size_type,
        portions_per_unit=item.portions_per_unit,
        cost_per_item=Decimal(str(cost_per_item)) if cost_per_item else None,
        cost_per_portion=Decimal(str(cost_per_portion)) if cost_per_portion else None
    )
    db.add(line_item)
    await db.commit()
    await db.refresh(line_item)

    return LineItemResponse(
        id=line_item.id,
        product_code=line_item.product_code,
        description=line_item.description,
        unit=line_item.unit,
        quantity=float(line_item.quantity) if line_item.quantity else None,
        order_quantity=float(line_item.order_quantity) if line_item.order_quantity else None,
        unit_price=float(line_item.unit_price) if line_item.unit_price else None,
        tax_rate=line_item.tax_rate,
        tax_amount=float(line_item.tax_amount) if line_item.tax_amount else None,
        amount=float(line_item.amount) if line_item.amount else None,
        line_number=line_item.line_number,
        is_non_stock=line_item.is_non_stock or False,
        raw_content=line_item.raw_content,
        pack_quantity=line_item.pack_quantity,
        unit_size=float(line_item.unit_size) if line_item.unit_size else None,
        unit_size_type=line_item.unit_size_type,
        portions_per_unit=line_item.portions_per_unit,  # Return actual value (null if not defined)
        cost_per_item=float(line_item.cost_per_item) if line_item.cost_per_item else None,
        cost_per_portion=float(line_item.cost_per_portion) if line_item.cost_per_portion else None,
        ocr_warnings=line_item.ocr_warnings
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
    decimal_fields = ["quantity", "order_quantity", "unit_price", "tax_amount", "amount", "unit_size", "cost_per_item", "cost_per_portion"]
    for field, value in update_data.items():
        if value is not None and field in decimal_fields:
            setattr(line_item, field, Decimal(str(value)))
        else:
            setattr(line_item, field, value)

    # Clear OCR warnings if user manually corrects any of the affected fields
    ocr_warning_fields = {"quantity", "unit_price", "amount", "unit_size", "pack_quantity"}
    if ocr_warning_fields & set(update_data.keys()):
        line_item.ocr_warnings = None

    # Recalculate costs if pack fields or unit_price changed
    recalc_fields = {"pack_quantity", "portions_per_unit", "unit_price"}
    if recalc_fields & set(update_data.keys()):
        if line_item.pack_quantity and line_item.unit_price:
            line_item.cost_per_item = Decimal(str(
                round(float(line_item.unit_price) / line_item.pack_quantity, 4)
            ))
            # Only calculate cost_per_portion if portions_per_unit is explicitly set
            if line_item.portions_per_unit:
                line_item.cost_per_portion = Decimal(str(
                    round(float(line_item.unit_price) / (line_item.pack_quantity * line_item.portions_per_unit), 4)
                ))
            else:
                line_item.cost_per_portion = None

    await db.commit()
    await db.refresh(line_item)

    return LineItemResponse(
        id=line_item.id,
        product_code=line_item.product_code,
        description=line_item.description,
        unit=line_item.unit,
        quantity=float(line_item.quantity) if line_item.quantity else None,
        order_quantity=float(line_item.order_quantity) if line_item.order_quantity else None,
        unit_price=float(line_item.unit_price) if line_item.unit_price else None,
        tax_rate=line_item.tax_rate,
        tax_amount=float(line_item.tax_amount) if line_item.tax_amount else None,
        amount=float(line_item.amount) if line_item.amount else None,
        line_number=line_item.line_number,
        is_non_stock=line_item.is_non_stock or False,
        raw_content=line_item.raw_content,
        pack_quantity=line_item.pack_quantity,
        unit_size=float(line_item.unit_size) if line_item.unit_size else None,
        unit_size_type=line_item.unit_size_type,
        portions_per_unit=line_item.portions_per_unit,  # Return actual value (null if not defined)
        cost_per_item=float(line_item.cost_per_item) if line_item.cost_per_item else None,
        cost_per_portion=float(line_item.cost_per_portion) if line_item.cost_per_portion else None,
        ocr_warnings=line_item.ocr_warnings
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


# Product Definition endpoints
@router.get("/product-definitions/", response_model=list[ProductDefinitionResponse])
async def list_product_definitions(
    supplier_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List product definitions for the current kitchen"""
    from sqlalchemy.orm import selectinload

    query = select(ProductDefinition).options(
        selectinload(ProductDefinition.saved_by_user),
        selectinload(ProductDefinition.source_invoice)
    ).where(
        ProductDefinition.kitchen_id == current_user.kitchen_id
    )
    if supplier_id:
        query = query.where(ProductDefinition.supplier_id == supplier_id)

    result = await db.execute(query.order_by(ProductDefinition.product_code))
    definitions = result.scalars().all()

    return [
        ProductDefinitionResponse(
            id=d.id,
            kitchen_id=d.kitchen_id,
            supplier_id=d.supplier_id,
            product_code=d.product_code,
            description_pattern=d.description_pattern,
            pack_quantity=d.pack_quantity,
            unit_size=float(d.unit_size) if d.unit_size else None,
            unit_size_type=d.unit_size_type,
            portions_per_unit=d.portions_per_unit,
            portion_description=d.portion_description,
            saved_by_user_id=d.saved_by_user_id,
            saved_by_username=d.saved_by_user.name if d.saved_by_user else None,
            source_invoice_id=d.source_invoice_id,
            source_invoice_number=d.source_invoice.invoice_number if d.source_invoice else None,
            updated_at=d.updated_at.isoformat() if d.updated_at else None
        )
        for d in definitions
    ]


@router.post("/product-definitions/", response_model=ProductDefinitionResponse)
async def create_product_definition(
    definition: ProductDefinitionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new product definition"""
    # Check if definition already exists for this product_code + supplier
    if definition.product_code:
        result = await db.execute(
            select(ProductDefinition).where(
                ProductDefinition.kitchen_id == current_user.kitchen_id,
                ProductDefinition.supplier_id == definition.supplier_id,
                ProductDefinition.product_code == definition.product_code
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            raise HTTPException(
                status_code=400,
                detail="Product definition already exists for this product code and supplier"
            )

    prod_def = ProductDefinition(
        kitchen_id=current_user.kitchen_id,
        supplier_id=definition.supplier_id,
        product_code=definition.product_code,
        description_pattern=definition.description_pattern,
        pack_quantity=definition.pack_quantity,
        unit_size=Decimal(str(definition.unit_size)) if definition.unit_size else None,
        unit_size_type=definition.unit_size_type,
        portions_per_unit=definition.portions_per_unit,
        portion_description=definition.portion_description,
        saved_by_user_id=current_user.id  # Record who created this definition
    )
    db.add(prod_def)
    await db.commit()
    await db.refresh(prod_def)

    return ProductDefinitionResponse(
        id=prod_def.id,
        kitchen_id=prod_def.kitchen_id,
        supplier_id=prod_def.supplier_id,
        product_code=prod_def.product_code,
        description_pattern=prod_def.description_pattern,
        pack_quantity=prod_def.pack_quantity,
        unit_size=float(prod_def.unit_size) if prod_def.unit_size else None,
        unit_size_type=prod_def.unit_size_type,
        portions_per_unit=prod_def.portions_per_unit,
        portion_description=prod_def.portion_description,
        saved_by_user_id=prod_def.saved_by_user_id,
        saved_by_username=current_user.name,
        source_invoice_id=prod_def.source_invoice_id,
        source_invoice_number=prod_def.source_invoice_number,
        updated_at=prod_def.updated_at.isoformat() if prod_def.updated_at else None
    )


@router.post("/{invoice_id}/apply-definitions")
async def apply_definitions_to_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Re-apply product definitions to all line items on an invoice.
    Useful after manually setting/changing the supplier on an invoice.
    Only updates line items where portions_per_unit is not already set.
    """
    from sqlalchemy import or_

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    if not invoice.supplier_id:
        return {"message": "No supplier set on invoice - no definitions to apply", "updated": 0}

    # Get all line items for this invoice
    result = await db.execute(
        select(LineItem)
        .where(LineItem.invoice_id == invoice_id)
        .order_by(LineItem.line_number)
    )
    line_items = result.scalars().all()

    if not line_items:
        return {"message": "No line items on invoice", "updated": 0}

    # Get definitions for this supplier (or kitchen-wide)
    conditions = [
        ProductDefinition.kitchen_id == current_user.kitchen_id,
        or_(
            ProductDefinition.supplier_id == invoice.supplier_id,
            ProductDefinition.supplier_id.is_(None)
        )
    ]

    result = await db.execute(
        select(ProductDefinition).where(*conditions)
    )
    all_definitions = result.scalars().all()

    logger.info(f"apply_definitions_to_invoice: invoice_id={invoice_id}, supplier_id={invoice.supplier_id}, found {len(all_definitions)} definitions")

    # Build lookup dicts - prefer supplier-specific over kitchen-wide
    definitions_by_code = {}
    definitions_by_desc = []  # List of (normalized_pattern, definition) tuples

    for d in all_definitions:
        if d.product_code:
            if d.product_code in definitions_by_code:
                existing = definitions_by_code[d.product_code]
                if existing.supplier_id and not d.supplier_id:
                    continue
            definitions_by_code[d.product_code] = d
        if d.description_pattern:
            norm_pattern = normalize_description(d.description_pattern)
            if norm_pattern:
                definitions_by_desc.append((norm_pattern, d))

    # Sort description patterns: prefer supplier-specific first, then by length
    definitions_by_desc.sort(key=lambda x: (0 if x[1].supplier_id else 1, -len(x[0])))

    if not definitions_by_code and not definitions_by_desc:
        return {"message": "No product definitions found for this supplier", "updated": 0}

    logger.info(f"apply_definitions_to_invoice: {len(definitions_by_code)} code definitions, {len(definitions_by_desc)} description definitions")

    def find_definition_for_item(item: LineItem) -> ProductDefinition | None:
        if item.product_code and item.product_code in definitions_by_code:
            return definitions_by_code[item.product_code]
        if item.description:
            item_desc_norm = normalize_description(item.description)
            for pattern, defn in definitions_by_desc:
                if pattern in item_desc_norm:
                    return defn
        return None

    updated_count = 0
    for item in line_items:
        defn = find_definition_for_item(item)
        if not defn:
            continue

        match_type = "product_code" if item.product_code and item.product_code in definitions_by_code else "description"
        logger.info(f"apply_definitions_to_invoice: applying definition (matched by {match_type}) to item: code={item.product_code}, desc={item.description[:50] if item.description else ''}")

        # Only update if portions_per_unit is not already set
        if item.portions_per_unit is None and defn.portions_per_unit:
            item.portions_per_unit = defn.portions_per_unit

            # Recalculate cost_per_portion
            if item.pack_quantity and item.unit_price:
                item.cost_per_portion = Decimal(str(
                    round(float(item.unit_price) / (item.pack_quantity * defn.portions_per_unit), 4)
                ))
            updated_count += 1

        # Also apply pack_quantity if OCR didn't find it
        if item.pack_quantity is None and defn.pack_quantity:
            item.pack_quantity = defn.pack_quantity
            if item.unit_price:
                item.cost_per_item = Decimal(str(
                    round(float(item.unit_price) / defn.pack_quantity, 4)
                ))
            # Recalculate cost_per_portion if portions now available
            if item.portions_per_unit and item.unit_price:
                item.cost_per_portion = Decimal(str(
                    round(float(item.unit_price) / (defn.pack_quantity * item.portions_per_unit), 4)
                ))
            updated_count += 1
        # Apply unit_size and unit_size_type if definition has them
        if item.unit_size is None and defn.unit_size:
            item.unit_size = defn.unit_size
        if item.unit_size_type is None and defn.unit_size_type:
            item.unit_size_type = defn.unit_size_type

    await db.commit()

    return {"message": f"Applied definitions to {updated_count} line items", "updated": updated_count}


class SaveDefinitionRequest(BaseModel):
    portion_description: Optional[str] = None


@router.post("/{invoice_id}/line-items/{item_id}/save-definition", response_model=ProductDefinitionResponse)
async def save_line_item_as_definition(
    invoice_id: int,
    item_id: int,
    request: Optional[SaveDefinitionRequest] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Save a line item's pack/portion data as a product definition.
    Creates or updates the definition for future invoices.

    Matching priority when saving:
    - If line item has product_code: save with product_code (preferred)
    - If no product_code but has description: save with description_pattern
    """
    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem).where(
            LineItem.id == item_id,
            LineItem.invoice_id == invoice_id
        )
    )
    line_item = result.scalar_one_or_none()
    if not line_item:
        raise HTTPException(status_code=404, detail="Line item not found")

    # Need either product_code or description to save a definition
    if not line_item.product_code and not line_item.description:
        raise HTTPException(
            status_code=400,
            detail="Cannot save definition: line item has no product code or description"
        )

    existing = None

    # Check if definition already exists - by product_code if available, otherwise by description
    if line_item.product_code:
        result = await db.execute(
            select(ProductDefinition).where(
                ProductDefinition.kitchen_id == current_user.kitchen_id,
                ProductDefinition.supplier_id == invoice.supplier_id,
                ProductDefinition.product_code == line_item.product_code
            )
        )
        existing = result.scalar_one_or_none()
    elif line_item.description:
        # Match by normalized description pattern
        norm_desc = normalize_description(line_item.description)
        result = await db.execute(
            select(ProductDefinition).where(
                ProductDefinition.kitchen_id == current_user.kitchen_id,
                ProductDefinition.supplier_id == invoice.supplier_id,
                ProductDefinition.product_code.is_(None)  # Only match description-based definitions
            )
        )
        all_desc_defs = result.scalars().all()
        for d in all_desc_defs:
            if d.description_pattern and normalize_description(d.description_pattern) == norm_desc:
                existing = d
                break

    # Get portion_description from request if provided
    portion_desc = request.portion_description if request else None

    if existing:
        # Update existing definition
        existing.pack_quantity = line_item.pack_quantity
        existing.unit_size = line_item.unit_size
        existing.unit_size_type = line_item.unit_size_type
        existing.portions_per_unit = line_item.portions_per_unit
        existing.description_pattern = line_item.description
        if portion_desc is not None:
            existing.portion_description = portion_desc
        # Update saved by metadata
        existing.saved_by_user_id = current_user.id
        existing.source_invoice_id = invoice.id
        await db.commit()
        await db.refresh(existing)
        prod_def = existing
    else:
        # Create new definition
        prod_def = ProductDefinition(
            kitchen_id=current_user.kitchen_id,
            supplier_id=invoice.supplier_id,
            product_code=line_item.product_code,  # May be None for description-only definitions
            description_pattern=line_item.description,
            pack_quantity=line_item.pack_quantity,
            unit_size=line_item.unit_size,
            unit_size_type=line_item.unit_size_type,
            portions_per_unit=line_item.portions_per_unit,
            portion_description=portion_desc,
            # Saved by metadata
            saved_by_user_id=current_user.id,
            source_invoice_id=invoice.id
        )
        db.add(prod_def)
        await db.commit()
        await db.refresh(prod_def)

    return ProductDefinitionResponse(
        id=prod_def.id,
        kitchen_id=prod_def.kitchen_id,
        supplier_id=prod_def.supplier_id,
        product_code=prod_def.product_code,
        description_pattern=prod_def.description_pattern,
        pack_quantity=prod_def.pack_quantity,
        unit_size=float(prod_def.unit_size) if prod_def.unit_size else None,
        unit_size_type=prod_def.unit_size_type,
        portions_per_unit=prod_def.portions_per_unit,
        portion_description=prod_def.portion_description,
        saved_by_user_id=prod_def.saved_by_user_id,
        saved_by_username=current_user.name,  # We have the user in scope
        source_invoice_id=prod_def.source_invoice_id,
        source_invoice_number=invoice.invoice_number,  # Get from current invoice
        updated_at=prod_def.updated_at.isoformat() if prod_def.updated_at else None
    )


@router.get("/{invoice_id}/line-items/{item_id}/definition", response_model=ProductDefinitionResponse | None)
async def get_line_item_definition(
    invoice_id: int,
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get the saved product definition that applies to a specific line item.
    Returns null if no definition exists.
    Used by frontend to compare current values with saved values.
    """
    from sqlalchemy import or_
    from sqlalchemy.orm import selectinload

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    result = await db.execute(
        select(LineItem).where(
            LineItem.id == item_id,
            LineItem.invoice_id == invoice_id
        )
    )
    line_item = result.scalar_one_or_none()
    if not line_item:
        raise HTTPException(status_code=404, detail="Line item not found")

    # Get definitions for this supplier (or kitchen-wide)
    conditions = [ProductDefinition.kitchen_id == current_user.kitchen_id]
    if invoice.supplier_id:
        conditions.append(
            or_(
                ProductDefinition.supplier_id == invoice.supplier_id,
                ProductDefinition.supplier_id.is_(None)
            )
        )
    else:
        conditions.append(ProductDefinition.supplier_id.is_(None))

    result = await db.execute(
        select(ProductDefinition).options(
            selectinload(ProductDefinition.saved_by_user),
            selectinload(ProductDefinition.source_invoice)
        ).where(*conditions)
    )
    all_definitions = result.scalars().all()

    # Build lookup dicts - prefer supplier-specific over kitchen-wide
    definitions_by_code = {}
    definitions_by_desc = []

    for d in all_definitions:
        if d.product_code:
            if d.product_code in definitions_by_code:
                existing = definitions_by_code[d.product_code]
                if existing.supplier_id and not d.supplier_id:
                    continue
            definitions_by_code[d.product_code] = d
        if d.description_pattern:
            norm_pattern = normalize_description(d.description_pattern)
            if norm_pattern:
                definitions_by_desc.append((norm_pattern, d))

    definitions_by_desc.sort(key=lambda x: (0 if x[1].supplier_id else 1, -len(x[0])))

    # Find matching definition
    defn = None
    if line_item.product_code and line_item.product_code in definitions_by_code:
        defn = definitions_by_code[line_item.product_code]
    elif line_item.description:
        item_desc_norm = normalize_description(line_item.description)
        for pattern, d in definitions_by_desc:
            if pattern in item_desc_norm:
                defn = d
                break

    if not defn:
        return None

    return ProductDefinitionResponse(
        id=defn.id,
        kitchen_id=defn.kitchen_id,
        supplier_id=defn.supplier_id,
        product_code=defn.product_code,
        description_pattern=defn.description_pattern,
        pack_quantity=defn.pack_quantity,
        unit_size=float(defn.unit_size) if defn.unit_size else None,
        unit_size_type=defn.unit_size_type,
        portions_per_unit=defn.portions_per_unit,
        portion_description=defn.portion_description,
        saved_by_user_id=defn.saved_by_user_id,
        saved_by_username=defn.saved_by_user.name if defn.saved_by_user else None,
        source_invoice_id=defn.source_invoice_id,
        source_invoice_number=defn.source_invoice.invoice_number if defn.source_invoice else None,
        updated_at=defn.updated_at.isoformat() if defn.updated_at else None
    )


# ============ Stock History Endpoint ============

@router.get("/{invoice_id}/stock-history")
async def get_invoice_stock_history(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get stock status history for all line items in an invoice.

    Returns a mapping of line_item_id to stock history info,
    indicating if items were previously marked as non-stock.
    """
    from services.stock_history import StockHistoryService

    invoice = await get_invoice_or_404(invoice_id, current_user, db)

    stock_service = StockHistoryService(db, current_user.kitchen_id)
    history_map = await stock_service.check_all_line_items(invoice_id)

    # Convert to JSON-serializable format
    result = {}
    for item_id, history in history_map.items():
        result[str(item_id)] = {
            'has_history': history.has_history,
            'previously_non_stock': history.previously_non_stock,
            'total_occurrences': history.total_occurrences,
            'non_stock_occurrences': history.non_stock_occurrences,
            'most_recent_status': history.most_recent_status
        }

    return result


# ============ Dext Integration Endpoint ============

@router.post("/{invoice_id}/send-to-dext")
async def send_invoice_to_dext(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Send invoice to Dext via email

    - Loads invoice with line items
    - Generates HTML email with notes and non-stock items (if configured)
    - Attaches invoice PDF/image
    - Sends via SMTP
    - Records sent timestamp and user
    """
    from datetime import datetime
    from sqlalchemy.orm import selectinload
    from models.settings import KitchenSettings
    from services.email_service import EmailService, generate_dext_email_html

    # Load invoice with relationships
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

    # Must be confirmed to send
    if invoice.status != InvoiceStatus.CONFIRMED:
        raise HTTPException(
            status_code=400,
            detail="Invoice must be confirmed before sending to Dext"
        )

    # Load settings
    settings_result = await db.execute(
        select(KitchenSettings).where(
            KitchenSettings.kitchen_id == current_user.kitchen_id
        )
    )
    settings = settings_result.scalar_one_or_none()

    if not settings:
        raise HTTPException(
            status_code=400,
            detail="Kitchen settings not found"
        )

    # Validate SMTP configuration
    if not all([settings.smtp_host, settings.smtp_from_email]):
        raise HTTPException(
            status_code=400,
            detail="SMTP not configured. Please configure email settings first."
        )

    # Validate Dext configuration
    if not settings.dext_email:
        raise HTTPException(
            status_code=400,
            detail="Dext email not configured. Please configure Dext settings first."
        )

    # Check if file exists
    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="Invoice file not found")

    # Read file
    try:
        with open(invoice.image_path, 'rb') as f:
            file_bytes = f.read()
    except Exception as e:
        logger.error(f"Failed to read invoice file: {e}")
        raise HTTPException(status_code=500, detail="Failed to read invoice file")

    # Determine filename from invoice data
    ext = invoice.image_path.split('.')[-1].lower()
    filename = f"{invoice.invoice_number or 'invoice'}_{invoice.invoice_date.strftime('%Y%m%d') if invoice.invoice_date else 'unknown'}.{ext}"

    # Generate email HTML
    html_body = generate_dext_email_html(
        invoice=invoice,
        supplier_name=invoice.supplier.name if invoice.supplier else None,
        line_items=invoice.line_items,
        notes=invoice.notes,
        include_notes=settings.dext_include_notes,
        include_non_stock=settings.dext_include_non_stock
    )

    # Send email
    email_service = EmailService(settings)
    subject = f"Invoice {invoice.invoice_number or 'N/A'} - {invoice.supplier.name if invoice.supplier else 'Unknown Supplier'}"

    success = email_service.send_email(
        to_email=settings.dext_email,
        subject=subject,
        html_body=html_body,
        attachments=[(filename, file_bytes)]
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to send email")

    # Record sent status
    invoice.dext_sent_at = datetime.utcnow()
    invoice.dext_sent_by_user_id = current_user.id
    await db.commit()

    return {
        "message": "Invoice sent to Dext successfully",
        "sent_at": invoice.dext_sent_at.isoformat(),
        "sent_to": settings.dext_email
    }


# ============ Admin Manual Control Endpoints ============

@router.post("/{invoice_id}/mark-dext-sent")
async def mark_dext_sent(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Admin only: Mark invoice as sent to Dext without actually sending.
    Also triggers Nextcloud archival if configured.

    For edge cases where invoice was uploaded directly to Dext.
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    from datetime import datetime
    from sqlalchemy.orm import selectinload

    # Load invoice
    result = await db.execute(
        select(Invoice).options(
            selectinload(Invoice.supplier)
        ).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Mark as sent
    invoice.dext_sent_at = datetime.utcnow()
    invoice.dext_sent_by_user_id = current_user.id
    await db.commit()
    await db.refresh(invoice)

    # Try to archive to Nextcloud if enabled
    archival_message = None
    try:
        from services.file_archival_service import FileArchivalService
        archival_service = FileArchivalService(db, current_user.kitchen_id)

        if await archival_service.is_ready_for_archival(invoice):
            success, result_msg = await archival_service.archive_invoice_file(invoice)
            if success:
                archival_message = f"Archived to Nextcloud: {result_msg}"
                await db.commit()
            else:
                archival_message = f"Archival skipped: {result_msg}"
        else:
            archival_message = "Not ready for archival (Nextcloud may not be enabled or configured)"
    except Exception as e:
        logger.error(f"Archival failed after marking Dext sent: {e}")
        archival_message = f"Archival error: {str(e)}"

    return {
        "message": "Invoice marked as sent to Dext",
        "sent_at": invoice.dext_sent_at.isoformat(),
        "archival_status": archival_message
    }


@router.post("/{invoice_id}/reprocess")
async def reprocess_invoice(
    invoice_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Admin only: Reprocess existing OCR data without re-sending to Azure.

    Re-runs:
    - Supplier identification
    - Document type detection
    - Line item creation (with product definitions)
    - Duplicate detection
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Load invoice
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Check if we have OCR data
    if not invoice.ocr_raw_json:
        raise HTTPException(
            status_code=400,
            detail="No OCR data available. Use 'Resend to Azure' instead."
        )

    try:
        import json
        from ocr.parser import identify_supplier
        from services.duplicate_detector import detect_document_type, DuplicateDetector

        # Parse stored OCR data
        raw_json = json.loads(invoice.ocr_raw_json)

        # Re-identify supplier
        supplier_id = None
        supplier_match_type = None
        if invoice.vendor_name:
            supplier_id, supplier_match_type = await identify_supplier(invoice.vendor_name, current_user.kitchen_id, db)
        if not supplier_id and invoice.ocr_raw_text:
            supplier_id, supplier_match_type = await identify_supplier(invoice.ocr_raw_text, current_user.kitchen_id, db)

        # Use document_type from stored raw_json if available (from azure_extractor)
        # Otherwise re-detect it
        document_type = raw_json.get("document_type")
        if not document_type:
            document_type = detect_document_type(
                invoice.ocr_raw_text or "",
                raw_json
            )

        # Update invoice fields
        invoice.supplier_id = supplier_id
        invoice.supplier_match_type = supplier_match_type
        invoice.document_type = document_type

        # Delete existing line items
        await db.execute(
            text("DELETE FROM line_items WHERE invoice_id = :invoice_id"),
            {"invoice_id": invoice_id}
        )
        await db.flush()

        # Re-create line items from stored OCR data
        # The stored raw_json is the Azure response, which has Items in Azure format
        # We need to extract line_items like the Azure extractor does
        line_items_data = []

        # Check if we have the processed line_items (newer format)
        if "line_items" in raw_json:
            line_items_data = raw_json["line_items"]
        # Otherwise parse from Azure raw format (older invoices)
        elif "documents" in raw_json:
            # Helper to extract numeric value from Azure field (handles currency objects)
            def get_numeric_value(field_data):
                if not field_data:
                    return None
                value = field_data.get("value")
                if value is None:
                    return None
                # Currency fields have {"code": "GBP", "amount": 54.2, "symbol": null}
                if isinstance(value, dict) and "amount" in value:
                    return value["amount"]
                return value

            # Extract from Azure format - simplified extraction
            for doc in raw_json.get("documents", []):
                fields = doc.get("fields", {})
                if "Items" in fields:
                    items = fields["Items"].get("value", [])
                    for item in items:
                        item_fields = item.get("value", {})
                        line_items_data.append({
                            "product_code": item_fields.get("ProductCode", {}).get("value"),
                            "description": item_fields.get("Description", {}).get("value"),
                            "unit": item_fields.get("Unit", {}).get("value"),
                            "quantity": get_numeric_value(item_fields.get("Quantity", {})),
                            "unit_price": get_numeric_value(item_fields.get("UnitPrice", {})),
                            "amount": get_numeric_value(item_fields.get("Amount", {})),
                            "tax_rate": get_numeric_value(item_fields.get("TaxRate", {})),
                        })

        # Apply product definitions
        line_items_data = await apply_product_definitions(
            line_items_data, current_user.kitchen_id, supplier_id, db
        )

        # Create line items
        for idx, item_data in enumerate(line_items_data):
            line_item = LineItem(
                invoice_id=invoice.id,
                product_code=item_data.get("product_code"),
                description=item_data.get("description"),
                unit=item_data.get("unit"),
                quantity=Decimal(str(item_data["quantity"])) if item_data.get("quantity") else None,
                order_quantity=Decimal(str(item_data["order_quantity"])) if item_data.get("order_quantity") else None,
                unit_price=Decimal(str(item_data["unit_price"])) if item_data.get("unit_price") else None,
                tax_rate=item_data.get("tax_rate"),
                tax_amount=Decimal(str(item_data["tax_amount"])) if item_data.get("tax_amount") else None,
                amount=Decimal(str(item_data["amount"])) if item_data.get("amount") else None,
                line_number=idx,
                raw_content=item_data.get("raw_content"),
                pack_quantity=item_data.get("pack_quantity"),
                unit_size=Decimal(str(item_data["unit_size"])) if item_data.get("unit_size") else None,
                unit_size_type=item_data.get("unit_size_type"),
                portions_per_unit=item_data.get("portions_per_unit"),
                cost_per_item=Decimal(str(item_data["cost_per_item"])) if item_data.get("cost_per_item") else None,
                cost_per_portion=Decimal(str(item_data["cost_per_portion"])) if item_data.get("cost_per_portion") else None,
                ocr_warnings=item_data.get("ocr_warnings")
            )
            db.add(line_item)

        await db.flush()

        # Re-run duplicate detection
        detector = DuplicateDetector(db, current_user.kitchen_id)
        duplicates = await detector.check_duplicates(invoice)

        if duplicates["firm_duplicate"]:
            invoice.duplicate_status = "firm_duplicate"
            invoice.duplicate_of_id = duplicates["firm_duplicate"].id
        elif duplicates["possible_duplicates"]:
            invoice.duplicate_status = "possible_duplicate"
            invoice.duplicate_of_id = duplicates["possible_duplicates"][0].id
        else:
            invoice.duplicate_status = None
            invoice.duplicate_of_id = None

        if duplicates["related_documents"]:
            invoice.related_document_id = duplicates["related_documents"][0].id

        await db.commit()

        logger.info(f"Invoice {invoice_id} reprocessed by admin {current_user.id}")

        return {
            "message": "Invoice reprocessed successfully",
            "supplier_id": supplier_id,
            "document_type": document_type,
            "line_items_count": len(line_items_data),
            "duplicate_status": invoice.duplicate_status
        }

    except Exception as e:
        await db.rollback()
        logger.error(f"Reprocessing failed for invoice {invoice_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Reprocessing failed: {str(e)}")


@router.post("/{invoice_id}/resend-to-azure")
async def resend_to_azure(
    invoice_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Admin only: Re-send invoice to Azure for OCR extraction.

    Fully re-processes the invoice:
    - Re-extracts from Azure Document Intelligence
    - Updates all invoice fields
    - Re-creates line items (with product definitions)
    - Re-runs duplicate detection
    """
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")

    # Load invoice
    result = await db.execute(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.kitchen_id == current_user.kitchen_id
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Check if file exists
    if not os.path.exists(invoice.image_path):
        raise HTTPException(status_code=404, detail="Invoice file not found")

    # Reset status to processing
    invoice.status = InvoiceStatus.PENDING
    await db.commit()

    # Run background processing
    background_tasks.add_task(
        process_invoice_background,
        invoice_id,
        invoice.image_path,
        current_user.kitchen_id
    )

    logger.info(f"Invoice {invoice_id} re-sent to Azure by admin {current_user.id}")

    return {
        "message": "Invoice re-sent to Azure for processing",
        "status": "pending"
    }
