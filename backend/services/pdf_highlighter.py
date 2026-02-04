"""
PDF Highlighter Service

Adds yellow highlight annotations to invoice PDFs for non-stock line items.
Uses Azure OCR bounding region data to position highlights accurately.
Also adds "*NOT KITCHEN STOCK*" labels and optional notes overlay.
"""

import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# Azure Document Intelligence returns coordinates in inches
# PDF coordinates are in points (72 points per inch)
POINTS_PER_INCH = 72

# Standard page width for scaling (US Letter = 612pt, A4 = 595pt)
STANDARD_PAGE_WIDTH = 612

# Header label text and styling (single header for all highlights)
HEADER_LABEL = "** NON KITCHEN STOCK ITEMS HIGHLIGHTED **"
HEADER_FONT_SIZE_BASE = 12  # Base size for standard page width
HEADER_FONT_SIZE_MIN = 12  # Minimum font size (absolute)
HEADER_COLOR = (0.8, 0.0, 0.0)  # Dark red
HEADER_BG_COLOR = (1.0, 1.0, 0.8)  # Light yellow background
HEADER_FONT = "hebo"  # Helvetica Bold

# Notes box styling
NOTES_BOX_COLOR = (1.0, 1.0, 0.8)  # Light yellow background
NOTES_BORDER_COLOR = (0.9, 0.7, 0.0)  # Orange border
NOTES_TEXT_COLOR = (0.2, 0.2, 0.2)  # Dark gray text
NOTES_FONT_SIZE_BASE = 16  # Base size for standard page width (reduced from 18)
NOTES_FONT_SIZE_MIN_BASE = 10  # Minimum base size for scaling
NOTES_FONT_SIZE_MIN_ABSOLUTE = 14  # Absolute minimum font size
NOTES_TITLE = "INVOICE NOTES:"
NOTES_BOX_WIDTH_RATIO = 0.38  # Box width as ratio of page width (reduced from 0.45)
NOTES_BOX_HEIGHT_RATIO = 0.15  # Box height as ratio of page height (reduced from 0.18)
# Minimum sizes for photo-based PDFs (ensures visibility)
NOTES_BOX_MIN_WIDTH = 260  # Minimum width in points
NOTES_BOX_MIN_HEIGHT = 110  # Minimum height in points
NOTES_MAX_LINES = 6  # Allow more lines in larger box


def parse_azure_ocr_line_items(ocr_raw_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Parse Azure Document Intelligence OCR JSON to extract line items with bounding regions.

    Azure OCR format stores line items at:
    documents[0].fields.Items.value[] where each item has:
    - bounding_regions: [{page_number, polygon: [[x,y], ...]}]
    - value.Description.value: description text
    - value.ProductCode.value: product code (optional)

    Args:
        ocr_raw_json: Raw OCR JSON from Azure Document Intelligence

    Returns:
        List of normalized line items with description, product_code, and bounding_regions
    """
    result = []

    try:
        documents = ocr_raw_json.get('documents', [])
        if not documents:
            logger.debug("No documents in OCR JSON")
            return result

        fields = documents[0].get('fields', {})
        items_field = fields.get('Items', {})
        items_list = items_field.get('value', [])

        for item in items_list:
            # Get bounding regions for the whole line item row
            bounding_regions = item.get('bounding_regions', [])

            # Get field values
            item_value = item.get('value', {})

            # Extract description
            description_field = item_value.get('Description', {})
            description = description_field.get('value', '')

            # Extract product code (may not exist)
            product_code_field = item_value.get('ProductCode', {})
            product_code = product_code_field.get('value', '')

            if bounding_regions:
                result.append({
                    'description': description,
                    'product_code': product_code,
                    'bounding_regions': bounding_regions
                })
                logger.debug(f"Parsed OCR item: '{description[:30]}...' with {len(bounding_regions)} regions")

    except Exception as e:
        logger.warning(f"Failed to parse Azure OCR line items: {e}")

    logger.info(f"Parsed {len(result)} line items from Azure OCR data")
    return result


def parse_azure_ocr_key_fields(ocr_raw_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Parse Azure Document Intelligence OCR JSON to extract key invoice fields with bounding regions.

    These are the important fields that should NOT be covered by the notes overlay:
    - VendorName (supplier)
    - InvoiceDate
    - SubTotal (net total)
    - TotalTax
    - InvoiceTotal (gross total)
    - AmountDue

    Args:
        ocr_raw_json: Raw OCR JSON from Azure Document Intelligence

    Returns:
        List of field info with name and bounding_regions
    """
    result = []

    # Key fields that should not be covered
    key_field_names = [
        'VendorName', 'VendorAddress', 'CustomerName', 'CustomerAddress',
        'InvoiceDate', 'DueDate', 'PurchaseOrder',
        'SubTotal', 'TotalTax', 'InvoiceTotal', 'AmountDue',
        'InvoiceId', 'BillingAddress', 'ShippingAddress'
    ]

    try:
        documents = ocr_raw_json.get('documents', [])
        if not documents:
            return result

        fields = documents[0].get('fields', {})

        for field_name in key_field_names:
            field = fields.get(field_name, {})
            bounding_regions = field.get('bounding_regions', [])

            if bounding_regions:
                result.append({
                    'field_name': field_name,
                    'bounding_regions': bounding_regions
                })
                logger.debug(f"Found key OCR field: {field_name} with {len(bounding_regions)} regions")

    except Exception as e:
        logger.warning(f"Failed to parse Azure OCR key fields: {e}")

    logger.debug(f"Parsed {len(result)} key fields from Azure OCR data")
    return result


class PDFHighlighter:
    """Service for adding highlight annotations to PDFs using OCR coordinate data."""

    def __init__(self, pdf_path: str):
        """
        Initialize the highlighter with a PDF file.

        Args:
            pdf_path: Path to the PDF file to annotate
        """
        self.pdf_path = Path(pdf_path)
        if not self.pdf_path.exists():
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")

        self.doc = fitz.open(str(self.pdf_path))
        logger.debug(f"Opened PDF: {pdf_path} ({len(self.doc)} pages)")

    def clear_all_annotations(self) -> int:
        """
        Remove all highlight, FreeText, and Square annotations from the PDF.
        This clears both the yellow highlights and the text labels/notes we add.

        Returns:
            Number of annotations removed
        """
        removed_count = 0

        for page in self.doc:
            # Get all annotations on this page
            annots_to_delete = []
            for annot in page.annots() or []:
                annot_type = annot.type[0]
                # 8 = Highlight, 2 = FreeText (for labels and notes), 4 = Square (for notes box)
                if annot_type in (8, 2, 4):
                    # For FreeText and Square annotations, only delete ones we created (check title)
                    if annot_type in (2, 4):
                        info = annot.info
                        if info.get('title', '') == 'Kitchen Invoice Flash':
                            annots_to_delete.append(annot)
                    else:
                        annots_to_delete.append(annot)

            # Delete the annotations
            for annot in annots_to_delete:
                page.delete_annot(annot)
                removed_count += 1

        if removed_count > 0:
            logger.info(f"Cleared {removed_count} existing annotations")

        return removed_count

    def clear_all_highlights(self) -> int:
        """Alias for backward compatibility."""
        return self.clear_all_annotations()

    def highlight_items_with_ocr_data(
        self,
        ocr_line_items: List[Dict[str, Any]],
        non_stock_line_items: List[Any],
        output_path: str,
        notes: Optional[str] = None,
        ocr_data: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Add yellow highlights to non-stock items using OCR bounding region data.

        This method first clears any existing highlight annotations, then adds
        new highlights for the current non-stock items. This allows highlights
        to be updated when non-stock status changes.

        Args:
            ocr_line_items: Line items from invoice.ocr_raw_json['line_items']
                           Contains 'description', 'product_code', 'bounding_regions'
            non_stock_line_items: Database LineItem objects with is_non_stock=True
            output_path: Path to save the annotated PDF
            notes: Optional invoice notes to overlay on page 1
            ocr_data: Full OCR JSON data (needed for notes overlay positioning)

        Returns:
            Path to the annotated PDF (or original path if highlighting failed)
        """
        # Always clear existing annotations first (allows re-highlighting)
        cleared_count = self.clear_all_highlights()

        highlights_added = 0

        # Add highlights for non-stock items if we have the data
        if non_stock_line_items and ocr_line_items:
            # Match database line items to OCR line items
            matched_items = self._match_line_items(ocr_line_items, non_stock_line_items)

            if matched_items:
                logger.info(f"Matched {len(matched_items)} of {len(non_stock_line_items)} non-stock items to OCR data")

                # Add highlights for each matched item
                for ocr_item in matched_items:
                    bounding_regions = ocr_item.get('bounding_regions', [])

                    for region in bounding_regions:
                        page_number = region.get('page_number', 1) - 1  # PyMuPDF uses 0-based indexing
                        polygon = region.get('polygon', [])

                        if page_number < 0 or page_number >= len(self.doc):
                            logger.warning(f"Invalid page number {page_number + 1} for item")
                            continue

                        if not polygon or len(polygon) < 4:
                            logger.warning(f"Invalid polygon data for item: {ocr_item.get('description', 'Unknown')}")
                            continue

                        try:
                            bbox = self._convert_polygon_to_bbox(polygon, page_number)
                            if bbox:
                                self._add_highlight_annotation(page_number, bbox)
                                highlights_added += 1
                        except Exception as e:
                            logger.warning(f"Failed to add highlight for item: {e}")
                            continue
            else:
                logger.warning("No line items could be matched to OCR data")

        # Add header label if any highlights were added
        if highlights_added > 0:
            self._add_header_label(page_number=0)

        # Add notes overlay on page 1 if provided (independent of highlights)
        notes_added = False
        if notes and ocr_data:
            try:
                notes_added = self.add_notes_overlay(notes, ocr_data, page_number=0)
            except Exception as e:
                logger.warning(f"Failed to add notes overlay: {e}")

        # Save the annotated PDF
        try:
            # When saving to the same file we opened, must use incremental save
            if str(output_path) == str(self.pdf_path):
                self.doc.save(output_path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
            else:
                # Saving to a different file - can use full save with garbage collection
                self.doc.save(output_path, garbage=4, deflate=True)
            logger.info(f"Saved PDF: {highlights_added} highlights, notes={'yes' if notes_added else 'no'}, cleared={cleared_count}")
            return output_path
        except Exception as e:
            logger.error(f"Failed to save annotated PDF: {e}")
            return str(self.pdf_path)
        finally:
            try:
                if self.doc and not self.doc.is_closed:
                    self.doc.close()
            except:
                pass

    def _match_line_items(
        self,
        ocr_items: List[Dict[str, Any]],
        db_items: List[Any]
    ) -> List[Dict[str, Any]]:
        """
        Match database line items to OCR line items by description or product code.

        Args:
            ocr_items: Line items from OCR JSON with bounding_regions
            db_items: Database LineItem objects

        Returns:
            List of matched OCR items (with bounding regions)
        """
        matched = []

        for db_item in db_items:
            db_description = (db_item.description or '').lower().strip()
            db_product_code = (db_item.product_code or '').lower().strip()

            best_match = None
            best_score = 0

            for ocr_item in ocr_items:
                ocr_description = (ocr_item.get('description') or '').lower().strip()
                ocr_product_code = (ocr_item.get('product_code') or '').lower().strip()

                # Skip if no bounding regions
                if not ocr_item.get('bounding_regions'):
                    continue

                # Try exact description match (highest priority)
                if db_description and ocr_description == db_description:
                    best_match = ocr_item
                    best_score = 100
                    break

                # Try product code match
                if db_product_code and ocr_product_code == db_product_code:
                    if best_score < 90:
                        best_match = ocr_item
                        best_score = 90

                # Try partial description match (description contains or is contained)
                if db_description and ocr_description:
                    if db_description in ocr_description or ocr_description in db_description:
                        if best_score < 80:
                            best_match = ocr_item
                            best_score = 80

                # Try fuzzy match using simple word overlap
                if db_description and ocr_description and best_score < 70:
                    similarity = self._calculate_similarity(db_description, ocr_description)
                    if similarity >= 0.85 and similarity * 100 > best_score:
                        best_match = ocr_item
                        best_score = similarity * 100

            if best_match:
                matched.append(best_match)
                logger.debug(f"Matched '{db_description}' to OCR item with score {best_score}")
            else:
                logger.warning(f"Could not match item: '{db_description}' (code: {db_product_code})")

        return matched

    def _calculate_similarity(self, s1: str, s2: str) -> float:
        """
        Calculate simple word-overlap similarity between two strings.

        Returns:
            Similarity score from 0.0 to 1.0
        """
        if not s1 or not s2:
            return 0.0

        words1 = set(s1.lower().split())
        words2 = set(s2.lower().split())

        if not words1 or not words2:
            return 0.0

        intersection = len(words1 & words2)
        union = len(words1 | words2)

        return intersection / union if union > 0 else 0.0

    def _convert_polygon_to_bbox(
        self,
        polygon: List[List[float]],
        page_number: int
    ) -> Optional[fitz.Rect]:
        """
        Convert Azure OCR polygon coordinates to PyMuPDF Rect.

        Azure returns coordinates in inches from top-left.
        PyMuPDF uses points (72 points per inch) from top-left.

        Args:
            polygon: List of [x, y] coordinate pairs from Azure OCR
            page_number: 0-based page index

        Returns:
            fitz.Rect object for the bounding box, or None if invalid
        """
        if not polygon or len(polygon) < 4:
            return None

        try:
            # Extract x and y coordinates
            x_coords = [p[0] for p in polygon]
            y_coords = [p[1] for p in polygon]

            # Get bounding box in inches
            x0_inches = min(x_coords)
            y0_inches = min(y_coords)
            x1_inches = max(x_coords)
            y1_inches = max(y_coords)

            # Convert inches to points (72 points per inch)
            x0 = x0_inches * POINTS_PER_INCH
            y0 = y0_inches * POINTS_PER_INCH
            x1 = x1_inches * POINTS_PER_INCH
            y1 = y1_inches * POINTS_PER_INCH

            # Create rectangle with some padding for better visibility
            padding = 2  # points
            rect = fitz.Rect(x0 - padding, y0 - padding, x1 + padding, y1 + padding)

            # Validate that rect is within page bounds
            page = self.doc[page_number]
            page_rect = page.rect

            # Clip to page bounds
            rect = rect & page_rect

            if rect.is_empty or rect.is_infinite:
                logger.warning(f"Invalid rect after clipping: {rect}")
                return None

            return rect

        except Exception as e:
            logger.warning(f"Failed to convert polygon to bbox: {e}")
            return None

    def _add_highlight_annotation(
        self,
        page_number: int,
        bbox: fitz.Rect,
        color: Tuple[float, float, float] = (1.0, 1.0, 0.0)  # Yellow
    ):
        """
        Add a highlight annotation to a page at the specified location.

        Args:
            page_number: 0-based page index
            bbox: Rectangle defining the highlight area
            color: RGB color tuple (0.0-1.0 range), defaults to yellow
        """
        page = self.doc[page_number]

        # Create highlight annotation
        highlight = page.add_highlight_annot(bbox)

        # Set highlight color (yellow)
        highlight.set_colors(stroke=color)

        # Set opacity (semi-transparent)
        highlight.set_opacity(0.5)

        # Update to apply changes (no popup/hover text)
        highlight.update()

        logger.debug(f"Added highlight on page {page_number + 1} at {bbox}")

    def _add_header_label(self, page_number: int = 0):
        """
        Add a single header label in the top-left corner of the page.
        This replaces individual per-item labels with one prominent header.
        Font size and dimensions scale based on page width for consistent appearance
        on both standard PDFs and photo-based PDFs.

        Args:
            page_number: Page to add the header to (0-indexed, default first page)
        """
        if page_number >= len(self.doc):
            return

        page = self.doc[page_number]
        page_rect = page.rect

        # Calculate scale factor based on page width
        # Photo-based PDFs are often much larger (e.g., 2480pt vs 612pt for standard)
        scale_factor = page_rect.width / STANDARD_PAGE_WIDTH

        # Scale font size with minimum enforcement
        font_size = max(HEADER_FONT_SIZE_MIN, int(HEADER_FONT_SIZE_BASE * scale_factor))
        margin = max(15, int(15 * scale_factor))

        logger.debug(f"Header: page width={page_rect.width:.0f}pt, scale={scale_factor:.2f}, font={font_size}pt")
        border_width = max(2, int(2 * scale_factor))

        # Calculate header dimensions - use generous width for bold text
        label_width = len(HEADER_LABEL) * font_size * 0.65
        label_height = font_size + int(10 * scale_factor)

        # Position in top-left with scaled margin
        label_x = margin
        label_y = margin

        # Create header rectangle with background (add padding)
        padding = int(10 * scale_factor)
        label_rect = fitz.Rect(label_x, label_y, label_x + label_width + padding, label_y + label_height)

        # Add background box (Square annotation for visible background)
        bg_annot = page.add_rect_annot(label_rect)
        bg_annot.set_colors(stroke=HEADER_COLOR, fill=HEADER_BG_COLOR)
        bg_annot.set_border(width=border_width)
        bg_annot.set_info(title="Kitchen Invoice Flash")
        bg_annot.update()

        # Add text annotation on top - use full width
        text_padding = int(5 * scale_factor)
        text_rect = fitz.Rect(label_x + text_padding, label_y + 2, label_x + label_width + text_padding, label_y + label_height - 2)
        text_annot = page.add_freetext_annot(
            text_rect,
            HEADER_LABEL,
            fontsize=font_size,
            fontname=HEADER_FONT,
            text_color=HEADER_COLOR,
            fill_color=None,
            border_color=None,
            align=fitz.TEXT_ALIGN_CENTER
        )
        text_annot.set_info(title="Kitchen Invoice Flash")
        text_annot.update()

        logger.debug(f"Added header label on page {page_number + 1} (scale: {scale_factor:.2f}, font: {font_size}pt)")

    def add_notes_overlay(
        self,
        notes: str,
        ocr_data: Dict[str, Any],
        page_number: int = 0
    ) -> bool:
        """
        Add a notes box overlay on a page in a clear spot.
        Uses OCR data to find an area that doesn't overlap with existing content.

        Args:
            notes: The notes text to display
            ocr_data: Full OCR JSON data containing page/content information
            page_number: Page to add notes to (0-indexed, default first page)

        Returns:
            True if notes were added successfully, False otherwise
        """
        if not notes or not notes.strip():
            return False

        if page_number >= len(self.doc):
            logger.warning(f"Page {page_number} doesn't exist, skipping notes overlay")
            return False

        page = self.doc[page_number]
        page_rect = page.rect

        # Find a clear spot for the notes box
        clear_rect = self._find_clear_spot(page, ocr_data, page_number)

        if not clear_rect:
            logger.warning("Could not find a clear spot for notes overlay")
            return False

        # Draw the notes box
        self._draw_notes_box(page, clear_rect, notes)
        logger.info(f"Added notes overlay on page {page_number + 1} at {clear_rect}")
        return True

    def _find_clear_spot(
        self,
        page: fitz.Page,
        ocr_data: Dict[str, Any],
        page_number: int
    ) -> Optional[fitz.Rect]:
        """
        Find a clear rectangular area on the page that doesn't overlap with content.

        Uses both PyMuPDF's native text extraction AND Azure OCR key field bounding
        regions to ensure we don't cover important invoice data like supplier name,
        date, net total, gross total, etc.

        Box dimensions scale proportionally with page size for consistent appearance
        on both standard PDFs and photo-based PDFs.

        Args:
            page: The PDF page
            ocr_data: Full OCR JSON data with key field bounding regions
            page_number: 0-indexed page number

        Returns:
            A fitz.Rect for the clear area, or None if no suitable spot found
        """
        page_rect = page.rect

        # Calculate box size as ratio of page dimensions with minimum enforcement
        # This ensures consistent proportions but also visibility on photo-based PDFs
        box_width = max(NOTES_BOX_MIN_WIDTH, page_rect.width * NOTES_BOX_WIDTH_RATIO)
        box_height = max(NOTES_BOX_MIN_HEIGHT, page_rect.height * NOTES_BOX_HEIGHT_RATIO)

        # Scale factor for margins based on page width
        scale_factor = page_rect.width / STANDARD_PAGE_WIDTH
        margin = max(15, int(15 * scale_factor))

        # Use PyMuPDF's native text extraction to find occupied areas
        # This is more accurate than OCR JSON data for native PDFs
        occupied_rects = self._get_text_regions_from_pdf(page)

        # Also add key invoice field regions from Azure OCR data
        # This ensures we don't cover important fields like supplier, date, totals
        if ocr_data:
            key_fields = parse_azure_ocr_key_fields(ocr_data)
            for field in key_fields:
                for region in field.get('bounding_regions', []):
                    # Only add regions on the current page
                    if region.get('page_number', 1) - 1 == page_number:
                        polygon = region.get('polygon', [])
                        if polygon and len(polygon) >= 4:
                            rect = self._polygon_to_rect(polygon)
                            if rect and not rect.is_empty:
                                # Add padding around key fields to ensure they're not covered
                                padding = 10 * scale_factor
                                padded_rect = fitz.Rect(
                                    rect.x0 - padding, rect.y0 - padding,
                                    rect.x1 + padding, rect.y1 + padding
                                )
                                occupied_rects.append(padded_rect)
                                logger.debug(f"Added OCR key field '{field['field_name']}' to occupied regions")

        # For very wide pages (scans, landscape), constrain to visible area
        # Scale the max visible width proportionally
        max_visible_width = min(page_rect.width, 850 * scale_factor)
        logger.debug(f"Page dimensions: {page_rect.width}x{page_rect.height}, box size: {box_width:.0f}x{box_height:.0f}, scale: {scale_factor:.2f}")

        # Candidate positions to try (in order of preference)
        # Bottom of page is usually safest for invoices
        candidates = [
            # Bottom-right corner (safest - most invoices have space here)
            (max_visible_width - box_width - margin, page_rect.height - box_height - margin),
            # Bottom-left corner
            (margin, page_rect.height - box_height - margin),
            # Top-right corner within visible area
            (max_visible_width - box_width - margin, margin),
            # Top-left corner
            (margin, margin),
            # Middle-right edge
            (max_visible_width - box_width - margin, page_rect.height / 2 - box_height / 2),
        ]

        # Scale overlap threshold based on page size
        overlap_threshold = 100 * scale_factor * scale_factor  # Area scales with square of linear scale

        for x0, y0 in candidates:
            candidate_rect = fitz.Rect(x0, y0, x0 + box_width, y0 + box_height)

            # Check if this candidate overlaps with any text region
            overlap_found = False
            for occupied in occupied_rects:
                intersection = candidate_rect & occupied
                if not intersection.is_empty:
                    # Any overlap with text is bad
                    overlap_area = intersection.width * intersection.height
                    if overlap_area > overlap_threshold:
                        overlap_found = True
                        logger.debug(f"Candidate at ({x0:.0f}, {y0:.0f}) overlaps with text at {occupied}")
                        break

            if not overlap_found:
                logger.info(f"Found clear spot for notes at ({x0:.0f}, {y0:.0f}), size {box_width:.0f}x{box_height:.0f}")
                return candidate_rect

        # If no clear spot found, use bottom-right as last resort
        logger.warning("No clear spot found, using bottom-right corner")
        return fitz.Rect(max_visible_width - box_width - margin, page_rect.height - box_height - margin,
                         max_visible_width - margin, page_rect.height - margin)

    def _get_text_regions_from_pdf(self, page: fitz.Page) -> List[fitz.Rect]:
        """
        Extract text block regions directly from the PDF using PyMuPDF.

        This is more accurate than OCR JSON because it reads the actual
        text layer embedded in the PDF (if any).

        Args:
            page: The PDF page

        Returns:
            List of fitz.Rect objects representing text areas
        """
        occupied = []

        try:
            # Get text blocks - each block is (x0, y0, x1, y1, text, block_no, block_type)
            # block_type: 0 = text, 1 = image
            blocks = page.get_text("blocks")

            for block in blocks:
                x0, y0, x1, y1 = block[:4]
                block_type = block[6] if len(block) > 6 else 0

                # Include both text blocks (0) and image blocks (1)
                rect = fitz.Rect(x0, y0, x1, y1)
                if not rect.is_empty and rect.width > 5 and rect.height > 5:
                    occupied.append(rect)

            # Also get image areas (in case the invoice is a scanned image)
            for img in page.get_images():
                try:
                    img_rect = page.get_image_rects(img[0])
                    if img_rect:
                        for rect in img_rect:
                            if not rect.is_empty:
                                occupied.append(rect)
                except Exception:
                    pass

        except Exception as e:
            logger.warning(f"Error extracting text regions from PDF: {e}")

        return occupied

    def _polygon_to_rect(self, polygon: List[List[float]]) -> Optional[fitz.Rect]:
        """Convert a polygon (list of [x, y] pairs in inches) to a fitz.Rect in points."""
        if not polygon or len(polygon) < 4:
            return None
        try:
            x_coords = [p[0] for p in polygon]
            y_coords = [p[1] for p in polygon]
            return fitz.Rect(
                min(x_coords) * POINTS_PER_INCH,
                min(y_coords) * POINTS_PER_INCH,
                max(x_coords) * POINTS_PER_INCH,
                max(y_coords) * POINTS_PER_INCH
            )
        except Exception:
            return None

    def _draw_notes_box(self, page: fitz.Page, rect: fitz.Rect, notes: str):
        """
        Draw a notes box with title and text content using Square annotation + text.
        Square annotation with fill provides reliable background rendering.
        Font size is adaptive - starts large and reduces if content doesn't fit.
        All sizes scale based on page dimensions for consistent appearance.

        Args:
            page: The PDF page
            rect: Rectangle defining the box area
            notes: The notes text to display
        """
        page_rect = page.rect

        # Calculate scale factor based on page width
        scale_factor = page_rect.width / STANDARD_PAGE_WIDTH

        # Scale font sizes with absolute minimum enforcement
        font_size_target = max(NOTES_FONT_SIZE_MIN_ABSOLUTE, int(NOTES_FONT_SIZE_BASE * scale_factor))
        font_size_min = max(NOTES_FONT_SIZE_MIN_ABSOLUTE, int(NOTES_FONT_SIZE_MIN_BASE * scale_factor))

        logger.debug(f"Notes box: page width={page_rect.width:.0f}pt, scale={scale_factor:.2f}, target font={font_size_target}pt")

        # Scale padding and spacing
        padding = int(10 * scale_factor)
        border_width = max(2, int(2 * scale_factor))

        # Find the best font size that allows content to fit
        font_size = font_size_target
        max_width = rect.width - padding
        box_height = rect.height

        while font_size >= font_size_min:
            # Calculate chars per line at this font size
            chars_per_line = int(max_width / (font_size * 0.55))

            # Calculate line height (font size + scaled spacing)
            line_height = font_size + int(4 * scale_factor)
            title_height = font_size + int(12 * scale_factor)  # Title takes more space

            # Available height for notes text
            available_text_height = box_height - title_height - padding
            max_lines = int(available_text_height / line_height)

            # Word wrap with current settings
            words = notes.split()
            lines = []
            current_line = ""
            for word in words:
                test_line = f"{current_line} {word}".strip() if current_line else word
                if len(test_line) <= chars_per_line:
                    current_line = test_line
                else:
                    if current_line:
                        lines.append(current_line)
                    current_line = word
            if current_line:
                lines.append(current_line)

            # Check if content fits
            if len(lines) <= max_lines:
                break  # Good fit at this font size

            # Try smaller font (decrement scales with page size)
            font_size -= max(2, int(2 * scale_factor))

        # Use minimum font size if we exhausted all options
        if font_size < font_size_min:
            font_size = font_size_min
            chars_per_line = int(max_width / (font_size * 0.55))
            line_height = font_size + int(4 * scale_factor)
            title_height = font_size + int(12 * scale_factor)
            available_text_height = box_height - title_height - padding
            max_lines = int(available_text_height / line_height)

            # Re-wrap at minimum font size
            words = notes.split()
            lines = []
            current_line = ""
            for word in words:
                test_line = f"{current_line} {word}".strip() if current_line else word
                if len(test_line) <= chars_per_line:
                    current_line = test_line
                else:
                    if current_line:
                        lines.append(current_line)
                    current_line = word
            if current_line:
                lines.append(current_line)

        # Limit lines to fit in box
        lines = lines[:max_lines]
        if len(notes.split()) > sum(len(line.split()) for line in lines):
            if lines:
                lines[-1] = lines[-1][:max(0, chars_per_line - 3)] + "..."

        # Create Square annotation for the background box (more reliable than FreeText fill)
        box_annot = page.add_rect_annot(rect)
        box_annot.set_colors(stroke=NOTES_BORDER_COLOR, fill=NOTES_BOX_COLOR)
        box_annot.set_border(width=border_width)
        box_annot.set_info(title="Kitchen Invoice Flash")
        box_annot.update()

        # Scale text padding
        text_padding = int(5 * scale_factor)
        title_spacing = int(8 * scale_factor)

        # Add title text as FreeText annotation
        title_rect = fitz.Rect(rect.x0 + text_padding, rect.y0 + int(3 * scale_factor), rect.x1 - text_padding, rect.y0 + font_size + title_spacing)
        title_annot = page.add_freetext_annot(
            title_rect,
            NOTES_TITLE,
            fontsize=font_size + 1,
            fontname="hebo",  # Bold title
            text_color=(0.6, 0.3, 0.0),  # Dark orange for title
            fill_color=None,
            border_color=None,
            align=fitz.TEXT_ALIGN_LEFT
        )
        title_annot.set_info(title="Kitchen Invoice Flash")
        title_annot.update()

        # Add notes text as FreeText annotation
        text_y = rect.y0 + font_size + int(12 * scale_factor)
        text_rect = fitz.Rect(rect.x0 + text_padding, text_y, rect.x1 - text_padding, rect.y1 - text_padding)
        notes_text = "\n".join(lines)
        notes_annot = page.add_freetext_annot(
            text_rect,
            notes_text,
            fontsize=font_size - 1,
            fontname="helv",
            text_color=NOTES_TEXT_COLOR,
            fill_color=None,
            border_color=None,
            align=fitz.TEXT_ALIGN_LEFT
        )
        notes_annot.set_info(title="Kitchen Invoice Flash")
        notes_annot.update()

        logger.debug(f"Drew notes box at {rect} with {len(lines)} lines at font size {font_size} (target was {font_size_target}, scale: {scale_factor:.2f})")


def highlight_non_stock_items(
    pdf_path: str,
    ocr_line_items: List[Dict[str, Any]],
    non_stock_line_items: List[Any],
    output_path: str
) -> str:
    """
    Convenience function to highlight non-stock items in an invoice PDF.

    Args:
        pdf_path: Path to the original PDF
        ocr_line_items: Line items from invoice.ocr_raw_json['line_items']
        non_stock_line_items: Database LineItem objects with is_non_stock=True
        output_path: Path to save the annotated PDF

    Returns:
        Path to the annotated PDF (or original path if highlighting failed)
    """
    if not non_stock_line_items:
        logger.info("No non-stock items to highlight, returning original")
        return pdf_path

    try:
        highlighter = PDFHighlighter(pdf_path)
        return highlighter.highlight_items_with_ocr_data(
            ocr_line_items=ocr_line_items,
            non_stock_line_items=non_stock_line_items,
            output_path=output_path
        )
    except FileNotFoundError:
        logger.error(f"PDF file not found: {pdf_path}")
        return pdf_path
    except Exception as e:
        logger.error(f"PDF highlighting failed: {e}", exc_info=True)
        return pdf_path
