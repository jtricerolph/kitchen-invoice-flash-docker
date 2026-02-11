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

                    # First, handle multipleChoiceValueName (predefined checkbox options)
                    if 'multipleChoiceValueName' in field:
                        choice_val = field.get('multipleChoiceValueName', '')
                        # Handle both list and string values
                        if isinstance(choice_val, list):
                            # Extract 'name' from each dict in the list
                            for item in choice_val:
                                if isinstance(item, dict) and 'name' in item:
                                    allergies_parts.append(item['name'].strip())
                                elif item:  # If it's just a string
                                    allergies_parts.append(str(item).strip())
                        elif isinstance(choice_val, str) and choice_val.startswith('['):
                            # Parse Python string representation (uses single quotes)
                            import ast
                            try:
                                parsed = ast.literal_eval(choice_val)
                                if isinstance(parsed, list):
                                    for item in parsed:
                                        if isinstance(item, dict) and 'name' in item:
                                            allergies_parts.append(item['name'].strip())
                                        elif item:
                                            allergies_parts.append(str(item).strip())
                            except (ValueError, SyntaxError):
                                # If parsing fails, just use the raw value
                                allergies_parts.append(str(choice_val))
                        elif choice_val:
                            allergies_parts.append(str(choice_val).strip())

                    # Then, ALSO check 'value' field
                    # This can contain either:
                    # 1. Actual Python list of checkbox selections: [{'_id': '...', 'name': 'Gluten Free', ...}]
                    # 2. Python list string of checkbox selections: "[{'_id': '...', 'name': 'Gluten Free', ...}]"
                    # 3. Free-text input: "No beef"
                    val = field.get('value', '')
                    if val:
                        # Check if already a list (API returns it as actual list, not string)
                        if isinstance(val, list):
                            for item in val:
                                if isinstance(item, dict) and 'name' in item:
                                    allergies_parts.append(item['name'].strip())
                                elif item:
                                    allergies_parts.append(str(item).strip())
                        elif isinstance(val, str) and val.startswith('['):
                            # Parse Python list string (if API returns string representation)
                            import ast
                            try:
                                parsed = ast.literal_eval(val)
                                if isinstance(parsed, list):
                                    for item in parsed:
                                        if isinstance(item, dict) and 'name' in item:
                                            allergies_parts.append(item['name'].strip())
                                        elif item:
                                            allergies_parts.append(str(item).strip())
                            except (ValueError, SyntaxError):
                                # If parsing fails, use as plain text
                                allergies_parts.append(str(val).strip())
                        else:
                            # Plain text value
                            allergies_parts.append(str(val).strip())

            if 'allergies_other' in field_mapping:
                field_id = field_mapping['allergies_other']
                if field_id in field_lookup:
                    val = field_lookup[field_id].get('value', '')
                    if val:
                        allergies_parts.append(str(val).strip())

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
                    # Collect both predefined checkbox options and free-text "Other" input
                    # First, handle multipleChoiceValueName (predefined options)
                    if 'multipleChoiceValueName' in field:
                        val = field.get('multipleChoiceValueName', '')
                        # Handle both list and string values
                        if isinstance(val, list):
                            # Extract 'name' from each dict in the list
                            for item in val:
                                if isinstance(item, dict) and 'name' in item:
                                    allergies_parts.append(item['name'].strip())
                                elif item:  # If it's just a string
                                    allergies_parts.append(str(item).strip())
                        elif isinstance(val, str) and val.startswith('['):
                            # Parse Python string representation (uses single quotes)
                            import ast
                            try:
                                parsed = ast.literal_eval(val)
                                if isinstance(parsed, list):
                                    for item in parsed:
                                        if isinstance(item, dict) and 'name' in item:
                                            allergies_parts.append(item['name'].strip())
                                        elif item:
                                            allergies_parts.append(str(item).strip())
                            except (ValueError, SyntaxError):
                                # If parsing fails, just use the raw value
                                allergies_parts.append(str(val))
                        elif val:
                            allergies_parts.append(str(val).strip())

                    # Then, ALSO check 'value' field (free-text "Other" input OR checkbox selections)
                    # This can exist alongside multipleChoiceValueName
                    val = field.get('value', '')
                    if val:
                        # Check if already a list (API returns it as actual list, not string)
                        if isinstance(val, list):
                            for item in val:
                                if isinstance(item, dict) and 'name' in item:
                                    allergies_parts.append(item['name'].strip())
                                elif item:
                                    allergies_parts.append(str(item).strip())
                        elif isinstance(val, str) and val.startswith('['):
                            # Parse Python list string (if API returns string representation)
                            import ast
                            try:
                                parsed = ast.literal_eval(val)
                                if isinstance(parsed, list):
                                    for item in parsed:
                                        if isinstance(item, dict) and 'name' in item:
                                            allergies_parts.append(item['name'].strip())
                                        elif item:
                                            allergies_parts.append(str(item).strip())
                                else:
                                    allergies_parts.append(str(val).strip())
                            except (ValueError, SyntaxError):
                                allergies_parts.append(str(val).strip())
                        else:
                            allergies_parts.append(str(val).strip())

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

        # Filter out special/one-off periods - only keep regular recurring service periods
        # Special periods include things like "closed", "no power", one-time events, etc.
        regular_hours = [h for h in hours if h.get('special') == False]
        special_hours = [h for h in hours if h.get('special') == True]

        logger.info(f"Fetched {len(hours)} total periods, filtered to {len(regular_hours)} regular service periods")

        # Log special periods to understand what's being filtered out
        breakfast_related = [h for h in special_hours if 'breakfast' in h.get('name', '').lower() or h.get('open', 0) < 1200]
        if breakfast_related:
            logger.info(f"Found {len(breakfast_related)} breakfast/morning periods that are marked as special:")
            for h in breakfast_related[:5]:  # Log first 5
                open_time = f"{h.get('open', 0) // 100:02d}:{h.get('open', 0) % 100:02d}" if 'open' in h else 'N/A'
                close_time = f"{h.get('close', 0) // 100:02d}:{h.get('close', 0) % 100:02d}" if 'close' in h else 'N/A'
                logger.info(f"  - {h.get('name', 'Unknown')}: {open_time} - {close_time} (special={h.get('special')})")

        # Delete existing hours
        await self.db.execute(
            delete(ResosOpeningHour).where(ResosOpeningHour.kitchen_id == self.kitchen_id)
        )

        # Insert fresh data (only regular periods)
        for hour in regular_hours:
            # Transform time format: Resos API uses 'open' and 'close' as HHMM integers (e.g., 1200 = 12:00)
            # Convert to time objects for database
            start_time = None
            end_time = None

            if 'open' in hour:
                open_val = hour['open']
                hours_part = open_val // 100
                mins_part = open_val % 100
                start_time = datetime.strptime(f"{hours_part:02d}:{mins_part:02d}", "%H:%M").time()

            if 'close' in hour:
                close_val = hour['close']
                hours_part = close_val // 100
                mins_part = close_val % 100
                end_time = datetime.strptime(f"{hours_part:02d}:{mins_part:02d}", "%H:%M").time()

            opening_hour = ResosOpeningHour(
                kitchen_id=self.kitchen_id,
                resos_opening_hour_id=hour['_id'],
                name=hour.get('name', 'Unknown'),
                start_time=start_time,
                end_time=end_time,
                days_of_week=','.join(hour.get('days', [])),
                is_special=hour.get('type') == 'special',
                fetched_at=datetime.utcnow()
            )
            self.db.add(opening_hour)

        await self.db.commit()
        logger.info(f"Synced {len(regular_hours)} regular opening hours (excluded {len(hours) - len(regular_hours)} special periods)")
        return len(regular_hours)

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
        logger.info(f"Starting Resos sync: kitchen_id={self.kitchen_id}, from={date_from}, to={date_to}, forecast={is_forecast}")

        log = await self._log_sync('forecast' if is_forecast else 'historical', date_from, date_to)

        try:
            settings = await self._get_settings()
            logger.info(f"Retrieved settings, API key configured: {bool(settings.resos_api_key)}")

            logger.info(f"Creating Resos API client...")
            async with await self._get_client() as client:
                logger.info(f"Fetching bookings from Resos API...")
                bookings = await client.get_bookings(date_from, date_to)

            total_fetched = len(bookings)
            total_processed = 0
            total_skipped = 0
            total_flagged = 0
            logger.info(f"Fetched {total_fetched} bookings from Resos API")

            # Get custom field mapping from settings
            field_mapping = settings.resos_custom_field_mapping or {}

            # Statuses to exclude from sync (cancelled, waitlist, deleted bookings shouldn't be counted)
            excluded_statuses = {'canceled', 'cancelled', 'waitlist', 'deleted', 'declined', 'rejected'}

            # Process each booking
            for booking_data in bookings:
                # Handle bookings with excluded statuses - remove from DB if they exist
                status = booking_data.get('status', '').lower()
                if status in excluded_statuses:
                    resos_id = booking_data.get('_id')
                    if resos_id:
                        await self.db.execute(
                            delete(ResosBooking).where(
                                and_(
                                    ResosBooking.kitchen_id == self.kitchen_id,
                                    ResosBooking.resos_booking_id == resos_id
                                )
                            )
                        )
                    logger.debug(f"Removed/skipped booking {resos_id} with excluded status: {status}")
                    total_skipped += 1
                    continue

                total_processed += 1

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
                # Convert to timezone-naive datetime for database (TIMESTAMP WITHOUT TIME ZONE)
                booked_at = None
                if booking_data.get('createdAt'):
                    try:
                        dt = datetime.fromisoformat(booking_data['createdAt'].replace('Z', '+00:00'))
                        # Remove timezone info to match database column type
                        booked_at = dt.replace(tzinfo=None)
                    except:
                        pass

                # Extract table name from tables array (Phase 8.1)
                # Format: [{'_id': '...', 'name': 'Table 8', 'area': {...}}]
                table_name = None
                tables = booking_data.get('tables', [])
                if tables and len(tables) > 0:
                    table_name = tables[0].get('name')

                # Upsert booking using INSERT ... ON CONFLICT
                stmt = insert(ResosBooking).values(
                    kitchen_id=self.kitchen_id,
                    resos_booking_id=booking_data['_id'],
                    booking_date=booking_date,
                    booking_time=booking_time,
                    people=booking_data.get('people', 0),
                    status=booking_data.get('status', 'unknown').lower(),
                    seating_area=booking_data.get('area'),
                    table_name=table_name,
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
                        'table_name': stmt.excluded.table_name,
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
            logger.info(f"Committed {total_processed} bookings to database ({total_skipped} skipped with excluded statuses)")

            # Aggregate into daily stats
            logger.info(f"Aggregating daily stats for {date_from} to {date_to}...")
            await self._aggregate_daily_stats(date_from, date_to, is_forecast)
            logger.info(f"Daily stats aggregation complete")

            await self._complete_sync(log, total_processed, total_flagged)
            logger.info(f"Resos sync completed successfully: {total_processed} processed, {total_skipped} skipped, {total_flagged} flagged")

            return {
                'bookings_fetched': total_fetched,
                'bookings_processed': total_processed,
                'bookings_skipped': total_skipped,
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
        logger.info(f"_aggregate_daily_stats: Querying bookings for aggregation...")
        # Query bookings grouped by date and service period
        result = await self.db.execute(
            select(
                ResosBooking.booking_date,
                ResosBooking.opening_hour_id,
                ResosBooking.opening_hour_name,
                func.count(ResosBooking.id).label('booking_count'),
                func.sum(ResosBooking.people).label('cover_count'),
                func.sum(case((ResosBooking.is_flagged == True, 1), else_=0)).label('flagged_count')
            ).where(
                and_(
                    ResosBooking.kitchen_id == self.kitchen_id,
                    ResosBooking.booking_date >= date_from,
                    ResosBooking.booking_date <= date_to,
                    ~func.lower(ResosBooking.status).in_(['canceled', 'cancelled', 'waitlist', 'deleted', 'declined', 'rejected'])
                )
            ).group_by(
                ResosBooking.booking_date,
                ResosBooking.opening_hour_id,
                ResosBooking.opening_hour_name
            )
        )

        # Get kitchen settings for service type mapping
        settings_result = await self.db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
        )
        settings = settings_result.scalar_one_or_none()
        opening_hours_mapping = settings.resos_opening_hours_mapping if settings else None

        # Create a map from opening_hour_id (resos_id) to service_type
        service_type_map = {}
        if opening_hours_mapping:
            for mapping in opening_hours_mapping:
                if isinstance(mapping, dict):
                    resos_id = mapping.get('resos_id', '')
                    service_type = mapping.get('service_type', '')
                    if resos_id and service_type:
                        service_type_map[resos_id] = service_type

        # Build daily stats
        daily_data = {}
        logger.info(f"_aggregate_daily_stats: Building daily stats from query results...")
        for row in result:
            booking_date = row.booking_date
            if booking_date not in daily_data:
                daily_data[booking_date] = {
                    'total_bookings': 0,
                    'total_covers': 0,
                    'flagged_count': 0,
                    'service_breakdown_raw': {}  # Store by service type
                }

            daily_data[booking_date]['total_bookings'] += row.booking_count
            daily_data[booking_date]['total_covers'] += row.cover_count
            daily_data[booking_date]['flagged_count'] += row.flagged_count

            # Map opening_hour_id to service_type
            opening_hour_id = row.opening_hour_id
            opening_hour_name = row.opening_hour_name or 'Unknown'

            # Look up service type by opening_hour_id, fallback to opening_hour_name
            service_type = service_type_map.get(opening_hour_id, opening_hour_name) if opening_hour_id else opening_hour_name

            # Capitalize service type for display
            service_type_display = service_type.capitalize() if service_type else 'Unknown'

            # Aggregate by service type
            if service_type_display not in daily_data[booking_date]['service_breakdown_raw']:
                daily_data[booking_date]['service_breakdown_raw'][service_type_display] = {
                    'bookings': 0,
                    'covers': 0
                }

            daily_data[booking_date]['service_breakdown_raw'][service_type_display]['bookings'] += row.booking_count
            daily_data[booking_date]['service_breakdown_raw'][service_type_display]['covers'] += row.cover_count

        # Convert service_breakdown_raw dict to list format
        for booking_date in daily_data.keys():
            daily_data[booking_date]['service_breakdown'] = [
                {
                    'period': service_type,
                    'bookings': stats['bookings'],
                    'covers': stats['covers']
                }
                for service_type, stats in daily_data[booking_date]['service_breakdown_raw'].items()
            ]
            del daily_data[booking_date]['service_breakdown_raw']  # Remove temp field

        # Build consolidated bookings summary for each day
        for booking_date in daily_data.keys():
            # Fetch all bookings for this date
            bookings_result = await self.db.execute(
                select(ResosBooking).where(
                    and_(
                        ResosBooking.kitchen_id == self.kitchen_id,
                        ResosBooking.booking_date == booking_date,
                        ~func.lower(ResosBooking.status).in_(['canceled', 'cancelled', 'waitlist', 'deleted', 'declined', 'rejected'])
                    )
                ).order_by(ResosBooking.booking_time)
            )

            bookings_for_date = bookings_result.scalars().all()

            # Build consolidated summary (stripped data for quick access)
            bookings_summary = []
            for b in bookings_for_date:
                # Map opening_hour_id to service_type for display
                service_type = service_type_map.get(b.opening_hour_id, b.opening_hour_name) if b.opening_hour_id else b.opening_hour_name
                service_type_display = service_type.capitalize() if service_type else (b.opening_hour_name or 'Unknown')

                bookings_summary.append({
                    'time': b.booking_time.strftime('%H:%M'),
                    'people': b.people,
                    'period': service_type_display,
                    'booked_at': b.booked_at.isoformat() if b.booked_at else None,
                    'is_flagged': b.is_flagged,
                    'status': b.status
                })

            # Collect unique flag types for this day
            unique_flags = set()
            for b in bookings_for_date:
                if b.is_flagged and b.flag_reasons:
                    # Split flag_reasons and add to set
                    for flag in b.flag_reasons.split(','):
                        flag = flag.strip()
                        if flag:
                            unique_flags.add(flag)

            daily_data[booking_date]['bookings_summary'] = bookings_summary
            daily_data[booking_date]['unique_flag_types'] = list(unique_flags)

        # Upsert daily stats
        for booking_date, data in daily_data.items():
            stmt = insert(ResosDailyStats).values(
                kitchen_id=self.kitchen_id,
                date=booking_date,
                total_bookings=data['total_bookings'],
                total_covers=data['total_covers'],
                service_breakdown=data['service_breakdown'],
                flagged_booking_count=data['flagged_count'],
                unique_flag_types=data['unique_flag_types'],
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
                    'unique_flag_types': stmt.excluded.unique_flag_types,
                    'bookings_summary': stmt.excluded.bookings_summary,
                    'fetched_at': stmt.excluded.fetched_at,
                    'is_forecast': stmt.excluded.is_forecast,
                }
            )

            await self.db.execute(stmt)

        # Clean up stale daily stats for dates in range that no longer have valid bookings
        # (e.g. all bookings for a date were cancelled - daily_data won't have an entry,
        # so the old stats row with inflated counts would persist)
        dates_with_bookings = set(daily_data.keys())
        existing_stats = await self.db.execute(
            select(ResosDailyStats.date).where(
                and_(
                    ResosDailyStats.kitchen_id == self.kitchen_id,
                    ResosDailyStats.date >= date_from,
                    ResosDailyStats.date <= date_to
                )
            )
        )
        for row in existing_stats:
            if row.date not in dates_with_bookings:
                await self.db.execute(
                    delete(ResosDailyStats).where(
                        and_(
                            ResosDailyStats.kitchen_id == self.kitchen_id,
                            ResosDailyStats.date == row.date
                        )
                    )
                )
                logger.info(f"Removed stale daily stats for {row.date} (no valid bookings remaining)")

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

    async def run_upcoming_sync(self) -> dict:
        """
        Run upcoming sync for next 7 days only.
        This is designed to run more frequently (e.g., every 15 minutes) to keep
        the most important upcoming bookings fresh.
        """
        today = date.today()
        next_week = today + timedelta(days=7)

        # Sync opening hours first
        await self.sync_opening_hours()

        # Sync next 7 days
        result = await self.sync_bookings(today, next_week, is_forecast=True)

        # Update last upcoming sync timestamp
        settings = await self._get_settings()
        settings.resos_last_upcoming_sync = datetime.utcnow()
        await self.db.commit()

        return {
            'upcoming': result
        }
