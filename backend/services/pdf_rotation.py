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
    Round angle to nearest 90 degrees.

    Azure returns angle in degrees (can be negative for CCW rotation).
    We round to nearest 90° for correction.
    """
    if angle is None or angle == 0:
        return 0
    # Round to nearest 90 degrees, preserving sign
    rounded = round(angle / 90) * 90
    # Normalize to -180 to 180 range for cleaner math
    while rounded > 180:
        rounded -= 360
    while rounded < -180:
        rounded += 360
    return int(rounded)


def transform_polygon(polygon: list, rotation: int, page_width: float, page_height: float) -> list:
    """
    Transform polygon coordinates based on rotation.

    The rotation is the detected angle (can be negative for CCW).
    We compute the correction and transform coordinates to match the corrected PDF.

    Args:
        polygon: List of [x, y] coordinate pairs in inches
        rotation: Detected angle in degrees (can be negative, e.g., -90 for CCW)
        page_width: Original page width in inches (before rotation)
        page_height: Original page height in inches (before rotation)

    Returns:
        Transformed polygon with coordinates adjusted for rotation
    """
    # Calculate correction angle (opposite of detected)
    # -90° detected -> +90° correction
    correction = -rotation
    # Normalize to positive 0-360 range
    correction = int(((correction % 360) + 360) % 360)

    transformed = []
    for point in polygon:
        x, y = point[0], point[1]

        if correction == 90:
            # Applied 90° CW rotation to PDF
            # For +90° CW: (x, y) -> (height - y, x)
            new_x = page_height - y
            new_y = x
        elif correction == 180:
            # Applied 180° rotation to PDF
            # (x, y) -> (width - x, height - y)
            new_x = page_width - x
            new_y = page_height - y
        elif correction == 270:
            # Applied 270° CW (90° CCW) rotation to PDF
            # For +270° CW: (x, y) -> (y, width - x)
            new_x = y
            new_y = page_width - x
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

    # Update page dimensions (swap width/height for 90/270 corrections)
    for page_info in ocr_json.get('pages', []):
        page_num = page_info.get('page_number', 1)
        rotation = rotations.get(page_num, 0)
        # Calculate correction angle (opposite of detected)
        correction = int(((-rotation % 360) + 360) % 360)
        if correction in (90, 270):
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
        raw_angle = page_info.get('angle', 0)
        angle = normalize_angle(raw_angle)
        logger.info(f"Page {page_num}: raw angle={raw_angle}, normalized={angle}")
        if angle != 0:
            rotations_needed[page_num] = angle

    if not rotations_needed:
        logger.debug("No page rotations needed")
        return False, ocr_raw_json

    logger.info(f"Rotating pages: {rotations_needed}")

    try:
        import tempfile
        import shutil
        import os

        # Open source PDF for reading
        src_doc = fitz.open(pdf_path)

        # Create a new document for output
        out_doc = fitz.open()

        # Process each page in order
        for page_idx in range(len(src_doc)):
            page_num = page_idx + 1
            src_page = src_doc[page_idx]
            rect = src_page.rect

            rotation = rotations_needed.get(page_num, 0)
            if rotation == 0:
                # No rotation needed - just copy the page as-is
                out_doc.insert_pdf(src_doc, from_page=page_idx, to_page=page_idx)
                logger.debug(f"Page {page_num}: no rotation needed, copied as-is")
            else:
                # Calculate correction: -90° content needs +90° rotation to appear upright
                correction = -rotation
                # Normalize to 0-360 for PyMuPDF
                correction = int(((correction % 360) + 360) % 360)

                logger.info(f"Page {page_num}: detected angle={rotation}°, applying correction={correction}°")
                logger.info(f"Page {page_num}: original size {rect.width}x{rect.height}")

                # Render page to pixmap at high resolution
                # Use 2x scale for better quality
                mat = fitz.Matrix(2, 2)
                pix = src_page.get_pixmap(matrix=mat)

                # Rotate the pixmap
                # PyMuPDF Pixmap doesn't have direct rotate, so we use PIL
                from PIL import Image
                import io

                # Convert pixmap to PIL Image
                img_data = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_data))

                # Rotate image (PIL rotates counter-clockwise, we need clockwise)
                # correction=90 means rotate 90° CW, which is -90° in PIL (or 270° CCW)
                pil_rotation = (360 - correction) % 360
                if pil_rotation != 0:
                    img = img.rotate(pil_rotation, expand=True)

                logger.info(f"Page {page_num}: rotated image {pil_rotation}° CCW (={correction}° CW)")

                # For 90° or 270° rotation, swap width and height
                if correction in (90, 270):
                    new_width, new_height = rect.height, rect.width
                else:
                    new_width, new_height = rect.width, rect.height

                # Create new page with correct dimensions
                new_page = out_doc.new_page(width=new_width, height=new_height)

                # Convert PIL image back to bytes
                img_buffer = io.BytesIO()
                img.save(img_buffer, format='PNG')
                img_buffer.seek(0)

                # Insert the rotated image into the new page
                new_page.insert_image(
                    fitz.Rect(0, 0, new_width, new_height),
                    stream=img_buffer.read()
                )

                logger.info(f"Page {page_num}: re-rendered with {correction}° rotation, new size {new_width}x{new_height}")

        src_doc.close()

        # Save to temp file first, then replace original
        temp_fd, temp_path = tempfile.mkstemp(suffix='.pdf')
        try:
            os.close(temp_fd)  # Close the file descriptor, we just need the path
            out_doc.save(temp_path, garbage=4, deflate=True)
            out_doc.close()
            # Replace original with rotated version
            shutil.move(temp_path, pdf_path)
        except Exception:
            # Clean up temp file on error
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            raise

        logger.info(f"PDF saved with rotated pages: {pdf_path}")

    except Exception as e:
        logger.error(f"Error rotating PDF: {e}")
        # Return original JSON if rotation fails
        return False, ocr_raw_json

    # Transform OCR coordinates to match new orientation
    updated_json = transform_ocr_coordinates(ocr_raw_json, rotations_needed)

    return True, updated_json
