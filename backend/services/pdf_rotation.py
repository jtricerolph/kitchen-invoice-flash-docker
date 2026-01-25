"""
PDF Rotation Service

Handles rotation of PDF pages based on Azure OCR angle data and transforms
OCR coordinates to match the corrected orientation.

This should be called as the FIRST post-processing step after Azure returns,
before any other processing extracts data from raw_json.
"""
import fitz  # PyMuPDF
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def normalize_angle(angle: Optional[float]) -> int:
    """
    Round angle to nearest 90 degrees (0, 90, 180, 270).

    Azure returns angle in degrees that content is rotated clockwise.
    """
    if angle is None:
        return 0
    # Normalize to 0-360 range
    normalized = ((angle % 360) + 360) % 360
    # Round to nearest 90 degrees
    return round(normalized / 90) * 90 % 360


def transform_polygon(polygon: list, rotation: int, page_width: float, page_height: float) -> list:
    """
    Transform polygon coordinates based on rotation.

    The rotation indicates how much the content was rotated clockwise.
    We need to transform coordinates as if we're rotating them counter-clockwise
    (to match the corrected page orientation).

    Args:
        polygon: List of [x, y] coordinate pairs in inches
        rotation: 90, 180, or 270 degrees
        page_width: Original page width in inches (before rotation)
        page_height: Original page height in inches (before rotation)

    Returns:
        Transformed polygon with coordinates adjusted for rotation
    """
    transformed = []
    for point in polygon:
        x, y = point[0], point[1]

        if rotation == 90:
            # Content rotated 90° CW means we rotate coords 90° CCW to match corrected PDF
            # (x, y) -> (y, width - x)
            new_x = y
            new_y = page_width - x
        elif rotation == 180:
            # Content rotated 180° means we rotate coords 180° to match
            # (x, y) -> (width - x, height - y)
            new_x = page_width - x
            new_y = page_height - y
        elif rotation == 270:
            # Content rotated 270° CW (or 90° CCW) means we rotate coords 90° CW to match
            # (x, y) -> (height - y, x)
            new_x = page_height - y
            new_y = x
        else:
            new_x, new_y = x, y

        transformed.append([new_x, new_y])

    return transformed


def transform_bounding_regions(regions: list, rotation: int, page_width: float, page_height: float) -> list:
    """Transform bounding regions for a rotated page."""
    for region in regions:
        if 'polygon' in region:
            region['polygon'] = transform_polygon(
                region['polygon'],
                rotation,
                page_width,
                page_height
            )
    return regions


def transform_fields_coordinates(fields: dict, rotations: dict[int, int], pages: list):
    """
    Recursively transform bounding regions in fields.

    Args:
        fields: Dictionary of field name -> field data
        rotations: Dictionary of page_number -> rotation angle
        pages: List of page info dictionaries (with original dimensions)
    """
    for field_name, field_data in fields.items():
        if not isinstance(field_data, dict):
            continue

        # Get page info for this field
        page_num = 1
        if 'bounding_regions' in field_data and field_data['bounding_regions']:
            page_num = field_data['bounding_regions'][0].get('page_number', 1)

        rotation = rotations.get(page_num, 0)
        if rotation != 0:
            page_info = next((p for p in pages if p.get('page_number') == page_num), None)
            if page_info and 'bounding_regions' in field_data:
                transform_bounding_regions(
                    field_data['bounding_regions'],
                    rotation,
                    page_info.get('width', 8.5),
                    page_info.get('height', 11)
                )

        # Recurse into nested value
        if 'value' in field_data:
            val = field_data['value']
            if isinstance(val, dict):
                transform_fields_coordinates(val, rotations, pages)
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, dict):
                        # Handle bounding_regions at item level
                        item_page = 1
                        if 'bounding_regions' in item and item['bounding_regions']:
                            item_page = item['bounding_regions'][0].get('page_number', 1)

                        item_rotation = rotations.get(item_page, 0)
                        if item_rotation != 0 and 'bounding_regions' in item:
                            item_page_info = next((p for p in pages if p.get('page_number') == item_page), None)
                            if item_page_info:
                                transform_bounding_regions(
                                    item['bounding_regions'],
                                    item_rotation,
                                    item_page_info.get('width', 8.5),
                                    item_page_info.get('height', 11)
                                )

                        # Recurse into item value
                        if 'value' in item and isinstance(item['value'], dict):
                            transform_fields_coordinates(item['value'], rotations, pages)


def transform_ocr_coordinates(ocr_json: dict, rotations: dict[int, int]) -> dict:
    """
    Transform all coordinates in OCR JSON based on page rotations.

    Args:
        ocr_json: The raw OCR JSON from Azure
        rotations: Dictionary mapping page_number to rotation angle

    Returns:
        Updated OCR JSON with transformed coordinates
    """
    # Store original dimensions before updating
    original_pages = []
    for page_info in ocr_json.get('pages', []):
        original_pages.append({
            'page_number': page_info.get('page_number', 1),
            'width': page_info.get('width'),
            'height': page_info.get('height')
        })

    # Update page dimensions (swap width/height for 90/270 rotations)
    for page_info in ocr_json.get('pages', []):
        page_num = page_info.get('page_number', 1)
        rotation = rotations.get(page_num, 0)
        if rotation in (90, 270):
            # Swap width and height
            old_width = page_info.get('width')
            old_height = page_info.get('height')
            page_info['width'] = old_height
            page_info['height'] = old_width
            logger.debug(f"Page {page_num}: swapped dimensions {old_width}x{old_height} -> {old_height}x{old_width}")
        # Reset angle to 0 since we've corrected it
        page_info['angle'] = 0

    # Transform bounding regions in documents using ORIGINAL dimensions
    for doc in ocr_json.get('documents', []):
        transform_fields_coordinates(doc.get('fields', {}), rotations, original_pages)

    return ocr_json


def rotate_pdf_pages(pdf_path: str, ocr_raw_json: dict) -> tuple[bool, dict]:
    """
    Rotate PDF pages based on OCR angle data and transform coordinates.

    This should be called immediately after Azure OCR returns, before any
    other post-processing extracts data from raw_json.

    Args:
        pdf_path: Path to the PDF file
        ocr_raw_json: The serialized OCR result containing page angles

    Returns:
        Tuple of (modified: bool, updated_ocr_json: dict)
        - modified: True if any pages were rotated
        - updated_ocr_json: OCR JSON with transformed coordinates
    """
    pages_info = ocr_raw_json.get('pages', [])
    rotations_needed = {}

    # Check which pages need rotation
    for page_info in pages_info:
        page_num = page_info.get('page_number', 1)
        angle = normalize_angle(page_info.get('angle', 0))
        if angle != 0:
            rotations_needed[page_num] = angle

    if not rotations_needed:
        logger.debug("No page rotations needed")
        return False, ocr_raw_json

    logger.info(f"Rotating pages: {rotations_needed}")

    try:
        # Open and rotate PDF
        doc = fitz.open(pdf_path)

        for page_num, rotation in rotations_needed.items():
            page_idx = page_num - 1
            if 0 <= page_idx < len(doc):
                page = doc[page_idx]
                # PyMuPDF set_rotation sets the page's rotation attribute
                # The rotation value corrects for content being rotated
                # If content is at 90° CW, we set rotation to 90 to correct it
                page.set_rotation(rotation)
                logger.info(f"Page {page_num}: set rotation to {rotation}° to correct content orientation")

        # Save rotated PDF (overwrites original)
        doc.save(pdf_path, incremental=False, garbage=4, deflate=True)
        doc.close()

        logger.info(f"PDF saved with rotated pages: {pdf_path}")

    except Exception as e:
        logger.error(f"Error rotating PDF: {e}")
        # Return original JSON if rotation fails
        return False, ocr_raw_json

    # Transform OCR coordinates to match new orientation
    updated_json = transform_ocr_coordinates(ocr_raw_json, rotations_needed)

    return True, updated_json
