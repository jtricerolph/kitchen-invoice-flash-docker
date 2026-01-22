"""
API endpoints for credit note management.

Handles:
- Credit note upload
- Credit note download
- Credit note CRUD operations
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from sqlalchemy.orm import selectinload
from datetime import date as date_type
from typing import Optional
from pydantic import BaseModel
from decimal import Decimal

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.dispute import CreditNote, InvoiceDispute, DisputeStatus, DisputeActivity
from models.invoice import Invoice
from models.supplier import Supplier
from services.dispute_archival_service import DisputeArchivalService

router = APIRouter()


# Pydantic Schemas

class CreditNoteResponse(BaseModel):
    id: int
    invoice_id: int
    supplier_id: int
    supplier_name: str
    credit_note_number: str
    credit_date: str
    credit_amount: float
    reason: Optional[str]
    notes: Optional[str]
    file_storage_location: str
    created_at: str
    created_by: str

    class Config:
        from_attributes = True


# Endpoints

@router.post("/upload")
async def upload_credit_note(
    file: UploadFile = File(...),
    invoice_id: int = Form(...),
    credit_note_number: str = Form(...),
    credit_date: str = Form(...),
    credit_amount: float = Form(...),
    dispute_id: Optional[int] = Form(None),
    reason: Optional[str] = Form(None),
    notes: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload credit note PDF"""

    # Verify invoice exists and belongs to kitchen
    result = await db.execute(
        select(Invoice).where(
            and_(
                Invoice.id == invoice_id,
                Invoice.kitchen_id == current_user.kitchen_id
            )
        )
    )
    invoice = result.scalar_one_or_none()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Parse credit date
    try:
        credit_date_obj = date_type.fromisoformat(credit_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    # Read file content
    file_content = await file.read()

    # Validate file type (should be PDF)
    if file.content_type and "pdf" not in file.content_type.lower():
        raise HTTPException(status_code=400, detail="Only PDF files are supported for credit notes")

    # Save file
    archival_service = DisputeArchivalService(db, current_user.kitchen_id)
    success, file_path = await archival_service.save_credit_note(
        invoice,
        file_content,
        file.filename or "credit_note.pdf"
    )

    if not success:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {file_path}")

    # Create credit note record
    credit_note = CreditNote(
        kitchen_id=current_user.kitchen_id,
        invoice_id=invoice_id,
        supplier_id=invoice.supplier_id or 0,  # Use 0 if no supplier (will need to handle)
        credit_note_number=credit_note_number,
        credit_date=credit_date_obj,
        credit_amount=Decimal(str(credit_amount)),
        reason=reason,
        notes=notes,
        file_path=file_path,
        file_storage_location="local",
        created_by=current_user.id
    )

    db.add(credit_note)
    await db.flush()  # Get credit_note.id

    # If linked to dispute, update dispute
    if dispute_id:
        result = await db.execute(
            select(InvoiceDispute).where(
                and_(
                    InvoiceDispute.id == dispute_id,
                    InvoiceDispute.kitchen_id == current_user.kitchen_id
                )
            )
        )
        dispute = result.scalar_one_or_none()

        if dispute:
            # Link credit note to dispute
            dispute.credit_note_id = credit_note.id
            dispute.resolved_amount = credit_note.credit_amount

            # Update dispute status if still open/in_progress
            if dispute.status in [DisputeStatus.OPEN, DisputeStatus.CONTACTED, DisputeStatus.IN_PROGRESS]:
                dispute.status = DisputeStatus.AWAITING_CREDIT

            # Log activity
            activity = DisputeActivity(
                dispute_id=dispute_id,
                activity_type="credit_note_added",
                description=f"Credit note {credit_note_number} (£{credit_amount:.2f}) linked to dispute",
                created_by=current_user.id
            )
            db.add(activity)

    await db.commit()
    await db.refresh(credit_note)

    # Archive to Nextcloud if enabled
    success, result = await archival_service.archive_credit_note(credit_note)
    if success:
        await db.commit()  # Update archived status

    return {
        "id": credit_note.id,
        "credit_note_number": credit_note_number,
        "credit_amount": credit_amount,
        "archived": success
    }


@router.get("/{credit_note_id}")
async def get_credit_note(
    credit_note_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> CreditNoteResponse:
    """Get credit note details"""

    result = await db.execute(
        select(CreditNote).options(
            selectinload(CreditNote.supplier),
            selectinload(CreditNote.created_by_user)
        ).where(
            and_(
                CreditNote.id == credit_note_id,
                CreditNote.kitchen_id == current_user.kitchen_id
            )
        )
    )
    credit_note = result.scalar_one_or_none()

    if not credit_note:
        raise HTTPException(status_code=404, detail="Credit note not found")

    return CreditNoteResponse(
        id=credit_note.id,
        invoice_id=credit_note.invoice_id,
        supplier_id=credit_note.supplier_id,
        supplier_name=credit_note.supplier.name if credit_note.supplier else "Unknown",
        credit_note_number=credit_note.credit_note_number,
        credit_date=credit_note.credit_date.isoformat(),
        credit_amount=float(credit_note.credit_amount),
        reason=credit_note.reason,
        notes=credit_note.notes,
        file_storage_location=credit_note.file_storage_location,
        created_at=credit_note.created_at.isoformat(),
        created_by=credit_note.created_by_user.name if credit_note.created_by_user else "Unknown"
    )


@router.get("/{credit_note_id}/download")
async def download_credit_note(
    credit_note_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Download credit note PDF"""

    result = await db.execute(
        select(CreditNote).where(
            and_(
                CreditNote.id == credit_note_id,
                CreditNote.kitchen_id == current_user.kitchen_id
            )
        )
    )
    credit_note = result.scalar_one_or_none()

    if not credit_note:
        raise HTTPException(status_code=404, detail="Credit note not found")

    # Get file content
    archival_service = DisputeArchivalService(db, current_user.kitchen_id)
    success, content = await archival_service.get_credit_note_content(credit_note)

    if not success:
        raise HTTPException(status_code=404, detail="File not found")

    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{credit_note.credit_note_number}.pdf"'}
    )


@router.patch("/{credit_note_id}")
async def update_credit_note(
    credit_note_id: int,
    credit_note_number: Optional[str] = None,
    credit_date: Optional[str] = None,
    credit_amount: Optional[float] = None,
    reason: Optional[str] = None,
    notes: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update credit note details"""

    result = await db.execute(
        select(CreditNote).where(
            and_(
                CreditNote.id == credit_note_id,
                CreditNote.kitchen_id == current_user.kitchen_id
            )
        )
    )
    credit_note = result.scalar_one_or_none()

    if not credit_note:
        raise HTTPException(status_code=404, detail="Credit note not found")

    if credit_note_number:
        credit_note.credit_note_number = credit_note_number

    if credit_date:
        try:
            credit_note.credit_date = date_type.fromisoformat(credit_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    if credit_amount is not None:
        credit_note.credit_amount = Decimal(str(credit_amount))

    if reason is not None:
        credit_note.reason = reason

    if notes is not None:
        credit_note.notes = notes

    await db.commit()

    return {"status": "updated"}


@router.delete("/{credit_note_id}")
async def delete_credit_note(
    credit_note_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete credit note"""

    result = await db.execute(
        select(CreditNote).where(
            and_(
                CreditNote.id == credit_note_id,
                CreditNote.kitchen_id == current_user.kitchen_id
            )
        )
    )
    credit_note = result.scalar_one_or_none()

    if not credit_note:
        raise HTTPException(status_code=404, detail="Credit note not found")

    # Check if linked to dispute
    result = await db.execute(
        select(InvoiceDispute).where(InvoiceDispute.credit_note_id == credit_note_id)
    )
    dispute = result.scalar_one_or_none()

    if dispute:
        # Unlink from dispute
        dispute.credit_note_id = None
        dispute.resolved_amount = None

    await db.delete(credit_note)
    await db.commit()

    return {"status": "deleted"}
