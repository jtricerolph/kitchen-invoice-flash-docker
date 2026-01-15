import logging
from datetime import date
from decimal import Decimal
from typing import Optional
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential

logger = logging.getLogger(__name__)


async def process_invoice_with_azure(
    image_path: str,
    azure_endpoint: str,
    azure_key: str
) -> dict:
    """
    Process an invoice image using Azure Document Intelligence.

    Returns:
        dict with extracted fields:
            - invoice_number: str or None
            - invoice_date: date or None
            - total: Decimal or None
            - vendor_name: str or None
            - order_number: str or None
            - line_items: list of dicts
            - raw_text: str
            - confidence: float
    """
    try:
        client = DocumentAnalysisClient(
            endpoint=azure_endpoint,
            credential=AzureKeyCredential(azure_key)
        )

        # Read the image file
        with open(image_path, "rb") as f:
            poller = client.begin_analyze_document(
                "prebuilt-invoice",
                document=f
            )

        result = poller.result()

        if not result.documents:
            logger.warning("No invoice detected in document")
            return {
                "invoice_number": None,
                "invoice_date": None,
                "total": None,
                "vendor_name": None,
                "order_number": None,
                "line_items": [],
                "raw_text": result.content or "",
                "confidence": 0.0
            }

        invoice = result.documents[0]
        fields = invoice.fields

        # Extract invoice number
        invoice_number = None
        if "InvoiceId" in fields and fields["InvoiceId"].value:
            invoice_number = str(fields["InvoiceId"].value)

        # Extract invoice date
        invoice_date = None
        if "InvoiceDate" in fields and fields["InvoiceDate"].value:
            inv_date = fields["InvoiceDate"].value
            if isinstance(inv_date, date):
                invoice_date = inv_date

        # Extract total
        total = None
        if "InvoiceTotal" in fields and fields["InvoiceTotal"].value:
            total_val = fields["InvoiceTotal"].value
            if hasattr(total_val, 'amount'):
                total = Decimal(str(total_val.amount))
            else:
                total = Decimal(str(total_val))

        # Extract vendor name
        vendor_name = None
        if "VendorName" in fields and fields["VendorName"].value:
            vendor_name = str(fields["VendorName"].value)

        # Extract purchase order / order number
        order_number = None
        if "PurchaseOrder" in fields and fields["PurchaseOrder"].value:
            order_number = str(fields["PurchaseOrder"].value)

        # Extract line items
        line_items = []
        if "Items" in fields and fields["Items"].value:
            for item in fields["Items"].value:
                item_fields = item.value if hasattr(item, 'value') else {}

                line_item = {
                    "description": None,
                    "quantity": None,
                    "unit_price": None,
                    "amount": None,
                    "product_code": None,
                }

                if "Description" in item_fields:
                    line_item["description"] = item_fields["Description"].value

                if "Quantity" in item_fields:
                    line_item["quantity"] = float(item_fields["Quantity"].value) if item_fields["Quantity"].value else None

                if "UnitPrice" in item_fields and item_fields["UnitPrice"].value:
                    up = item_fields["UnitPrice"].value
                    line_item["unit_price"] = float(up.amount) if hasattr(up, 'amount') else float(up)

                if "Amount" in item_fields and item_fields["Amount"].value:
                    amt = item_fields["Amount"].value
                    line_item["amount"] = float(amt.amount) if hasattr(amt, 'amount') else float(amt)

                if "ProductCode" in item_fields:
                    line_item["product_code"] = item_fields["ProductCode"].value

                line_items.append(line_item)

        # Calculate average confidence
        confidence = invoice.confidence if hasattr(invoice, 'confidence') else 0.9

        logger.info(f"Azure extracted: invoice_number={invoice_number}, date={invoice_date}, "
                    f"total={total}, vendor={vendor_name}, order={order_number}, {len(line_items)} line items")

        return {
            "invoice_number": invoice_number,
            "invoice_date": invoice_date,
            "total": total,
            "vendor_name": vendor_name,
            "order_number": order_number,
            "line_items": line_items,
            "raw_text": result.content or "",
            "confidence": confidence
        }

    except Exception as e:
        logger.error(f"Azure OCR error: {e}")
        raise
