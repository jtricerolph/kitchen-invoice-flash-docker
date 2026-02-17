"""
Search API endpoints for searching invoices, line items, and product definitions.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, desc
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.invoice import Invoice, InvoiceStatus
from models.line_item import LineItem
from models.supplier import Supplier
from models.product_definition import ProductDefinition
from models.settings import KitchenSettings
from auth.jwt import get_current_user
from services.price_history import PriceHistoryService

router = APIRouter(prefix="/api/search", tags=["search"])


# ============ Response Models ============

class GroupSummary(BaseModel):
    name: str
    count: int
    total: Optional[Decimal] = None


class InvoiceSearchItem(BaseModel):
    id: int
    invoice_number: Optional[str]
    invoice_date: Optional[date]
    total: Optional[Decimal]
    net_total: Optional[Decimal]
    supplier_id: Optional[int]
    supplier_name: Optional[str]
    vendor_name: Optional[str]
    status: str
    document_type: Optional[str]

    class Config:
        from_attributes = True


class InvoiceSearchResponse(BaseModel):
    items: List[InvoiceSearchItem]
    total_count: int
    grouped_by: Optional[str]
    groups: Optional[List[GroupSummary]]


class LineItemSearchItem(BaseModel):
    product_code: Optional[str]
    description: Optional[str]
    supplier_id: Optional[int]
    supplier_name: Optional[str]
    unit: Optional[str]
    most_recent_price: Optional[Decimal]
    earliest_price_in_period: Optional[Decimal]
    price_change_percent: Optional[float]
    price_change_status: str
    total_quantity: Optional[Decimal]
    occurrence_count: int
    most_recent_invoice_id: Optional[int]
    most_recent_invoice_number: Optional[str]
    most_recent_date: Optional[date]
    has_definition: bool
    portions_per_unit: Optional[int]
    pack_quantity: Optional[int]
    most_recent_line_item_id: Optional[int] = None
    most_recent_line_number: Optional[int] = None
    most_recent_raw_content: Optional[str] = None
    most_recent_pack_quantity: Optional[int] = None
    most_recent_unit_size: Optional[Decimal] = None
    most_recent_unit_size_type: Optional[str] = None
    # Ingredient mapping info
    ingredient_id: Optional[int] = None
    ingredient_name: Optional[str] = None
    ingredient_standard_unit: Optional[str] = None
    price_per_std_unit: Optional[Decimal] = None

    class Config:
        from_attributes = True


class LineItemSearchResponse(BaseModel):
    items: List[LineItemSearchItem]
    total_count: int
    grouped_by: Optional[str]
    groups: Optional[List[GroupSummary]]


class DefinitionSearchItem(BaseModel):
    id: int
    product_code: Optional[str]
    description_pattern: Optional[str]
    supplier_id: Optional[int]
    supplier_name: Optional[str]
    pack_quantity: Optional[int]
    unit_size: Optional[Decimal]
    unit_size_type: Optional[str]
    portions_per_unit: Optional[int]
    portion_description: Optional[str]
    source_invoice_id: Optional[int]
    source_invoice_number: Optional[str]
    most_recent_price: Optional[Decimal]
    updated_at: datetime

    class Config:
        from_attributes = True


class DefinitionSearchResponse(BaseModel):
    items: List[DefinitionSearchItem]
    total_count: int


class PriceHistoryPointResponse(BaseModel):
    date: date
    price: Decimal
    invoice_id: int
    invoice_number: Optional[str]
    quantity: Optional[Decimal]


class LineItemHistoryResponse(BaseModel):
    product_code: Optional[str]
    description: Optional[str]
    supplier_id: int
    supplier_name: Optional[str]
    price_history: List[PriceHistoryPointResponse]
    total_occurrences: int
    total_quantity: Decimal
    avg_qty_per_invoice: Decimal
    avg_qty_per_week: Decimal
    avg_qty_per_month: Decimal
    current_price: Optional[Decimal]
    price_change_status: str


class AcknowledgePriceRequest(BaseModel):
    product_code: Optional[str] = None
    description: Optional[str] = None
    supplier_id: int
    new_price: Decimal
    source_invoice_id: Optional[int] = None
    source_line_item_id: Optional[int] = None


class AcknowledgePriceResponse(BaseModel):
    id: int
    acknowledged_price: Decimal
    acknowledged_at: datetime


# ============ Invoice Search ============

@router.get("/invoices", response_model=InvoiceSearchResponse)
async def search_invoices(
    q: str = "",
    include_line_items: bool = False,
    supplier_id: Optional[int] = None,
    status: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    group_by: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Search invoices with optional filters.

    - q: Search term (invoice_number, vendor_name)
    - include_line_items: Also search line item product_code/description
    - supplier_id: Filter by supplier
    - status: Filter by status (pending, confirmed, etc.)
    - date_from/date_to: Date range (default: last 30 days)
    - group_by: "supplier" or "month" for grouped results
    """
    # Default date range: last 30 days
    if date_to is None:
        date_to = date.today()
    if date_from is None:
        date_from = date_to - timedelta(days=30)

    # Build base conditions
    conditions = [
        Invoice.kitchen_id == current_user.kitchen_id,
        Invoice.invoice_date >= date_from,
        Invoice.invoice_date <= date_to,
    ]

    if supplier_id:
        conditions.append(Invoice.supplier_id == supplier_id)

    if status:
        conditions.append(Invoice.status == status)

    # Search filter
    if q:
        search_pattern = f"%{q}%"
        search_conditions = [
            Invoice.invoice_number.ilike(search_pattern),
            Invoice.vendor_name.ilike(search_pattern),
        ]

        if include_line_items:
            # Need to join line items and search there too
            line_item_subquery = (
                select(LineItem.invoice_id)
                .where(or_(
                    LineItem.product_code.ilike(search_pattern),
                    LineItem.description.ilike(search_pattern)
                ))
                .distinct()
            )
            search_conditions.append(Invoice.id.in_(line_item_subquery))

        conditions.append(or_(*search_conditions))

    # Get total count
    count_query = select(func.count(Invoice.id)).where(and_(*conditions))
    count_result = await db.execute(count_query)
    total_count = count_result.scalar() or 0

    # Get invoices with supplier name
    query = (
        select(Invoice, Supplier.name.label('supplier_name'))
        .outerjoin(Supplier, Invoice.supplier_id == Supplier.id)
        .where(and_(*conditions))
        .order_by(desc(Invoice.invoice_date))
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    rows = result.fetchall()

    items = [
        InvoiceSearchItem(
            id=row.Invoice.id,
            invoice_number=row.Invoice.invoice_number,
            invoice_date=row.Invoice.invoice_date,
            total=row.Invoice.total,
            net_total=row.Invoice.net_total,
            supplier_id=row.Invoice.supplier_id,
            supplier_name=row.supplier_name,
            vendor_name=row.Invoice.vendor_name,
            status=row.Invoice.status.value if isinstance(row.Invoice.status, InvoiceStatus) else row.Invoice.status,
            document_type=row.Invoice.document_type
        )
        for row in rows
    ]

    # Handle grouping
    groups = None
    if group_by == "supplier":
        group_query = (
            select(
                Supplier.name,
                func.count(Invoice.id).label('count'),
                func.sum(Invoice.net_total).label('total')
            )
            .outerjoin(Supplier, Invoice.supplier_id == Supplier.id)
            .where(and_(*conditions))
            .group_by(Supplier.name)
            .order_by(desc('total'))
        )
        group_result = await db.execute(group_query)
        groups = [
            GroupSummary(name=row[0] or "Unknown", count=row[1], total=row[2])
            for row in group_result.fetchall()
        ]
    elif group_by == "month":
        group_query = (
            select(
                func.to_char(Invoice.invoice_date, 'YYYY-MM').label('month'),
                func.count(Invoice.id).label('count'),
                func.sum(Invoice.net_total).label('total')
            )
            .where(and_(*conditions))
            .group_by(func.to_char(Invoice.invoice_date, 'YYYY-MM'))
            .order_by(desc('month'))
        )
        group_result = await db.execute(group_query)
        groups = [
            GroupSummary(name=row[0] or "Unknown", count=row[1], total=row[2])
            for row in group_result.fetchall()
        ]

    return InvoiceSearchResponse(
        items=items,
        total_count=total_count,
        grouped_by=group_by,
        groups=groups
    )


# ============ Line Items Search (Consolidated) ============

@router.get("/line-items", response_model=LineItemSearchResponse)
async def search_line_items(
    q: str = "",
    supplier_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    group_by: Optional[str] = None,
    mapped: Optional[str] = Query(default=None, description="Filter by ingredient mapping: 'yes', 'no'"),
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Search line items with consolidation.

    Returns DISTINCT line items by (product_code OR description + supplier),
    with most recent price, price change status, total quantity, occurrence count.
    """
    price_service = PriceHistoryService(db, current_user.kitchen_id)

    items_data, total_count = await price_service.get_consolidated_line_items(
        search_query=q if q else None,
        supplier_id=supplier_id,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset
    )

    items = [LineItemSearchItem(**item) for item in items_data]

    # Filter by ingredient mapping status
    if mapped == 'yes':
        items = [i for i in items if i.ingredient_id is not None]
        total_count = len(items)
    elif mapped == 'no':
        items = [i for i in items if i.ingredient_id is None]
        total_count = len(items)

    # Handle grouping (for UI display)
    groups = None
    if group_by == "supplier":
        # Group items by supplier
        supplier_groups = {}
        for item in items:
            name = item.supplier_name or "Unknown"
            if name not in supplier_groups:
                supplier_groups[name] = {"count": 0, "total": Decimal(0)}
            supplier_groups[name]["count"] += item.occurrence_count
            if item.total_quantity:
                supplier_groups[name]["total"] += item.total_quantity

        groups = [
            GroupSummary(name=name, count=data["count"], total=data["total"])
            for name, data in sorted(supplier_groups.items(), key=lambda x: -x[1]["count"])
        ]

    return LineItemSearchResponse(
        items=items,
        total_count=total_count,
        grouped_by=group_by,
        groups=groups
    )


# ============ Definitions Search ============

@router.get("/definitions", response_model=DefinitionSearchResponse)
async def search_definitions(
    q: str = "",
    supplier_id: Optional[int] = None,
    has_portions: Optional[bool] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Search product definitions.

    - q: Search term (product_code, description_pattern)
    - supplier_id: Filter by supplier
    - has_portions: Filter by whether portions_per_unit is set
    """
    conditions = [ProductDefinition.kitchen_id == current_user.kitchen_id]

    if supplier_id:
        conditions.append(ProductDefinition.supplier_id == supplier_id)

    if q:
        search_pattern = f"%{q}%"
        conditions.append(or_(
            ProductDefinition.product_code.ilike(search_pattern),
            ProductDefinition.description_pattern.ilike(search_pattern)
        ))

    if has_portions is not None:
        if has_portions:
            conditions.append(ProductDefinition.portions_per_unit.isnot(None))
        else:
            conditions.append(ProductDefinition.portions_per_unit.is_(None))

    # Get total count
    count_query = select(func.count(ProductDefinition.id)).where(and_(*conditions))
    count_result = await db.execute(count_query)
    total_count = count_result.scalar() or 0

    # Get definitions with supplier name and source invoice number
    query = (
        select(
            ProductDefinition,
            Supplier.name.label('supplier_name'),
            Invoice.invoice_number.label('source_invoice_number')
        )
        .outerjoin(Supplier, ProductDefinition.supplier_id == Supplier.id)
        .outerjoin(Invoice, ProductDefinition.source_invoice_id == Invoice.id)
        .where(and_(*conditions))
        .order_by(desc(ProductDefinition.updated_at))
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    rows = result.fetchall()

    items = []
    for row in rows:
        definition = row.ProductDefinition

        # Get most recent price from matching line items
        most_recent_price = None
        price_conditions = [Invoice.kitchen_id == current_user.kitchen_id]

        if definition.supplier_id:
            price_conditions.append(Invoice.supplier_id == definition.supplier_id)

        if definition.product_code:
            price_conditions.append(LineItem.product_code == definition.product_code)
        elif definition.description_pattern:
            price_conditions.append(LineItem.description.ilike(f"%{definition.description_pattern}%"))

        if len(price_conditions) > 1:  # Has at least one matching condition beyond kitchen_id
            price_query = (
                select(LineItem.unit_price)
                .join(Invoice, LineItem.invoice_id == Invoice.id)
                .where(and_(*price_conditions))
                .order_by(desc(Invoice.invoice_date))
                .limit(1)
            )
            price_result = await db.execute(price_query)
            price_row = price_result.scalar_one_or_none()
            if price_row is not None:
                most_recent_price = price_row

        items.append(DefinitionSearchItem(
            id=definition.id,
            product_code=definition.product_code,
            description_pattern=definition.description_pattern,
            supplier_id=definition.supplier_id,
            supplier_name=row.supplier_name,
            pack_quantity=definition.pack_quantity,
            unit_size=definition.unit_size,
            unit_size_type=definition.unit_size_type,
            portions_per_unit=definition.portions_per_unit,
            portion_description=definition.portion_description,
            source_invoice_id=definition.source_invoice_id,
            source_invoice_number=row.source_invoice_number,
            most_recent_price=most_recent_price,
            updated_at=definition.updated_at
        ))

    return DefinitionSearchResponse(items=items, total_count=total_count)


# ============ Line Item History ============

@router.get("/line-items/history", response_model=LineItemHistoryResponse)
async def get_line_item_history(
    supplier_id: int,
    product_code: Optional[str] = None,
    description: Optional[str] = None,
    unit: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get price and quantity history for a specific line item.

    Used by the history modal to show price chart and stats.
    """
    if not product_code and not description:
        raise HTTPException(
            status_code=400,
            detail="Either product_code or description is required"
        )

    price_service = PriceHistoryService(db, current_user.kitchen_id)
    history = await price_service.get_history(
        supplier_id=supplier_id,
        product_code=product_code,
        description=description,
        unit=unit,
        date_from=date_from,
        date_to=date_to
    )

    return LineItemHistoryResponse(
        product_code=history.product_code,
        description=history.description,
        supplier_id=history.supplier_id,
        supplier_name=history.supplier_name,
        price_history=[
            PriceHistoryPointResponse(
                date=point.date,
                price=point.price,
                invoice_id=point.invoice_id,
                invoice_number=point.invoice_number,
                quantity=point.quantity
            )
            for point in history.price_history
        ],
        total_occurrences=history.total_occurrences,
        total_quantity=history.total_quantity,
        avg_qty_per_invoice=history.avg_qty_per_invoice,
        avg_qty_per_week=history.avg_qty_per_week,
        avg_qty_per_month=history.avg_qty_per_month,
        current_price=history.current_price,
        price_change_status=history.price_change_status
    )


# ============ Price Acknowledgement ============

@router.post("/line-items/acknowledge-price", response_model=AcknowledgePriceResponse)
async def acknowledge_price_change(
    request: AcknowledgePriceRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Acknowledge a price change for a line item.

    Creates or updates the AcknowledgedPrice record so the price
    won't be flagged as changed in future.
    """
    if not request.product_code and not request.description:
        raise HTTPException(
            status_code=400,
            detail="Either product_code or description is required"
        )

    price_service = PriceHistoryService(db, current_user.kitchen_id)
    acknowledged = await price_service.acknowledge_price(
        user_id=current_user.id,
        supplier_id=request.supplier_id,
        product_code=request.product_code,
        description=request.description,
        new_price=request.new_price,
        source_invoice_id=request.source_invoice_id,
        source_line_item_id=request.source_line_item_id
    )

    return AcknowledgePriceResponse(
        id=acknowledged.id,
        acknowledged_price=acknowledged.acknowledged_price,
        acknowledged_at=acknowledged.acknowledged_at
    )


# ============ Search Settings ============

class SearchSettingsResponse(BaseModel):
    price_change_lookback_days: int
    price_change_amber_threshold: int
    price_change_red_threshold: int


class SearchSettingsUpdate(BaseModel):
    price_change_lookback_days: Optional[int] = None
    price_change_amber_threshold: Optional[int] = None
    price_change_red_threshold: Optional[int] = None


@router.get("/settings", response_model=SearchSettingsResponse)
async def get_search_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get search/price change settings."""
    result = await db.execute(
        select(KitchenSettings).where(
            KitchenSettings.kitchen_id == current_user.kitchen_id
        )
    )
    settings = result.scalar_one_or_none()

    return SearchSettingsResponse(
        price_change_lookback_days=settings.price_change_lookback_days if settings else 30,
        price_change_amber_threshold=settings.price_change_amber_threshold if settings else 10,
        price_change_red_threshold=settings.price_change_red_threshold if settings else 20
    )


@router.patch("/settings", response_model=SearchSettingsResponse)
async def update_search_settings(
    update: SearchSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update search/price change settings."""
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")

    result = await db.execute(
        select(KitchenSettings).where(
            KitchenSettings.kitchen_id == current_user.kitchen_id
        )
    )
    settings = result.scalar_one_or_none()

    if not settings:
        settings = KitchenSettings(kitchen_id=current_user.kitchen_id)
        db.add(settings)

    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if value is not None:
            setattr(settings, field, value)

    await db.commit()
    await db.refresh(settings)

    return SearchSettingsResponse(
        price_change_lookback_days=settings.price_change_lookback_days,
        price_change_amber_threshold=settings.price_change_amber_threshold,
        price_change_red_threshold=settings.price_change_red_threshold
    )


# ============ Definition Update ============

class DefinitionUpdateRequest(BaseModel):
    pack_quantity: Optional[int] = None
    unit_size: Optional[Decimal] = None
    unit_size_type: Optional[str] = None
    portions_per_unit: Optional[int] = None
    portion_description: Optional[str] = None


@router.patch("/definitions/{definition_id}", response_model=DefinitionSearchItem)
async def update_definition(
    definition_id: int,
    update: DefinitionUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update a product definition."""
    # Fetch the definition
    result = await db.execute(
        select(ProductDefinition).where(
            ProductDefinition.id == definition_id,
            ProductDefinition.kitchen_id == current_user.kitchen_id
        )
    )
    definition = result.scalar_one_or_none()

    if not definition:
        raise HTTPException(status_code=404, detail="Definition not found")

    # Update fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(definition, field, value)

    # Update saved_by metadata
    definition.saved_by_user_id = current_user.id

    await db.commit()
    await db.refresh(definition)

    # Get supplier name for response
    supplier_name = None
    if definition.supplier_id:
        supplier_result = await db.execute(
            select(Supplier.name).where(Supplier.id == definition.supplier_id)
        )
        supplier_name = supplier_result.scalar_one_or_none()

    # Get source invoice number
    source_invoice_number = None
    if definition.source_invoice_id:
        invoice_result = await db.execute(
            select(Invoice.invoice_number).where(Invoice.id == definition.source_invoice_id)
        )
        source_invoice_number = invoice_result.scalar_one_or_none()

    # Get most recent price
    most_recent_price = None
    price_conditions = [Invoice.kitchen_id == current_user.kitchen_id]

    if definition.supplier_id:
        price_conditions.append(Invoice.supplier_id == definition.supplier_id)

    if definition.product_code:
        price_conditions.append(LineItem.product_code == definition.product_code)
    elif definition.description_pattern:
        price_conditions.append(LineItem.description.ilike(f"%{definition.description_pattern}%"))

    if len(price_conditions) > 1:  # Has at least one matching condition beyond kitchen_id
        price_query = (
            select(LineItem.unit_price)
            .join(Invoice, LineItem.invoice_id == Invoice.id)
            .where(and_(*price_conditions))
            .order_by(desc(Invoice.invoice_date))
            .limit(1)
        )
        price_result = await db.execute(price_query)
        price_row = price_result.scalar_one_or_none()
        if price_row is not None:
            most_recent_price = price_row

    return DefinitionSearchItem(
        id=definition.id,
        product_code=definition.product_code,
        description_pattern=definition.description_pattern,
        supplier_id=definition.supplier_id,
        supplier_name=supplier_name,
        pack_quantity=definition.pack_quantity,
        unit_size=definition.unit_size,
        unit_size_type=definition.unit_size_type,
        portions_per_unit=definition.portions_per_unit,
        portion_description=definition.portion_description,
        source_invoice_id=definition.source_invoice_id,
        source_invoice_number=source_invoice_number,
        most_recent_price=most_recent_price,
        updated_at=definition.updated_at
    )
