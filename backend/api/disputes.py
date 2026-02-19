"""
API endpoints for invoice dispute tracking.

Handles:
- Dispute CRUD operations
- Dispute attachments upload/download
- Dispute activity logging
- Dashboard statistics
"""
import secrets
import hashlib
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from sqlalchemy.orm import selectinload
from datetime import datetime, date, timedelta
from typing import Optional, List
from pydantic import BaseModel
from decimal import Decimal

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.dispute import (
    InvoiceDispute, DisputeLineItem, DisputeAttachment, DisputeActivity,
    DisputeType, DisputeStatus, DisputePriority
)
from models.invoice import Invoice
from models.supplier import Supplier
from services.dispute_archival_service import DisputeArchivalService


def generate_public_hash() -> str:
    """Generate a secure random hash for public attachment links"""
    return secrets.token_urlsafe(32)  # 43 character URL-safe string

router = APIRouter()


# Pydantic Schemas

class DisputeLineItemInput(BaseModel):
    invoice_line_item_id: Optional[int] = None
    product_name: str
    product_code: Optional[str] = None
    quantity_ordered: Optional[float] = None
    quantity_received: Optional[float] = None
    unit_price_quoted: Optional[float] = None
    unit_price_charged: Optional[float] = None
    total_charged: float
    total_expected: Optional[float] = None
    notes: Optional[str] = None


class CreateDisputeInput(BaseModel):
    invoice_id: int
    dispute_type: DisputeType
    priority: DisputePriority = DisputePriority.MEDIUM
    title: str
    description: Optional[str] = ""
    disputed_amount: float
    expected_amount: Optional[float] = None
    line_items: List[DisputeLineItemInput] = []
    tags: Optional[List[str]] = None


class UpdateDisputeInput(BaseModel):
    status: Optional[DisputeStatus] = None
    priority: Optional[DisputePriority] = None
    title: Optional[str] = None
    description: Optional[str] = None
    resolution_notes: Optional[str] = None
    supplier_response: Optional[str] = None
    supplier_contact_name: Optional[str] = None
    resolved_amount: Optional[float] = None


class DisputeLineItemResponse(BaseModel):
    id: int
    product_name: str
    product_code: Optional[str]
    quantity_ordered: Optional[float]
    quantity_received: Optional[float]
    quantity_difference: Optional[float]
    unit_price_quoted: Optional[float]
    unit_price_charged: Optional[float]
    price_difference: Optional[float]
    total_charged: float
    total_expected: Optional[float]
    notes: Optional[str]

    class Config:
        from_attributes = True


class DisputeAttachmentResponse(BaseModel):
    id: int
    file_name: str
    file_type: str
    file_size_bytes: int
    attachment_type: str
    description: Optional[str]
    uploaded_at: str
    uploaded_by_username: str
    public_hash: Optional[str] = None
    public_url: Optional[str] = None

    class Config:
        from_attributes = True


class DisputeActivityResponse(BaseModel):
    id: int
    activity_type: str
    description: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: str
    created_by_username: str

    class Config:
        from_attributes = True


class DisputeResponse(BaseModel):
    id: int
    invoice_id: int
    invoice_number: Optional[str]
    supplier_name: str
    dispute_type: str
    status: str
    priority: str
    title: str
    description: str
    disputed_amount: float
    expected_amount: Optional[float]
    difference_amount: float
    supplier_contacted_at: Optional[str]
    supplier_response: Optional[str]
    supplier_contact_name: Optional[str]
    resolved_amount: Optional[float]
    opened_at: str
    opened_by: str
    updated_at: str
    resolved_at: Optional[str]
    closed_at: Optional[str]
    tags: Optional[List[str]]
    line_items: List[DisputeLineItemResponse]
    attachments: List[DisputeAttachmentResponse]
    activity_log: List[DisputeActivityResponse]

    class Config:
        from_attributes = True


# Endpoints

@router.get("")
async def get_disputes(
    status: Optional[str] = None,
    priority: Optional[str] = None,
    invoice_id: Optional[int] = None,
    supplier_id: Optional[int] = None,
    opened_date: Optional[date] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get disputes with filters"""

    # Build base query
    query = select(InvoiceDispute).options(
        selectinload(InvoiceDispute.invoice).selectinload(Invoice.supplier),
        selectinload(InvoiceDispute.opened_by_user),
        selectinload(InvoiceDispute.resolved_by_user),
        selectinload(InvoiceDispute.closed_by_user),
        selectinload(InvoiceDispute.line_items),
        selectinload(InvoiceDispute.attachments).selectinload(DisputeAttachment.uploaded_by_user),
        selectinload(InvoiceDispute.activity_log).selectinload(DisputeActivity.created_by_user)
    ).where(InvoiceDispute.kitchen_id == current_user.kitchen_id)

    # Join with Invoice for supplier filtering
    if supplier_id:
        query = query.join(Invoice, InvoiceDispute.invoice_id == Invoice.id).where(Invoice.supplier_id == supplier_id)

    if status:
        try:
            status_enum = DisputeStatus(status)
            query = query.where(InvoiceDispute.status == status_enum)
        except ValueError:
            pass

    if priority:
        try:
            priority_enum = DisputePriority(priority)
            query = query.where(InvoiceDispute.priority == priority_enum)
        except ValueError:
            pass

    if invoice_id:
        query = query.where(InvoiceDispute.invoice_id == invoice_id)

    if opened_date:
        day_start = datetime.combine(opened_date, datetime.min.time())
        day_end = datetime.combine(opened_date + timedelta(days=1), datetime.min.time())
        query = query.where(InvoiceDispute.opened_at >= day_start, InvoiceDispute.opened_at < day_end)

    # Count total (before pagination)
    count_query = select(func.count()).select_from(InvoiceDispute).where(InvoiceDispute.kitchen_id == current_user.kitchen_id)
    if supplier_id:
        count_query = count_query.join(Invoice, InvoiceDispute.invoice_id == Invoice.id).where(Invoice.supplier_id == supplier_id)
    if status:
        try:
            status_enum = DisputeStatus(status)
            count_query = count_query.where(InvoiceDispute.status == status_enum)
        except ValueError:
            pass
    if priority:
        try:
            priority_enum = DisputePriority(priority)
            count_query = count_query.where(InvoiceDispute.priority == priority_enum)
        except ValueError:
            pass
    if invoice_id:
        count_query = count_query.where(InvoiceDispute.invoice_id == invoice_id)
    if opened_date:
        day_start = datetime.combine(opened_date, datetime.min.time())
        day_end = datetime.combine(opened_date + timedelta(days=1), datetime.min.time())
        count_query = count_query.where(InvoiceDispute.opened_at >= day_start, InvoiceDispute.opened_at < day_end)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    # Apply pagination
    query = query.order_by(InvoiceDispute.opened_at.desc())
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    disputes = result.scalars().all()

    return {
        "disputes": [_format_dispute(dispute) for dispute in disputes],
        "total": total
    }


@router.get("/{dispute_id}")
async def get_dispute(
    dispute_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> DisputeResponse:
    """Get single dispute by ID"""

    result = await db.execute(
        select(InvoiceDispute).options(
            selectinload(InvoiceDispute.invoice).selectinload(Invoice.supplier),
            selectinload(InvoiceDispute.opened_by_user),
            selectinload(InvoiceDispute.resolved_by_user),
            selectinload(InvoiceDispute.closed_by_user),
            selectinload(InvoiceDispute.line_items),
            selectinload(InvoiceDispute.attachments).selectinload(DisputeAttachment.uploaded_by_user),
            selectinload(InvoiceDispute.activity_log).selectinload(DisputeActivity.created_by_user)
        ).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()

    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    return _format_dispute(dispute)


@router.post("")
async def create_dispute(
    dispute_input: CreateDisputeInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> DisputeResponse:
    """Create new invoice dispute"""

    # Verify invoice belongs to kitchen
    result = await db.execute(
        select(Invoice).where(
            and_(
                Invoice.id == dispute_input.invoice_id,
                Invoice.kitchen_id == current_user.kitchen_id
            )
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Calculate difference
    expected = Decimal(str(dispute_input.expected_amount)) if dispute_input.expected_amount else Decimal(0)
    disputed = Decimal(str(dispute_input.disputed_amount))
    difference = disputed - expected

    # Create dispute
    dispute = InvoiceDispute(
        kitchen_id=current_user.kitchen_id,
        invoice_id=dispute_input.invoice_id,
        dispute_type=dispute_input.dispute_type,
        priority=dispute_input.priority,
        status=DisputeStatus.NEW,
        title=dispute_input.title,
        description=dispute_input.description,
        disputed_amount=disputed,
        expected_amount=expected if dispute_input.expected_amount else None,
        difference_amount=difference,
        opened_by=current_user.id,
        tags=dispute_input.tags
    )

    db.add(dispute)
    await db.flush()  # Get dispute.id

    # Add line items
    for item_input in dispute_input.line_items:
        qty_diff = None
        if item_input.quantity_ordered is not None and item_input.quantity_received is not None:
            qty_diff = Decimal(str(item_input.quantity_ordered)) - Decimal(str(item_input.quantity_received))

        price_diff = None
        if item_input.unit_price_quoted is not None and item_input.unit_price_charged is not None:
            price_diff = Decimal(str(item_input.unit_price_charged)) - Decimal(str(item_input.unit_price_quoted))

        line_item = DisputeLineItem(
            dispute_id=dispute.id,
            invoice_line_item_id=item_input.invoice_line_item_id,
            product_name=item_input.product_name,
            product_code=item_input.product_code,
            quantity_ordered=Decimal(str(item_input.quantity_ordered)) if item_input.quantity_ordered else None,
            quantity_received=Decimal(str(item_input.quantity_received)) if item_input.quantity_received else None,
            quantity_difference=qty_diff,
            unit_price_quoted=Decimal(str(item_input.unit_price_quoted)) if item_input.unit_price_quoted else None,
            unit_price_charged=Decimal(str(item_input.unit_price_charged)) if item_input.unit_price_charged else None,
            price_difference=price_diff,
            total_charged=Decimal(str(item_input.total_charged)),
            total_expected=Decimal(str(item_input.total_expected)) if item_input.total_expected else None,
            notes=item_input.notes
        )
        db.add(line_item)

    # Log activity
    activity = DisputeActivity(
        dispute_id=dispute.id,
        activity_type="created",
        description=f"Dispute created: {dispute.title}",
        created_by=current_user.id
    )
    db.add(activity)

    await db.commit()
    await db.refresh(dispute)

    # Re-fetch with all relationships
    result = await db.execute(
        select(InvoiceDispute).options(
            selectinload(InvoiceDispute.invoice).selectinload(Invoice.supplier),
            selectinload(InvoiceDispute.opened_by_user),
            selectinload(InvoiceDispute.line_items),
            selectinload(InvoiceDispute.attachments).selectinload(DisputeAttachment.uploaded_by_user),
            selectinload(InvoiceDispute.activity_log).selectinload(DisputeActivity.created_by_user)
        ).where(InvoiceDispute.id == dispute.id)
    )
    dispute = result.scalar_one()

    return _format_dispute(dispute)


@router.patch("/{dispute_id}")
async def update_dispute(
    dispute_id: int,
    update_input: UpdateDisputeInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update dispute status or details"""

    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()

    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Track changes for activity log
    changes = []

    if update_input.status and update_input.status != dispute.status:
        old_status = dispute.status.value.upper()
        new_status = update_input.status.value.upper()
        dispute.status = update_input.status

        # Log status change with specific activity_type
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="status_change",
            description=f"Status changed from {old_status} to {new_status}",
            created_by=current_user.id
        )
        db.add(activity)
        changes.append(f"Status changed from {old_status} to {new_status}")

        # Auto-set resolved_at when status changes to resolved
        if update_input.status == DisputeStatus.RESOLVED and not dispute.resolved_at:
            dispute.resolved_at = datetime.utcnow()
            dispute.resolved_by = current_user.id

        # Auto-set closed_at when status changes to closed
        if update_input.status == DisputeStatus.CLOSED and not dispute.closed_at:
            dispute.closed_at = datetime.utcnow()
            dispute.closed_by = current_user.id

    if update_input.priority and update_input.priority != dispute.priority:
        old_priority = dispute.priority.value.upper()
        new_priority = update_input.priority.value.upper()
        dispute.priority = update_input.priority

        # Log priority change with specific activity_type
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="priority_change",
            description=f"Priority changed from {old_priority} to {new_priority}",
            created_by=current_user.id
        )
        db.add(activity)
        changes.append(f"Priority changed from {old_priority} to {new_priority}")

    if update_input.title and update_input.title != dispute.title:
        old_title = dispute.title
        dispute.title = update_input.title
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="updated",
            description=f"Title updated from '{old_title}' to '{update_input.title}'",
            created_by=current_user.id
        )
        db.add(activity)
        changes.append("Title updated")

    if update_input.description is not None and update_input.description != dispute.description:
        dispute.description = update_input.description
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="updated",
            description="Description updated",
            created_by=current_user.id
        )
        db.add(activity)
        changes.append("Description updated")

    if update_input.resolution_notes:
        dispute.resolution_notes = update_input.resolution_notes
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="note",
            description=update_input.resolution_notes,
            created_by=current_user.id
        )
        db.add(activity)
        changes.append("Resolution notes updated")

    if update_input.supplier_response:
        dispute.supplier_response = update_input.supplier_response
        if not dispute.supplier_contacted_at:
            dispute.supplier_contacted_at = datetime.utcnow()

        # Log note with specific activity_type
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="note",
            description=update_input.supplier_response,
            created_by=current_user.id
        )
        db.add(activity)
        changes.append(update_input.supplier_response)

    if update_input.supplier_contact_name:
        dispute.supplier_contact_name = update_input.supplier_contact_name

    if update_input.resolved_amount is not None:
        dispute.resolved_amount = Decimal(str(update_input.resolved_amount))
        activity = DisputeActivity(
            dispute_id=dispute.id,
            activity_type="updated",
            description=f"Resolved amount set to £{update_input.resolved_amount:.2f}",
            created_by=current_user.id
        )
        db.add(activity)
        changes.append(f"Resolved amount set to £{update_input.resolved_amount:.2f}")

    dispute.updated_at = datetime.utcnow()

    await db.commit()

    return {"status": "updated", "changes": changes}


@router.delete("/{dispute_id}")
async def delete_dispute(
    dispute_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a dispute (admin only, use carefully)"""

    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()

    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Cascade delete handles attachments, line items, activity
    await db.delete(dispute)
    await db.commit()

    return {"status": "deleted"}


@router.post("/{dispute_id}/attachments")
async def upload_dispute_attachment(
    dispute_id: int,
    file: UploadFile = File(...),
    attachment_type: str = "other",
    description: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload supporting document (photo, email, delivery note)"""

    # Verify dispute exists
    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Read file content
    file_content = await file.read()
    file_size = len(file_content)

    # Save file
    archival_service = DisputeArchivalService(db, current_user.kitchen_id)
    success, file_path = await archival_service.save_dispute_attachment(
        dispute,
        file_content,
        file.filename or "attachment",
        file.content_type or "application/octet-stream"
    )

    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {file_path}")

    # Generate public hash for shareable link
    public_hash = generate_public_hash()

    # Create attachment record
    attachment = DisputeAttachment(
        dispute_id=dispute_id,
        kitchen_id=current_user.kitchen_id,
        file_name=file.filename or "attachment",
        file_path=file_path,
        file_type=file.content_type or "application/octet-stream",
        file_size_bytes=file_size,
        attachment_type=attachment_type,
        description=description,
        uploaded_by=current_user.id,
        public_hash=public_hash
    )

    db.add(attachment)

    # Log activity
    activity = DisputeActivity(
        dispute_id=dispute_id,
        activity_type="attachment_added",
        description=f"Attachment added: {file.filename} ({attachment_type})",
        created_by=current_user.id
    )
    db.add(activity)

    await db.commit()
    await db.refresh(attachment)

    # Archive to Nextcloud if enabled
    success, result = await archival_service.archive_dispute_attachment(attachment)
    if success:
        await db.commit()  # Update archived status

    return {
        "id": attachment.id,
        "file_name": file.filename,
        "file_size": file_size,
        "archived": success,
        "public_hash": public_hash,
        "public_url": f"/api/public/attachments/{public_hash}"
    }


@router.get("/{dispute_id}/attachments/{attachment_id}")
async def download_dispute_attachment(
    dispute_id: int,
    attachment_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Download dispute attachment"""
    from fastapi.responses import Response

    result = await db.execute(
        select(DisputeAttachment).where(
            and_(
                DisputeAttachment.id == attachment_id,
                DisputeAttachment.dispute_id == dispute_id,
                DisputeAttachment.kitchen_id == current_user.kitchen_id
            )
        )
    )
    attachment = result.scalar_one_or_none()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get file content
    archival_service = DisputeArchivalService(db, current_user.kitchen_id)
    success, content = await archival_service.get_attachment_content(attachment)

    if not success:
        raise HTTPException(status_code=404, detail="File not found")

    return Response(
        content=content,
        media_type=attachment.file_type,
        headers={"Content-Disposition": f'inline; filename="{attachment.file_name}"'}
    )


@router.get("/stats/summary")
async def get_dispute_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get dispute statistics for dashboard widget"""

    # Count by status
    result = await db.execute(
        select(
            InvoiceDispute.status,
            func.count(InvoiceDispute.id).label("count"),
            func.sum(InvoiceDispute.difference_amount).label("total_amount")
        ).where(
            InvoiceDispute.kitchen_id == current_user.kitchen_id
        ).group_by(InvoiceDispute.status)
    )
    status_counts = {
        row.status.value: {
            "count": row.count,
            "amount": float(row.total_amount or 0)
        }
        for row in result
    }

    # Recent disputes
    result = await db.execute(
        select(InvoiceDispute).options(
            selectinload(InvoiceDispute.invoice).selectinload(Invoice.supplier)
        ).where(
            InvoiceDispute.kitchen_id == current_user.kitchen_id
        ).order_by(InvoiceDispute.opened_at.desc()).limit(5)
    )
    recent_disputes = result.scalars().all()

    # Count open disputes (all non-resolved statuses)
    open_count = sum(
        status_counts.get(status, {}).get("count", 0)
        for status in ["NEW", "CONTACTED", "AWAITING_CREDIT", "AWAITING_REPLACEMENT"]
    )

    # Total disputed amount
    total_disputed_amount = sum(s.get("amount", 0) for s in status_counts.values())

    return {
        "status_counts": status_counts,
        "total_disputes": sum(s.get("count", 0) for s in status_counts.values()),
        "open_disputes": open_count,
        "total_disputed_amount": total_disputed_amount,
        "recent_disputes": [
            {
                "id": d.id,
                "invoice_id": d.invoice_id,
                "title": d.title,
                "status": d.status.value,
                "disputed_amount": float(d.difference_amount),
                "opened_at": d.opened_at.isoformat(),
                "invoice_number": d.invoice.invoice_number if d.invoice else None,
                "supplier_name": d.invoice.supplier.name if d.invoice and d.invoice.supplier else "Unknown"
            }
            for d in recent_disputes
        ]
    }


@router.get("/stats/daily")
async def get_daily_dispute_stats(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get daily dispute statistics for a date range (for purchases chart integration).
    Returns totals split by resolved/unresolved status for color-coding."""
    from sqlalchemy import cast, Date, case

    resolved_statuses = [DisputeStatus.RESOLVED, DisputeStatus.CLOSED]

    query = select(
        cast(InvoiceDispute.opened_at, Date).label("date"),
        func.count(InvoiceDispute.id).label("count"),
        func.sum(InvoiceDispute.disputed_amount).label("total_disputed"),
        # Unresolved breakdown
        func.sum(case(
            (InvoiceDispute.status.notin_(resolved_statuses), InvoiceDispute.disputed_amount),
            else_=0
        )).label("unresolved_total"),
        func.count(case(
            (InvoiceDispute.status.notin_(resolved_statuses), InvoiceDispute.id),
        )).label("unresolved_count"),
        # Resolved breakdown
        func.sum(case(
            (InvoiceDispute.status.in_(resolved_statuses), InvoiceDispute.disputed_amount),
            else_=0
        )).label("resolved_total"),
        func.count(case(
            (InvoiceDispute.status.in_(resolved_statuses), InvoiceDispute.id),
        )).label("resolved_count"),
    ).where(
        InvoiceDispute.kitchen_id == current_user.kitchen_id
    )

    if from_date:
        query = query.where(cast(InvoiceDispute.opened_at, Date) >= from_date)
    if to_date:
        query = query.where(cast(InvoiceDispute.opened_at, Date) <= to_date)

    query = query.group_by(cast(InvoiceDispute.opened_at, Date))
    query = query.order_by(cast(InvoiceDispute.opened_at, Date))

    result = await db.execute(query)
    rows = result.all()

    return {
        "daily_stats": {
            row.date.isoformat(): {
                "count": row.count,
                "total_disputed": float(row.total_disputed or 0),
                "unresolved_count": row.unresolved_count,
                "unresolved_total": float(row.unresolved_total or 0),
                "resolved_count": row.resolved_count,
                "resolved_total": float(row.resolved_total or 0),
            }
            for row in rows
        }
    }


def _format_dispute(dispute: InvoiceDispute) -> DisputeResponse:
    """Format dispute for API response"""

    supplier_name = "Unknown"
    if dispute.invoice and dispute.invoice.supplier:
        supplier_name = dispute.invoice.supplier.name
    elif dispute.invoice and dispute.invoice.vendor_name:
        supplier_name = dispute.invoice.vendor_name

    return DisputeResponse(
        id=dispute.id,
        invoice_id=dispute.invoice_id,
        invoice_number=dispute.invoice.invoice_number if dispute.invoice else None,
        supplier_name=supplier_name,
        dispute_type=dispute.dispute_type.value,
        status=dispute.status.value,
        priority=dispute.priority.value,
        title=dispute.title,
        description=dispute.description,
        disputed_amount=float(dispute.disputed_amount),
        expected_amount=float(dispute.expected_amount) if dispute.expected_amount else None,
        difference_amount=float(dispute.difference_amount),
        supplier_contacted_at=dispute.supplier_contacted_at.isoformat() if dispute.supplier_contacted_at else None,
        supplier_response=dispute.supplier_response,
        supplier_contact_name=dispute.supplier_contact_name,
        resolved_amount=float(dispute.resolved_amount) if dispute.resolved_amount else None,
        opened_at=dispute.opened_at.isoformat(),
        opened_by=dispute.opened_by_user.name if dispute.opened_by_user else "Unknown",
        updated_at=dispute.updated_at.isoformat(),
        resolved_at=dispute.resolved_at.isoformat() if dispute.resolved_at else None,
        closed_at=dispute.closed_at.isoformat() if dispute.closed_at else None,
        tags=dispute.tags,
        line_items=[
            DisputeLineItemResponse(
                id=item.id,
                product_name=item.product_name,
                product_code=item.product_code,
                quantity_ordered=float(item.quantity_ordered) if item.quantity_ordered else None,
                quantity_received=float(item.quantity_received) if item.quantity_received else None,
                quantity_difference=float(item.quantity_difference) if item.quantity_difference else None,
                unit_price_quoted=float(item.unit_price_quoted) if item.unit_price_quoted else None,
                unit_price_charged=float(item.unit_price_charged) if item.unit_price_charged else None,
                price_difference=float(item.price_difference) if item.price_difference else None,
                total_charged=float(item.total_charged),
                total_expected=float(item.total_expected) if item.total_expected else None,
                notes=item.notes
            )
            for item in dispute.line_items
        ],
        attachments=[
            DisputeAttachmentResponse(
                id=att.id,
                file_name=att.file_name,
                file_type=att.file_type,
                file_size_bytes=att.file_size_bytes,
                attachment_type=att.attachment_type,
                description=att.description,
                uploaded_at=att.uploaded_at.isoformat(),
                uploaded_by_username=att.uploaded_by_user.name if att.uploaded_by_user else "Unknown",
                public_hash=att.public_hash,
                public_url=f"/api/public/attachments/{att.public_hash}" if att.public_hash else None
            )
            for att in dispute.attachments
        ],
        activity_log=[
            DisputeActivityResponse(
                id=act.id,
                activity_type=act.activity_type,
                description=act.description,
                old_value=act.old_value,
                new_value=act.new_value,
                created_at=act.created_at.isoformat(),
                created_by_username=act.created_by_user.name if act.created_by_user else "Unknown"
            )
            for act in sorted(dispute.activity_log, key=lambda x: x.created_at)
        ]
    )


# ===== Credit Note Linking Endpoints =====

class OpenDisputeResponse(BaseModel):
    """Simplified dispute info for linking modal"""
    id: int
    title: str
    dispute_type: str
    status: str
    disputed_amount: float
    opened_at: str
    invoice_number: Optional[str] = None


class LinkCreditNoteInput(BaseModel):
    """Input for linking a credit note to a dispute"""
    credit_note_invoice_id: int  # The invoice ID with document_type='credit_note'
    resolved_amount: Optional[float] = None  # Optional: override the credit note amount
    resolution_notes: Optional[str] = None  # Optional: additional notes


@router.get("/supplier/{supplier_id}/open", response_model=List[OpenDisputeResponse])
async def get_open_disputes_for_supplier(
    supplier_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get all open/unresolved disputes for a specific supplier"""
    # Open statuses (not resolved or closed)
    open_statuses = [
        DisputeStatus.NEW,
        DisputeStatus.OPEN,
        DisputeStatus.CONTACTED,
        DisputeStatus.IN_PROGRESS,
        DisputeStatus.AWAITING_CREDIT,
        DisputeStatus.AWAITING_REPLACEMENT,
        DisputeStatus.ESCALATED
    ]

    result = await db.execute(
        select(InvoiceDispute, Invoice.invoice_number)
        .join(Invoice, InvoiceDispute.invoice_id == Invoice.id)
        .where(
            and_(
                InvoiceDispute.kitchen_id == current_user.kitchen_id,
                Invoice.supplier_id == supplier_id,
                InvoiceDispute.status.in_(open_statuses)
            )
        )
        .order_by(InvoiceDispute.opened_at.desc())
    )
    rows = result.all()

    return [
        OpenDisputeResponse(
            id=dispute.id,
            title=dispute.title,
            dispute_type=dispute.dispute_type.value,
            status=dispute.status.value,
            disputed_amount=float(dispute.disputed_amount),
            opened_at=dispute.opened_at.isoformat(),
            invoice_number=invoice_number
        )
        for dispute, invoice_number in rows
    ]


@router.post("/{dispute_id}/link-credit-note")
async def link_credit_note_to_dispute(
    dispute_id: int,
    link_input: LinkCreditNoteInput,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Link a credit note invoice to a dispute and mark it as resolved"""
    # Get the dispute
    result = await db.execute(
        select(InvoiceDispute).where(
            and_(
                InvoiceDispute.id == dispute_id,
                InvoiceDispute.kitchen_id == current_user.kitchen_id
            )
        )
    )
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Get the credit note invoice
    result = await db.execute(
        select(Invoice).where(
            and_(
                Invoice.id == link_input.credit_note_invoice_id,
                Invoice.kitchen_id == current_user.kitchen_id
            )
        )
    )
    credit_note = result.scalar_one_or_none()
    if not credit_note:
        raise HTTPException(status_code=404, detail="Credit note not found")

    # Verify it's a credit note
    if credit_note.document_type != 'credit_note':
        raise HTTPException(status_code=400, detail="Invoice is not a credit note")

    # Determine resolved amount
    resolved_amount = link_input.resolved_amount
    if resolved_amount is None and credit_note.total:
        # Use the credit note total (as positive value)
        resolved_amount = abs(float(credit_note.total))

    # Update the dispute
    old_status = dispute.status.value
    dispute.status = DisputeStatus.RESOLVED
    dispute.resolved_amount = Decimal(str(resolved_amount)) if resolved_amount else None
    dispute.resolved_by = current_user.id
    dispute.resolved_at = datetime.utcnow()

    if link_input.resolution_notes:
        dispute.resolution_notes = link_input.resolution_notes

    # Build credit note reference
    credit_note_ref = credit_note.invoice_number or f"ID#{credit_note.id}"
    credit_note_date = credit_note.invoice_date.strftime('%d %b %Y') if credit_note.invoice_date else 'unknown date'

    # Add activity for status change
    status_activity = DisputeActivity(
        dispute_id=dispute.id,
        activity_type="status_change",
        description=f"Status changed from {old_status} to RESOLVED",
        old_value=old_status,
        new_value="RESOLVED",
        created_by=current_user.id
    )
    db.add(status_activity)

    # Add activity for credit note link
    link_activity = DisputeActivity(
        dispute_id=dispute.id,
        activity_type="credit_note_linked",
        description=f"Dispute resolved with credit note #{credit_note_ref} dated {credit_note_date}",
        new_value=str(credit_note.id),  # Store invoice ID for linking
        created_by=current_user.id
    )
    db.add(link_activity)

    # Update the credit note to track the linked dispute
    credit_note.linked_dispute_id = dispute.id

    await db.commit()

    return {
        "success": True,
        "message": f"Dispute linked to credit note #{credit_note_ref}",
        "dispute_id": dispute.id,
        "credit_note_id": credit_note.id,
        "credit_note_number": credit_note_ref,
        "resolved_amount": resolved_amount
    }


# LLM FEATURE — see LLM-MANIFEST.md for removal instructions
@router.post("/{dispute_id}/draft-email")
async def draft_email(
    dispute_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Draft a supplier dispute email using AI."""
    from services.llm_service import draft_dispute_email
    from models.settings import KitchenSettings

    # Load dispute with line items
    result = await db.execute(
        select(InvoiceDispute)
        .options(selectinload(InvoiceDispute.line_items))
        .where(
            InvoiceDispute.id == dispute_id,
            InvoiceDispute.kitchen_id == current_user.kitchen_id,
        )
    )
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    # Load supplier name via invoice
    from models.invoice import Invoice
    from models.supplier import Supplier
    inv_result = await db.execute(
        select(Invoice).where(Invoice.id == dispute.invoice_id)
    )
    invoice = inv_result.scalar_one_or_none()
    supplier_name = "Unknown Supplier"
    if invoice and invoice.supplier_id:
        sup_result = await db.execute(
            select(Supplier.name).where(Supplier.id == invoice.supplier_id)
        )
        sup_row = sup_result.scalar_one_or_none()
        if sup_row:
            supplier_name = sup_row

    # Load kitchen details
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == current_user.kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()

    kitchen_details = {
        "name": getattr(settings, "kitchen_display_name", "") or "",
        "address": " ".join(filter(None, [
            getattr(settings, "kitchen_address_line1", ""),
            getattr(settings, "kitchen_address_line2", ""),
            getattr(settings, "kitchen_city", ""),
            getattr(settings, "kitchen_postcode", ""),
        ])),
        "email": getattr(settings, "kitchen_email", "") or "",
        "phone": getattr(settings, "kitchen_phone", "") or "",
    }

    dispute_data = {
        "supplier_name": supplier_name,
        "invoice_number": invoice.invoice_number if invoice else None,
        "invoice_date": str(invoice.invoice_date) if invoice and invoice.invoice_date else None,
        "dispute_type": dispute.dispute_type.value if dispute.dispute_type else "price_discrepancy",
        "title": dispute.title,
        "description": dispute.description,
        "disputed_amount": float(dispute.disputed_amount) if dispute.disputed_amount else 0,
        "line_items": [
            {
                "product_name": li.product_name,
                "product_code": li.product_code,
                "quantity_ordered": float(li.quantity_ordered) if li.quantity_ordered else None,
                "quantity_received": float(li.quantity_received) if li.quantity_received else None,
                "unit_price_quoted": float(li.unit_price_quoted) if li.unit_price_quoted else None,
                "unit_price_charged": float(li.unit_price_charged) if li.unit_price_charged else None,
                "total_charged": float(li.total_charged) if li.total_charged else 0,
                "total_expected": float(li.total_expected) if li.total_expected else None,
            }
            for li in (dispute.line_items or [])
        ],
    }

    llm_result = await draft_dispute_email(
        db=db,
        kitchen_id=current_user.kitchen_id,
        dispute_data=dispute_data,
        kitchen_details=kitchen_details,
    )

    return {
        "llm_status": llm_result["status"],
        "email_subject": llm_result.get("email_subject"),
        "email_body": llm_result.get("email_body"),
        "error": llm_result.get("error"),
    }
