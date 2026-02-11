"""
Forecast API Client Service

Handles communication with the external forecasting Docker app to fetch
forecasted revenue data for the Spend Budget feature.

API Endpoint: /public/forecast/revenue
Auth: X-API-Key header
"""
import logging
import httpx
from datetime import date
from decimal import Decimal
from typing import Optional

logger = logging.getLogger(__name__)


class ForecastAPIError(Exception):
    """Custom exception for Forecast API errors"""
    def __init__(self, message: str, status_code: int = None, response_data: dict = None):
        self.message = message
        self.status_code = status_code
        self.response_data = response_data
        super().__init__(self.message)


class ForecastAPIClient:
    """
    Async client for external Forecast API.

    Usage:
        async with ForecastAPIClient(base_url, api_key) as client:
            forecast = await client.get_revenue_forecast(start_date, days=7)
    """

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self._client: httpx.AsyncClient = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=15.0),
            follow_redirects=True,
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()

    async def _request(
        self,
        endpoint: str,
        params: dict = None,
        method: str = "GET"
    ) -> dict:
        """
        Make an authenticated request to the Forecast API.

        All requests include X-API-Key header for authentication.
        """
        url = f"{self.base_url}{endpoint}"
        headers = {"X-API-Key": self.api_key}

        try:
            logger.info(f"Forecast API request: {method} {endpoint}")

            if method == "GET":
                response = await self._client.get(url, params=params, headers=headers)
            else:
                response = await self._client.post(url, json=params, headers=headers)

            if response.status_code == 401:
                raise ForecastAPIError("Authentication failed. Check API key.", 401)

            if response.status_code == 403:
                raise ForecastAPIError("Access denied. Check API key permissions.", 403)

            response.raise_for_status()
            return response.json()

        except httpx.HTTPStatusError as e:
            logger.error(f"Forecast API HTTP error: {e.response.status_code}")
            raise ForecastAPIError(f"HTTP {e.response.status_code}: {str(e)}", e.response.status_code)
        except httpx.RequestError as e:
            logger.error(f"Forecast API request error: {e}")
            raise ForecastAPIError(f"Request failed: {str(e)}")

    async def test_connection(self) -> tuple[bool, str]:
        """
        Test API connection by making a minimal forecast request.

        Returns (success, message) tuple.
        """
        try:
            # Request just 1 day of forecast to test connection
            await self.get_revenue_forecast(date.today(), days=1)
            return True, "Connection successful"
        except ForecastAPIError as e:
            return False, str(e.message)
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    async def get_revenue_forecast(
        self,
        start_date: date,
        days: int = 7,
        revenue_type: str = "all"
    ) -> list[dict]:
        """
        Fetch revenue forecast from /public/forecast/revenue

        Args:
            start_date: Start date for forecast
            days: Number of days to fetch (default 7 for a week)
            revenue_type: Type filter - "all", "dry", "wet", "total"

        Returns list of daily forecasts with:
            - date: ISO date string
            - day: Day name
            - lead_days: Days from today
            - dry: {otb, forecast, prior_final, budget}
            - wet: {otb, forecast, prior_final, budget}
            - total: {otb, forecast, prior_final, budget}
        """
        params = {
            "start_date": start_date.isoformat(),
            "days": days,
        }
        if revenue_type != "all":
            params["type"] = revenue_type

        response = await self._request("/public/forecast/revenue", params)

        # Response format: {"data": [...], "meta": {...}}
        data = response.get("data", [])

        logger.info(f"Fetched {len(data)} days of revenue forecast from {start_date}")
        return data

    def calculate_food_revenue(self, forecast_data: list[dict]) -> tuple[Decimal, Decimal]:
        """
        Calculate total food revenue (dry only) from forecast data.

        Args:
            forecast_data: List of daily forecasts from get_revenue_forecast

        Returns tuple of (otb_revenue, forecast_revenue):
            - otb_revenue: On The Books (current bookings only) - conservative minimum
            - forecast_revenue: Full forecast including expected pickup
        """
        total_otb = Decimal("0")
        total_forecast = Decimal("0")

        for day in forecast_data:
            # Get dry values only (wet is beverages, not food cost)
            dry = day.get("dry", {})

            # OTB is current bookings, forecast includes expected pickup
            dry_otb = Decimal(str(dry.get("otb", 0) or 0))
            dry_forecast = Decimal(str(dry.get("forecast", 0) or 0))

            total_otb += dry_otb
            total_forecast += dry_forecast

        return total_otb, total_forecast

    def get_daily_breakdown(self, forecast_data: list[dict]) -> list[dict]:
        """
        Process forecast data into daily revenue breakdown for budget tracking.

        Args:
            forecast_data: List of daily forecasts from get_revenue_forecast

        Returns list of daily data with:
            - date: ISO date string
            - day_name: Day name (Mon, Tue, etc.)
            - forecast_revenue: dry + wet forecast
            - forecast_dry: dry forecast only
            - forecast_wet: wet forecast only
        """
        daily = []

        for day in forecast_data:
            dry = day.get("dry", {})
            wet = day.get("wet", {})

            dry_forecast = Decimal(str(dry.get("forecast", 0) or 0))
            wet_forecast = Decimal(str(wet.get("forecast", 0) or 0))

            daily.append({
                "date": day.get("date"),
                "day_name": day.get("day", ""),
                "forecast_revenue": dry_forecast + wet_forecast,
                "forecast_dry": dry_forecast,
                "forecast_wet": wet_forecast,
            })

        return daily
