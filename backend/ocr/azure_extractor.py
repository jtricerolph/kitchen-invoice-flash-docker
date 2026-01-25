import logging
import json
import asyncio
import re
from datetime import date
from decimal import Decimal
from typing import Optional, Any
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import HttpResponseError

logger = logging.getLogger(__name__)


def parse_pack_size(raw_content: str) -> dict:
    """
    Extract pack size info from raw line item content.

    Examples:
        "120x15g" -> pack_quantity=120, unit_size=15, unit_size_type="g"
        "12×1ltr" -> pack_quantity=12, unit_size=1, unit_size_type="ltr"
        "6x1.5kg" -> pack_quantity=6, unit_size=1.5, unit_size_type="kg"
    """
    result = {
        "pack_quantity": None,
        "unit_size": None,
        "unit_size_type": None,
    }

    if not raw_content:
        return result

    # Pattern: 120x15g, 12×1ltr, 6x1.5kg, etc. (note: includes Unicode × symbol)
    pack_pattern = r'(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(g|kg|ml|ltr|l|oz|cl)\b'
    match = re.search(pack_pattern, raw_content, re.IGNORECASE)

    if match:
        result["pack_quantity"] = int(match.group(1))
        result["unit_size"] = float(match.group(2))
        result["unit_size_type"] = match.group(3).lower()
        # Normalize 'l' to 'ltr' for consistency
        if result["unit_size_type"] == 'l':
            result["unit_size_type"] = 'ltr'

    return result

# Retry configuration for rate limiting
MAX_RETRIES = 3
BASE_RETRY_DELAY = 5  # seconds


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


def serialize_bounding_regions(field: Any) -> list:
    """Extract bounding regions from an Azure DocumentField."""
    regions = []
    if hasattr(field, 'bounding_regions') and field.bounding_regions:
        for region in field.bounding_regions:
            region_data = {
                'page_number': region.page_number if hasattr(region, 'page_number') else 1,
                'polygon': []
            }
            if hasattr(region, 'polygon') and region.polygon:
                # polygon is a list of Point objects with x, y attributes
                region_data['polygon'] = [
                    [p.x, p.y] for p in region.polygon
                ]
            regions.append(region_data)
    return regions


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

    # Get bounding regions (coordinates for highlighting)
    bounding_regions = serialize_bounding_regions(field)
    if bounding_regions:
        result['bounding_regions'] = bounding_regions

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
        'documents': [],
        'pages': []
    }

    # Capture page dimensions for coordinate scaling
    if hasattr(result, 'pages') and result.pages:
        for page in result.pages:
            page_info = {
                'page_number': page.page_number if hasattr(page, 'page_number') else 1,
                'width': page.width if hasattr(page, 'width') else None,
                'height': page.height if hasattr(page, 'height') else None,
                'unit': str(page.unit) if hasattr(page, 'unit') else 'inch'
            }
            output['pages'].append(page_info)

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


def _call_azure_sync(image_path: str, azure_endpoint: str, azure_key: str):
    """
    Synchronous Azure API call - runs in thread pool to avoid blocking event loop.
    """
    client = DocumentAnalysisClient(
        endpoint=azure_endpoint,
        credential=AzureKeyCredential(azure_key)
    )

    with open(image_path, "rb") as f:
        poller = client.begin_analyze_document(
            "prebuilt-invoice",
            document=f
        )

    return poller.result()


async def process_invoice_with_azure(
    image_path: str,
    azure_endpoint: str,
    azure_key: str,
    clean_product_codes: bool = False,
    filter_subtotal_rows: bool = False,
    use_weight_as_quantity: bool = False
) -> dict:
    """
    Process an invoice image using Azure Document Intelligence.

    Args:
        image_path: Path to the invoice image
        azure_endpoint: Azure Document Intelligence endpoint
        azure_key: Azure API key
        clean_product_codes: Strip section headers (like "CHILL/AMBIENT") from product codes
        filter_subtotal_rows: Filter out subtotal/total rows from line items

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
    # Retry loop for rate limiting (429 errors)
    last_error = None
    loop = asyncio.get_event_loop()

    for attempt in range(MAX_RETRIES + 1):
        try:
            # Run blocking Azure SDK call in thread pool to avoid blocking event loop
            result = await loop.run_in_executor(
                None,  # Use default thread pool
                _call_azure_sync,
                image_path,
                azure_endpoint,
                azure_key
            )
            break  # Success - exit retry loop

        except HttpResponseError as e:
            if e.status_code == 429:
                # Rate limited - extract retry-after or use exponential backoff
                retry_after = BASE_RETRY_DELAY * (2 ** attempt)
                if hasattr(e, 'response') and e.response:
                    retry_header = e.response.headers.get('Retry-After')
                    if retry_header:
                        try:
                            retry_after = int(retry_header)
                        except ValueError:
                            pass

                if attempt < MAX_RETRIES:
                    logger.warning(f"Azure rate limited (429). Retry {attempt + 1}/{MAX_RETRIES} after {retry_after}s")
                    await asyncio.sleep(retry_after)
                    last_error = e
                    continue
                else:
                    logger.error(f"Azure rate limit exceeded after {MAX_RETRIES} retries")
                    raise Exception(f"Azure rate limit exceeded. Please wait a moment and try again.") from e
            elif e.status_code == 403:
                # Quota exceeded or access denied
                logger.error(f"Azure access denied (403): {str(e)}")
                raise Exception(
                    "Azure quota exceeded or access denied. "
                    "Please check your Azure subscription and budget limits in the Azure portal."
                ) from e
            elif e.status_code == 401:
                # Authentication failed
                logger.error(f"Azure authentication failed (401): {str(e)}")
                raise Exception(
                    "Azure authentication failed. Please check your API credentials in Settings."
                ) from e
            else:
                # Other HTTP error - don't retry
                logger.error(f"Azure HTTP error {e.status_code}: {str(e)}")
                raise
        except Exception as e:
            logger.error(f"Azure OCR error: {e}")
            raise
    else:
        # Exhausted retries without success
        raise Exception(f"Azure processing failed after {MAX_RETRIES} retries") from last_error

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
                            "product_code": None,
                            "description": None,
                            "unit": None,
                            "quantity": None,
                            "order_quantity": None,
                            "unit_price": None,
                            "tax_rate": None,
                            "tax_amount": None,
                            "amount": None,
                            "bounding_regions": [],
                            "raw_content": None,
                            "pack_quantity": None,
                            "unit_size": None,
                            "unit_size_type": None,
                            "cost_per_item": None,
                            "cost_per_portion": None,
                        }

                        # Capture bounding regions for this line item
                        line_item["bounding_regions"] = serialize_bounding_regions(item)

                        # Capture raw content (contains all text including pack size info)
                        line_item["raw_content"] = item.content if hasattr(item, 'content') else None

                        # Helper to safely get field value
                        def safe_get_field(fields, key):
                            try:
                                if key in fields:
                                    return extract_field_value(fields[key])
                            except (KeyError, TypeError):
                                pass
                            return None

                        # Extract product code
                        line_item["product_code"] = safe_get_field(item_fields, "ProductCode")

                        # Clean product code if enabled - strip section headers
                        # NOTE: May need supplier-specific constraints in future (e.g., only for Brakes/Sysco)
                        if clean_product_codes and line_item["product_code"]:
                            if '\n' in line_item["product_code"]:
                                original_code = line_item["product_code"]
                                line_item["product_code"] = line_item["product_code"].split('\n')[-1].strip()
                                logger.debug(f"Cleaned product code: '{original_code}' -> '{line_item['product_code']}'")

                        # Fallback: extract product code from raw_content if Azure missed it
                        # Only use if first line looks like a product code (alphanumeric, no decimals, reasonable length)
                        line_item["product_code_fallback"] = False  # Track if fallback was used
                        if not line_item.get("product_code") and line_item.get("raw_content"):
                            first_line = line_item["raw_content"].split('\n')[0].strip()
                            # Valid product code patterns:
                            # - All digits, 2-6 chars (e.g., "1646", "955")
                            # - Alphanumeric with optional hyphens, 2-15 chars (e.g., "01SAL4K06", "ABC-123")
                            # - Must NOT look like a price (no decimal point with 2 digits after)
                            is_numeric_code = re.match(r'^\d{2,6}$', first_line)
                            is_alphanum_code = re.match(r'^[A-Z0-9][A-Z0-9\-]{1,14}$', first_line, re.IGNORECASE)
                            is_price = re.match(r'^\d+\.\d{2}$', first_line)  # e.g., "14.64"

                            if (is_numeric_code or is_alphanum_code) and not is_price:
                                line_item["product_code"] = first_line
                                line_item["product_code_fallback"] = True
                                logger.info(f"Extracted product code from raw_content fallback: '{first_line}'")

                        # Extract description
                        line_item["description"] = safe_get_field(item_fields, "Description")

                        # Check for content vs value mismatch in Description field
                        # If they differ significantly, store the alternative for user selection
                        line_item["description_alt"] = None
                        if "Description" in item_fields:
                            desc_field = item_fields["Description"]
                            if hasattr(desc_field, 'content') and hasattr(desc_field, 'value'):
                                content = desc_field.content or ""
                                value = str(desc_field.value) if desc_field.value else ""
                                # Normalize for comparison (strip, lowercase)
                                content_norm = content.strip().lower()
                                value_norm = value.strip().lower()
                                # If first lines differ, store alternative
                                if content_norm.split('\n')[0] != value_norm.split('\n')[0]:
                                    # Use value as description (current behavior), store content as alt
                                    line_item["description_alt"] = content
                                    logger.debug(f"Description mismatch detected: value='{value[:50]}...' content='{content[:50]}...'")

                        # Extract unit of measure
                        line_item["unit"] = safe_get_field(item_fields, "Unit")

                        # Extract quantity (delivered)
                        qty = safe_get_field(item_fields, "Quantity")
                        if qty is not None:
                            try:
                                line_item["quantity"] = float(qty)
                            except (ValueError, TypeError):
                                pass

                        # Fallback: parse quantity from leading number in raw_content
                        # e.g., "2\nHovis Soft White..." -> quantity = 2
                        if not line_item.get("quantity") and line_item.get("raw_content"):
                            leading_qty_match = re.match(r'^(\d+)\s*[\n\r]', line_item["raw_content"])
                            if leading_qty_match:
                                try:
                                    line_item["quantity"] = float(leading_qty_match.group(1))
                                    logger.debug(f"Extracted quantity {line_item['quantity']} from raw_content leading number")
                                except (ValueError, TypeError):
                                    pass

                        # Extract order quantity (if available, e.g., Brakes invoices)
                        order_qty = safe_get_field(item_fields, "OrderQuantity")
                        if order_qty is not None:
                            try:
                                line_item["order_quantity"] = float(order_qty)
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

                        # Extract tax rate (e.g., "ZERO", "20.00", "No VAT")
                        tax_rate = safe_get_field(item_fields, "TaxRate")
                        if tax_rate is None:
                            # Fall back to Tax field which sometimes contains rate description
                            tax_rate = safe_get_field(item_fields, "Tax")
                        if tax_rate is not None:
                            line_item["tax_rate"] = str(tax_rate)

                        # Extract tax amount (if specified separately from rate)
                        tax_val = safe_get_field(item_fields, "Tax")
                        if tax_val is not None:
                            try:
                                if hasattr(tax_val, 'amount') and tax_val.amount is not None:
                                    line_item["tax_amount"] = float(tax_val.amount)
                                elif isinstance(tax_val, (int, float)):
                                    line_item["tax_amount"] = float(tax_val)
                            except (ValueError, TypeError):
                                pass

                        # Extract amount (line total - may be gross or net depending on supplier)
                        amt_val = safe_get_field(item_fields, "Amount")
                        if amt_val is not None:
                            try:
                                if hasattr(amt_val, 'amount') and amt_val.amount is not None:
                                    line_item["amount"] = float(amt_val.amount)
                                else:
                                    line_item["amount"] = float(amt_val)
                            except (ValueError, TypeError):
                                pass

                        # Check if amount is gross (inc VAT) or net (exc VAT)
                        # Compare against unit_price * quantity to determine
                        if line_item.get("amount") and line_item.get("tax_amount") and line_item.get("unit_price") and line_item.get("quantity"):
                            expected_net = line_item["unit_price"] * line_item["quantity"]
                            current_amount = line_item["amount"]
                            adjusted_amount = current_amount - line_item["tax_amount"]

                            # Check which is closer to expected net: current amount or adjusted amount
                            diff_current = abs(current_amount - expected_net)
                            diff_adjusted = abs(adjusted_amount - expected_net)

                            if diff_adjusted < diff_current and adjusted_amount > 0:
                                # Amount appears to be gross, adjust to net
                                line_item["amount"] = round(adjusted_amount, 2)
                                logger.debug(f"Adjusted line amount from gross {current_amount} to net {adjusted_amount} (expected ~{expected_net:.2f})")

                        # Parse pack size from raw content (e.g., "120x15g")
                        pack_info = parse_pack_size(line_item["raw_content"])
                        line_item["pack_quantity"] = pack_info["pack_quantity"]
                        line_item["unit_size"] = pack_info["unit_size"]
                        line_item["unit_size_type"] = pack_info["unit_size_type"]

                        # If unit_price is missing, try to extract from description/raw_content
                        if not line_item.get("unit_price"):
                            # Look for "£X.XX each" or "£X.XX/each" patterns
                            price_each_pattern = r'£(\d+\.?\d*)\s*(?:each|/each|per\s*unit|ea\b)'
                            text_to_search = f"{line_item.get('description', '')} {line_item.get('raw_content', '')}"
                            price_match = re.search(price_each_pattern, text_to_search, re.IGNORECASE)
                            if price_match:
                                try:
                                    line_item["unit_price"] = float(price_match.group(1))
                                    logger.debug(f"Extracted unit_price £{line_item['unit_price']:.2f} from description/raw_content")
                                except (ValueError, TypeError):
                                    pass

                        # If still no unit_price, back-calculate from amount and quantity
                        if not line_item.get("unit_price") and line_item.get("amount") and line_item.get("quantity"):
                            if line_item["quantity"] > 0:
                                line_item["unit_price"] = round(line_item["amount"] / line_item["quantity"], 2)
                                logger.debug(f"Back-calculated unit_price £{line_item['unit_price']:.2f} from amount/quantity")

                        # If still no quantity, back-calculate from amount and unit_price
                        if not line_item.get("quantity") and line_item.get("amount") and line_item.get("unit_price"):
                            if line_item["unit_price"] > 0:
                                calculated_qty = line_item["amount"] / line_item["unit_price"]
                                # Only use if result is close to a whole number (receipts usually have integer quantities)
                                if abs(calculated_qty - round(calculated_qty)) < 0.01:
                                    line_item["quantity"] = round(calculated_qty)
                                    logger.debug(f"Back-calculated quantity {line_item['quantity']} from amount/unit_price")

                        # Validate numeric values to prevent database overflow
                        # DECIMAL(10,3) allows up to 9,999,999.999 - cap at reasonable limits
                        MAX_QUANTITY = 999999.0
                        MAX_PRICE = 999999.0
                        MAX_UNIT_SIZE = 99999.0  # 99kg in grams is plenty
                        MAX_PACK_QTY = 9999

                        # Collect warnings for values that need capping (OCR misreads)
                        ocr_warnings = []

                        if line_item.get("quantity") and line_item["quantity"] > MAX_QUANTITY:
                            ocr_warnings.append(f"Quantity OCR error: {line_item['quantity']:.0f} → capped to {MAX_QUANTITY:.0f}")
                            logger.warning(f"Capping quantity {line_item['quantity']} to {MAX_QUANTITY}")
                            line_item["quantity"] = MAX_QUANTITY
                        if line_item.get("unit_price") and line_item["unit_price"] > MAX_PRICE:
                            ocr_warnings.append(f"Unit price OCR error: {line_item['unit_price']:.2f} → capped to {MAX_PRICE:.0f}")
                            logger.warning(f"Capping unit_price {line_item['unit_price']} to {MAX_PRICE}")
                            line_item["unit_price"] = MAX_PRICE
                        if line_item.get("amount") and line_item["amount"] > MAX_PRICE:
                            ocr_warnings.append(f"Amount OCR error: {line_item['amount']:.2f} → capped to {MAX_PRICE:.0f}")
                            logger.warning(f"Capping amount {line_item['amount']} to {MAX_PRICE}")
                            line_item["amount"] = MAX_PRICE
                        if line_item.get("unit_size") and line_item["unit_size"] > MAX_UNIT_SIZE:
                            ocr_warnings.append(f"Unit size OCR error: {line_item['unit_size']:.0f} → capped to {MAX_UNIT_SIZE:.0f}")
                            logger.warning(f"Capping unit_size {line_item['unit_size']} to {MAX_UNIT_SIZE}")
                            line_item["unit_size"] = MAX_UNIT_SIZE
                        if line_item.get("pack_quantity") and line_item["pack_quantity"] > MAX_PACK_QTY:
                            ocr_warnings.append(f"Pack qty OCR error: {line_item['pack_quantity']} → capped to {MAX_PACK_QTY}")
                            logger.warning(f"Capping pack_quantity {line_item['pack_quantity']} to {MAX_PACK_QTY}")
                            line_item["pack_quantity"] = MAX_PACK_QTY

                        # Track product code fallback extraction
                        if line_item.get("product_code_fallback"):
                            ocr_warnings.append(f"SKU extracted from raw content: {line_item['product_code']}")

                        # Store warnings in line item
                        if ocr_warnings:
                            line_item["ocr_warnings"] = "; ".join(ocr_warnings)

                        # Calculate cost per item if we have pack_quantity and unit_price
                        if pack_info["pack_quantity"] and line_item.get("unit_price"):
                            line_item["cost_per_item"] = round(
                                line_item["unit_price"] / pack_info["pack_quantity"], 4
                            )
                            # cost_per_portion NOT calculated here - requires portions_per_unit
                            # which is defined via product_definitions or manual entry
                            line_item["cost_per_portion"] = None

                        # Filter subtotal rows if enabled
                        # Must check ALL THREE conditions: has "Total" in description, no product_code, no quantity
                        if filter_subtotal_rows:
                            desc = (line_item.get("description") or "").lower()
                            has_total_keyword = "sub total" in desc or desc.endswith("total")
                            no_product_code = not line_item.get("product_code")
                            no_quantity = line_item.get("quantity") is None

                            if has_total_keyword and no_product_code and no_quantity:
                                logger.debug(f"Filtered subtotal row: {line_item.get('description')}")
                                continue  # Skip this item

                        # Weight-based quantity adjustment for KG items
                        # When enabled: if unit is KG and qty × price ≠ amount, look for weight in raw_content
                        if use_weight_as_quantity:
                            unit = (line_item.get("unit") or "").upper()
                            qty = line_item.get("quantity")
                            price = line_item.get("unit_price")
                            amount = line_item.get("amount")

                            # Only process KG items with all values present
                            if unit == "KG" and qty is not None and price is not None and amount is not None:
                                # Check if current qty × price matches amount (with tolerance)
                                expected = qty * price
                                if abs(expected - amount) > 0.02:  # Mismatch detected
                                    # Try to parse weight from raw_content
                                    raw = line_item.get("raw_content") or ""
                                    # Pattern: weight on its own line (after newline) with space before KG
                                    # This avoids matching product sizes like "1.25-1.65KG" in descriptions
                                    weight_match = re.search(r'\n(\d+\.\d+)\s+KG', raw, re.IGNORECASE)
                                    # Fallback: try matching at start of content (if weight is first)
                                    if not weight_match:
                                        weight_match = re.search(r'^(\d+\.\d+)\s+KG', raw, re.IGNORECASE)

                                    if weight_match:
                                        weight = float(weight_match.group(1))
                                        # Validate: weight × price should equal amount
                                        weight_expected = weight * price
                                        if abs(weight_expected - amount) <= 0.02:  # Match!
                                            logger.info(f"Weight adjustment: qty {qty} -> {weight} KG (validated: {weight} × {price} = {amount})")
                                            # Move original qty to order_quantity, use weight as quantity
                                            line_item["order_quantity"] = qty
                                            line_item["quantity"] = weight
                                        else:
                                            logger.debug(f"Weight {weight} × price {price} = {weight_expected} doesn't match amount {amount}, keeping original qty")
                                    else:
                                        logger.debug(f"No weight pattern found in raw_content for KG item with qty mismatch")

                        line_items.append(line_item)
                        desc_preview = (line_item.get('description') or 'N/A')[:30]
                        logger.debug(f"Line item {item_idx}: {desc_preview} - "
                                    f"qty={line_item.get('quantity')} amt={line_item.get('amount')}")
                    except Exception as item_err:
                        logger.warning(f"Error processing line item {item_idx}: {item_err}")

    # Calculate average confidence from extracted fields
    # Collect confidence scores from key fields that were actually extracted
    confidence_scores = []

    if "InvoiceId" in fields and fields["InvoiceId"] and hasattr(fields["InvoiceId"], 'confidence'):
        confidence_scores.append(fields["InvoiceId"].confidence)

    if "InvoiceDate" in fields and fields["InvoiceDate"] and hasattr(fields["InvoiceDate"], 'confidence'):
        confidence_scores.append(fields["InvoiceDate"].confidence)

    if "InvoiceTotal" in fields and fields["InvoiceTotal"] and hasattr(fields["InvoiceTotal"], 'confidence'):
        confidence_scores.append(fields["InvoiceTotal"].confidence)

    if "SubTotal" in fields and fields["SubTotal"] and hasattr(fields["SubTotal"], 'confidence'):
        confidence_scores.append(fields["SubTotal"].confidence)

    if "VendorName" in fields and fields["VendorName"] and hasattr(fields["VendorName"], 'confidence'):
        confidence_scores.append(fields["VendorName"].confidence)

    if "PurchaseOrder" in fields and fields["PurchaseOrder"] and hasattr(fields["PurchaseOrder"], 'confidence'):
        confidence_scores.append(fields["PurchaseOrder"].confidence)

    # Calculate average confidence from extracted fields
    if confidence_scores:
        confidence = sum(confidence_scores) / len(confidence_scores)
        logger.debug(f"Average field confidence: {confidence:.2%} from {len(confidence_scores)} fields")
    else:
        # Fallback to document-level confidence if no field confidences available
        confidence = invoice.confidence if hasattr(invoice, 'confidence') else 0.9
        logger.debug(f"Using document confidence: {confidence:.2%} (no field confidences)")

    # Detect document type (invoice vs credit note)
    document_type = "invoice"  # default

    # Check Azure's doc_type field
    if hasattr(invoice, 'doc_type') and invoice.doc_type:
        doc_type_str = str(invoice.doc_type).lower()
        if 'credit' in doc_type_str:
            document_type = "credit_note"
            logger.debug(f"Detected credit note from Azure doc_type: {invoice.doc_type}")

    # Check for negative total (strong indicator of credit note)
    if total is not None and total < 0:
        document_type = "credit_note"
        logger.debug(f"Detected credit note from negative total: {total}")
    elif net_total is not None and net_total < 0:
        document_type = "credit_note"
        logger.debug(f"Detected credit note from negative net_total: {net_total}")

    # Check for credit note keywords in invoice number
    if invoice_number:
        inv_num_upper = invoice_number.upper()
        credit_keywords = ['CREDIT', 'CR NOTE', 'CN', 'CREDIT NOTE', 'C/N']
        if any(keyword in inv_num_upper for keyword in credit_keywords):
            document_type = "credit_note"
            logger.debug(f"Detected credit note from invoice number keywords: {invoice_number}")

    logger.info(f"Azure extracted: invoice_number={invoice_number}, date={invoice_date}, "
                f"total={total}, net_total={net_total}, vendor={vendor_name}, order={order_number}, "
                f"{len(line_items)} total line items from {doc_count} documents, "
                f"document_type={document_type}, confidence={confidence:.2%}")

    return {
        "invoice_number": invoice_number,
        "invoice_date": invoice_date,
        "total": total,
        "net_total": net_total,
        "vendor_name": vendor_name,
        "order_number": order_number,
        "document_type": document_type,
        "line_items": line_items,
        "raw_text": result.content or "",
        "raw_json": raw_json,
        "confidence": confidence
    }
