"""
Resos Data Sync Service

Handles synchronization of booking data from Resos API to local database.
READ-ONLY integration - all API calls are GET requests only.
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, and_, func, case
from sqlalchemy.dialects.postgresql import insert

from models.settings import KitchenSettings
from models.resos import ResosBooking, ResosDailyStats, ResosOpeningHour, ResosSyncLog
from services.resos_api import ResosAPIClient, ResosAPIError

logger = logging.getLogger(__name__)


class ResosSyncService:
    """Service for syncing Resos booking data"""

    FORECAST_DAYS = 60
    HISTORICAL_BACKFILL_DAYS = 30

    def __init__(self, kitchen_id: int, db: AsyncSession):
        self.kitchen_id = kitchen_id
        self.db = db
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

    async def _get_client(self) -> ResosAPIClient:
        """Create authenticated Resos API client"""
        settings = await self._get_settings()
        if not settings.resos_api_key:
            raise ValueError("Resos API key not configured")
        return ResosAPIClient(settings.resos_api_key)

    async def _log_sync(
        self,
        sync_type: str,
        date_from: Optional[date] = None,
        date_to: Optional[date] = None
    ) -> ResosSyncLog:
        """Create sync log entry"""
        log = ResosSyncLog(
            kitchen_id=self.kitchen_id,
            sync_type=sync_type,
            status="running",
            date_from=date_from,
            date_to=date_to
        )
        self.db.add(log)
        await self.db.commit()
        await self.db.refresh(log)
        return log

    async def _complete_sync(
        self,
        log: ResosSyncLog,
        bookings_fetched: int,
        bookings_flagged: int,
        error: Optional[str] = None
    ):
        """Mark sync log as complete"""
        log.status = "failed" if error else "success"
        log.bookings_fetched = bookings_fetched
        log.bookings_flagged = bookings_flagged
        log.error_message = error
        log.completed_at = datetime.utcnow()
        await self.db.commit()

    def _parse_custom_fields(self, custom_fields: list[dict], field_mapping: dict) -> dict:
        """
        Extract custom fields from Resos booking using configured mapping

        Args:
            custom_fields: Raw custom fields array from Resos API
            field_mapping: Mapping dict from settings (field_name -> resos_field_id)

        Returns dict with extracted field values
        """
        result = {}

        # Build lookup by field ID if mapping exists
        if field_mapping:
            field_lookup = {f['_id']: f for f in custom_fields}

            # Use mapped field IDs
            if 'booking_number' in field_mapping:
                field_id = field_mapping['booking_number']
                if field_id in field_lookup:
                    result['hotel_booking_number'] = field_lookup[field_id].get('value')

            if 'hotel_guest' in field_mapping:
                field_id = field_mapping['hotel_guest']
                if field_id in field_lookup:
                    choice_name = field_lookup[field_id].get('multipleChoiceValueName', '').lower()
                    result['is_hotel_guest'] = 'yes' in choice_name

            if 'dbb' in field_mapping:
                field_id = field_mapping['dbb']
                if field_id in field_lookup:
                    choice_name = field_lookup[field_id].get('multipleChoiceValueName', '').lower()
                    result['is_dbb'] = 'yes' in choice_name

            if 'package' in field_mapping:
                field_id = field_mapping['package']
                if field_id in field_lookup:
                    choice_name = field_lookup[field_id].get('multipleChoiceValueName', '').lower()
                    result['is_package'] = 'yes' in choice_name

            if 'exclude' in field_mapping:
                field_id = field_mapping['exclude']
                if field_id in field_lookup:
                    result['exclude_flag'] = field_lookup[field_id].get('value')

            # Handle allergies - combine predefined and other fields
            allergies_parts = []
            if 'allergies' in field_mapping:
                field_id = field_mapping['allergies']
                if field_id in field_lookup:
                    field = field_lookup[field_id]
                    if 'multipleChoiceValueName' in field:
                        allergies_parts.append(field.get('multipleChoiceValueName', ''))
                    else:
                        val = field.get('value', '')
                        if val:
                            allergies_parts.append(val)

            if 'allergies_other' in field_mapping:
                field_id = field_mapping['allergies_other']
                if field_id in field_lookup:
                    val = field_lookup[field_id].get('value', '')
                    if val:
                        allergies_parts.append(val)

            if allergies_parts:
                result['allergies'] = ', '.join(filter(None, allergies_parts))

        else:
            # Fallback: Use name-based matching (case-insensitive substring)
            allergies_parts = []
            for field in custom_fields:
                name = field.get('name', '').lower()

                if 'booking #' in name or 'booking number' in name:
                    result['hotel_booking_number'] = field.get('value')

                elif 'hotel guest' in name:
                    choice_name = field.get('multipleChoiceValueName', '').lower()
                    result['is_hotel_guest'] = 'yes' in choice_name

                elif 'dbb' in name:
                    choice_name = field.get('multipleChoiceValueName', '').lower()
                    result['is_dbb'] = 'yes' in choice_name

                elif 'package' in name:
                    choice_name = field.get('multipleChoiceValueName', '').lower()
                    result['is_package'] = 'yes' in choice_name

                elif 'group' in name and 'exclude' in name:
                    result['exclude_flag'] = field.get('value')

                elif 'allerg' in name or 'dietary' in name:
                    # Collect both predefined and custom allergy fields
                    if 'multipleChoiceValueName' in field:
                        val = field.get('multipleChoiceValueName', '')
                        if val:
                            allergies_parts.append(val)
                    else:
                        val = field.get('value', '')
                        if val:
                            allergies_parts.append(val)

            if allergies_parts:
                result['allergies'] = ', '.join(filter(None, allergies_parts))

        return result

    def _check_flags(
        self,
        booking: dict,
        people: int,
        notes: str,
        allergies: str,
        settings: KitchenSettings
    ) -> tuple[bool, list[str]]:
        """
        Check if booking should be flagged

        Returns: (is_flagged, flag_reasons list)
        """
        flags = []

        # Large group check
        if people >= settings.resos_large_group_threshold:
            flags.append("large_group")

        # Allergy check
        if allergies:
            flags.append("allergies")

        # Note keyword check
        if notes and settings.resos_note_keywords:
            keywords = [k.strip().lower() for k in settings.resos_note_keywords.split('|') if k.strip()]
            notes_lower = notes.lower()
            for keyword in keywords:
                if keyword in notes_lower:
                    flags.append(f"note_keyword_{keyword}")

        return (len(flags) > 0, flags)

    async def sync_opening_hours(self) -> int:
        """
        Sync opening hours/service periods from Resos

        Returns number of periods synced
        """
        logger.info(f"Syncing opening hours for kitchen {self.kitchen_id}")

        async with await self._get_client() as client:
            hours = await client.get_opening_hours()

        # Delete existing hours
        await self.db.execute(
            delete(ResosOpeningHour).where(ResosOpeningHour.kitchen_id == self.kitchen_id)
        )

        # Insert fresh data
        for hour in hours:
            opening_hour = ResosOpeningHour(
                kitchen_id=self.kitchen_id,
                resos_opening_hour_id=hour['_id'],
                name=hour.get('name', 'Unknown'),
                start_time=hour.get('startTime'),
                end_time=hour.get('endTime'),
                days_of_week=','.join(hour.get('days', [])),
                is_special=hour.get('type') == 'special',
                fetched_at=datetime.utcnow()
            )
            self.db.add(opening_hour)

        await self.db.commit()
        logger.info(f"Synced {len(hours)} opening hours")
        return len(hours)

    async def sync_bookings(
        self,
        date_from: date,
        date_to: date,
        is_forecast: bool = False
    ) -> dict:
        """
        Sync bookings for date range

        Returns summary dict with counts
        """
        log = await self._log_sync('forecast' if is_forecast else 'historical', date_from, date_to)

        try:
            settings = await self._get_settings()

            async with await self._get_client() as client:
                bookings = await client.get_bookings(date_from, date_to)

            total_fetched = len(bookings)
            total_flagged = 0

            # Get custom field mapping from settings
            field_mapping = settings.resos_custom_field_mapping or {}

            # Process each booking
            for booking_data in bookings:
                custom_fields = self._parse_custom_fields(
                    booking_data.get('customFields', []),
                    field_mapping
                )

                # Extract notes
                notes_list = booking_data.get('restaurantNotes', [])
                notes = '\n'.join([n.get('restaurantNote', '') for n in notes_list if n.get('restaurantNote')])

                # Check flags
                is_flagged, flag_reasons = self._check_flags(
                    booking_data,
                    booking_data.get('people', 0),
                    notes,
                    custom_fields.get('allergies', ''),
                    settings
                )

                if is_flagged:
                    total_flagged += 1

                # Parse date and time
                # Resos API returns date as "YYYY-MM-DD" and time as "HH:MM"
                from datetime import time as time_class
                booking_date = date.fromisoformat(booking_data['date'])

                # Parse time string (format: "HH:MM" or "HH:MM:SS")
                time_str = booking_data['time']
                if ':' in time_str:
                    time_parts = time_str.split(':')
                    booking_time = time_class(int(time_parts[0]), int(time_parts[1]))
                else:
                    # Fallback if no colon
                    booking_time = time_class(0, 0)

                # Parse booked_at timestamp if available
                booked_at = None
                if booking_data.get('createdAt'):
                    try:
                        booked_at = datetime.fromisoformat(booking_data['createdAt'].replace('Z', '+00:00'))
                    except:
                        pass

                # Upsert booking using INSERT ... ON CONFLICT
                stmt = insert(ResosBooking).values(
                    kitchen_id=self.kitchen_id,
                    resos_booking_id=booking_data['_id'],
                    booking_date=booking_date,
                    booking_time=booking_time,
                    people=booking_data.get('people', 0),
                    status=booking_data.get('status', 'unknown'),
                    seating_area=booking_data.get('area'),
                    hotel_booking_number=custom_fields.get('hotel_booking_number'),
                    is_hotel_guest=custom_fields.get('is_hotel_guest'),
                    is_dbb=custom_fields.get('is_dbb'),
                    is_package=custom_fields.get('is_package'),
                    exclude_flag=custom_fields.get('exclude_flag'),
                    allergies=custom_fields.get('allergies'),
                    notes=notes,
                    booked_at=booked_at,
                    opening_hour_id=booking_data.get('openingHourId'),
                    opening_hour_name=booking_data.get('openingHourName'),
                    is_flagged=is_flagged,
                    flag_reasons=','.join(flag_reasons) if flag_reasons else None,
                    fetched_at=datetime.utcnow(),
                    is_forecast=is_forecast
                )

                stmt = stmt.on_conflict_do_update(
                    index_elements=['kitchen_id', 'resos_booking_id'],
                    set_={
                        'booking_date': stmt.excluded.booking_date,
                        'booking_time': stmt.excluded.booking_time,
                        'people': stmt.excluded.people,
                        'status': stmt.excluded.status,
                        'seating_area': stmt.excluded.seating_area,
                        'hotel_booking_number': stmt.excluded.hotel_booking_number,
                        'is_hotel_guest': stmt.excluded.is_hotel_guest,
                        'is_dbb': stmt.excluded.is_dbb,
                        'is_package': stmt.excluded.is_package,
                        'exclude_flag': stmt.excluded.exclude_flag,
                        'allergies': stmt.excluded.allergies,
                        'notes': stmt.excluded.notes,
                        'booked_at': stmt.excluded.booked_at,
                        'opening_hour_id': stmt.excluded.opening_hour_id,
                        'opening_hour_name': stmt.excluded.opening_hour_name,
                        'is_flagged': stmt.excluded.is_flagged,
                        'flag_reasons': stmt.excluded.flag_reasons,
                        'fetched_at': stmt.excluded.fetched_at,
                        'is_forecast': stmt.excluded.is_forecast,
                    }
                )

                await self.db.execute(stmt)

            await self.db.commit()

            # Aggregate into daily stats
            await self._aggregate_daily_stats(date_from, date_to, is_forecast)

            await self._complete_sync(log, total_fetched, total_flagged)

            return {
                'bookings_fetched': total_fetched,
                'bookings_flagged': total_flagged,
                'date_from': date_from,
                'date_to': date_to
            }

        except Exception as e:
            logger.error(f"Resos sync failed: {e}", exc_info=True)
            await self._complete_sync(log, 0, 0, str(e))
            raise

    async def _aggregate_daily_stats(
        self,
        date_from: date,
        date_to: date,
        is_forecast: bool
    ):
        """
        Aggregate bookings into daily stats
        """
        # Query bookings grouped by date and service period
        result = await self.db.execute(
            select(
                ResosBooking.booking_date,
                ResosBooking.opening_hour_name,
                func.count(ResosBooking.id).label('booking_count'),
                func.sum(ResosBooking.people).label('cover_count'),
                func.sum(case((ResosBooking.is_flagged == True, 1), else_=0)).label('flagged_count')
            ).where(
                and_(
                    ResosBooking.kitchen_id == self.kitchen_id,
                    ResosBooking.booking_date >= date_from,
                    ResosBooking.booking_date <= date_to
                )
            ).group_by(
                ResosBooking.booking_date,
                ResosBooking.opening_hour_name
            )
        )

        # Build daily stats
        daily_data = {}
        for row in result:
            booking_date = row.booking_date
            if booking_date not in daily_data:
                daily_data[booking_date] = {
                    'total_bookings': 0,
                    'total_covers': 0,
                    'flagged_count': 0,
                    'service_breakdown': []
                }

            daily_data[booking_date]['total_bookings'] += row.booking_count
            daily_data[booking_date]['total_covers'] += row.cover_count
            daily_data[booking_date]['flagged_count'] += row.flagged_count

            daily_data[booking_date]['service_breakdown'].append({
                'period': row.opening_hour_name or 'Unknown',
                'bookings': row.booking_count,
                'covers': row.cover_count
            })

        # Build consolidated bookings summary for each day
        for booking_date in daily_data.keys():
            # Fetch all bookings for this date
            bookings_result = await self.db.execute(
                select(ResosBooking).where(
                    and_(
                        ResosBooking.kitchen_id == self.kitchen_id,
                        ResosBooking.booking_date == booking_date
                    )
                ).order_by(ResosBooking.booking_time)
            )

            bookings_for_date = bookings_result.scalars().all()

            # Build consolidated summary (stripped data for quick access)
            bookings_summary = [
                {
                    'time': b.booking_time.strftime('%H:%M'),
                    'people': b.people,
                    'period': b.opening_hour_name,
                    'booked_at': b.booked_at.isoformat() if b.booked_at else None,
                    'is_flagged': b.is_flagged,
                    'status': b.status
                }
                for b in bookings_for_date
            ]

            daily_data[booking_date]['bookings_summary'] = bookings_summary

        # Upsert daily stats
        for booking_date, data in daily_data.items():
            stmt = insert(ResosDailyStats).values(
                kitchen_id=self.kitchen_id,
                date=booking_date,
                total_bookings=data['total_bookings'],
                total_covers=data['total_covers'],
                service_breakdown=data['service_breakdown'],
                flagged_booking_count=data['flagged_count'],
                bookings_summary=data['bookings_summary'],
                fetched_at=datetime.utcnow(),
                is_forecast=is_forecast
            )

            stmt = stmt.on_conflict_do_update(
                index_elements=['kitchen_id', 'date'],
                set_={
                    'total_bookings': stmt.excluded.total_bookings,
                    'total_covers': stmt.excluded.total_covers,
                    'service_breakdown': stmt.excluded.service_breakdown,
                    'flagged_booking_count': stmt.excluded.flagged_booking_count,
                    'bookings_summary': stmt.excluded.bookings_summary,
                    'fetched_at': stmt.excluded.fetched_at,
                    'is_forecast': stmt.excluded.is_forecast,
                }
            )

            await self.db.execute(stmt)

        await self.db.commit()

    async def run_daily_sync(self) -> dict:
        """
        Run daily sync:
        - Historical: Yesterday - 30 days
        - Forecast: Today + 60 days
        """
        today = date.today()
        yesterday = today - timedelta(days=1)
        historical_from = yesterday - timedelta(days=self.HISTORICAL_BACKFILL_DAYS)
        forecast_to = today + timedelta(days=self.FORECAST_DAYS)

        # Sync opening hours first
        await self.sync_opening_hours()

        # Sync historical
        hist_result = await self.sync_bookings(historical_from, yesterday, is_forecast=False)

        # Sync forecast
        forecast_result = await self.sync_bookings(today, forecast_to, is_forecast=True)

        # Update last sync timestamp
        settings = await self._get_settings()
        settings.resos_last_sync = datetime.utcnow()
        await self.db.commit()

        return {
            'historical': hist_result,
            'forecast': forecast_result
        }
