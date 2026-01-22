# Plan 6: PDF Highlighting for Non-Stock Items in Dext Emails

## Current State

### Existing Dext Integration
**Files:**
- `backend/services/dext.py` - Dext API client
- `backend/services/email_service.py` - Email sending
- Email templates for notifications

Current email functionality:
- Sends plain text email with invoice details
- Lists non-stock items in email body
- Provides link to PDF in Nextcloud
- No highlighting or annotation on PDF itself

**Example current email:**
```
Subject: Invoice Requires Attention - Non-Stock Items Found

Invoice #12345 from ACME Suppliers has 3 non-stock items:

- Garden Peas, Frozen (2.5 kg) - €15.50
- Tomato Sauce, Organic (1 L) - €8.25
- Cleaning Spray (500 ml) - €4.99

Please add these items to your product catalog or link them to existing products.

View Invoice: [Nextcloud Link]
```

## Problem Statement

**User Request:**
> "highlight or embed in the pdf itself not just the email body text"

**Current Limitation:**
- Non-stock items only highlighted in email text
- PDF remains unchanged from Dext
- User must manually find items in PDF
- Time-consuming when PDF has 50+ line items

**Goal:**
Modify the PDF to visually highlight non-stock items before sending email, so users can immediately identify problematic items in the document itself.

## Use Cases

### Use Case 1: Large Multi-Page Invoice
**Scenario:** 100-item invoice with 5 non-stock items scattered across 3 pages

**Current Experience:**
1. Read email listing 5 items
2. Open PDF
3. Manually scan all 100 items to find the 5 mentioned
4. Switch back and forth between email and PDF

**Desired Experience:**
1. Open PDF
2. **Immediately see yellow-highlighted items** on pages 1, 2, and 3
3. Quickly identify and resolve non-stock items

### Use Case 2: Similar Product Names
**Scenario:** Invoice has "Tomatoes, Vine" (in stock) and "Tomatoes, Cherry" (not in stock)

**Current Experience:**
- Email says "Tomatoes, Cherry" not in stock
- PDF has 3 different tomato products
- User must carefully read each tomato line to find "Cherry"

**Desired Experience:**
- PDF shows "Tomatoes, Cherry" with bright yellow highlight
- Instantly distinguishable from other tomato products

## Technical Approaches

### Option A: PDF Annotation (Recommended)

**Concept:** Add highlight annotations directly to PDF using PyPDF2 or reportlab

**Pros:**
- Native PDF feature (annotations)
- Works in all PDF viewers
- Non-destructive (original content preserved)
- Can add notes/comments

**Cons:**
- Complex to position highlights accurately
- Requires text coordinate detection
- May not work with scanned PDFs (OCR needed)

**Libraries:**
- `PyPDF2` / `pypdf` - PDF manipulation
- `pdfplumber` - Text extraction with coordinates
- `reportlab` - PDF generation/modification

### Option B: Render New PDF with Highlights

**Concept:** Extract content, render new PDF with highlighted sections

**Pros:**
- Full control over appearance
- Can add colored boxes, borders, icons
- Works with any PDF structure

**Cons:**
- More complex implementation
- May lose original formatting
- Larger file sizes

**Libraries:**
- `reportlab` - PDF rendering
- `pdf2image` + PIL - Image-based approach

### Option C: Embedded Annotations + Email Summary

**Concept:** Combine PDF annotations with enhanced email (current approach++)

**Pros:**
- Best of both worlds
- Fallback for annotation failures
- Accessible via email even without PDF viewer

**Cons:**
- Most development work
- Redundant information

## Recommended Approach: Option A (PDF Annotation)

Use pdfplumber to find text coordinates and PyPDF2 to add highlight annotations.

## Implementation Plan

### Phase 1: Text Coordinate Detection

#### 1.1 Install Dependencies

**File:** `backend/requirements.txt` (UPDATE)

```txt
# Existing dependencies...

# PDF processing
pdfplumber==0.10.3
pypdf==3.17.4
```

#### 1.2 Create PDF Highlighter Service

**File:** `backend/services/pdf_highlighter.py` (NEW)

```python
import pdfplumber
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, ArrayObject, FloatObject, NameObject
from pathlib import Path
import logging
from typing import List, Dict, Tuple

logger = logging.getLogger(__name__)


class PDFHighlighter:
    """Service for highlighting text in PDF files"""

    def __init__(self, pdf_path: str):
        self.pdf_path = pdf_path
        self.reader = PdfReader(pdf_path)
        self.writer = PdfWriter()

    def highlight_text_items(self, items_to_highlight: List[str], output_path: str) -> str:
        """
        Highlight specific text items in PDF

        Args:
            items_to_highlight: List of text strings to find and highlight
            output_path: Path to save annotated PDF

        Returns:
            Path to annotated PDF
        """

        logger.info(f"Highlighting {len(items_to_highlight)} items in {self.pdf_path}")

        try:
            # Extract text with coordinates using pdfplumber
            text_coordinates = self._extract_text_coordinates(items_to_highlight)

            # Add pages to writer with highlights
            for page_num, page in enumerate(self.reader.pages):
                # Add page to writer
                self.writer.add_page(page)

                # Get highlights for this page
                page_highlights = text_coordinates.get(page_num, [])

                if page_highlights:
                    # Add highlight annotations to page
                    for coords in page_highlights:
                        self._add_highlight_annotation(
                            page_num=page_num,
                            coordinates=coords
                        )

            # Write annotated PDF
            with open(output_path, "wb") as output_file:
                self.writer.write(output_file)

            logger.info(f"Annotated PDF saved to {output_path}")
            return output_path

        except Exception as e:
            logger.error(f"PDF highlighting failed: {e}", exc_info=True)
            # Return original PDF path if highlighting fails
            return self.pdf_path

    def _extract_text_coordinates(self, search_texts: List[str]) -> Dict[int, List[Dict]]:
        """
        Find coordinates of text items in PDF

        Returns:
            Dict mapping page_num -> list of coordinate dicts
        """

        coordinates = {}

        with pdfplumber.open(self.pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages):
                page_coords = []

                # Extract words with bounding boxes
                words = page.extract_words(x_tolerance=3, y_tolerance=3)

                # Search for each item
                for search_text in search_texts:
                    # Normalize text for comparison
                    search_normalized = search_text.lower().strip()

                    # Find matching words
                    matches = []
                    for word in words:
                        word_text = word['text'].lower()

                        if search_normalized in word_text or word_text in search_normalized:
                            matches.append(word)

                    # Group consecutive words into phrases
                    if matches:
                        # Get bounding box for entire phrase
                        x0 = min(w['x0'] for w in matches)
                        x1 = max(w['x1'] for w in matches)
                        y0 = min(w['top'] for w in matches)
                        y1 = max(w['bottom'] for w in matches)

                        # Convert to PDF coordinates (bottom-left origin)
                        page_height = page.height

                        coord = {
                            'x0': x0,
                            'y0': page_height - y1,  # Flip Y coordinate
                            'x1': x1,
                            'y1': page_height - y0,
                            'text': search_text
                        }

                        page_coords.append(coord)
                        logger.debug(f"Found '{search_text}' on page {page_num} at {coord}")

                if page_coords:
                    coordinates[page_num] = page_coords

        return coordinates

    def _add_highlight_annotation(self, page_num: int, coordinates: Dict):
        """
        Add highlight annotation to page

        Args:
            page_num: Page index
            coordinates: Dict with x0, y0, x1, y1 coordinates
        """

        page = self.writer.pages[page_num]

        # Create highlight annotation
        highlight = DictionaryObject()
        highlight.update({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Highlight"),
            NameObject("/Rect"): ArrayObject([
                FloatObject(coordinates['x0'] - 2),  # Add padding
                FloatObject(coordinates['y0'] - 2),
                FloatObject(coordinates['x1'] + 2),
                FloatObject(coordinates['y1'] + 2)
            ]),
            NameObject("/C"): ArrayObject([
                FloatObject(1.0),   # Red
                FloatObject(1.0),   # Green
                FloatObject(0.0)    # Blue -> Yellow
            ]),
            NameObject("/CA"): FloatObject(0.5),  # 50% transparency
            NameObject("/T"): "Kitchen Invoice Flash",  # Author
            NameObject("/Contents"): "Non-stock item - requires product mapping"
        })

        # Add to page annotations
        if "/Annots" in page:
            page[NameObject("/Annots")].append(highlight)
        else:
            page[NameObject("/Annots")] = ArrayObject([highlight])


def highlight_non_stock_items_in_pdf(
    original_pdf_path: str,
    non_stock_items: List[Dict],
    output_path: str
) -> str:
    """
    Convenience function to highlight non-stock items in invoice PDF

    Args:
        original_pdf_path: Path to original PDF
        non_stock_items: List of dicts with 'description' key
        output_path: Path to save annotated PDF

    Returns:
        Path to annotated PDF (or original if highlighting fails)

    Example:
        non_stock_items = [
            {"description": "Garden Peas, Frozen", "quantity": 2.5},
            {"description": "Tomato Sauce, Organic", "quantity": 1.0}
        ]
        highlighted_path = highlight_non_stock_items_in_pdf(
            "/app/pdfs/invoice_123.pdf",
            non_stock_items,
            "/app/pdfs/invoice_123_highlighted.pdf"
        )
    """

    if not non_stock_items:
        logger.info("No non-stock items to highlight")
        return original_pdf_path

    try:
        highlighter = PDFHighlighter(original_pdf_path)

        # Extract item descriptions
        items_to_highlight = [item['description'] for item in non_stock_items]

        # Create highlighted PDF
        return highlighter.highlight_text_items(items_to_highlight, output_path)

    except Exception as e:
        logger.error(f"Failed to create highlighted PDF: {e}", exc_info=True)
        return original_pdf_path
```

### Phase 2: Integration with Dext Processing

#### 2.1 Update Dext Service

**File:** `backend/services/dext.py` (UPDATE)

Modify invoice processing to generate highlighted PDF:

```python
from services.pdf_highlighter import highlight_non_stock_items_in_pdf

async def process_invoice_with_highlighting(invoice_data: dict, pdf_path: str) -> dict:
    """
    Process invoice and create highlighted PDF if non-stock items found

    Returns:
        dict with processing results including highlighted_pdf_path
    """

    # Existing invoice processing logic...
    line_items = extract_line_items(invoice_data)

    # Identify non-stock items
    non_stock_items = []
    for item in line_items:
        product = await find_matching_product(item['description'], db)

        if not product:
            non_stock_items.append({
                'description': item['description'],
                'quantity': item['quantity'],
                'total': item['total']
            })

    # Create highlighted PDF if non-stock items exist
    highlighted_pdf_path = pdf_path  # Default to original

    if non_stock_items:
        output_path = pdf_path.replace('.pdf', '_highlighted.pdf')

        highlighted_pdf_path = highlight_non_stock_items_in_pdf(
            original_pdf_path=pdf_path,
            non_stock_items=non_stock_items,
            output_path=output_path
        )

        logger.info(f"Created highlighted PDF with {len(non_stock_items)} items marked")

    return {
        'line_items': line_items,
        'non_stock_items': non_stock_items,
        'original_pdf_path': pdf_path,
        'highlighted_pdf_path': highlighted_pdf_path,
        'has_highlights': highlighted_pdf_path != pdf_path
    }
```

### Phase 3: Update Email Service

#### 3.1 Attach Highlighted PDF to Email

**File:** `backend/services/email_service.py` (UPDATE)

```python
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

async def send_non_stock_items_alert(
    recipient_email: str,
    invoice_number: str,
    supplier_name: str,
    non_stock_items: List[Dict],
    highlighted_pdf_path: str,
    nextcloud_link: str
):
    """
    Send email alert with highlighted PDF attached

    Args:
        recipient_email: Recipient email address
        invoice_number: Invoice number
        supplier_name: Supplier name
        non_stock_items: List of non-stock items
        highlighted_pdf_path: Path to PDF with highlights
        nextcloud_link: Link to PDF in Nextcloud
    """

    # Create multipart message
    msg = MIMEMultipart()
    msg['From'] = os.getenv('EMAIL_FROM', 'noreply@kitchen-invoice-flash.com')
    msg['To'] = recipient_email
    msg['Subject'] = f"⚠️ Invoice #{invoice_number} - Non-Stock Items Highlighted"

    # Email body (HTML for better formatting)
    html_body = f"""
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2 style="color: #d97706;">⚠️ Invoice Requires Attention</h2>

        <p>
            Invoice <strong>#{invoice_number}</strong> from <strong>{supplier_name}</strong>
            contains <strong>{len(non_stock_items)}</strong> non-stock item(s).
        </p>

        <div style="background: #fef3c7; padding: 15px; border-left: 4px solid #f59e0b; margin: 20px 0;">
            <p style="margin: 0; font-weight: bold; color: #92400e;">
                📄 The attached PDF has been annotated with <span style="background: yellow; padding: 2px 6px;">yellow highlights</span>
                to help you quickly locate these items.
            </p>
        </div>

        <h3>Non-Stock Items:</h3>
        <ul>
            {"".join(f'<li><strong>{item["description"]}</strong> - {item["quantity"]} × €{item.get("unit_price", 0):.2f} = €{item["total"]:.2f}</li>' for item in non_stock_items)}
        </ul>

        <h3>Next Steps:</h3>
        <ol>
            <li>Open the attached PDF (highlights visible in any PDF viewer)</li>
            <li>Review each highlighted item</li>
            <li>Add new products to catalog OR link to existing products</li>
            <li>Re-process invoice once products are mapped</li>
        </ol>

        <p style="margin-top: 30px;">
            <a href="{nextcloud_link}" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                View Invoice in Nextcloud
            </a>
        </p>

        <hr style="margin-top: 30px; border: none; border-top: 1px solid #e5e7eb;">
        <p style="font-size: 0.9em; color: #6b7280;">
            Generated by Kitchen Invoice Flash<br>
            <em>Tip: Use Ctrl+F in the PDF to search for highlighted items if you have many pages.</em>
        </p>
    </body>
    </html>
    """

    msg.attach(MIMEText(html_body, 'html'))

    # Attach highlighted PDF
    if os.path.exists(highlighted_pdf_path):
        with open(highlighted_pdf_path, 'rb') as pdf_file:
            pdf_attachment = MIMEApplication(pdf_file.read(), _subtype="pdf")
            pdf_attachment.add_header(
                'Content-Disposition',
                'attachment',
                filename=f'invoice_{invoice_number}_highlighted.pdf'
            )
            msg.attach(pdf_attachment)

        logger.info(f"Attached highlighted PDF: {highlighted_pdf_path}")
    else:
        logger.warning(f"Highlighted PDF not found: {highlighted_pdf_path}")

    # Send email
    await send_email(msg)
```

### Phase 4: Testing & Validation

#### 4.1 Unit Tests

**File:** `backend/tests/test_pdf_highlighter.py` (NEW)

```python
import pytest
from services.pdf_highlighter import PDFHighlighter, highlight_non_stock_items_in_pdf
import pdfplumber


def test_highlight_single_item(sample_pdf_path):
    """Test highlighting a single item"""

    output_path = "/tmp/test_highlighted.pdf"

    highlighter = PDFHighlighter(sample_pdf_path)
    result_path = highlighter.highlight_text_items(
        items_to_highlight=["Garden Peas"],
        output_path=output_path
    )

    assert os.path.exists(result_path)

    # Verify annotation exists
    reader = PdfReader(result_path)
    page = reader.pages[0]

    assert "/Annots" in page
    assert len(page["/Annots"]) > 0

    # Check annotation type
    annot = page["/Annots"][0].get_object()
    assert annot["/Subtype"] == "/Highlight"


def test_highlight_multiple_items_across_pages(multi_page_pdf):
    """Test highlighting items on different pages"""

    items = [
        "Item on Page 1",
        "Item on Page 2",
        "Item on Page 3"
    ]

    output_path = "/tmp/test_multi_page.pdf"

    highlighter = PDFHighlighter(multi_page_pdf)
    result_path = highlighter.highlight_text_items(items, output_path)

    reader = PdfReader(result_path)

    # Verify each page has annotations
    for page_num in range(3):
        page = reader.pages[page_num]
        assert "/Annots" in page


def test_highlight_non_existent_text(sample_pdf_path):
    """Test highlighting text that doesn't exist in PDF"""

    output_path = "/tmp/test_no_match.pdf"

    highlighter = PDFHighlighter(sample_pdf_path)
    result_path = highlighter.highlight_text_items(
        items_to_highlight=["NonExistentItem12345"],
        output_path=output_path
    )

    # Should still create output, just without highlights
    assert os.path.exists(result_path)


def test_highlight_with_special_characters(sample_pdf_path):
    """Test highlighting items with special characters"""

    items = [
        "Tomato Sauce, Organic (1L)",
        "Cheese - Parmesan, Grated"
    ]

    output_path = "/tmp/test_special_chars.pdf"

    result_path = highlight_non_stock_items_in_pdf(
        original_pdf_path=sample_pdf_path,
        non_stock_items=[
            {"description": item, "quantity": 1.0}
            for item in items
        ],
        output_path=output_path
    )

    assert os.path.exists(result_path)


def test_highlight_fallback_on_error(corrupted_pdf_path):
    """Test that errors fall back to original PDF"""

    output_path = "/tmp/test_fallback.pdf"

    result_path = highlight_non_stock_items_in_pdf(
        original_pdf_path=corrupted_pdf_path,
        non_stock_items=[{"description": "Item", "quantity": 1}],
        output_path=output_path
    )

    # Should return original path if highlighting fails
    assert result_path == corrupted_pdf_path
```

#### 4.2 Integration Test

**Manual test procedure:**

1. **Prepare Test Invoice**
   - Get sample invoice PDF with 10+ line items
   - Identify 3-5 items to mark as "non-stock"

2. **Trigger Processing**
   ```bash
   # Upload invoice via Dext
   # Or manually trigger processing
   curl -X POST http://localhost:8000/api/invoices/process \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"invoice_id": 123}'
   ```

3. **Verify Highlighted PDF**
   - Download highlighted PDF from email attachment
   - Open in Adobe Acrobat, Preview, or Chrome
   - Verify yellow highlights visible on non-stock items
   - Check highlights are positioned correctly (not covering text)

4. **Test in Multiple PDF Viewers**
   - Adobe Acrobat Reader
   - macOS Preview
   - Google Chrome (built-in PDF viewer)
   - Firefox PDF viewer
   - Mobile PDF viewers (iOS, Android)

5. **Test Edge Cases**
   - Very long product names (>100 characters)
   - Multi-line item descriptions
   - Items with special characters (é, ñ, ü)
   - Scanned PDFs (may not work - expected behavior)

### Phase 5: Error Handling & Fallbacks

#### 5.1 Graceful Degradation

**Scenarios where highlighting might fail:**

1. **Scanned PDF (Image-based)**
   - No extractable text
   - Solution: OCR first, or skip highlighting

2. **Encrypted/Protected PDF**
   - Cannot modify
   - Solution: Use original PDF, note in email

3. **Corrupted PDF**
   - pdfplumber fails
   - Solution: Fallback to original

4. **Text Not Found**
   - Item description doesn't exactly match PDF text
   - Solution: Try fuzzy matching, or skip specific item

**Implementation:**

```python
def highlight_with_fallback(pdf_path: str, items: List[str], output_path: str) -> Tuple[str, List[str]]:
    """
    Highlight PDF with robust error handling

    Returns:
        (path_to_pdf, list_of_errors)
    """

    errors = []

    try:
        # Attempt highlighting
        result = highlight_non_stock_items_in_pdf(pdf_path, items, output_path)

        if result == pdf_path:
            errors.append("Highlighting failed, using original PDF")

        return result, errors

    except Exception as e:
        logger.error(f"Highlighting error: {e}")
        errors.append(f"Could not highlight PDF: {str(e)}")
        return pdf_path, errors
```

### Phase 6: UI Enhancements

#### 6.1 Show Highlight Status in Invoice List

**File:** `frontend/src/pages/Invoices.tsx` (UPDATE)

Add indicator for invoices with highlights:

```typescript
{invoice.has_highlighted_pdf && (
  <span style={styles.highlightBadge} title="PDF contains highlighted non-stock items">
    🟡 Highlighted
  </span>
)}
```

#### 6.2 Download Both Versions

Provide option to download original and highlighted versions:

```typescript
<div style={styles.downloadButtons}>
  <a href={invoice.pdf_url} download>
    📄 Download Original PDF
  </a>
  {invoice.highlighted_pdf_url && (
    <a href={invoice.highlighted_pdf_url} download>
      🟡 Download Highlighted PDF
    </a>
  )}
</div>
```

## Success Criteria

✅ Non-stock items highlighted in yellow in PDF
✅ Highlights visible in all major PDF viewers
✅ Email attaches highlighted PDF (not just link)
✅ Original PDF preserved (both versions available)
✅ Fallback to original PDF if highlighting fails
✅ Highlights positioned accurately on item descriptions
✅ Works with multi-page invoices
✅ Email explains highlights feature
✅ Processing time <5 seconds for highlighting

## Testing Checklist

- [ ] Single item highlighted on page 1
- [ ] Multiple items highlighted across multiple pages
- [ ] Very long product names (>80 chars)
- [ ] Special characters in item names (é, ñ, £, €)
- [ ] 50+ item invoice with 10 non-stock items
- [ ] Scanned PDF (should gracefully fail)
- [ ] PDF with complex layout (tables, multi-column)
- [ ] Email received with attachment
- [ ] Highlights visible in Adobe Acrobat
- [ ] Highlights visible in Chrome PDF viewer
- [ ] Highlights visible on mobile (iOS/Android)

## Performance Considerations

**Expected Processing Times:**
- Text extraction: 0.5-2 seconds per page
- Annotation creation: 0.1 seconds per item
- PDF writing: 0.5-1 second

**Total:** 2-5 seconds for typical invoice (3 pages, 5 non-stock items)

**Optimization:**
- Cache text extraction results
- Batch process annotations
- Async processing (don't block email)

## Limitations & Future Enhancements

### Current Limitations

1. **Text-Based PDFs Only**
   - Scanned PDFs without OCR won't work
   - Need OCR preprocessing for image-based invoices

2. **Exact Text Matching**
   - Item description must match PDF text closely
   - Punctuation/spacing differences may cause misses

3. **Fixed Highlight Color**
   - Always yellow, not customizable

### Future Enhancements

1. **OCR Integration**
   - Use Tesseract to OCR scanned PDFs
   - Enable highlighting on image-based documents

2. **Smart Text Matching**
   - Fuzzy matching with fuzzywuzzy
   - Handle abbreviations and variations

3. **Customizable Highlights**
   - Color coding by category (red=critical, yellow=review, green=optional)
   - Different styles for different issue types

4. **Interactive PDF**
   - Clickable highlights link to product catalog search
   - Embedded forms for quick product mapping

5. **AI-Powered Annotation**
   - Use LLM to suggest product matches
   - Add sticky notes with mapping recommendations

6. **Highlight Dashboard**
   - Track highlight accuracy
   - Learn from user corrections
   - Improve matching algorithm over time
