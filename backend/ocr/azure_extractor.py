import logging
import json
from datetime import date
from decimal import Decimal
from typing import Optional, Any
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential

logger = logging.getLogger(__name__)


def extract_field_value(field: Any) -> Any:
    """Extract the actual value from an Azure DocumentField, handling different types."""
    if field is None:
        return None

    # Try the .value attribute first (standard SDK approach)
    if hasattr(field, 'value'):
        return field.value

    # For currency types, check for .amount
    if hasattr(field, 'amount'):
        return field.amount

    # Direct value
    return field


def extract_currency_amount(field: Any) -> Optional[Decimal]:
    """Extract a currency amount from an Azure field."""
    if field is None:
        return None

    val = extract_field_value(field)
    if val is None:
        return None

    # If it's a currency object with .amount
    if hasattr(val, 'amount'):
        return Decimal(str(val.amount))

    # Direct numeric value
    try:
        return Decimal(str(val))
    except (ValueError, TypeError):
        return None


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

        # Log document count for debugging
        doc_count = len(result.documents) if result.documents else 0
        logger.info(f"Azure returned {doc_count} document(s)")

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

        # For multi-page invoices, we may have multiple documents
        # Use first document for header fields, but combine line items from all
        invoice = result.documents[0]
        fields = invoice.fields

        # Log available fields for debugging
        field_names = list(fields.keys()) if fields else []
        logger.info(f"Available fields in first document: {field_names}")

        # Extract invoice number
        invoice_number = None
        if "InvoiceId" in fields:
            val = extract_field_value(fields["InvoiceId"])
            if val:
                invoice_number = str(val)
                logger.debug(f"Extracted InvoiceId: {invoice_number}")

        # Extract invoice date
        invoice_date = None
        if "InvoiceDate" in fields:
            val = extract_field_value(fields["InvoiceDate"])
            if val and isinstance(val, date):
                invoice_date = val
                logger.debug(f"Extracted InvoiceDate: {invoice_date}")

        # Extract total (gross, inc. VAT)
        total = extract_currency_amount(fields.get("InvoiceTotal"))
        if total:
            logger.debug(f"Extracted InvoiceTotal: {total}")

        # Extract subtotal (net, exc. VAT)
        net_total = extract_currency_amount(fields.get("SubTotal"))
        if net_total:
            logger.debug(f"Extracted SubTotal: {net_total}")

        # Extract vendor name
        vendor_name = None
        if "VendorName" in fields:
            val = extract_field_value(fields["VendorName"])
            if val:
                vendor_name = str(val)
                logger.debug(f"Extracted VendorName: {vendor_name}")

        # Extract purchase order / order number
        order_number = None
        if "PurchaseOrder" in fields:
            val = extract_field_value(fields["PurchaseOrder"])
            if val:
                order_number = str(val)
                logger.debug(f"Extracted PurchaseOrder: {order_number}")

        # Extract line items from ALL documents (for multi-page invoices)
        line_items = []
        for doc_idx, doc in enumerate(result.documents):
            doc_fields = doc.fields or {}
            if "Items" in doc_fields:
                items_field = doc_fields["Items"]
                items_value = extract_field_value(items_field)
                if items_value:
                    logger.info(f"Document {doc_idx}: Found {len(items_value)} line items")
                    for item_idx, item in enumerate(items_value):
                        # Get the item's fields - it could be item.value or item itself
                        item_fields = extract_field_value(item)
                        if item_fields is None:
                            item_fields = item
                        if not isinstance(item_fields, dict):
                            # Try to access as object with value attribute
                            if hasattr(item_fields, 'value') and isinstance(item_fields.value, dict):
                                item_fields = item_fields.value
                            else:
                                logger.warning(f"Item {item_idx}: Unexpected item_fields type: {type(item_fields)}")
                                continue

                        line_item = {
                            "description": None,
                            "quantity": None,
                            "unit_price": None,
                            "amount": None,
                            "product_code": None,
                        }

                        # Extract description
                        if "Description" in item_fields:
                            line_item["description"] = extract_field_value(item_fields["Description"])

                        # Extract quantity
                        if "Quantity" in item_fields:
                            qty = extract_field_value(item_fields["Quantity"])
                            if qty is not None:
                                try:
                                    line_item["quantity"] = float(qty)
                                except (ValueError, TypeError):
                                    pass

                        # Extract unit price
                        if "UnitPrice" in item_fields:
                            up_field = item_fields["UnitPrice"]
                            up_val = extract_field_value(up_field)
                            if up_val is not None:
                                try:
                                    if hasattr(up_val, 'amount'):
                                        line_item["unit_price"] = float(up_val.amount)
                                    else:
                                        line_item["unit_price"] = float(up_val)
                                except (ValueError, TypeError):
                                    pass

                        # Extract amount
                        if "Amount" in item_fields:
                            amt_field = item_fields["Amount"]
                            amt_val = extract_field_value(amt_field)
                            if amt_val is not None:
                                try:
                                    if hasattr(amt_val, 'amount'):
                                        line_item["amount"] = float(amt_val.amount)
                                    else:
                                        line_item["amount"] = float(amt_val)
                                except (ValueError, TypeError):
                                    pass

                        # Extract product code
                        if "ProductCode" in item_fields:
                            line_item["product_code"] = extract_field_value(item_fields["ProductCode"])

                        line_items.append(line_item)
                        logger.debug(f"Line item {item_idx}: {line_item.get('description', 'N/A')[:30]} - "
                                    f"qty={line_item.get('quantity')} amt={line_item.get('amount')}")

        # Calculate average confidence
        confidence = invoice.confidence if hasattr(invoice, 'confidence') else 0.9

        logger.info(f"Azure extracted: invoice_number={invoice_number}, date={invoice_date}, "
                    f"total={total}, net_total={net_total}, vendor={vendor_name}, order={order_number}, "
                    f"{len(line_items)} total line items from {doc_count} documents")

        return {
            "invoice_number": invoice_number,
            "invoice_date": invoice_date,
            "total": total,
            "net_total": net_total,
            "vendor_name": vendor_name,
            "order_number": order_number,
            "line_items": line_items,
            "raw_text": result.content or "",
            "confidence": confidence
        }

    except Exception as e:
        logger.error(f"Azure OCR error: {e}")
        raise
