"""
Newbook API Client Service

Handles authentication and API calls to Newbook PMS.
Base URL: https://api.newbook.cloud/rest/
Auth: HTTP Basic Auth (username:password) + API Key + Region in request body
"""
import logging
import httpx
from datetime import date
from typing import Optional, Any
from decimal import Decimal

logger = logging.getLogger(__name__)

# Single base URL for all regions - region is passed in request body
NEWBOOK_BASE_URL = "https://api.newbook.cloud/rest/"

# Valid regions (passed in request body, not URL)
VALID_REGIONS = ["au", "ap", "eu", "us", "uk"]


class NewbookAPIError(Exception):
    """Custom exception for Newbook API errors"""
    def __init__(self, message: str, status_code: int = None, response_data: dict = None):
        self.message = message
        self.status_code = status_code
        self.response_data = response_data
        super().__init__(self.message)


class NewbookAPIClient:
    """
    Async client for Newbook REST API.

    Usage:
        async with NewbookAPIClient(username, password, api_key, region, instance_id) as client:
            accounts = await client.get_gl_accounts()
            revenue = await client.get_earned_revenue(date_from, date_to)
    """

    def __init__(
        self,
        username: str,
        password: str,
        api_key: str,
        region: str = "au",
        instance_id: str = None
    ):
        self.username = username
        self.password = password
        self.api_key = api_key
        self.region = region  # Passed in request body
        self.instance_id = instance_id
        self.base_url = NEWBOOK_BASE_URL
        self._client: httpx.AsyncClient = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            auth=(self.username, self.password),
            timeout=httpx.Timeout(30.0, connect=15.0),
            follow_redirects=True,
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()

    async def _request(self, endpoint: str, payload: dict = None) -> dict:
        """
        Make an authenticated request to Newbook API.

        All requests include api_key in the body.
        """
        if payload is None:
            payload = {}

        # Always include region and api_key in request body
        payload["region"] = self.region
        payload["api_key"] = self.api_key

        # Include instance_id if configured
        if self.instance_id:
            payload["instance_id"] = self.instance_id

        url = f"{self.base_url}{endpoint}"

        try:
            logger.info(f"Newbook API request: POST {endpoint}")
            response = await self._client.post(url, json=payload)

            if response.status_code == 401:
                raise NewbookAPIError("Authentication failed. Check username/password.", 401)

            if response.status_code == 403:
                raise NewbookAPIError("Access denied. Check API key and permissions.", 403)

            response.raise_for_status()

            data = response.json()

            # Check for Newbook-specific error responses
            if isinstance(data, dict) and data.get("success") is False:
                error_msg = data.get("message", "Unknown Newbook API error")
                raise NewbookAPIError(error_msg, response.status_code, data)

            return data

        except httpx.HTTPStatusError as e:
            logger.error(f"Newbook API HTTP error: {e.response.status_code}")
            raise NewbookAPIError(f"HTTP {e.response.status_code}: {str(e)}", e.response.status_code)
        except httpx.RequestError as e:
            logger.error(f"Newbook API request error: {e}")
            raise NewbookAPIError(f"Request failed: {str(e)}")

    async def test_connection(self) -> bool:
        """Test API connection by fetching GL accounts (lightweight call)"""
        try:
            await self.get_gl_accounts()
            return True
        except NewbookAPIError:
            return False

    async def get_gl_accounts(self) -> list[dict]:
        """
        Fetch list of GL accounts from Newbook.

        Endpoint: gl_account_list

        Note: Newbook returns individual GL accounts with group info.
        Each item has both gl_account_id/gl_account_name (individual)
        and gl_group_id/gl_group_name (category).

        Returns list of individual GL accounts with:
            - id: GL account ID (gl_account_id)
            - code: Account code
            - name: Account name (gl_account_name)
            - group_id: Parent group ID (gl_group_id)
            - group_name: Parent group name (gl_group_name)
            - type: Account type
        """
        response = await self._request("gl_account_list")

        # Normalize response format
        accounts = {}  # Use dict to dedupe by gl_account_id
        items = response.get("data", response) if isinstance(response, dict) else response

        if isinstance(items, list):
            for item in items:
                # Get individual account ID (prefer gl_account_id, fall back to id)
                gl_account_id = str(item.get("gl_account_id", item.get("id", "")))
                gl_account_name = item.get("gl_account_name", item.get("name", ""))

                # Get group info for categorization
                gl_group_id = str(item.get("gl_group_id", ""))
                gl_group_name = item.get("gl_group_name", "")

                if not gl_account_id or gl_account_id in accounts:
                    continue

                # Extract code from account name or use account ID
                code = item.get("gl_account_code", item.get("code", ""))
                if not code and " - " in gl_account_name:
                    code = gl_account_name.split(" - ")[0].strip()

                accounts[gl_account_id] = {
                    "id": gl_account_id,
                    "code": code,
                    "name": gl_account_name,
                    "group_id": gl_group_id,
                    "group_name": gl_group_name,
                    "type": item.get("gl_type", item.get("type", ""))
                }

        result = list(accounts.values())
        logger.info(f"Fetched {len(result)} GL accounts from Newbook")
        return result

    async def get_earned_revenue(
        self,
        date_from: date,
        date_to: date,
        gl_account_ids: list[str] = None
    ) -> list[dict]:
        """
        Fetch earned revenue report - requests one day at a time to get daily breakdown.

        Endpoint: reports_earned_revenue

        Note: Newbook returns period totals per GL account, not daily breakdown.
        We request each day individually to get daily revenue per GL account.
        Rate limited to ~80 requests/min to stay under Newbook's 100/min limit.

        Args:
            date_from: Start date
            date_to: End date
            gl_account_ids: Optional list of GL account IDs to filter

        Returns list of daily revenue entries:
            - date: Date (ISO string)
            - gl_account_id: GL Account ID
            - gl_account_name: GL Account name
            - amount_net: Net amount (exc tax)
            - amount_gross: Gross amount (inc tax) if available
        """
        import asyncio
        from datetime import timedelta

        revenue_entries = []
        current_date = date_from
        request_count = 0

        # Rate limit: ~80 requests/min to stay under 100/min limit
        # 0.75 seconds between requests = 80 requests/min
        RATE_LIMIT_DELAY = 0.75

        # Request each day individually to get daily breakdown
        while current_date <= date_to:
            payload = {
                "period_from": current_date.isoformat(),
                "period_to": current_date.isoformat(),
            }

            if gl_account_ids:
                payload["gl_account_ids"] = gl_account_ids

            try:
                response = await self._request("reports_earned_revenue", payload)
                request_count += 1

                items = response.get("data", response) if isinstance(response, dict) else response

                # Log first response to debug field names
                if request_count == 1:
                    logger.info(f"Earned revenue first response sample: {items[:2] if isinstance(items, list) else items}")

                if isinstance(items, list):
                    for item in items:
                        # Newbook returns: earned_revenue_ex (net), earned_revenue (gross)
                        # Also check legacy field names as fallback
                        amount_net = Decimal(str(
                            item.get("earned_revenue_ex") or
                            item.get("amount_net") or
                            item.get("amount", 0) or 0
                        ))
                        # Skip zero amounts
                        if amount_net == 0:
                            continue

                        # GL account code is in gl_account_code field
                        gl_code = str(
                            item.get("gl_account_code") or
                            item.get("gl_account_id", "")
                        )
                        gl_name = (
                            item.get("gl_account_description") or
                            item.get("gl_account_name", "")
                        )

                        entry = {
                            "date": current_date.isoformat(),
                            "gl_account_id": gl_code,  # Note: this is actually the code, not internal ID
                            "gl_account_name": gl_name,
                            "amount_net": amount_net,
                            "amount_gross": None
                        }
                        # Gross amount is earned_revenue (inc tax)
                        gross = item.get("earned_revenue") or item.get("amount_gross")
                        if gross:
                            entry["amount_gross"] = Decimal(str(gross))
                        revenue_entries.append(entry)

            except NewbookAPIError as e:
                logger.warning(f"Failed to fetch revenue for {current_date}: {e}")

            current_date += timedelta(days=1)

            # Rate limiting delay between requests
            if current_date <= date_to:
                await asyncio.sleep(RATE_LIMIT_DELAY)

        logger.info(f"Fetched {len(revenue_entries)} revenue entries from Newbook ({date_from} to {date_to}, {request_count} requests)")
        return revenue_entries

    async def get_occupancy_report(
        self,
        date_from: date,
        date_to: date
    ) -> list[dict]:
        """
        Fetch occupancy report.

        Endpoint: reports_occupancy

        Note: Newbook returns data grouped by room category. Each category has
        an 'occupancy' dict with dates as keys. We aggregate across all categories
        to get daily totals.

        Returns list of daily occupancy data:
            - date
            - total_rooms
            - occupied_rooms
            - occupancy_percentage
            - total_guests (estimated from occupied rooms)
        """
        payload = {
            "period_from": date_from.isoformat(),
            "period_to": date_to.isoformat(),
        }

        response = await self._request("reports_occupancy", payload)

        # Aggregate occupancy across all room categories by date
        daily_totals = {}  # date -> {available, occupied, maintenance, adults, children}

        items = response.get("data", response) if isinstance(response, dict) else response

        if isinstance(items, list):
            for category in items:
                # Each category has an 'occupancy' dict with dates as keys
                category_occupancy = category.get("occupancy", {})

                if isinstance(category_occupancy, dict):
                    for date_str, day_data in category_occupancy.items():
                        # Debug: log first day's data structure to see guest field format
                        if not daily_totals:
                            logger.info(f"Occupancy day_data sample keys: {list(day_data.keys()) if isinstance(day_data, dict) else 'not dict'}")
                            logger.info(f"Occupancy day_data sample: {day_data}")

                        if date_str not in daily_totals:
                            daily_totals[date_str] = {
                                "available": 0,
                                "occupied": 0,
                                "maintenance": 0,
                                "adults": 0,
                                "children": 0
                            }

                        daily_totals[date_str]["available"] += day_data.get("available", 0) or 0
                        daily_totals[date_str]["occupied"] += day_data.get("occupied", 0) or 0
                        daily_totals[date_str]["maintenance"] += day_data.get("maintenance", 0) or 0

                        # Parse guest counts - can be direct fields or in arrays
                        # Handle array format: [adults, children, infants] or [{type, count}, ...]
                        guests_data = day_data.get("guests", day_data.get("people", None))

                        if isinstance(guests_data, list):
                            if len(guests_data) >= 2:
                                # Check if it's [adults, children, infants] format (numbers)
                                if isinstance(guests_data[0], (int, float)):
                                    daily_totals[date_str]["adults"] += int(guests_data[0] or 0)
                                    daily_totals[date_str]["children"] += int(guests_data[1] or 0)
                                    # Ignore infants at index 2
                                # Check if it's [{type, count}, ...] format
                                elif isinstance(guests_data[0], dict):
                                    for guest_item in guests_data:
                                        guest_type = str(guest_item.get("type", guest_item.get("name", ""))).lower()
                                        count = int(guest_item.get("count", guest_item.get("quantity", 0)) or 0)
                                        if "adult" in guest_type:
                                            daily_totals[date_str]["adults"] += count
                                        elif "child" in guest_type:
                                            daily_totals[date_str]["children"] += count
                                        # Ignore infants
                        else:
                            # Try direct fields
                            daily_totals[date_str]["adults"] += int(day_data.get("adults", 0) or 0)
                            daily_totals[date_str]["children"] += int(day_data.get("children", 0) or 0)

        # Convert to list format
        occupancy_data = []
        for date_str, totals in sorted(daily_totals.items()):
            total_rooms = totals["available"]
            occupied_rooms = totals["occupied"]
            total_guests = totals["adults"] + totals["children"]

            # Calculate occupancy percentage
            occupancy_pct = None
            if total_rooms > 0:
                occupancy_pct = Decimal(str(round(occupied_rooms / total_rooms * 100, 2)))

            # Fall back to occupied_rooms if no guest data
            if total_guests == 0:
                total_guests = occupied_rooms

            occupancy_data.append({
                "date": date_str,
                "total_rooms": total_rooms,
                "occupied_rooms": occupied_rooms,
                "occupancy_percentage": occupancy_pct,
                "total_guests": total_guests,
            })

        logger.info(f"Fetched {len(occupancy_data)} daily occupancy records from Newbook (aggregated from {len(items) if items else 0} categories)")
        return occupancy_data

    async def get_bookings(
        self,
        date_from: date,
        date_to: date,
        include_cancelled: bool = False
    ) -> list[dict]:
        """
        Fetch bookings list with inventory items.

        Endpoint: bookings_list

        Note: Newbook paginates results (default 100, max 1000 per request).
        This method automatically fetches all pages.

        Args:
            date_from: Check-in date from
            date_to: Check-in date to
            include_cancelled: Include cancelled bookings

        Returns list of bookings with inventory items
        """
        bookings = []
        data_offset = 0
        data_limit = 1000  # Max allowed by Newbook
        total_fetched = 0

        while True:
            payload = {
                "period_from": date_from.isoformat(),
                "period_to": date_to.isoformat(),
                "list_type": "staying",  # Get bookings staying on these dates
                "data_offset": data_offset,
                "data_limit": data_limit,
            }

            response = await self._request("bookings_list", payload)

            # Get pagination info from response
            data_total = response.get("data_total", 0)
            data_count = response.get("data_count", 0)

            items = response.get("data", response) if isinstance(response, dict) else response

            if isinstance(items, list):
                for item in items:
                    status = item.get("status", "").lower()
                    if not include_cancelled and status == "cancelled":
                        continue

                    # Parse guest count - use booking_adults + booking_children directly
                    # Newbook provides these as separate fields, excluding infants (who don't eat full meals)
                    adults = int(item.get("booking_adults", 0) or 0)
                    children = int(item.get("booking_children", 0) or 0)
                    infants = int(item.get("booking_infants", 0) or 0)
                    num_guests = adults + children

                    # Fall back to 1 only if no guest data at all (single occupancy assumed)
                    # Don't fall back if there are only infants - they don't count for meals
                    if num_guests == 0 and infants == 0:
                        num_guests = 1

                    # Log first booking's structure to debug
                    if len(bookings) == 0:
                        logger.info(f"First booking guest data - adults: {item.get('booking_adults')}, children: {item.get('booking_children')}, infants: {item.get('booking_infants')} => counted: {num_guests}")
                        logger.info(f"First booking dates - arrival: {item.get('booking_arrival')}, departure: {item.get('booking_departure')}")
                        logger.info(f"First booking category_id: {item.get('category_id')}")

                    # Get room category/type - use category_id which maps to room types
                    # category_id is the numeric ID that corresponds to room types like "Standard", "Suite"
                    category_id = item.get("category_id") or item.get("site_category_id") or ""
                    room_type_name = (
                        item.get("site_type") or
                        item.get("category_name") or
                        item.get("room_type_name") or
                        ""
                    )

                    # Log first booking's room fields to debug matching
                    if len(bookings) == 0:
                        logger.info(f"First booking room fields - category_id: {category_id}, site_type: {item.get('site_type')}, site_name: {item.get('site_name')}")

                    bookings.append({
                        "booking_id": str(item.get("id", item.get("booking_id", ""))),
                        "booking_reference": item.get("reference", item.get("booking_reference", item.get("booking_reference_id"))),
                        "check_in_date": item.get("booking_arrival", item.get("check_in", item.get("check_in_date"))),
                        "check_out_date": item.get("booking_departure", item.get("check_out", item.get("check_out_date"))),
                        "nights": item.get("booking_length", item.get("nights")),
                        "room_type": room_type_name,  # Room type name if available
                        "category_id": str(category_id) if category_id else "",  # Category ID for filtering
                        "site_id": item.get("site_id"),  # Individual room ID
                        "site_name": item.get("site_name"),  # Room number (e.g. "108")
                        "num_guests": num_guests,
                        "booking_adults": int(item.get("booking_adults", 0) or 0),  # Debug
                        "booking_children": int(item.get("booking_children", 0) or 0),  # Debug
                        "booking_infants": int(item.get("booking_infants", 0) or 0),  # Debug
                        "num_rooms": item.get("rooms", item.get("num_rooms", 1)),
                        "total_amount": Decimal(str(item.get("total", 0))) if item.get("total") else None,
                        "status": status,
                        "inventory_items": item.get("inventory_items", item.get("items", []))
                    })

                total_fetched += len(items)

            # Check if we've fetched all records
            if data_count == 0 or total_fetched >= data_total:
                break

            # Move to next page
            data_offset += data_limit
            logger.info(f"Fetching next page of bookings (offset: {data_offset}, total: {data_total})")

        logger.info(f"Fetched {len(bookings)} bookings from Newbook (total available: {data_total})")
        return bookings

    def process_bookings_for_allocations(
        self,
        bookings: list[dict],
        breakfast_gl_codes: list[str],
        dinner_gl_codes: list[str],
        gl_account_id_to_code: dict[str, str] = None,
        breakfast_vat_rate: Decimal = None,
        dinner_vat_rate: Decimal = None
    ) -> dict[str, dict]:
        """
        Process bookings inventory items to calculate meal allocations per date.

        Args:
            bookings: List of bookings with inventory_items
            breakfast_gl_codes: GL codes that indicate breakfast allocation
            dinner_gl_codes: GL codes that indicate dinner allocation
            gl_account_id_to_code: Mapping from Newbook gl_account_id to gl_code
            breakfast_vat_rate: VAT rate for breakfast (e.g., 0.10 for 10%)
            dinner_vat_rate: VAT rate for dinner (e.g., 0.10 for 10%)

        Returns dict keyed by date with:
            - breakfast_qty: Total breakfast allocations
            - breakfast_netvalue: Total breakfast net value (exc VAT)
            - dinner_qty: Total dinner allocations
            - dinner_netvalue: Total dinner net value (exc VAT)
        """
        allocations_by_date = {}
        gl_account_id_to_code = gl_account_id_to_code or {}

        # Default VAT rates if not provided
        breakfast_vat_rate = breakfast_vat_rate or Decimal("0.10")
        dinner_vat_rate = dinner_vat_rate or Decimal("0.10")

        logger.info(f"Processing {len(bookings)} bookings for allocations")
        logger.info(f"Breakfast GL codes: {breakfast_gl_codes}, Dinner GL codes: {dinner_gl_codes}")
        logger.info(f"VAT rates - Breakfast: {breakfast_vat_rate}, Dinner: {dinner_vat_rate}")
        logger.info(f"GL account ID to code mapping has {len(gl_account_id_to_code)} entries")

        for booking in bookings:
            inventory_items = booking.get("inventory_items", [])
            if not inventory_items:
                continue

            # Get guest count for this booking - PAX should be based on guests, not item qty
            booking_guests = booking.get("num_guests", 1) or 1

            for item in inventory_items:
                # Newbook inventory items use gl_account_id (internal ID), not gl_code
                gl_account_id = str(item.get("gl_account_id", ""))
                # Translate to gl_code using our mapping
                gl_code = gl_account_id_to_code.get(gl_account_id, "")

                # Date is in stay_date field
                item_date = item.get("stay_date", item.get("date", item.get("item_date")))
                # PAX is the number of guests in the booking, not the inventory item qty
                # (inventory items are typically 1 per booking per day, but represent all guests)
                pax = booking_guests
                # Amount field - Newbook returns gross (inc VAT)
                gross_amount = Decimal(str(item.get("amount", item.get("net_amount", 0)) or 0))

                if not item_date or not gl_code:
                    continue

                if item_date not in allocations_by_date:
                    allocations_by_date[item_date] = {
                        "breakfast_qty": 0,
                        "breakfast_netvalue": Decimal("0"),
                        "dinner_qty": 0,
                        "dinner_netvalue": Decimal("0"),
                    }

                # Check if this item matches breakfast or dinner GL codes
                # Calculate net from gross: net = gross / (1 + vat_rate)
                if gl_code in breakfast_gl_codes:
                    net_amount = gross_amount / (1 + breakfast_vat_rate)
                    allocations_by_date[item_date]["breakfast_qty"] += pax
                    allocations_by_date[item_date]["breakfast_netvalue"] += net_amount.quantize(Decimal("0.01"))
                elif gl_code in dinner_gl_codes:
                    net_amount = gross_amount / (1 + dinner_vat_rate)
                    allocations_by_date[item_date]["dinner_qty"] += pax
                    allocations_by_date[item_date]["dinner_netvalue"] += net_amount.quantize(Decimal("0.01"))

        logger.info(f"Found allocations for {len(allocations_by_date)} dates")
        return allocations_by_date

    async def get_site_list(self) -> list[dict]:
        """
        Fetch site/room categories from Newbook and aggregate by room type.

        Endpoint: site_list

        Returns list of unique room types (aggregated from individual sites):
            - id: Type name (used as ID since types don't have IDs)
            - name: Type name (e.g., "Standard Room", "Overflow")
            - type: Same as name
            - count: Number of sites/rooms of this type
        """
        response = await self._request("site_list")

        # Log the raw response structure to understand it
        logger.info(f"site_list raw response type: {type(response)}")
        if isinstance(response, dict):
            logger.info(f"site_list response keys: {response.keys()}")

        items = response.get("data", response) if isinstance(response, dict) else response

        # Log first few items to understand structure
        if isinstance(items, list) and len(items) > 0:
            logger.info(f"site_list first item keys: {items[0].keys() if isinstance(items[0], dict) else 'not a dict'}")
            logger.info(f"site_list first 3 items: {items[:3]}")

        # Aggregate by room type name AND build category_id -> type mapping
        type_counts = {}  # type_name -> count
        category_id_to_type = {}  # category_id -> room_type (for booking filtering)
        if isinstance(items, list):
            for item in items:
                # Get category_id (what bookings use to identify room type)
                category_id = item.get("category_id") or item.get("site_category_id")

                # Try various field names that might contain the room type/category
                room_type = (
                    item.get("site_type") or
                    item.get("type") or
                    item.get("category") or
                    item.get("category_name") or
                    item.get("room_type") or
                    item.get("site_category") or
                    ""
                )

                # Fall back to site_name if no type found (shouldn't happen normally)
                if not room_type:
                    room_type = item.get("site_name", item.get("name", "Unknown"))
                    logger.debug(f"No type field found, using site_name: {room_type}")

                if room_type:
                    type_counts[room_type] = type_counts.get(room_type, 0) + 1

                # Build mapping from category_id to type
                if category_id and room_type:
                    category_id_to_type[str(category_id)] = room_type

        # Convert to list format
        categories = []
        for type_name, count in sorted(type_counts.items()):
            categories.append({
                "id": type_name,  # Use type name as ID
                "name": type_name,
                "type": type_name,
                "count": count,
            })

        logger.info(f"Fetched {len(categories)} unique room types from Newbook (from {sum(type_counts.values())} sites)")
        logger.info(f"Built category_id to type mapping: {category_id_to_type}")
        return categories, category_id_to_type

    def process_bookings_for_guests(
        self,
        bookings: list[dict],
        included_room_types: list[str] = None,
        category_id_to_type: dict[str, str] = None
    ) -> dict[str, int]:
        """
        Process bookings to count total guests per stay date.

        Args:
            bookings: List of bookings from get_bookings()
            included_room_types: List of room type names to include (None = all)
            category_id_to_type: Mapping from category_id (e.g. "1") to room type (e.g. "Standard")

        Returns dict keyed by date string with guest count
        """
        from datetime import datetime, timedelta

        guests_by_date = {}
        total_bookings_processed = 0
        total_guests_counted = 0
        bookings_filtered_out = 0
        category_id_to_type = category_id_to_type or {}

        logger.info(f"Processing {len(bookings)} bookings for guest counts")
        if included_room_types:
            logger.info(f"Filtering to room types: {included_room_types}")
        if category_id_to_type:
            logger.info(f"Using category_id to type mapping: {category_id_to_type}")

        # Resolve room types for all bookings using the mapping
        resolved_room_types = set()
        for b in bookings:
            category_id = b.get("category_id", "")
            resolved_type = category_id_to_type.get(category_id, b.get("room_type", category_id))
            resolved_room_types.add(resolved_type)

        logger.info(f"Resolved room types in bookings: {resolved_room_types}")

        # Log matching analysis if filtering
        if included_room_types:
            matching = resolved_room_types & set(included_room_types)
            non_matching = resolved_room_types - set(included_room_types)
            logger.info(f"Room type matching: {len(matching)} match, {len(non_matching)} don't match")
            if non_matching:
                logger.info(f"Non-matching room types: {non_matching}")

        for booking in bookings:
            # Get category_id and resolve to room type
            category_id = booking.get("category_id", "")
            room_type = category_id_to_type.get(category_id, booking.get("room_type", category_id))

            # Filter by room type if specified
            if included_room_types and room_type not in included_room_types:
                bookings_filtered_out += 1
                continue

            # Get guest count and stay dates
            # Don't use "or 1" - trust the computed value (0 is valid for infant-only bookings)
            num_guests = booking.get("num_guests", 0)
            check_in = booking.get("check_in_date")
            check_out = booking.get("check_out_date")
            nights = booking.get("nights", 1)

            if not check_in:
                continue

            total_bookings_processed += 1
            total_guests_counted += num_guests

            # Parse check-in date
            if isinstance(check_in, str):
                try:
                    check_in_date = datetime.fromisoformat(check_in.split("T")[0]).date()
                except ValueError:
                    continue
            else:
                check_in_date = check_in

            # Calculate stay dates (guest is present from check-in through day before check-out)
            if check_out:
                if isinstance(check_out, str):
                    try:
                        check_out_date = datetime.fromisoformat(check_out.split("T")[0]).date()
                    except ValueError:
                        check_out_date = check_in_date + timedelta(days=nights or 1)
                else:
                    check_out_date = check_out
            else:
                check_out_date = check_in_date + timedelta(days=nights or 1)

            # Add guests to each stay date (not including checkout day)
            current_date = check_in_date
            while current_date < check_out_date:
                date_str = current_date.isoformat()
                if date_str not in guests_by_date:
                    guests_by_date[date_str] = 0
                guests_by_date[date_str] += num_guests
                current_date += timedelta(days=1)

        logger.info(f"Guest count summary: processed {total_bookings_processed} bookings, {total_guests_counted} total guests, {bookings_filtered_out} filtered by room type")
        logger.info(f"Calculated guest counts for {len(guests_by_date)} dates")
        if guests_by_date:
            sample_dates = list(guests_by_date.items())[:3]
            logger.info(f"Sample guest counts: {sample_dates}")
        return guests_by_date

    async def get_charges_list(
        self,
        date_from: date,
        date_to: date,
        account_for: str = None
    ) -> list[dict]:
        """
        Fetch charges list from Newbook with pagination support.

        Endpoint: charges_list

        Args:
            date_from: Period start (charges raised or voided within this period)
            date_to: Period end
            account_for: Optional filter by account type (leads, guests, bookings, companies, travel_agents)

        Returns list of charges with:
            - id: Charge ID
            - gl_account_id: GL Account ID
            - gl_account_code: GL Account code
            - description: Charge description (e.g., "Ticket: 22900 - 1 x Venison Bourguignon")
            - amount_ex_tax: Net amount (exc tax)
            - amount_inc_tax: Gross amount (inc tax)
            - generated_when: When the charge was created
            - voided_when: When the charge was voided (None if not voided)
            - voided_by: Who voided it ("0" if not voided)
        """
        charges = []
        data_offset = 0
        data_limit = 1000  # Max allowed by Newbook
        total_fetched = 0

        while True:
            payload = {
                "period_from": f"{date_from.isoformat()} 00:00:00",
                "period_to": f"{date_to.isoformat()} 23:59:59",
                "data_offset": data_offset,
                "data_limit": data_limit,
            }

            if account_for:
                payload["account_for"] = account_for

            logger.info(f"Fetching charges: {date_from} to {date_to}, offset={data_offset}, limit={data_limit}")

            response = await self._request("charges_list", payload)

            # Get pagination info from response
            data_total = response.get("data_total", 0)
            data_count = response.get("data_count", 0)

            items = response.get("data", response) if isinstance(response, dict) else response

            if isinstance(items, list):
                for item in items:
                    charges.append({
                        "id": item.get("id"),
                        "account_id": item.get("account_id"),
                        "account_for": item.get("account_for"),
                        "gl_account_id": str(item.get("gl_account_id", "")),
                        "gl_account_code": item.get("gl_account_code", ""),
                        "gl_category_id": item.get("gl_category_id"),
                        "description": item.get("description", ""),
                        "amount": Decimal(str(item.get("amount", 0) or 0)),
                        "amount_ex_tax": Decimal(str(item.get("amount_ex_tax", 0) or 0)),
                        "amount_inc_tax": Decimal(str(item.get("amount_inc_tax", 0) or 0)),
                        "tax": Decimal(str(item.get("tax", 0) or 0)),
                        "generated_when": item.get("generated_when"),
                        "voided_when": item.get("voided_when"),
                        "voided_by": str(item.get("voided_by", "0")),
                    })

                total_fetched += len(items)

            logger.info(f"Charges page: got {data_count} items, total available: {data_total}, fetched so far: {total_fetched}")

            # Check if we've fetched all records
            if data_count == 0 or total_fetched >= data_total or len(items) < data_limit:
                break

            # Move to next page
            data_offset += data_limit

        logger.info(f"Fetched {len(charges)} total charges from Newbook ({date_from} to {date_to})")
        return charges
