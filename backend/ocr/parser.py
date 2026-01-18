import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


# Default patterns for common invoice formats
DEFAULT_PATTERNS = {
    "invoice_number": [
        # "Invoice No: 12345" or "Invoice Number: ABC-123" or "Invoice #12345"
        r"(?:Invoice|Inv)[\s.]*(?:No|Number|#)?[\s.:]*([A-Z0-9][A-Z0-9\-/]+)",
        # "Invoice: 12345" - simple format
        r"Invoice[:\s]+([A-Z0-9][A-Z0-9\-/]*\d+)",
        # Just digits after Invoice keyword
        r"(?:Invoice|Inv)[\s#.:]*(\d{3,})",
        # Order/Reference numbers
        r"(?:Order|Ref|Reference)[\s.]*(?:No|Number|#)?[\s.:]*([A-Z0-9\-/]+)",
        # NUMBER: 12345
        r"(?:NUMBER|NUMB)[:\s]*([0-9\-]+)",
        # Standalone number patterns like "No. 12345" or "No: ABC-123"
        r"(?:^|\s)No[.:\s]+([A-Z0-9][A-Z0-9\-/]+)",
    ],
    # Patterns for invoice number on NEXT LINE after label
    "invoice_number_multiline": [
        # "Invoice\n12345" or "Invoice Number\n12345"
        r"(?:Invoice|Inv)(?:\s*(?:No|Number|#))?[\s.:]*\n\s*([A-Z0-9][A-Z0-9\-/]+)",
        # "Invoice No.\n12345"
        r"Invoice\s*No\.?\s*\n\s*([A-Z0-9][A-Z0-9\-/]+)",
    ],
    "date": [
        # DD Mon YYYY (e.g., "15 Jan 2026", "15 January 2026")
        r"(\d{1,2}\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*\d{2,4})",
        # DD/MM/YYYY or MM/DD/YYYY
        r"(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})",
        # YYYY-MM-DD
        r"(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})",
        # Date: or Dated: prefix (same line)
        r"(?:Date|Dated)[:\s]*(\d{1,2}[/.\-\s]+(?:\w+|\d{1,2})[/.\-\s]+\d{2,4})",
        # Date label followed by date on next line
        r"(?:Date|Dated|Invoice Date)[:\s]*\n\s*(\d{1,2}\s*(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*\d{2,4})",
        r"(?:Date|Dated|Invoice Date)[:\s]*\n\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})",
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
        "invoice_number": extract_invoice_number(
            raw_text,
            patterns.get("invoice_number", DEFAULT_PATTERNS["invoice_number"]),
            patterns.get("invoice_number_multiline", DEFAULT_PATTERNS.get("invoice_number_multiline", []))
        ),
        "invoice_date": extract_date(raw_text, patterns.get("date", DEFAULT_PATTERNS["date"])),
        "total": extract_total(raw_text, patterns.get("total", DEFAULT_PATTERNS["total"]))
    }

    return result


def extract_invoice_number(text: str, patterns: list, multiline_patterns: list = None) -> Optional[str]:
    """Extract invoice number using provided patterns"""
    # Try single-line patterns first
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            result = match.group(1).strip()
            # Skip if we just captured the word "Invoice" or similar
            if result.lower() not in ('invoice', 'inv', 'number', 'no'):
                return result

    # Try multiline patterns (number on next line after label)
    if multiline_patterns:
        for pattern in multiline_patterns:
            match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
            if match:
                result = match.group(1).strip()
                if result.lower() not in ('invoice', 'inv', 'number', 'no'):
                    return result

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
    # Normalize whitespace - OCR sometimes adds extra spaces
    date_str = ' '.join(date_str.strip().split())

    # Common date formats to try
    formats = [
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",  # DD/MM/YYYY
        "%m/%d/%Y", "%m-%d-%Y", "%m.%d.%Y",  # MM/DD/YYYY
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d",  # YYYY-MM-DD
        "%d/%m/%y", "%d-%m-%y", "%d.%m.%y",  # DD/MM/YY
        "%d %b %Y", "%d %B %Y",              # DD Mon YYYY
        "%d %b %y", "%d %B %y",              # DD Mon YY
        "%d%b%Y", "%d%B%Y",                  # DDMonYYYY (no spaces)
        "%d%b%y", "%d%B%y",                  # DDMonYY (no spaces)
    ]

    for fmt in formats:
        try:
            parsed = datetime.strptime(date_str, fmt)
            return parsed.date()
        except ValueError:
            continue

    # Try to handle variations like "15Jan2026" or extra characters
    # Remove common noise characters
    cleaned = re.sub(r'[,]', ' ', date_str)
    cleaned = ' '.join(cleaned.split())

    if cleaned != date_str:
        for fmt in formats:
            try:
                parsed = datetime.strptime(cleaned, fmt)
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


def normalize_text(text: str) -> str:
    """Normalize text for fuzzy matching - lowercase, remove punctuation, extra spaces"""
    import string
    text = text.lower()
    text = text.translate(str.maketrans('', '', string.punctuation))
    text = ' '.join(text.split())
    return text


def get_words(text: str) -> set:
    """Get set of significant words (3+ chars) from text"""
    return {w for w in normalize_text(text).split() if len(w) >= 3}


def fuzzy_match_score(supplier_name: str, text: str) -> float:
    """
    Calculate fuzzy match score between supplier name and text.
    Returns score from 0.0 to 1.0

    Requires strong evidence of match - simple word overlap is not enough.
    """
    supplier_norm = normalize_text(supplier_name)
    text_norm = normalize_text(text)

    # Check if supplier name is contained in text (high confidence)
    if supplier_norm in text_norm:
        return 0.95

    # Get significant words (4+ chars to avoid common short words like "the", "ltd", "and")
    supplier_words = {w for w in normalize_text(supplier_name).split() if len(w) >= 4}
    text_words = {w for w in normalize_text(text).split() if len(w) >= 4}

    if not supplier_words:
        # Fall back to 3+ char words if no 4+ char words
        supplier_words = get_words(supplier_name)
        if not supplier_words:
            return 0.0

    # Count how many supplier words appear in text
    matching_words = supplier_words & text_words

    # No matches at all = no fuzzy match
    if not matching_words:
        return 0.0

    # Calculate base score from word overlap
    word_score = len(matching_words) / len(supplier_words)

    # Bonus: Check if first word (company name) matches - this is most important
    supplier_first = supplier_norm.split()[0] if supplier_norm.split() else ""
    first_word_matches = False
    if supplier_first and len(supplier_first) >= 4:
        if supplier_first in text_norm:
            first_word_matches = True
            word_score = max(word_score, 0.75)

    # Require either:
    # - First word matching (strong signal), OR
    # - Multiple words matching (at least 2)
    # Single non-first word matches are not reliable
    if not first_word_matches and len(matching_words) < 2:
        # Single word match (not first word) - reduce confidence significantly
        word_score = word_score * 0.5

    return word_score


async def identify_supplier(
    text: str,
    kitchen_id: int,
    db: AsyncSession
) -> tuple[Optional[int], Optional[str]]:
    """
    Try to identify the supplier from OCR text.

    Match types:
    - "exact": vendor_name exactly equals supplier name or alias (case-insensitive)
    - "fuzzy": supplier name/alias is contained in text, or fuzzy word matching

    Returns:
        tuple of (supplier_id, match_type) where match_type is "exact", "fuzzy", or None
    """
    from models.supplier import Supplier

    result = await db.execute(
        select(Supplier).where(Supplier.kitchen_id == kitchen_id)
    )
    suppliers = result.scalars().all()

    text_normalized = normalize_text(text)
    text_upper = text.upper()

    # First pass: TRUE exact matches (text equals name/alias exactly)
    for supplier in suppliers:
        supplier_norm = normalize_text(supplier.name)

        # Check if text exactly equals supplier name
        if text_normalized == supplier_norm:
            return (supplier.id, "exact")

        # Check if text exactly equals any alias
        aliases = supplier.aliases or []
        for alias in aliases:
            if text_normalized == normalize_text(alias):
                return (supplier.id, "exact")

    # Second pass: "contains" matches - name/alias found IN text (fuzzy, not exact)
    for supplier in suppliers:
        # Check if supplier name is contained in text
        if supplier.name.upper() in text_upper:
            return (supplier.id, "fuzzy")

        # Check aliases contained in text
        aliases = supplier.aliases or []
        for alias in aliases:
            if alias.upper() in text_upper:
                return (supplier.id, "fuzzy")

        # Check identifier_config keywords
        identifier_config = supplier.identifier_config or {}
        keywords = identifier_config.get("keywords", [])
        for keyword in keywords:
            if keyword.upper() in text_upper:
                return (supplier.id, "fuzzy")

    # Third pass: fuzzy word matching
    # Only do fuzzy matching on vendor name-like text (short text, not full OCR dump)
    # Full OCR text has too many words that could accidentally match
    if len(text) > 500:
        # Text is too long - likely full OCR text, skip fuzzy matching
        return (None, None)

    best_match = None
    best_score = 0.0
    FUZZY_THRESHOLD = 0.6  # Minimum score to consider a fuzzy match

    for supplier in suppliers:
        # Check supplier name fuzzy match
        score = fuzzy_match_score(supplier.name, text)
        if score > best_score and score >= FUZZY_THRESHOLD:
            best_score = score
            best_match = supplier.id

        # Check aliases fuzzy match
        aliases = supplier.aliases or []
        for alias in aliases:
            score = fuzzy_match_score(alias, text)
            if score > best_score and score >= FUZZY_THRESHOLD:
                best_score = score
                best_match = supplier.id

    if best_match:
        return (best_match, "fuzzy")

    return (None, None)


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
