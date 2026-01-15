from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from database import Base


class FieldMapping(Base):
    """
    Maps supplier-specific field names to standard invoice/line item fields.

    For example, if a supplier's invoices have "Document No" instead of "Invoice ID",
    we can create a mapping:
        source_field="Document No" -> target_field="invoice_number"

    Field types:
        - invoice: Maps to Invoice model fields (invoice_number, invoice_date, total, etc.)
        - line_item: Maps to LineItem model fields (description, quantity, amount, etc.)
    """
    __tablename__ = "field_mappings"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    # Can be kitchen-wide (supplier_id=null) or supplier-specific
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"), nullable=False)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), nullable=True)

    # The field name as it appears in the Azure OCR response
    source_field: Mapped[str] = mapped_column(String(100), nullable=False)

    # The target field in our model (e.g., "invoice_number", "description", "amount")
    target_field: Mapped[str] = mapped_column(String(100), nullable=False)

    # Field type: "invoice" or "line_item"
    field_type: Mapped[str] = mapped_column(String(20), default="invoice")

    # Optional transformation (for future use): "direct", "date", "currency", "number"
    transform: Mapped[str] = mapped_column(String(50), default="direct")

    # Priority for applying mappings (higher = applied first)
    priority: Mapped[int] = mapped_column(Integer, default=0)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    kitchen: Mapped["Kitchen"] = relationship("Kitchen")
    supplier: Mapped["Supplier"] = relationship("Supplier")


# Standard Azure field names for reference
AZURE_INVOICE_FIELDS = [
    "InvoiceId",
    "InvoiceDate",
    "InvoiceTotal",
    "SubTotal",
    "TotalTax",
    "AmountDue",
    "VendorName",
    "VendorAddress",
    "CustomerName",
    "CustomerAddress",
    "PurchaseOrder",
    "DueDate",
    "ServiceDate",
    "ServiceStartDate",
    "ServiceEndDate",
]

AZURE_LINE_ITEM_FIELDS = [
    "Description",
    "Quantity",
    "UnitPrice",
    "Amount",
    "ProductCode",
    "Unit",
    "Date",
    "Tax",
]

# Our target fields
TARGET_INVOICE_FIELDS = [
    "invoice_number",
    "invoice_date",
    "total",
    "net_total",
    "vendor_name",
    "order_number",
]

TARGET_LINE_ITEM_FIELDS = [
    "description",
    "quantity",
    "unit_price",
    "amount",
    "product_code",
]


from .user import Kitchen
from .supplier import Supplier
