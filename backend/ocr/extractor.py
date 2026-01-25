import logging
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from .parser import identify_supplier
from .azure_extractor import process_invoice_with_azure
from services.duplicate_detector import detect_document_type
from services.pdf_rotation import rotate_pdf_pages

logger = logging.getLogger(__name__)


async def process_invoice_image(
    image_path: str,
    kitchen_id: int,
    db: AsyncSession
) -> dict:
    """
    Process an invoice image through Azure OCR and extract relevant fields.

    Args:
        image_path: Path to the invoice image
        kitchen_id: ID of the kitchen for supplier matching
        db: Database session for supplier lookup

    Returns:
        dict with extracted fields:
            - invoice_number: str or None
            - invoice_date: date or None
            - total: Decimal or None
            - supplier_id: int or None
            - supplier_match_type: str ("exact", "fuzzy") or None
            - vendor_name: str or None
            - order_number: str or None
            - document_type: str ("invoice" or "delivery_note")
            - line_items: list
            - raw_text: str
            - raw_json: dict (serialized Azure response)
            - confidence: float
    """
    # Check kitchen settings for Azure credentials
    from models.settings import KitchenSettings
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()

    # Require Azure configuration
    if not settings or not settings.azure_endpoint or not settings.azure_key:
        logger.error("Azure credentials not configured for kitchen")
        return {
            "invoice_number": None,
            "invoice_date": None,
            "total": None,
            "net_total": None,
            "supplier_id": None,
            "supplier_match_type": None,
            "vendor_name": None,
            "order_number": None,
            "document_type": "invoice",
            "line_items": [],
            "raw_text": "Error: Azure credentials not configured. Please configure in Settings.",
            "raw_json": None,
            "confidence": 0.0
        }

    logger.info("Using Azure Document Intelligence for OCR")

    try:
        result = await process_invoice_with_azure(
            image_path,
            settings.azure_endpoint,
            settings.azure_key,
            clean_product_codes=settings.ocr_clean_product_codes,
            filter_subtotal_rows=settings.ocr_filter_subtotal_rows,
            use_weight_as_quantity=settings.ocr_use_weight_as_quantity
        )

        # FIRST post-processing step: Rotate PDF pages with non-zero angles
        # This must happen BEFORE any other processing extracts data from raw_json
        # because coordinates need to be transformed to match the corrected orientation
        if image_path.lower().endswith('.pdf') and result.get('raw_json'):
            try:
                modified, updated_json = rotate_pdf_pages(image_path, result['raw_json'])
                if modified:
                    result['raw_json'] = updated_json
                    logger.info(f"PDF pages rotated and coordinates transformed for {image_path}")
            except Exception as e:
                logger.warning(f"PDF rotation failed (non-fatal): {e}")

        # Try to identify/match supplier from vendor name
        supplier_id = None
        supplier_match_type = None
        if result.get("vendor_name"):
            supplier_id, supplier_match_type = await identify_supplier(result["vendor_name"], kitchen_id, db)
        if not supplier_id and result.get("raw_text"):
            supplier_id, supplier_match_type = await identify_supplier(result["raw_text"], kitchen_id, db)

        # Use document_type from azure_extractor (already detected there)
        # Fall back to detect_document_type only if not provided
        document_type = result.get("document_type")
        if not document_type:
            document_type = detect_document_type(
                result.get("raw_text", ""),
                result
            )

        logger.info(f"Processed invoice: number={result.get('invoice_number')}, "
                    f"type={document_type}, supplier_id={supplier_id}, match_type={supplier_match_type}")

        return {
            "invoice_number": result.get("invoice_number"),
            "invoice_date": result.get("invoice_date"),
            "total": result.get("total"),
            "net_total": result.get("net_total"),
            "supplier_id": supplier_id,
            "supplier_match_type": supplier_match_type,
            "vendor_name": result.get("vendor_name"),
            "order_number": result.get("order_number"),
            "document_type": document_type,
            "line_items": result.get("line_items", []),
            "raw_text": result.get("raw_text", ""),
            "raw_json": result.get("raw_json"),
            "confidence": result.get("confidence", 0.0)
        }

    except Exception as e:
        logger.error(f"Azure OCR failed: {e}")
        return {
            "invoice_number": None,
            "invoice_date": None,
            "total": None,
            "net_total": None,
            "supplier_id": None,
            "supplier_match_type": None,
            "vendor_name": None,
            "order_number": None,
            "document_type": "invoice",
            "line_items": [],
            "raw_text": f"Error: Azure OCR failed - {str(e)}",
            "raw_json": None,
            "confidence": 0.0
        }
