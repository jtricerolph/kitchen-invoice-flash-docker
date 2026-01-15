import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


# Default patterns for common invoice formats
DEFAULT_PATTERNS = {
    "invoice_number": [
        r"(?:Invoice|Inv|Invoice\s*(?:No|#|Number)?)[:\s#]*([A-Z0-9]+-?[A-Z0-9]+)",
        r"(?:Invoice|Inv)\s*#?\s*:?\s*(\d+)",
        r"(?:Order|Ref|Reference)\s*(?:No|#)?[:\s]*([A-Z0-9-]+)",
        r"(?:NUMBER|NUMB)[:\s]*([0-9-]+)",
    ],
    "date": [
        r"(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})",  # DD/MM/YYYY or MM/DD/YYYY
        r"(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})",    # YYYY-MM-DD
        r"(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})",
    ],
    "total": [
        r"(?:Total|Grand\s*Total|Amount\s*Due|Balance\s*Due)[:\s]*[£$€]?\s*([\d,]+\.?\d*)",
        r"(?:TOTAL)[:\s]*[£$€]?\s*([\d,]+\.?\d*)",
        r"[£$€]\s*([\d,]+\.\d{2})\s*$",  # Currency at end of line
    ]
}


def extract_invoice_fields(raw_text: str, template_config: dict = None) -> dict:
    """
    Extract invoice number, date, and total from OCR text.

    Args:
        raw_text: The raw OCR text
        template_config: Optional supplier-specific patterns

    Returns:
        dict with invoice_number, invoice_date, total
    """
    patterns = template_config if template_config else DEFAULT_PATTERNS

    result = {
        "invoice_number": extract_invoice_number(raw_text, patterns.get("invoice_number", DEFAULT_PATTERNS["invoice_number"])),
        "invoice_date": extract_date(raw_text, patterns.get("date", DEFAULT_PATTERNS["date"])),
        "total": extract_total(raw_text, patterns.get("total", DEFAULT_PATTERNS["total"]))
    }

    return result


def extract_invoice_number(text: str, patterns: list) -> Optional[str]:
    """Extract invoice number using provided patterns"""
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


def extract_date(text: str, patterns: list) -> Optional[date]:
    """Extract and parse date from text"""
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            date_str = match.group(1)
            parsed = parse_date_string(date_str)
            if parsed:
                return parsed
    return None


def parse_date_string(date_str: str) -> Optional[date]:
    """Parse various date formats"""
    # Common date formats to try
    formats = [
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",  # DD/MM/YYYY
        "%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y",  # MM/DD/YYYY
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d",  # YYYY-MM-DD
        "%d/%m/%y", "%d-%m-%y", "%d.%m.%y",  # DD/MM/YY
        "%d %b %Y", "%d %B %Y",              # DD Mon YYYY
        "%d %b %y", "%d %B %y",              # DD Mon YY
    ]

    for fmt in formats:
        try:
            parsed = datetime.strptime(date_str.strip(), fmt)
            return parsed.date()
        except ValueError:
            continue

    return None


def extract_total(text: str, patterns: list) -> Optional[Decimal]:
    """Extract total amount from text"""
    # Try each pattern
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE | re.MULTILINE)
        for match in matches:
            amount = parse_amount(match)
            if amount and amount > Decimal("0"):
                return amount

    # Fallback: look for the largest currency amount
    currency_pattern = r"[£$€]?\s*([\d,]+\.\d{2})"
    amounts = re.findall(currency_pattern, text)
    if amounts:
        parsed_amounts = [parse_amount(a) for a in amounts]
        valid_amounts = [a for a in parsed_amounts if a and a > Decimal("0")]
        if valid_amounts:
            # Return the largest amount (likely the total)
            return max(valid_amounts)

    return None


def parse_amount(amount_str: str) -> Optional[Decimal]:
    """Parse amount string to Decimal"""
    try:
        # Remove currency symbols and commas
        cleaned = re.sub(r"[£$€,\s]", "", amount_str)
        if cleaned:
            return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        pass
    return None


async def identify_supplier(
    text: str,
    kitchen_id: int,
    db: AsyncSession
) -> Optional[int]:
    """
    Try to identify the supplier from OCR text.

    Matches against supplier identifier_config keywords.
    """
    from models.supplier import Supplier

    result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == kitchen_id)
    )
    suppliers = result.scalars().all()

    text_upper = text.upper()

    for supplier in suppliers:
        identifier_config = supplier.identifier_config or {}
        keywords = identifier_config.get("keywords", [])

        for keyword in keywords:
            if keyword.upper() in text_upper:
                return supplier.id

        # Also check if supplier name appears in text
        if supplier.name.upper() in text_upper:
            return supplier.id

    return None


def build_supplier_template(sample_texts: list[str], extracted_values: list[dict]) -> dict:
    """
    Helper to build supplier template from sample invoices.

    Args:
        sample_texts: List of OCR texts from sample invoices
        extracted_values: List of known correct values for each sample

    Returns:
        Template config with patterns
    """
    # This would analyze patterns across samples to build regex
    # For now, return default patterns
    return DEFAULT_PATTERNS
