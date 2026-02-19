"""
Price History Service for price change detection and history tracking.

This service is used by:
- Search pages for showing price change indicators
- Invoice review for line item price status
- History modal for viewing price trends
"""
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, Tuple, List
from dataclasses import dataclass
from sqlalchemy import select, func, and_, or_, desc
from sqlalchemy.ext.asyncio import AsyncSession

from models.invoice import Invoice
from models.line_item import LineItem
from models.supplier import Supplier
from models.settings import KitchenSettings
from models.acknowledged_price import AcknowledgedPrice

logger = logging.getLogger(__name__)


def normalize_description(description: Optional[str]) -> Optional[str]:
    """
    Normalize description by taking only the first line.
    Many descriptions have newlines and additional details,
    but for matching purposes we only want the first line.
    """
    if not description:
        return description
    # Take everything before the first newline
    return description.split('\n')[0].strip()


@dataclass
class PriceHistoryPoint:
    """Single point in price history."""
    date: date
    price: Decimal
    invoice_id: int
    invoice_number: Optional[str]
    quantity: Optional[Decimal] = None


@dataclass
class PriceStatus:
    """Price status result for a line item."""
    status: str  # "consistent", "no_history", "amber", "red", "acknowledged"
    previous_price: Optional[Decimal] = None
    change_percent: Optional[float] = None
    acknowledged_price: Optional[Decimal] = None
    # Future price info (for old invoices)
    future_price: Optional[Decimal] = None
    future_change_percent: Optional[float] = None


@dataclass
class LineItemHistory:
    """Full history data for a line item."""
    product_code: Optional[str]
    description: Optional[str]
    supplier_id: int
    supplier_name: Optional[str]
    # Price history for charting
    price_history: List[PriceHistoryPoint]
    # Stats
    total_occurrences: int
    total_quantity: Decimal
    avg_qty_per_invoice: Decimal
    avg_qty_per_week: Decimal
    avg_qty_per_month: Decimal
    # Current status
    current_price: Optional[Decimal]
    price_change_status: str


class PriceHistoryService:
    """Service for price history and change detection."""

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id

    async def _get_settings(self) -> Optional[KitchenSettings]:
        """Get kitchen settings for price thresholds."""
        result = await self.db.execute(
            select(KitchenSettings).where(
                KitchenSettings.kitchen_id == self.kitchen_id
            )
        )
        return result.scalar_one_or_none()

    async def _get_acknowledged_price(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str]
    ) -> Optional[AcknowledgedPrice]:
        """Get acknowledged price for a product if it exists."""
        # Build query - need to handle NULL values in comparison
        conditions = [
            AcknowledgedPrice.kitchen_id == self.kitchen_id,
            AcknowledgedPrice.supplier_id == supplier_id,
        ]

        # Handle product_code - compare with IS NULL for None
        if product_code:
            conditions.append(AcknowledgedPrice.product_code == product_code)
        else:
            conditions.append(AcknowledgedPrice.product_code.is_(None))

        # Handle description - compare with IS NULL for None
        if description:
            conditions.append(AcknowledgedPrice.description == description)
        else:
            conditions.append(AcknowledgedPrice.description.is_(None))

        result = await self.db.execute(
            select(AcknowledgedPrice).where(and_(*conditions))
        )
        return result.scalar_one_or_none()

    async def _get_previous_prices(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        unit: Optional[str],
        lookback_days: int,
        exclude_invoice_id: Optional[int] = None,
        reference_date: Optional[date] = None
    ) -> List[Tuple[Decimal, date]]:
        """Get previous prices for a product within lookback period."""
        # Use reference_date if provided (invoice date), otherwise use today
        ref_date = reference_date or date.today()
        cutoff_date = ref_date - timedelta(days=lookback_days)

        # Build conditions for matching product
        conditions = [
            Invoice.kitchen_id == self.kitchen_id,
            LineItem.invoice_id == Invoice.id,
            Invoice.supplier_id == supplier_id,
            Invoice.invoice_date >= cutoff_date,
            LineItem.unit_price.isnot(None),
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

        # Match by unit - critical for products sold in different units (Box, Each, Kg, etc.)
        if unit:
            conditions.append(LineItem.unit == unit)
        else:
            conditions.append(LineItem.unit.is_(None))

        # Exclude current invoice if provided
        if exclude_invoice_id:
            conditions.append(Invoice.id != exclude_invoice_id)

        result = await self.db.execute(
            select(LineItem.unit_price, Invoice.invoice_date)
            .where(and_(*conditions))
            .order_by(desc(Invoice.invoice_date))
        )

        return [(row[0], row[1]) for row in result.fetchall()]

    async def _get_future_prices(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        unit: Optional[str],
        reference_date: date,
        exclude_invoice_id: Optional[int] = None
    ) -> List[Tuple[Decimal, date]]:
        """Get future prices for a product (after reference_date)."""
        # Build conditions for matching product
        conditions = [
            Invoice.kitchen_id == self.kitchen_id,
            LineItem.invoice_id == Invoice.id,
            Invoice.supplier_id == supplier_id,
            Invoice.invoice_date > reference_date,
            LineItem.unit_price.isnot(None),
        ]

        # Match by product_code if available, otherwise by description
        if product_code:
            conditions.append(LineItem.product_code == product_code)
        else:
            conditions.append(LineItem.product_code.is_(None))
            if description:
                normalized_desc = normalize_description(description)
                conditions.append(
                    func.split_part(LineItem.description, '\n', 1) == normalized_desc
                )

        # Match by unit
        if unit:
            conditions.append(LineItem.unit == unit)
        else:
            conditions.append(LineItem.unit.is_(None))

        # Exclude current invoice if provided
        if exclude_invoice_id:
            conditions.append(Invoice.id != exclude_invoice_id)

        result = await self.db.execute(
            select(LineItem.unit_price, Invoice.invoice_date)
            .where(and_(*conditions))
            .order_by(desc(Invoice.invoice_date))
        )

        return [(row[0], row[1]) for row in result.fetchall()]

    async def get_price_status(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        current_price: Decimal,
        unit: Optional[str] = None,
        current_invoice_id: Optional[int] = None,
        reference_date: Optional[date] = None,
        lookback_days: Optional[int] = None,
        amber_threshold: Optional[int] = None,
        red_threshold: Optional[int] = None,
    ) -> PriceStatus:
        """
        Get price status for a line item.

        Returns:
            PriceStatus with:
            - "consistent": Price matches history (green tick)
            - "no_history": First time seeing this item (no icon)
            - "amber": Small price change within threshold
            - "red": Large price change above threshold
            - "acknowledged": Price was flagged but user acknowledged it
        """
        # Get settings if thresholds not provided
        if lookback_days is None or amber_threshold is None or red_threshold is None:
            settings = await self._get_settings()
            lookback_days = lookback_days or (settings.price_change_lookback_days if settings else 30)
            amber_threshold = amber_threshold or (settings.price_change_amber_threshold if settings else 10)
            red_threshold = red_threshold or (settings.price_change_red_threshold if settings else 20)

        # Get previous prices
        previous_prices = await self._get_previous_prices(
            supplier_id, product_code, description, unit, lookback_days, current_invoice_id, reference_date
        )

        # Get future prices (if viewing an old invoice)
        future_price = None
        future_change_percent = None
        if reference_date:
            future_prices = await self._get_future_prices(
                supplier_id, product_code, description, unit, reference_date, current_invoice_id
            )
            if future_prices:
                future_price = future_prices[0][0]  # Most recent future price
                if future_price and future_price != 0:
                    future_change_percent = float((future_price - current_price) / current_price * 100)

        if not previous_prices:
            return PriceStatus(
                status="no_history",
                future_price=future_price,
                future_change_percent=future_change_percent
            )

        # Get most recent previous price
        previous_price = previous_prices[0][0]

        # Calculate change percentage
        if previous_price and previous_price != 0:
            change_percent = float((current_price - previous_price) / previous_price * 100)
        else:
            change_percent = 0.0

        # If there's a future price change, suppress regular price change indicator
        # (only show the grey future price indicator)
        # But still include previous_price/change_percent so price history button works
        if future_price and future_change_percent is not None:
            return PriceStatus(
                status="consistent",  # Hide regular indicator
                previous_price=previous_price,
                change_percent=change_percent,
                future_price=future_price,
                future_change_percent=future_change_percent
            )

        abs_change = abs(change_percent)

        # Check if price is acknowledged
        acknowledged = await self._get_acknowledged_price(
            supplier_id, product_code, description
        )

        if acknowledged and acknowledged.acknowledged_price == current_price:
            return PriceStatus(
                status="acknowledged",
                previous_price=previous_price,
                change_percent=change_percent,
                acknowledged_price=acknowledged.acknowledged_price,
                future_price=future_price,
                future_change_percent=future_change_percent
            )

        # Determine status based on change
        if abs_change <= 0.01:  # Essentially no change (floating point tolerance)
            return PriceStatus(
                status="consistent",
                previous_price=previous_price,
                change_percent=0.0,
                future_price=future_price,
                future_change_percent=future_change_percent
            )
        elif abs_change <= red_threshold:
            return PriceStatus(
                status="amber",  # Any change > 0.01% up to red threshold shows amber
                previous_price=previous_price,
                change_percent=change_percent,
                future_price=future_price,
                future_change_percent=future_change_percent
            )
        else:
            return PriceStatus(
                status="red",
                previous_price=previous_price,
                change_percent=change_percent,
                future_price=future_price,
                future_change_percent=future_change_percent
            )

    async def get_history(
        self,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        unit: Optional[str] = None,
        date_from: Optional[date] = None,
        date_to: Optional[date] = None,
    ) -> LineItemHistory:
        """
        Get full history for a product including price history and quantity stats.

        Args:
            supplier_id: Supplier ID
            product_code: Product code (may be None)
            description: Description (used if no product_code)
            unit: Unit (Box, Each, Kg, etc.)
            date_from: Start date (default: 12 months ago)
            date_to: End date (default: today)

        Returns:
            LineItemHistory with price history and stats
        """
        # Default date range: 12 months
        if date_to is None:
            date_to = date.today()
        if date_from is None:
            date_from = date_to - timedelta(days=365)

        # Build conditions for matching product
        conditions = [
            Invoice.kitchen_id == self.kitchen_id,
            LineItem.invoice_id == Invoice.id,
            Invoice.supplier_id == supplier_id,
            Invoice.invoice_date >= date_from,
            Invoice.invoice_date <= date_to,
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

        # Get price history points
        result = await self.db.execute(
            select(
                Invoice.invoice_date,
                LineItem.unit_price,
                LineItem.quantity,
                Invoice.id,
                Invoice.invoice_number
            )
            .where(and_(*conditions))
            .order_by(Invoice.invoice_date)
        )
        rows = result.fetchall()

        price_history = []
        total_qty = Decimal(0)
        total_occurrences = 0
        current_price = None

        for row in rows:
            inv_date, unit_price, qty, inv_id, inv_num = row
            if unit_price is not None:
                price_history.append(PriceHistoryPoint(
                    date=inv_date,
                    price=unit_price,
                    invoice_id=inv_id,
                    invoice_number=inv_num,
                    quantity=qty
                ))
                current_price = unit_price
            if qty:
                total_qty += qty
            total_occurrences += 1

        # Calculate averages
        avg_qty_per_invoice = total_qty / total_occurrences if total_occurrences > 0 else Decimal(0)

        # Calculate weeks and months in period
        days_in_period = (date_to - date_from).days or 1
        weeks_in_period = max(days_in_period / 7, 1)
        months_in_period = max(days_in_period / 30, 1)

        avg_qty_per_week = total_qty / Decimal(str(weeks_in_period))
        avg_qty_per_month = total_qty / Decimal(str(months_in_period))

        # Get supplier name
        supplier_result = await self.db.execute(
            select(Supplier.name).where(Supplier.id == supplier_id)
        )
        supplier_name = supplier_result.scalar_one_or_none()

        # Determine price change status for current price
        if current_price and len(price_history) > 1:
            status = await self.get_price_status(
                supplier_id, product_code, description, current_price, unit
            )
            price_change_status = status.status
        else:
            price_change_status = "no_history" if not price_history else "consistent"

        return LineItemHistory(
            product_code=product_code,
            description=description,
            supplier_id=supplier_id,
            supplier_name=supplier_name,
            price_history=price_history,
            total_occurrences=total_occurrences,
            total_quantity=total_qty,
            avg_qty_per_invoice=avg_qty_per_invoice,
            avg_qty_per_week=avg_qty_per_week,
            avg_qty_per_month=avg_qty_per_month,
            current_price=current_price,
            price_change_status=price_change_status
        )

    async def acknowledge_price(
        self,
        user_id: int,
        supplier_id: int,
        product_code: Optional[str],
        description: Optional[str],
        new_price: Decimal,
        source_invoice_id: Optional[int] = None,
        source_line_item_id: Optional[int] = None,
    ) -> AcknowledgedPrice:
        """
        Acknowledge a price change for a product.

        Creates or updates the AcknowledgedPrice record so the price
        won't be flagged in future.
        """
        # Check if already exists
        existing = await self._get_acknowledged_price(
            supplier_id, product_code, description
        )

        if existing:
            # Update existing record
            existing.acknowledged_price = new_price
            existing.acknowledged_at = datetime.utcnow()
            existing.acknowledged_by_user_id = user_id
            existing.source_invoice_id = source_invoice_id
            existing.source_line_item_id = source_line_item_id
            await self.db.commit()
            return existing
        else:
            # Create new record
            acknowledged = AcknowledgedPrice(
                kitchen_id=self.kitchen_id,
                supplier_id=supplier_id,
                product_code=product_code,
                description=description,
                acknowledged_price=new_price,
                acknowledged_by_user_id=user_id,
                source_invoice_id=source_invoice_id,
                source_line_item_id=source_line_item_id
            )
            self.db.add(acknowledged)
            await self.db.commit()
            await self.db.refresh(acknowledged)
            return acknowledged

    async def get_consolidated_line_items(
        self,
        search_query: Optional[str] = None,
        supplier_id: Optional[int] = None,
        date_from: Optional[date] = None,
        date_to: Optional[date] = None,
        limit: int = 100,
        offset: int = 0
    ) -> Tuple[List[dict], int]:
        """
        Get consolidated line items for search results.

        Groups line items by (product_code OR description) + supplier,
        returning most recent price, total quantity, occurrence count, etc.

        Returns:
            (list of consolidated items, total count)
        """
        # Build base conditions — search all history unless dates explicitly provided
        conditions = [
            Invoice.kitchen_id == self.kitchen_id,
            LineItem.invoice_id == Invoice.id,
        ]

        if date_from is not None:
            conditions.append(Invoice.invoice_date >= date_from)
        if date_to is not None:
            conditions.append(Invoice.invoice_date <= date_to)

        if supplier_id:
            conditions.append(Invoice.supplier_id == supplier_id)

        if search_query:
            # Split into words so "Cod Fillet" matches "COD: FILLET 1-2KG SCALED BONED"
            words = search_query.strip().split()
            if len(words) == 1:
                search_pattern = f"%{words[0]}%"
                conditions.append(or_(
                    LineItem.product_code.ilike(search_pattern),
                    LineItem.description.ilike(search_pattern)
                ))
            else:
                # All words must appear in description (or exact phrase matches product_code)
                word_conditions = []
                for word in words:
                    word_conditions.append(LineItem.description.ilike(f"%{word}%"))
                conditions.append(or_(
                    and_(*word_conditions),
                    LineItem.product_code.ilike(f"%{search_query}%")
                ))

        # Build query for consolidated items using subquery
        # We need to group by product identity and get aggregates

        # First, get the consolidation key and aggregates
        from sqlalchemy import case, literal_column

        # Create expression for first line of description (reuse this in SELECT and GROUP BY)
        desc_first_line = func.split_part(LineItem.description, '\n', 1)

        # Create a composite key for grouping
        # Use first line of description only for grouping
        consolidation_key = func.concat(
            func.coalesce(LineItem.product_code, ''),
            '||',
            func.coalesce(desc_first_line, ''),
            '||',
            func.cast(Invoice.supplier_id, String)
        )

        # Get aggregated data
        # Note: We don't group by unit since the same product may have slightly different
        # unit values across invoices. We'll pick the most recent unit in the detail query.
        agg_query = (
            select(
                LineItem.product_code,
                desc_first_line.label('description'),
                Invoice.supplier_id,
                Supplier.name.label('supplier_name'),
                func.sum(LineItem.quantity).label('total_quantity'),
                func.count(LineItem.id).label('occurrence_count'),
                func.max(Invoice.invoice_date).label('most_recent_date'),
            )
            .select_from(LineItem)
            .join(Invoice, LineItem.invoice_id == Invoice.id)
            .join(Supplier, Invoice.supplier_id == Supplier.id)
            .where(and_(*conditions))
            .group_by(
                LineItem.product_code,
                desc_first_line,
                Invoice.supplier_id,
                Supplier.name,
            )
        )

        # Get total count
        count_subquery = agg_query.subquery()
        count_result = await self.db.execute(
            select(func.count()).select_from(count_subquery)
        )
        total_count = count_result.scalar() or 0

        # Get paginated results
        agg_result = await self.db.execute(
            agg_query.order_by(desc('most_recent_date')).limit(limit).offset(offset)
        )
        rows = agg_result.fetchall()

        # Build result list with additional data
        items = []
        for row in rows:
            product_code = row.product_code
            description = row.description
            supplier_id_val = row.supplier_id

            # Get most recent price, invoice info, and unit
            # Match by first line of description only
            recent_conditions = [
                Invoice.kitchen_id == self.kitchen_id,
                LineItem.invoice_id == Invoice.id,
                Invoice.supplier_id == supplier_id_val,
                LineItem.product_code == product_code if product_code else LineItem.product_code.is_(None),
            ]
            if description:
                recent_conditions.append(
                    func.split_part(LineItem.description, '\n', 1) == description
                )

            recent_query = (
                select(
                    LineItem.unit_price,
                    Invoice.id,
                    Invoice.invoice_number,
                    LineItem.unit,
                    LineItem.id.label('line_item_id'),
                    LineItem.line_number,
                    LineItem.raw_content,
                    LineItem.pack_quantity.label('li_pack_quantity'),
                    LineItem.unit_size,
                    LineItem.unit_size_type,
                )
                .where(and_(*recent_conditions))
                .order_by(desc(Invoice.invoice_date))
                .limit(1)
            )
            recent_result = await self.db.execute(recent_query)
            recent_row = recent_result.fetchone()

            most_recent_price = recent_row[0] if recent_row else None
            most_recent_invoice_id = recent_row[1] if recent_row else None
            most_recent_invoice_number = recent_row[2] if recent_row else None
            unit = recent_row[3] if recent_row else None
            most_recent_line_item_id = recent_row[4] if recent_row else None
            most_recent_line_number = recent_row[5] if recent_row else None
            most_recent_raw_content = recent_row[6] if recent_row else None
            most_recent_pack_quantity = recent_row[7] if recent_row else None
            most_recent_unit_size = recent_row[8] if recent_row else None
            most_recent_unit_size_type = recent_row[9] if recent_row else None

            # Get earliest price in period for change detection
            # Only when date range is provided (skip for undated searches like IngredientModal)
            price_change_percent = None
            price_change_status = "no_history"
            earliest_price = None

            if date_from is not None and date_to is not None:
                # Match by first line of description only
                earliest_conditions = [
                    Invoice.kitchen_id == self.kitchen_id,
                    LineItem.invoice_id == Invoice.id,
                    Invoice.supplier_id == supplier_id_val,
                    Invoice.invoice_date >= date_from,
                    Invoice.invoice_date <= date_to,
                    LineItem.product_code == product_code if product_code else LineItem.product_code.is_(None),
                ]
                if description:
                    earliest_conditions.append(
                        func.split_part(LineItem.description, '\n', 1) == description
                    )

                earliest_query = (
                    select(LineItem.unit_price)
                    .where(and_(*earliest_conditions))
                    .order_by(Invoice.invoice_date)
                    .limit(1)
                )
                earliest_result = await self.db.execute(earliest_query)
                earliest_row = earliest_result.fetchone()
                earliest_price = earliest_row[0] if earliest_row else None

                if most_recent_price is not None and earliest_price is not None:
                    if earliest_price != 0:
                        price_change_percent = float(
                            (most_recent_price - earliest_price) / earliest_price * 100
                        )

                    # Get price status
                    # Extend lookback to ensure we have history beyond the search period
                    if most_recent_price:
                        # Calculate extended lookback: search period + configured lookback days
                        search_period_days = (date_to - date_from).days
                        extended_lookback = search_period_days + 30  # Add configured lookback on top

                        status = await self.get_price_status(
                            supplier_id_val, product_code, description, most_recent_price,
                            unit=unit,
                            lookback_days=extended_lookback,
                            current_invoice_id=most_recent_invoice_id  # Exclude most recent invoice from comparison
                        )
                        price_change_status = status.status

            # Check if has definition
            from models.product_definition import ProductDefinition

            # Build conditions for definition lookup
            def_conditions = [
                ProductDefinition.kitchen_id == self.kitchen_id,
                ProductDefinition.supplier_id == supplier_id_val,
            ]

            # Match by product_code (preferred) OR description (fallback), not both
            if product_code:
                # Exact match by product_code only
                def_conditions.append(ProductDefinition.product_code == product_code)
            else:
                # Match by description, but ONLY definitions without product_code
                def_conditions.append(ProductDefinition.product_code.is_(None))
                if description:
                    def_conditions.append(ProductDefinition.description_pattern == description)

            def_query = (
                select(ProductDefinition.portions_per_unit, ProductDefinition.pack_quantity)
                .where(and_(*def_conditions))
                .limit(1)
            )
            def_result = await self.db.execute(def_query)
            def_row = def_result.fetchone()

            # Look up ingredient source mapping
            from models.ingredient import Ingredient, IngredientSource

            src_conditions = [
                IngredientSource.kitchen_id == self.kitchen_id,
                IngredientSource.supplier_id == supplier_id_val,
            ]

            # Match by product_code (preferred) OR description_pattern (fallback)
            if product_code:
                src_conditions.append(IngredientSource.product_code == product_code)
            else:
                src_conditions.append(IngredientSource.product_code.is_(None))
                if description:
                    src_conditions.append(func.lower(IngredientSource.description_pattern) == description.lower())

            src_query = (
                select(
                    IngredientSource.ingredient_id,
                    Ingredient.name.label('ingredient_name'),
                    Ingredient.standard_unit.label('ingredient_standard_unit'),
                    IngredientSource.price_per_std_unit,
                )
                .join(Ingredient, IngredientSource.ingredient_id == Ingredient.id)
                .where(and_(*src_conditions))
                .limit(1)
            )
            src_result = await self.db.execute(src_query)
            src_row = src_result.fetchone()

            items.append({
                'product_code': product_code,
                'description': description,
                'supplier_id': supplier_id_val,
                'supplier_name': row.supplier_name,
                'unit': unit,
                'most_recent_price': most_recent_price,
                'earliest_price_in_period': earliest_price,
                'price_change_percent': price_change_percent,
                'price_change_status': price_change_status,
                'total_quantity': row.total_quantity,
                'occurrence_count': row.occurrence_count,
                'most_recent_invoice_id': most_recent_invoice_id,
                'most_recent_invoice_number': most_recent_invoice_number,
                'most_recent_date': row.most_recent_date,
                'has_definition': def_row is not None,
                'portions_per_unit': def_row[0] if def_row else None,
                'pack_quantity': def_row[1] if def_row else None,
                'most_recent_line_item_id': most_recent_line_item_id,
                'most_recent_line_number': most_recent_line_number,
                'most_recent_raw_content': most_recent_raw_content,
                'most_recent_pack_quantity': most_recent_pack_quantity,
                'most_recent_unit_size': most_recent_unit_size,
                'most_recent_unit_size_type': most_recent_unit_size_type,
                'ingredient_id': src_row[0] if src_row else None,
                'ingredient_name': src_row[1] if src_row else None,
                'ingredient_standard_unit': src_row[2] if src_row else None,
                'price_per_std_unit': src_row[3] if src_row else None,
            })

        return items, total_count


# Import String for cast
from sqlalchemy import String
