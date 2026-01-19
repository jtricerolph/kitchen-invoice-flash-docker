"""
Newbook Data Sync Service

Handles synchronization of data between Newbook API and local database.
"""
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.dialects.postgresql import insert

from models.settings import KitchenSettings
from models.newbook import (
    NewbookGLAccount, NewbookDailyRevenue, NewbookDailyOccupancy, NewbookSyncLog, NewbookRoomCategory
)
from services.newbook_api import NewbookAPIClient, NewbookAPIError

logger = logging.getLogger(__name__)


class NewbookSyncService:
    """Service for syncing Newbook data to local database"""

    # Default forecast period (days ahead)
    FORECAST_DAYS = 60

    def __init__(self, db: AsyncSession, kitchen_id: int):
        self.db = db
        self.kitchen_id = kitchen_id
        self._settings: KitchenSettings = None

    async def _get_settings(self) -> KitchenSettings:
        """Fetch and cache kitchen settings"""
        if self._settings is None:
            result = await self.db.execute(
                select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
            )
            self._settings = result.scalar_one_or_none()

            if not self._settings:
                raise ValueError("Kitchen settings not found")

        return self._settings

    async def _get_client(self) -> NewbookAPIClient:
        """Create authenticated Newbook API client"""
        settings = await self._get_settings()

        if not all([
            settings.newbook_api_username,
            settings.newbook_api_password,
            settings.newbook_api_key,
            settings.newbook_api_region
        ]):
            raise ValueError("Newbook API credentials not fully configured")

        return NewbookAPIClient(
            username=settings.newbook_api_username,
            password=settings.newbook_api_password,
            api_key=settings.newbook_api_key,
            region=settings.newbook_api_region,
            instance_id=settings.newbook_instance_id
        )

    async def _get_included_room_types(self) -> list[str] | None:
        """Get list of room type names that are included for occupancy calculations.

        Returns None if no room categories are configured (include all).
        Returns list of site_name values for categories with is_included=True.
        """
        result = await self.db.execute(
            select(NewbookRoomCategory).where(
                NewbookRoomCategory.kitchen_id == self.kitchen_id
            )
        )
        categories = list(result.scalars().all())

        if not categories:
            # No categories configured - include all
            return None

        # Return only included category names
        included = [cat.site_name for cat in categories if cat.is_included]
        logger.info(f"Included room types for occupancy: {included}")
        return included if included else None

    async def _log_sync(
        self,
        sync_type: str,
        date_from: date = None,
        date_to: date = None
    ) -> NewbookSyncLog:
        """Create a sync log entry"""
        log = NewbookSyncLog(
            kitchen_id=self.kitchen_id,
            sync_type=sync_type,
            date_from=date_from,
            date_to=date_to,
            status="running"
        )
        self.db.add(log)
        await self.db.commit()
        await self.db.refresh(log)
        return log

    async def _complete_sync(
        self,
        log: NewbookSyncLog,
        status: str,
        records: int = 0,
        error: str = None
    ):
        """Update sync log on completion"""
        log.completed_at = datetime.utcnow()
        log.status = status
        log.records_fetched = records
        log.error_message = error
        await self.db.commit()

    async def sync_gl_accounts(self) -> list[NewbookGLAccount]:
        """
        Fetch and sync GL accounts from Newbook.

        Updates existing accounts, adds new ones.
        Does NOT delete accounts (preserves user selections).
        """
        log = await self._log_sync("gl_accounts")

        try:
            async with await self._get_client() as client:
                accounts_data = await client.get_gl_accounts()

            synced_accounts = []

            for acc in accounts_data:
                # Upsert pattern: update if exists, insert if not
                stmt = insert(NewbookGLAccount).values(
                    kitchen_id=self.kitchen_id,
                    gl_account_id=acc["id"],
                    gl_code=acc["code"],
                    gl_name=acc["name"],
                    gl_type=acc["type"],
                    gl_group_id=acc.get("group_id"),
                    gl_group_name=acc.get("group_name"),
                    updated_at=datetime.utcnow()
                ).on_conflict_do_update(
                    constraint="uq_newbook_gl_account",
                    set_={
                        "gl_code": acc["code"],
                        "gl_name": acc["name"],
                        "gl_type": acc["type"],
                        "gl_group_id": acc.get("group_id"),
                        "gl_group_name": acc.get("group_name"),
                        "updated_at": datetime.utcnow()
                    }
                )
                await self.db.execute(stmt)

            await self.db.commit()

            # Fetch all accounts for return
            result = await self.db.execute(
                select(NewbookGLAccount).where(NewbookGLAccount.kitchen_id == self.kitchen_id)
            )
            synced_accounts = list(result.scalars().all())

            await self._complete_sync(log, "success", len(synced_accounts))
            logger.info(f"Synced {len(synced_accounts)} GL accounts for kitchen {self.kitchen_id}")

            return synced_accounts

        except Exception as e:
            await self._complete_sync(log, "failed", error=str(e))
            logger.error(f"GL account sync failed: {e}")
            raise

    async def sync_revenue(
        self,
        date_from: date,
        date_to: date,
        tracked_only: bool = True
    ) -> int:
        """
        Fetch and sync earned revenue data.

        Args:
            date_from: Start date
            date_to: End date
            tracked_only: Only fetch for tracked GL accounts

        Returns number of records synced
        """
        log = await self._log_sync("revenue", date_from, date_to)

        try:
            # Get tracked GL accounts - we filter locally after fetching all data
            # (Newbook API filtering by gl_account_ids is unreliable with code vs ID mismatch)
            if tracked_only:
                result = await self.db.execute(
                    select(NewbookGLAccount.id, NewbookGLAccount.gl_code).where(
                        NewbookGLAccount.kitchen_id == self.kitchen_id,
                        NewbookGLAccount.is_tracked == True
                    )
                )
                tracked_gl = {row[1]: row[0] for row in result.all()}  # code -> local id

                if not tracked_gl:
                    logger.warning("No tracked GL accounts, skipping revenue sync")
                    await self._complete_sync(log, "success", 0)
                    return 0

                gl_map = tracked_gl
            else:
                # Get all GL accounts
                result = await self.db.execute(
                    select(NewbookGLAccount.id, NewbookGLAccount.gl_code).where(
                        NewbookGLAccount.kitchen_id == self.kitchen_id
                    )
                )
                gl_map = {row[1]: row[0] for row in result.all()}  # code -> local id

            # Fetch all revenue from Newbook (filter locally by tracked accounts)
            async with await self._get_client() as client:
                revenue_data = await client.get_earned_revenue(date_from, date_to)

            records_count = 0

            for entry in revenue_data:
                # entry["gl_account_id"] actually contains the gl_code from earned_revenue report
                local_gl_id = gl_map.get(entry["gl_account_id"])
                if not local_gl_id:
                    continue

                entry_date = date.fromisoformat(entry["date"]) if isinstance(entry["date"], str) else entry["date"]

                # Upsert revenue entry
                stmt = insert(NewbookDailyRevenue).values(
                    kitchen_id=self.kitchen_id,
                    gl_account_id=local_gl_id,
                    date=entry_date,
                    amount_net=entry["amount_net"],
                    amount_gross=entry.get("amount_gross"),
                    fetched_at=datetime.utcnow()
                ).on_conflict_do_update(
                    constraint="uq_newbook_revenue_per_day",
                    set_={
                        "amount_net": entry["amount_net"],
                        "amount_gross": entry.get("amount_gross"),
                        "fetched_at": datetime.utcnow()
                    }
                )
                await self.db.execute(stmt)
                records_count += 1

            await self.db.commit()
            await self._complete_sync(log, "success", records_count)

            logger.info(f"Synced {records_count} revenue records for kitchen {self.kitchen_id}")
            return records_count

        except Exception as e:
            await self._complete_sync(log, "failed", error=str(e))
            logger.error(f"Revenue sync failed: {e}")
            raise

    async def sync_occupancy(
        self,
        date_from: date,
        date_to: date,
        is_forecast: bool = False
    ) -> int:
        """
        Fetch and sync occupancy data with meal allocations.

        Args:
            date_from: Start date
            date_to: End date
            is_forecast: Mark as forecast data (for future dates)
        """
        log = await self._log_sync("occupancy", date_from, date_to)

        try:
            settings = await self._get_settings()

            # Parse breakfast/dinner GL codes from settings
            breakfast_gl_codes = []
            dinner_gl_codes = []
            if settings.newbook_breakfast_gl_codes:
                breakfast_gl_codes = [c.strip() for c in settings.newbook_breakfast_gl_codes.split(",") if c.strip()]
            if settings.newbook_dinner_gl_codes:
                dinner_gl_codes = [c.strip() for c in settings.newbook_dinner_gl_codes.split(",") if c.strip()]

            # Get VAT rates from settings
            breakfast_vat_rate = settings.newbook_breakfast_vat_rate
            dinner_vat_rate = settings.newbook_dinner_vat_rate

            # Build GL account ID to code mapping for allocation processing
            gl_account_id_to_code = {}
            if breakfast_gl_codes or dinner_gl_codes:
                result = await self.db.execute(
                    select(NewbookGLAccount.gl_account_id, NewbookGLAccount.gl_code).where(
                        NewbookGLAccount.kitchen_id == self.kitchen_id
                    )
                )
                gl_account_id_to_code = {row[0]: row[1] for row in result.all()}
                logger.info(f"Built GL account mapping with {len(gl_account_id_to_code)} entries")

            # Get included room types for filtering
            included_room_types = await self._get_included_room_types()

            async with await self._get_client() as client:
                # Fetch category_id to type mapping for guest filtering
                _, category_id_to_type = await client.get_site_list()

                # Fetch occupancy data
                occupancy_data = await client.get_occupancy_report(date_from, date_to)

                # Always fetch bookings to get guest counts and allocations
                bookings = await client.get_bookings(date_from, date_to)

                # Process bookings for guest counts (filtered by room type)
                guests_by_date = client.process_bookings_for_guests(bookings, included_room_types, category_id_to_type)

                # Process bookings for meal allocations (also filtered by room type)
                allocations_by_date = {}
                if breakfast_gl_codes or dinner_gl_codes:
                    allocations_by_date = client.process_bookings_for_allocations(
                        bookings, breakfast_gl_codes, dinner_gl_codes, gl_account_id_to_code,
                        breakfast_vat_rate, dinner_vat_rate
                    )

            records_count = 0
            today = date.today()

            for entry in occupancy_data:
                # Skip entries with no date
                if not entry.get("date"):
                    continue

                entry_date = date.fromisoformat(entry["date"]) if isinstance(entry["date"], str) else entry["date"]

                # Skip if date parsing failed
                if not entry_date:
                    continue

                # Determine if this is forecast/current data (today or future)
                # Today should be updatable, not locked as historical
                entry_is_forecast = entry_date >= today

                # Get allocations for this date if available
                allocs = allocations_by_date.get(entry["date"], allocations_by_date.get(str(entry_date), {}))

                # Get guest count from bookings (filtered by room type)
                guest_count = guests_by_date.get(str(entry_date), guests_by_date.get(entry["date"]))

                # Log first few entries for debugging
                if records_count < 3:
                    logger.info(f"Occupancy entry: date={entry_date}, guest_count={guest_count}, occupied_rooms={entry.get('occupied_rooms')}, is_forecast={entry_is_forecast}")

                # For past dates, only insert if not exists (don't overwrite)
                # For future dates, always update
                if entry_is_forecast:
                    stmt = insert(NewbookDailyOccupancy).values(
                        kitchen_id=self.kitchen_id,
                        date=entry_date,
                        total_rooms=entry.get("total_rooms"),
                        occupied_rooms=entry.get("occupied_rooms"),
                        occupancy_percentage=entry.get("occupancy_percentage"),
                        total_guests=guest_count,
                        breakfast_allocation_qty=allocs.get("breakfast_qty"),
                        breakfast_allocation_netvalue=allocs.get("breakfast_netvalue"),
                        dinner_allocation_qty=allocs.get("dinner_qty"),
                        dinner_allocation_netvalue=allocs.get("dinner_netvalue"),
                        is_forecast=True,
                        fetched_at=datetime.utcnow()
                    ).on_conflict_do_update(
                        constraint="uq_newbook_occupancy_per_day",
                        set_={
                            "total_rooms": entry.get("total_rooms"),
                            "occupied_rooms": entry.get("occupied_rooms"),
                            "occupancy_percentage": entry.get("occupancy_percentage"),
                            "total_guests": guest_count,
                            "breakfast_allocation_qty": allocs.get("breakfast_qty"),
                            "breakfast_allocation_netvalue": allocs.get("breakfast_netvalue"),
                            "dinner_allocation_qty": allocs.get("dinner_qty"),
                            "dinner_allocation_netvalue": allocs.get("dinner_netvalue"),
                            "is_forecast": True,
                            "fetched_at": datetime.utcnow()
                        }
                    )
                else:
                    # Past dates - insert if new, or update is_forecast flag if already exists
                    # This ensures dates that were previously forecast get marked as historical
                    stmt = insert(NewbookDailyOccupancy).values(
                        kitchen_id=self.kitchen_id,
                        date=entry_date,
                        total_rooms=entry.get("total_rooms"),
                        occupied_rooms=entry.get("occupied_rooms"),
                        occupancy_percentage=entry.get("occupancy_percentage"),
                        total_guests=guest_count,
                        breakfast_allocation_qty=allocs.get("breakfast_qty"),
                        breakfast_allocation_netvalue=allocs.get("breakfast_netvalue"),
                        dinner_allocation_qty=allocs.get("dinner_qty"),
                        dinner_allocation_netvalue=allocs.get("dinner_netvalue"),
                        is_forecast=False,
                        fetched_at=datetime.utcnow()
                    ).on_conflict_do_update(
                        constraint="uq_newbook_occupancy_per_day",
                        set_={
                            "is_forecast": False,
                            "fetched_at": datetime.utcnow()
                        }
                    )

                await self.db.execute(stmt)
                records_count += 1

            await self.db.commit()
            await self._complete_sync(log, "success", records_count)

            logger.info(f"Synced {records_count} occupancy records for kitchen {self.kitchen_id}")
            return records_count

        except Exception as e:
            await self._complete_sync(log, "failed", error=str(e))
            logger.error(f"Occupancy sync failed: {e}")
            raise

    async def run_daily_sync(self) -> dict:
        """
        Run the daily automatic sync job.

        - Backfills any missing historical data (last 30 days)
        - Updates forecast period (next 60 days)
        """
        today = date.today()
        results = {
            "revenue_historical": 0,
            "occupancy_historical": 0,
            "occupancy_forecast": 0,
        }

        try:
            # Historical data (last 30 days)
            hist_from = today - timedelta(days=30)
            results["revenue_historical"] = await self.sync_revenue(hist_from, today)
            results["occupancy_historical"] = await self.sync_occupancy(hist_from, today, is_forecast=False)

            # Forecast data (next 60 days)
            forecast_to = today + timedelta(days=self.FORECAST_DAYS)
            results["occupancy_forecast"] = await self.sync_occupancy(today, forecast_to, is_forecast=True)

            # Update last sync timestamp
            settings = await self._get_settings()
            settings.newbook_last_sync = datetime.utcnow()
            await self.db.commit()

            logger.info(f"Daily sync completed for kitchen {self.kitchen_id}: {results}")

        except Exception as e:
            logger.error(f"Daily sync failed for kitchen {self.kitchen_id}: {e}")
            raise

        return results

    async def sync_forecast_period(self) -> dict:
        """
        Manual sync for forecast period only (next ~2 months).
        Called from settings UI button.
        """
        today = date.today()
        forecast_to = today + timedelta(days=self.FORECAST_DAYS)

        results = {
            "occupancy": await self.sync_occupancy(today, forecast_to, is_forecast=True),
        }

        return results

    async def sync_historical_range(self, date_from: date, date_to: date) -> dict:
        """
        Manual sync for specific historical date range.
        Called from settings UI date picker.

        Note: For historical data, this will force update existing records.
        """
        log = await self._log_sync("historical_manual", date_from, date_to)

        try:
            settings = await self._get_settings()

            # Parse breakfast/dinner GL codes for meal allocation counts
            breakfast_gl_codes = []
            dinner_gl_codes = []
            if settings.newbook_breakfast_gl_codes:
                breakfast_gl_codes = [c.strip() for c in settings.newbook_breakfast_gl_codes.split(",") if c.strip()]
            if settings.newbook_dinner_gl_codes:
                dinner_gl_codes = [c.strip() for c in settings.newbook_dinner_gl_codes.split(",") if c.strip()]

            # Get VAT rates (needed for allocation processing)
            breakfast_vat_rate = settings.newbook_breakfast_vat_rate
            dinner_vat_rate = settings.newbook_dinner_vat_rate

            # Build GL account ID to code mapping for allocation processing
            gl_account_id_to_code = {}
            if breakfast_gl_codes or dinner_gl_codes:
                result = await self.db.execute(
                    select(NewbookGLAccount.gl_account_id, NewbookGLAccount.gl_code).where(
                        NewbookGLAccount.kitchen_id == self.kitchen_id
                    )
                )
                gl_account_id_to_code = {row[0]: row[1] for row in result.all()}

            # Sync revenue from earned revenue report (actual revenue)
            revenue_count = await self.sync_revenue(date_from, date_to)

            # Get included room types for filtering guest counts
            included_room_types = await self._get_included_room_types()

            # For historical sync: get occupancy, guest counts, and meal allocation COUNTS
            # (values come from earned_revenue report, but counts are useful for analysis)
            async with await self._get_client() as client:
                # Fetch category_id to type mapping for guest filtering
                _, category_id_to_type = await client.get_site_list()

                occupancy_data = await client.get_occupancy_report(date_from, date_to)

                # Fetch bookings for guest counts and meal allocation counts
                bookings = await client.get_bookings(date_from, date_to)

                # Process bookings for guest counts (filtered by room type)
                guests_by_date = client.process_bookings_for_guests(bookings, included_room_types, category_id_to_type)

                # Process bookings for meal allocation counts (PAX only, values from earned_revenue)
                allocations_by_date = {}
                if breakfast_gl_codes or dinner_gl_codes:
                    allocations_by_date = client.process_bookings_for_allocations(
                        bookings, breakfast_gl_codes, dinner_gl_codes, gl_account_id_to_code,
                        breakfast_vat_rate, dinner_vat_rate
                    )

            occupancy_count = 0
            for entry in occupancy_data:
                entry_date = date.fromisoformat(entry["date"]) if isinstance(entry["date"], str) else entry["date"]
                allocs = allocations_by_date.get(entry["date"], allocations_by_date.get(str(entry_date), {}))

                # Get guest count from bookings (filtered by room type)
                guest_count = guests_by_date.get(str(entry_date), guests_by_date.get(entry["date"]))

                # Log first few entries for debugging
                if occupancy_count < 3:
                    logger.info(f"Historical occupancy entry: date={entry_date}, guest_count={guest_count}, occupied_rooms={entry.get('occupied_rooms')}, breakfast_qty={allocs.get('breakfast_qty')}")

                # Force update for manual historical sync
                # Store meal allocation QTY (pax counts) but NOT values (values come from earned_revenue)
                stmt = insert(NewbookDailyOccupancy).values(
                    kitchen_id=self.kitchen_id,
                    date=entry_date,
                    total_rooms=entry.get("total_rooms"),
                    occupied_rooms=entry.get("occupied_rooms"),
                    occupancy_percentage=entry.get("occupancy_percentage"),
                    total_guests=guest_count,
                    breakfast_allocation_qty=allocs.get("breakfast_qty"),
                    breakfast_allocation_netvalue=None,  # Historical: use earned_revenue for actual values
                    dinner_allocation_qty=allocs.get("dinner_qty"),
                    dinner_allocation_netvalue=None,  # Historical: use earned_revenue for actual values
                    is_forecast=False,
                    fetched_at=datetime.utcnow()
                ).on_conflict_do_update(
                    constraint="uq_newbook_occupancy_per_day",
                    set_={
                        "total_rooms": entry.get("total_rooms"),
                        "occupied_rooms": entry.get("occupied_rooms"),
                        "occupancy_percentage": entry.get("occupancy_percentage"),
                        "total_guests": guest_count,
                        "breakfast_allocation_qty": allocs.get("breakfast_qty"),
                        "breakfast_allocation_netvalue": None,
                        "dinner_allocation_qty": allocs.get("dinner_qty"),
                        "dinner_allocation_netvalue": None,
                        "is_forecast": False,
                        "fetched_at": datetime.utcnow()
                    }
                )
                await self.db.execute(stmt)
                occupancy_count += 1

            await self.db.commit()

            results = {
                "revenue": revenue_count,
                "occupancy": occupancy_count
            }

            await self._complete_sync(log, "success", revenue_count + occupancy_count)
            return results

        except Exception as e:
            await self._complete_sync(log, "failed", error=str(e))
            raise
