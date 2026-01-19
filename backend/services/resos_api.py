"""
Resos API Client

CRITICAL: This client is READ-ONLY. All methods use GET requests only.
NO data is written, modified, or deleted in Resos.
Data flows ONE WAY: Resos → Local Database
"""
import httpx
import base64
from datetime import date, datetime, timedelta
import logging
from typing import Optional
import asyncio

logger = logging.getLogger(__name__)


class ResosAPIError(Exception):
    """Custom exception for Resos API errors"""
    pass


class ResosAPIClient:
    """
    Async client for Resos API

    CRITICAL: This client is READ-ONLY. All methods use GET requests only.
    NO data is written, modified, or deleted in Resos.
    Data flows ONE WAY: Resos → Local Database
    """

    BASE_URL = "https://api.resos.com/v1"

    def __init__(self, api_key: str):
        self.api_key = api_key
        # HTTP Basic Auth: base64_encode(api_key + ':')
        self.auth_header = f"Basic {base64.b64encode(f'{api_key}:'.encode()).decode()}"

    async def __aenter__(self):
        self.client = httpx.AsyncClient(timeout=30.0)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.client.aclose()

    async def test_connection(self) -> bool:
        """Test API connection by fetching opening hours (GET request only)"""
        try:
            response = await self.client.get(
                f"{self.BASE_URL}/openingHours",
                headers={"Authorization": self.auth_header}
            )
            return response.status_code == 200
        except Exception as e:
            logger.error(f"Resos connection test failed: {e}")
            return False

    async def get_bookings(
        self,
        from_date: date,
        to_date: date,
        batch_days: int = 7
    ) -> list[dict]:
        """
        Fetch bookings for date range with pagination and rate limiting (GET request only)

        Uses batching by date spans to avoid hitting API limits.
        Implements rate limiting (1 request per second).

        Returns list of booking objects with structure:
        {
            '_id': 'booking_id',
            'date': '2026-01-20',
            'time': '19:00',
            'people': 2,
            'status': 'confirmed',
            'guest': {...},
            'customFields': [...],
            'restaurantNotes': [...]
        }
        """
        all_bookings = []
        current_date = from_date

        # Batch requests by date spans (default 7 days per request)
        while current_date <= to_date:
            batch_end = min(current_date + timedelta(days=batch_days - 1), to_date)

            from_datetime = f"{current_date}T00:00:00"
            to_datetime = f"{batch_end}T23:59:59"

            # Paginate through bookings for this date range
            offset = 0
            batch_total = 0

            while True:
                logger.info(f"Fetching Resos bookings: {current_date} to {batch_end} (offset: {offset})")

                response = await self.client.get(
                    f"{self.BASE_URL}/bookings",
                    headers={"Authorization": self.auth_header},
                    params={
                        "fromDateTime": from_datetime,
                        "toDateTime": to_datetime,
                        "limit": 100,  # Max per request (Resos API limit)
                        "skip": offset  # Pagination offset
                    }
                )

                if response.status_code != 200:
                    error_body = response.text
                    logger.error(f"Resos API error {response.status_code}: {error_body}")
                    raise ResosAPIError(f"Failed to fetch bookings: {response.status_code} - {error_body}")

                data = response.json()
                page_bookings = data if isinstance(data, list) else []

                if not page_bookings:
                    # No more bookings to fetch
                    break

                all_bookings.extend(page_bookings)
                batch_total += len(page_bookings)

                logger.info(f"Fetched {len(page_bookings)} bookings (offset {offset})")

                # If we got fewer than the limit, we've reached the end
                if len(page_bookings) < 100:
                    break

                # Move to next page
                offset += 100

                # Rate limiting: 1 request per second
                await asyncio.sleep(1)

            logger.info(f"Total for {current_date} to {batch_end}: {batch_total} bookings")

            # Move to next date batch
            current_date = batch_end + timedelta(days=1)

        logger.info(f"Total bookings fetched: {len(all_bookings)}")
        return all_bookings

    async def get_opening_hours(self) -> list[dict]:
        """
        Fetch opening hours/service periods (GET request only)

        Returns list of opening hour objects:
        {
            '_id': 'opening_hour_id',
            'name': 'Dinner',
            'startTime': '18:00',
            'endTime': '22:00',
            'days': ['monday', 'tuesday', 'wednesday', ...]
        }
        """
        response = await self.client.get(
            f"{self.BASE_URL}/openingHours",
            headers={"Authorization": self.auth_header},
            params={"showDeleted": "false", "onlySpecial": "false"}
        )

        if response.status_code != 200:
            raise ResosAPIError(f"Failed to fetch opening hours: {response.status_code}")

        return response.json()

    async def get_custom_field_definitions(self) -> list[dict]:
        """
        Fetch custom field definitions (GET request only)

        Returns field definitions with choice options for dropdowns/radios
        """
        response = await self.client.get(
            f"{self.BASE_URL}/customFields",
            headers={"Authorization": self.auth_header}
        )

        if response.status_code != 200:
            raise ResosAPIError(f"Failed to fetch custom fields: {response.status_code}")

        return response.json()
