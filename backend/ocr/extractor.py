import os
import logging
from typing import Optional
from paddleocr import PaddleOCR
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from .preprocessor import preprocess_image, resize_for_ocr
from .parser import extract_invoice_fields, identify_supplier
from .azure_extractor import process_invoice_with_azure

logger = logging.getLogger(__name__)


# Initialize PaddleOCR with GPU support
# use_gpu=True enables CUDA acceleration
# lang='en' for English text
ocr_engine: Optional[PaddleOCR] = None


def get_ocr_engine() -> PaddleOCR:
    """Get or initialize the OCR engine (singleton pattern)"""
    global ocr_engine

    if ocr_engine is None:
        # Check if GPU is available
        use_gpu = os.environ.get("CUDA_VISIBLE_DEVICES") is not None

        ocr_engine = PaddleOCR(
            use_angle_cls=True,  # Detect text angle
            lang='en',
            use_gpu=use_gpu,
            show_log=False,
            # Limit GPU memory usage
            gpu_mem=1000,  # 1GB limit to coexist with other GPU workloads
        )

    return ocr_engine


async def process_invoice_image(
    image_path: str,
    kitchen_id: int,
    db: AsyncSession
) -> dict:
    """
    Process an invoice image through OCR and extract relevant fields.

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
            - vendor_name: str or None (Azure only)
            - line_items: list (Azure only)
            - raw_text: str
            - confidence: float
    """
    # Check kitchen settings for OCR provider
    from models.settings import KitchenSettings
    settings_result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    settings = settings_result.scalar_one_or_none()

    # Use Azure if configured
    if settings and settings.ocr_provider == "azure" and settings.azure_endpoint and settings.azure_key:
        logger.info("Using Azure Document Intelligence for OCR")
        try:
            result = await process_invoice_with_azure(
                image_path,
                settings.azure_endpoint,
                settings.azure_key
            )

            # Try to identify/match supplier from vendor name
            supplier_id = None
            if result.get("vendor_name"):
                supplier_id = await identify_supplier(result["vendor_name"], kitchen_id, db)
            if not supplier_id and result.get("raw_text"):
                supplier_id = await identify_supplier(result["raw_text"], kitchen_id, db)

            return {
                "invoice_number": result.get("invoice_number"),
                "invoice_date": result.get("invoice_date"),
                "total": result.get("total"),
                "supplier_id": supplier_id,
                "vendor_name": result.get("vendor_name"),
                "line_items": result.get("line_items", []),
                "raw_text": result.get("raw_text", ""),
                "confidence": result.get("confidence", 0.0)
            }
        except Exception as e:
            logger.error(f"Azure OCR failed, falling back to PaddleOCR: {e}")

    # Fall back to PaddleOCR
    logger.info("Using PaddleOCR for OCR")
    return await process_invoice_with_paddle(image_path, kitchen_id, db)


async def process_invoice_with_paddle(
    image_path: str,
    kitchen_id: int,
    db: AsyncSession
) -> dict:
    """Process invoice using PaddleOCR (local GPU)"""
    # Preprocess image
    preprocessed = preprocess_image(image_path)
    preprocessed = resize_for_ocr(preprocessed)

    # Run OCR
    engine = get_ocr_engine()
    result = engine.ocr(preprocessed, cls=True)

    if not result or not result[0]:
        return {
            "invoice_number": None,
            "invoice_date": None,
            "total": None,
            "supplier_id": None,
            "vendor_name": None,
            "line_items": [],
            "raw_text": "",
            "confidence": 0.0
        }

    # Extract text and calculate average confidence
    lines = []
    confidences = []

    for line in result[0]:
        if line and len(line) >= 2:
            text = line[1][0]  # Text content
            conf = line[1][1]  # Confidence score
            lines.append(text)
            confidences.append(conf)

    raw_text = "\n".join(lines)
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

    # Log raw OCR text for debugging
    logger.info(f"PaddleOCR raw text ({avg_confidence:.2%} confidence):\n{raw_text}")

    # Try to identify supplier
    supplier_id = await identify_supplier(raw_text, kitchen_id, db)

    # Get supplier template if available
    template_config = {}
    if supplier_id:
        from models.supplier import Supplier
        supplier_result = await db.execute(
            select(Supplier).where(Supplier.id == supplier_id)
        )
        supplier = supplier_result.scalar_one_or_none()
        if supplier:
            template_config = supplier.template_config

    # Extract fields using template or generic patterns
    extracted = extract_invoice_fields(raw_text, template_config)

    logger.info(f"Extracted fields: invoice_number={extracted.get('invoice_number')}, "
                f"date={extracted.get('invoice_date')}, total={extracted.get('total')}")

    return {
        "invoice_number": extracted.get("invoice_number"),
        "invoice_date": extracted.get("invoice_date"),
        "total": extracted.get("total"),
        "supplier_id": supplier_id,
        "vendor_name": None,
        "line_items": [],
        "raw_text": raw_text,
        "confidence": avg_confidence
    }


async def ocr_image_to_text(image_path: str) -> tuple[str, float]:
    """
    Simple OCR that returns just text and confidence.
    Useful for testing or simple extraction.
    """
    preprocessed = preprocess_image(image_path)
    preprocessed = resize_for_ocr(preprocessed)

    engine = get_ocr_engine()
    result = engine.ocr(preprocessed, cls=True)

    if not result or not result[0]:
        return "", 0.0

    lines = []
    confidences = []

    for line in result[0]:
        if line and len(line) >= 2:
            lines.append(line[1][0])
            confidences.append(line[1][1])

    text = "\n".join(lines)
    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    return text, confidence
