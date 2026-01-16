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


def serialize_azure_field(field: Any) -> Any:
    """Serialize an Azure DocumentField to a JSON-compatible dict."""
    if field is None:
        return None

    result = {}

    # Get field type
    if hasattr(field, 'value_type'):
        result['type'] = str(field.value_type)

    # Get content (the raw text from the document)
    if hasattr(field, 'content'):
        result['content'] = field.content

    # Get confidence
    if hasattr(field, 'confidence'):
        result['confidence'] = field.confidence

    # Get the value based on type
    value = extract_field_value(field)

    if value is None:
        result['value'] = None
    elif isinstance(value, (str, int, float, bool)):
        result['value'] = value
    elif isinstance(value, date):
        result['value'] = value.isoformat()
    elif isinstance(value, Decimal):
        result['value'] = float(value)
    elif hasattr(value, 'amount'):
        # Currency type
        result['value'] = {
            'amount': float(value.amount) if value.amount else None,
            'symbol': getattr(value, 'symbol', None),
            'code': getattr(value, 'code', None),
        }
    elif isinstance(value, list):
        # Array of items
        result['value'] = [serialize_azure_field(item) for item in value]
    elif isinstance(value, dict):
        # Object with nested fields
        result['value'] = {k: serialize_azure_field(v) for k, v in value.items()}
    else:
        # Unknown type - try to convert to string
        result['value'] = str(value)

    return result


def serialize_azure_result(result: Any) -> dict:
    """Serialize the full Azure AnalyzeResult to a JSON-compatible dict."""
    output = {
        'content': result.content,
        'documents': []
    }

    if result.documents:
        for doc in result.documents:
            doc_dict = {
                'doc_type': doc.doc_type if hasattr(doc, 'doc_type') else None,
                'confidence': doc.confidence if hasattr(doc, 'confidence') else None,
                'fields': {}
            }

            if doc.fields:
                for field_name, field_value in doc.fields.items():
                    doc_dict['fields'][field_name] = serialize_azure_field(field_value)

            output['documents'].append(doc_dict)

    return output


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

        # Serialize the full Azure response for storage/debugging
        raw_json = serialize_azure_result(result)

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
                "raw_json": raw_json,
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
                if items_value and hasattr(items_value, '__iter__'):
                    logger.info(f"Document {doc_idx}: Found {len(items_value)} line items")
                    for item_idx, item in enumerate(items_value):
                        try:
                            # Get the item's fields - handle various Azure SDK structures
                            item_fields = None

                            # Try item.value first (standard DocumentField)
                            if hasattr(item, 'value') and item.value is not None:
                                item_fields = item.value

                            # If value is still None, try to use item directly
                            if item_fields is None:
                                item_fields = item

                            # Skip if we still don't have usable fields
                            if item_fields is None:
                                logger.warning(f"Item {item_idx}: fields is None, skipping")
                                continue

                            # item_fields should be dict-like (either dict or has __getitem__)
                            if not (isinstance(item_fields, dict) or hasattr(item_fields, '__getitem__')):
                                logger.warning(f"Item {item_idx}: Unexpected item_fields type: {type(item_fields)}")
                                continue

                            line_item = {
                                "description": None,
                                "quantity": None,
                                "unit_price": None,
                                "amount": None,
                                "product_code": None,
                            }

                            # Helper to safely get field value
                            def safe_get_field(fields, key):
                                try:
                                    if key in fields:
                                        return extract_field_value(fields[key])
                                except (KeyError, TypeError):
                                    pass
                                return None

                            # Extract description
                            line_item["description"] = safe_get_field(item_fields, "Description")

                            # Extract quantity
                            qty = safe_get_field(item_fields, "Quantity")
                            if qty is not None:
                                try:
                                    line_item["quantity"] = float(qty)
                                except (ValueError, TypeError):
                                    pass

                            # Extract unit price
                            up_val = safe_get_field(item_fields, "UnitPrice")
                            if up_val is not None:
                                try:
                                    if hasattr(up_val, 'amount') and up_val.amount is not None:
                                        line_item["unit_price"] = float(up_val.amount)
                                    else:
                                        line_item["unit_price"] = float(up_val)
                                except (ValueError, TypeError):
                                    pass

                            # Extract amount
                            amt_val = safe_get_field(item_fields, "Amount")
                            if amt_val is not None:
                                try:
                                    if hasattr(amt_val, 'amount') and amt_val.amount is not None:
                                        line_item["amount"] = float(amt_val.amount)
                                    else:
                                        line_item["amount"] = float(amt_val)
                                except (ValueError, TypeError):
                                    pass

                            # Extract product code
                            line_item["product_code"] = safe_get_field(item_fields, "ProductCode")

                            line_items.append(line_item)
                            desc_preview = (line_item.get('description') or 'N/A')[:30]
                            logger.debug(f"Line item {item_idx}: {desc_preview} - "
                                        f"qty={line_item.get('quantity')} amt={line_item.get('amount')}")
                        except Exception as item_err:
                            logger.warning(f"Error processing line item {item_idx}: {item_err}")

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
            "raw_json": raw_json,
            "confidence": confidence
        }

    except Exception as e:
        logger.error(f"Azure OCR error: {e}")
        raise
