"""
Stock History Service for detecting stock status changes.

Similar to price history, this tracks whether items have been marked as non-stock
in the past and warns when the status conflicts with history.
"""
import logging
from datetime import date, timedelta
from typing import Optional, List
from dataclasses import dataclass
from sqlalchemy import select, and_, desc, func
from sqlalchemy.ext.asyncio import AsyncSession

from models.invoice import Invoice
from models.line_item import LineItem

logger = logging.getLogger(__name__)


def normalize_description(description: Optional[str]) -> Optional[str]:
    """
    Normalize description by taking only the first line.
    """
    if not description:
        return description
    return description.split('\n')[0].strip()


@dataclass
class StockStatusHistory:
    """Stock status history result for a line item."""
    has_history: bool
    previously_non_stock: bool
    total_occurrences: int
    non_stock_occurrences: int
    most_recent_status: Optional[bool] = None  # is_non_stock value


class StockHistoryService:
    """Service for stock status history and conflict detection."""

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def get_stock_status_history(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        unit: Optional[str] = None,
        lookback_days: int = 90,
        exclude_invoice_id: Optional[int] = None
    ) -> StockStatusHistory:
        """
        Get stock status history for a line item.

        Returns information about whether this item has been marked as non-stock
        in previous invoices.

        Args:
            supplier_id: Supplier ID
            product_code: Product code (may be None)
            description: Description (used if no product_code)
            unit: Unit (Box, Each, Kg, etc.)
            lookback_days: How far back to check (default 90 days)
            exclude_invoice_id: Exclude a specific invoice (typically current invoice)

        Returns:
            StockStatusHistory with conflict information
        """
        cutoff_date = date.today() - timedelta(days=lookback_days)

        # Build conditions for matching product
        conditions = [
            Invoice.kitchen_id == self.kitchen_id,
            LineItem.invoice_id == Invoice.id,
            Invoice.supplier_id == supplier_id,
            Invoice.invoice_date >= cutoff_date,
        ]

        # Match by product_code if available, otherwise by description
        if product_code:
            conditions.append(LineItem.product_code == product_code)
        else:
            conditions.append(LineItem.product_code.is_(None))
            if description:
                # Normalize description to first line only for matching
                normalized_desc = normalize_description(description)
                # Match against first line of stored descriptions
                conditions.append(
                    func.split_part(LineItem.description, '\n', 1) == normalized_desc
                )

        # Match by unit - critical for products sold in different units
        if unit:
            conditions.append(LineItem.unit == unit)
        else:
            conditions.append(LineItem.unit.is_(None))

        # Exclude current invoice if provided
        if exclude_invoice_id:
            conditions.append(Invoice.id != exclude_invoice_id)

        # Get all matching line items
        result = await self.db.execute(
            select(LineItem.is_non_stock, Invoice.invoice_date)
            .where(and_(*conditions))
            .order_by(desc(Invoice.invoice_date))
        )
        rows = result.fetchall()

        if not rows:
            return StockStatusHistory(
                has_history=False,
                previously_non_stock=False,
                total_occurrences=0,
                non_stock_occurrences=0
            )

        # Count occurrences
        total_occurrences = len(rows)
        non_stock_occurrences = sum(1 for row in rows if row[0])  # is_non_stock=True
        most_recent_status = rows[0][0]  # Most recent is_non_stock value

        # Previously marked as non-stock if ANY previous occurrence was non-stock
        previously_non_stock = non_stock_occurrences > 0

        return StockStatusHistory(
            has_history=True,
            previously_non_stock=previously_non_stock,
            total_occurrences=total_occurrences,
            non_stock_occurrences=non_stock_occurrences,
            most_recent_status=most_recent_status
        )

    async def check_all_line_items(
        self,
        invoice_id: int,
        lookback_days: int = 90
    ) -> dict[int, StockStatusHistory]:
        """
        Check stock status history for all line items in an invoice.

        Returns:
            Dict mapping line_item_id to StockStatusHistory
        """
        # Get all line items for this invoice
        result = await self.db.execute(
            select(LineItem, Invoice.supplier_id)
            .join(Invoice, LineItem.invoice_id == Invoice.id)
            .where(
                and_(
                    LineItem.invoice_id == invoice_id,
                    Invoice.kitchen_id == self.kitchen_id
                )
            )
        )
        rows = result.fetchall()

        history_map = {}
        for line_item, supplier_id in rows:
            history = await self.get_stock_status_history(
                supplier_id=supplier_id,
                product_code=line_item.product_code,
                description=line_item.description,
                unit=line_item.unit,
                lookback_days=lookback_days,
                exclude_invoice_id=invoice_id
            )
            history_map[line_item.id] = history

        return history_map
