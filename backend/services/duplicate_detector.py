from datetime import timedelta
from decimal import Decimal
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from models.invoice import Invoice


class DuplicateDetector:
    """Service for detecting duplicate and related invoices."""

    # Configuration thresholds
    DATE_TOLERANCE_DAYS = 3
    AMOUNT_TOLERANCE_PERCENT = 5.0

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def check_duplicates(self, invoice: Invoice) -> dict:
        """
        Check for duplicates of the given invoice.

        Returns:
            {
                "firm_duplicate": Invoice or None,
                "possible_duplicates": list[Invoice],
                "related_documents": list[Invoice]
            }
        """
        result = {
            "firm_duplicate": None,
            "possible_duplicates": [],
            "related_documents": []
        }

        # Only check if we have supplier_id
        if not invoice.supplier_id:
            return result

        # 1. FIRM DUPLICATE: Same supplier + same invoice_number
        if invoice.invoice_number:
            firm = await self._find_firm_duplicate(invoice)
            if firm:
                result["firm_duplicate"] = firm

        # 2. FUZZY/POSSIBLE DUPLICATE: Same supplier + similar date + similar total
        if invoice.invoice_date and invoice.total:
            possible = await self._find_fuzzy_duplicates(invoice)
            result["possible_duplicates"] = possible

        # 3. RELATED DOCUMENTS: Cross-match by order_number
        if invoice.order_number:
            related = await self._find_related_documents(invoice)
            result["related_documents"] = related

        return result

    async def _find_firm_duplicate(self, invoice: Invoice) -> Optional[Invoice]:
        """Find exact match: same supplier + invoice_number"""
        query = select(Invoice).where(
            and_(
                Invoice.kitchen_id == self.kitchen_id,
                Invoice.supplier_id == invoice.supplier_id,
                Invoice.invoice_number == invoice.invoice_number,
                Invoice.id != invoice.id
            )
        )
        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def _find_fuzzy_duplicates(self, invoice: Invoice) -> list[Invoice]:
        """Find similar invoices: same supplier + close date + close total"""
        date_min = invoice.invoice_date - timedelta(days=self.DATE_TOLERANCE_DAYS)
        date_max = invoice.invoice_date + timedelta(days=self.DATE_TOLERANCE_DAYS)

        # Calculate amount tolerance
        amount_tolerance = invoice.total * Decimal(str(self.AMOUNT_TOLERANCE_PERCENT / 100))
        amount_min = invoice.total - amount_tolerance
        amount_max = invoice.total + amount_tolerance

        query = select(Invoice).where(
            and_(
                Invoice.kitchen_id == self.kitchen_id,
                Invoice.supplier_id == invoice.supplier_id,
                Invoice.id != invoice.id,
                Invoice.invoice_date.between(date_min, date_max),
                Invoice.total.between(amount_min, amount_max),
                # Exclude if it's the same invoice_number (already caught by firm)
                or_(
                    Invoice.invoice_number == None,
                    Invoice.invoice_number != invoice.invoice_number
                )
            )
        )
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def _find_related_documents(self, invoice: Invoice) -> list[Invoice]:
        """Find documents with same order_number but different invoice_number"""
        query = select(Invoice).where(
            and_(
                Invoice.kitchen_id == self.kitchen_id,
                Invoice.order_number == invoice.order_number,
                Invoice.id != invoice.id,
                # Must have different invoice_number to be related (not duplicate)
                or_(
                    Invoice.invoice_number == None,
                    Invoice.invoice_number != invoice.invoice_number
                )
            )
        )
        result = await self.db.execute(query)
        return list(result.scalars().all())


def detect_document_type(raw_text: str, fields: dict) -> str:
    """
    Detect if document is Invoice or Delivery Note based on OCR text.

    Args:
        raw_text: Full OCR text
        fields: Extracted fields dict from Azure

    Returns:
        "invoice" or "delivery_note"
    """
    if not raw_text:
        return "invoice"

    text_upper = raw_text.upper()

    # Keywords suggesting delivery note
    dn_keywords = [
        "DELIVERY NOTE", "DELIVERY DOCKET", "DISPATCH NOTE",
        "DELIVERY ADVICE", "PACKING SLIP", "PACKING LIST",
        "DN NO", "DN:", "D/N"
    ]

    # Keywords suggesting invoice
    inv_keywords = [
        "TAX INVOICE", "VAT INVOICE", "INVOICE NO",
        "INVOICE DATE", "INVOICE TOTAL", "AMOUNT DUE",
        "PAYMENT DUE", "BALANCE DUE"
    ]

    dn_score = sum(1 for kw in dn_keywords if kw in text_upper)
    inv_score = sum(1 for kw in inv_keywords if kw in text_upper)

    # Also check if there's no total amount (delivery notes often don't have)
    if not fields.get("total"):
        dn_score += 1

    return "delivery_note" if dn_score > inv_score else "invoice"
