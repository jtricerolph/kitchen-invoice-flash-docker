"""
Resos Statistics Service - Phase 8

Handles matching between SambaPOS tickets and Resos bookings,
calculates spend analysis, and generates statistics for the Bookings Stats Report.
"""
import logging
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func

from models.resos import ResosBooking, ResosOpeningHour
from models.settings import KitchenSettings
from services.sambapos_api import SambaPOSClient

logger = logging.getLogger(__name__)


class ResosStatsService:
    """Service for calculating Resos booking statistics with SambaPOS spend integration."""

    def __init__(self, kitchen_id: int, db: AsyncSession):
        self.kitchen_id = kitchen_id
        self.db = db

    async def _get_settings(self) -> KitchenSettings:
        """Fetch kitchen settings."""
        result = await self.db.execute(
            select(KitchenSettings).where(KitchenSettings.kitchen_id == self.kitchen_id)
        )
        return result.scalar_one()

    async def _get_sambapos_client(self, settings: KitchenSettings) -> Optional[SambaPOSClient]:
        """Create SambaPOS client if configured."""
        if not all([settings.sambapos_db_host, settings.sambapos_db_name,
                   settings.sambapos_db_username, settings.sambapos_db_password]):
            logger.warning("SambaPOS not configured, skipping spend analysis")
            return None

        return SambaPOSClient(
            host=settings.sambapos_db_host,
            port=settings.sambapos_db_port or 1433,
            database=settings.sambapos_db_name,
            username=settings.sambapos_db_username,
            password=settings.sambapos_db_password
        )

    def _parse_gl_codes(self, gl_code_str: Optional[str]) -> list[str]:
        """Parse comma-separated GL codes from settings."""
        if not gl_code_str:
            return []
        return [code.strip() for code in gl_code_str.split(',') if code.strip()]

    def _match_ticket_to_booking_by_id(
        self,
        ticket: dict,
        bookings_by_id: dict[str, dict]
    ) -> Optional[dict]:
        """
        Primary matching: Match ticket to booking by Resos booking ID from ticket tag.

        Tag format: "BOOKING_ID - Guest Name" (e.g., "ABC123XYZ - John Smith")

        NOT YET IMPLEMENTED - This is a placeholder for future enhancement.
        Currently returns None, causing fallback to table matching.

        Args:
            ticket: Ticket data from SambaPOS
            bookings_by_id: Dict mapping resos_booking_id to booking data

        Returns:
            Matched booking dict or None if no match
        """
        # TODO: Implement when ticket tagging with booking ID is added to SambaPOS
        # booking_id = ticket.get('booking_id')
        # if booking_id and booking_id in bookings_by_id:
        #     logger.debug(f"Primary match: Ticket {ticket['ticket_id']} matched to booking {booking_id}")
        #     return bookings_by_id[booking_id]

        return None

    def _normalize_table_name(self, resos_table_name: str, sambapos_table_name: str) -> bool:
        """
        Check if Resos and SambaPOS table names match, using smart normalization.

        Handles common naming patterns:
        - "Table 1" (Resos) → "T01" (SambaPOS)
        - "Table 10" (Resos) → "T10" (SambaPOS)

        Args:
            resos_table_name: Table name from Resos booking
            sambapos_table_name: Table name from SambaPOS ticket

        Returns:
            True if names match, False otherwise
        """
        # Handle None values
        if resos_table_name is None or sambapos_table_name is None:
            return False

        # Exact match
        if resos_table_name == sambapos_table_name:
            return True

        # Case-insensitive match
        if resos_table_name.lower() == sambapos_table_name.lower():
            return True

        # Smart normalization: "Table 1" → "T01"
        # Extract number from Resos name (e.g., "Table 1" → "1")
        if resos_table_name.startswith("Table "):
            try:
                table_num = resos_table_name.replace("Table ", "").strip()
                # Try zero-padded format: "1" → "T01"
                if f"T{table_num.zfill(2)}" == sambapos_table_name:
                    return True
                # Try non-padded format: "10" → "T10"
                if f"T{table_num}" == sambapos_table_name:
                    return True
            except:
                pass

        # SambaPOS format to Resos format: "T01" → "Table 1"
        if sambapos_table_name.startswith("T"):
            try:
                table_num = sambapos_table_name[1:].lstrip("0") or "0"
                if f"Table {table_num}" == resos_table_name:
                    return True
            except:
                pass

        return False

    def _match_ticket_to_booking_by_table(
        self,
        ticket: dict,
        bookings_by_table_date: dict[tuple, list[dict]],
        opening_hours_mapping: Optional[list[dict]]
    ) -> Optional[dict]:
        """
        Fallback matching: Match ticket to booking by table + date + service period.

        Uses smart table name normalization to match different naming conventions:
        - "Table 1" (Resos) ↔ "T01" (SambaPOS)

        Args:
            ticket: Ticket data from SambaPOS with table_name, ticket_date, ticket_time
            bookings_by_table_date: Dict mapping (table_name, date) to list of bookings
            opening_hours_mapping: Service period time windows from settings

        Returns:
            Matched booking dict or None if no match
        """
        table_name = ticket.get('table_name')
        ticket_date = ticket.get('ticket_date')
        ticket_time = ticket.get('ticket_time')

        if not table_name or not ticket_date or not ticket_time:
            return None

        # Convert ticket_date to date object if it's a datetime
        from datetime import date as date_type, datetime as datetime_type
        if isinstance(ticket_date, datetime_type):
            ticket_date_only = ticket_date.date()
        else:
            ticket_date_only = ticket_date

        # Try exact match first
        key = (table_name, ticket_date_only)
        candidate_bookings = bookings_by_table_date.get(key, [])

        # If no exact match, try normalized matching
        if not candidate_bookings:
            logger.info(f"No exact match for table '{table_name}' on {ticket_date_only}, trying normalization...")
            matches_found = False
            for (booking_table, booking_date), bookings in bookings_by_table_date.items():
                if booking_date == ticket_date_only:
                    matches = self._normalize_table_name(booking_table, table_name)
                    logger.info(f"  Comparing Resos '{booking_table}' with SambaPOS '{table_name}': {matches}")
                    if matches:
                        candidate_bookings = bookings
                        matches_found = True
                        logger.info(f"✓ Table name MATCHED: '{booking_table}' (Resos) ↔ '{table_name}' (SambaPOS)")
                        break

        if not candidate_bookings:
            logger.info(f"❌ No bookings found for table '{table_name}' on {ticket_date_only}")
            return None

        # Calculate time differences for all bookings (even if only one)
        # We still need to enforce the 60-minute window!
        candidates_with_time_diff = []
        for booking in candidate_bookings:
            booking_time = booking['booking_time']
            ticket_dt = datetime.combine(ticket_date_only, ticket_time)
            booking_dt = datetime.combine(ticket_date_only, booking_time)
            time_diff = abs((ticket_dt - booking_dt).total_seconds() / 60)

            candidates_with_time_diff.append({
                'booking': booking,
                'time_diff': time_diff
            })

        # Filter to bookings within 60 minutes (reduced from 120)
        candidates_within_window = [c for c in candidates_with_time_diff if c['time_diff'] <= 60]

        if not candidates_within_window:
            # No matches within time window
            min_diff = min(c['time_diff'] for c in candidates_with_time_diff) if candidates_with_time_diff else None
            logger.debug(f"No match: Ticket {ticket['ticket_id']} for {table_name} on {ticket_date_only} - closest booking {min_diff:.0f} min away (outside 60min window)")
            return None

        # If multiple matches within window, prefer same service period
        if len(candidates_within_window) > 1 and opening_hours_mapping:
            # Infer ticket's service period
            ticket_period = self._infer_service_period_from_time(
                ticket_time,
                [],  # opening_hours_data not available here, but method handles gracefully
                ticket_datetime=datetime.combine(ticket_date_only, ticket_time),
                settings=None  # settings not available here
            )

            # Find candidates in same service period
            same_period_candidates = [
                c for c in candidates_within_window
                if c['booking'].get('opening_hour_name') == ticket_period
            ]

            if same_period_candidates:
                # Return closest match from same service period
                best_candidate = min(same_period_candidates, key=lambda c: c['time_diff'])
                logger.debug(f"Fallback match: Ticket {ticket['ticket_id']} matched to booking {best_candidate['booking']['resos_booking_id']} (time diff: {best_candidate['time_diff']:.0f} min, same service period: {ticket_period})")
                return best_candidate['booking']

        # Return closest match by time within window
        best_candidate = min(candidates_within_window, key=lambda c: c['time_diff'])
        logger.debug(f"Fallback match: Ticket {ticket['ticket_id']} matched to booking {best_candidate['booking']['resos_booking_id']} (time diff: {best_candidate['time_diff']:.0f} min)")
        return best_candidate['booking']

    async def get_spend_statistics(
        self,
        from_date: date,
        to_date: date
    ) -> dict:
        """
        Calculate spend statistics for date range with resident/non-resident split.

        Uses two-fold matching:
        1. Primary: Match by booking ID from ticket tag (not yet implemented)
        2. Fallback: Match by table + date + service period

        Args:
            from_date: Start date (inclusive)
            to_date: End date (inclusive)

        Returns:
            Dict with:
            - total_spend: Decimal
            - food_spend: Decimal
            - beverage_spend: Decimal
            - resident_spend: Decimal
            - non_resident_spend: Decimal
            - resident_covers: int
            - non_resident_covers: int
            - matched_tickets: int
            - unmatched_tickets: int
            - daily_breakdown: list[dict]
            - service_period_breakdown: list[dict]
        """
        settings = await self._get_settings()

        # Get SambaPOS client
        sambapos = await self._get_sambapos_client(settings)
        if not sambapos:
            return self._empty_stats()

        # Parse GL codes
        food_gl_codes = self._parse_gl_codes(settings.sambapos_food_gl_codes)
        beverage_gl_codes = self._parse_gl_codes(settings.sambapos_beverage_gl_codes)

        if not food_gl_codes and not beverage_gl_codes:
            logger.warning("No GL codes configured for food/beverage split")
            return self._empty_stats()

        # Get tracked categories
        tracked_categories = []
        if settings.sambapos_tracked_categories:
            tracked_categories = [cat.strip() for cat in settings.sambapos_tracked_categories.split(',') if cat.strip()]

        if not tracked_categories:
            logger.warning("No tracked categories configured")
            return self._empty_stats()

        # Fetch SambaPOS tickets
        logger.info(f"Fetching SambaPOS restaurant spend for {from_date} to {to_date}")
        tickets = await sambapos.get_restaurant_spend(
            from_date=from_date,
            to_date=to_date,
            tracked_categories=tracked_categories,
            food_gl_codes=food_gl_codes,
            beverage_gl_codes=beverage_gl_codes
        )

        logger.info(f"Fetched {len(tickets)} tickets from SambaPOS")

        # Fetch Resos bookings (only completed dining events with table assignments)
        result = await self.db.execute(
            select(ResosBooking).where(
                and_(
                    ResosBooking.kitchen_id == self.kitchen_id,
                    ResosBooking.booking_date >= from_date,
                    ResosBooking.booking_date <= to_date,
                    ResosBooking.status.in_(['seated', 'left', 'arrived']),  # Only completed bookings
                    ResosBooking.table_name.isnot(None)  # Must have table assignment
                )
            )
        )
        bookings = result.scalars().all()

        logger.info(f"Fetched {len(bookings)} completed bookings with tables from Resos")

        # Fetch opening hours from database to infer service periods for unmatched tickets
        from models.resos import ResosOpeningHour
        opening_hours_result = await self.db.execute(
            select(ResosOpeningHour).where(
                ResosOpeningHour.kitchen_id == self.kitchen_id
            )
        )
        opening_hours = opening_hours_result.scalars().all()

        logger.info(f"Fetched {len(opening_hours)} opening hours from database for kitchen {self.kitchen_id}")

        # Build opening hours data with display names and actual_end times from settings
        opening_hours_data = []
        opening_hours_map = {}
        if settings.resos_opening_hours_mapping:
            logger.debug(f"Settings has {len(settings.resos_opening_hours_mapping)} opening hour mappings")
            for mapping in settings.resos_opening_hours_mapping:
                resos_id = mapping.get('resos_id')
                if resos_id:
                    # Store full mapping (display_name and actual_end)
                    opening_hours_map[resos_id] = mapping
        else:
            logger.warning("No resos_opening_hours_mapping in settings")

        for oh in opening_hours:
            logger.debug(f"Processing opening hour: {oh.name}, start={oh.start_time}, end={oh.end_time}, id={oh.resos_opening_hour_id}")
            if oh.start_time and oh.end_time:
                mapping = opening_hours_map.get(oh.resos_opening_hour_id, {})
                display_name = mapping.get('display_name', oh.name)

                # Use actual_end from mapping if available, otherwise use database end_time
                actual_end_str = mapping.get('actual_end')
                if actual_end_str:
                    # Parse time string to time object
                    from datetime import datetime
                    end_time = datetime.strptime(actual_end_str, '%H:%M').time()
                    logger.debug(f"Using actual_end {actual_end_str} for {display_name} (database has {oh.end_time})")
                else:
                    end_time = oh.end_time

                opening_hours_data.append({
                    'start_time': oh.start_time,
                    'end_time': end_time,
                    'display_name': display_name,
                    'resos_id': oh.resos_opening_hour_id
                })
            else:
                logger.warning(f"Skipping opening hour '{oh.name}' - missing start_time or end_time")

        logger.info(f"Loaded {len(opening_hours_data)} opening hours for service period inference")

        # Build lookup dicts for matching
        bookings_by_id = {b.resos_booking_id: b for b in bookings}

        # Group bookings by (table_name, date) for fallback matching
        bookings_by_table_date = {}
        resos_table_names = set()
        for booking in bookings:
            if booking.table_name:
                resos_table_names.add(booking.table_name)
            key = (booking.table_name, booking.booking_date)
            if key not in bookings_by_table_date:
                bookings_by_table_date[key] = []
            bookings_by_table_date[key].append({
                'resos_booking_id': booking.resos_booking_id,
                'booking_date': booking.booking_date,
                'booking_time': booking.booking_time,
                'is_hotel_guest': booking.is_hotel_guest,
                'people': booking.people,
                'opening_hour_id': booking.opening_hour_id,
                'opening_hour_name': booking.opening_hour_name
            })

        logger.info(f"Resos table names: {sorted(resos_table_names)}")

        # NEW APPROACH: Classify ALL tickets as resident/non-resident
        # Don't throw away unmatched tickets!
        all_tickets = []
        resident_tickets = []
        non_resident_tickets = []

        sambapos_table_names = set()
        for ticket in tickets:
            if ticket.get('table_name'):
                sambapos_table_names.add(ticket['table_name'])

        logger.info(f"SambaPOS table names: {sorted(sambapos_table_names)}")

        for ticket in tickets:
            # Method 1: Check if ticket has a Room entity in SambaPOS
            # TODO: Need to add room_entity field to ticket data from get_restaurant_spend
            has_room_entity = ticket.get('has_room_entity', False)

            is_resident = False
            classification_method = 'non-resident-default'

            if has_room_entity:
                # Definitely a resident - they selected their room
                is_resident = True
                classification_method = 'room-entity'
            else:
                # Method 2: Try to match table to Resos booking
                matched_booking = self._match_ticket_to_booking_by_id(ticket, bookings_by_id)

                if not matched_booking:
                    matched_booking = self._match_ticket_to_booking_by_table(
                        ticket,
                        bookings_by_table_date,
                        settings.resos_opening_hours_mapping
                    )

                if matched_booking:
                    # Check if Resos booking indicates hotel guest
                    is_resident = matched_booking.get('is_hotel_guest', False) or False
                    classification_method = 'resos-booking-match'
                    ticket['matched_booking'] = matched_booking

            ticket['is_resident'] = is_resident
            ticket['classification_method'] = classification_method
            all_tickets.append(ticket)

            if is_resident:
                resident_tickets.append(ticket)
            else:
                non_resident_tickets.append(ticket)

        logger.info(f"Classified {len(all_tickets)} total tickets: {len(resident_tickets)} residents, {len(non_resident_tickets)} non-residents")

        # Calculate totals from ALL tickets (not just matched ones)
        total_spend = sum(t['total_spend'] for t in all_tickets)
        food_spend = sum(t['food_total'] for t in all_tickets)
        beverage_spend = sum(t['beverage_total'] for t in all_tickets)

        # Resident vs non-resident spend (based on classification)
        resident_spend = sum(t['total_spend'] for t in resident_tickets)
        non_resident_spend = sum(t['total_spend'] for t in non_resident_tickets)

        # Count covers from matched bookings (only for tickets that matched to Resos)
        # For tickets classified by room entity, we don't have cover count
        resident_covers = sum(
            t.get('matched_booking', {}).get('people', 0)
            for t in resident_tickets
            if 'matched_booking' in t
        )
        non_resident_covers = sum(
            t.get('matched_booking', {}).get('people', 0)
            for t in non_resident_tickets
            if 'matched_booking' in t
        )

        # Count how many tickets were matched to Resos bookings
        matched_count = sum(1 for t in all_tickets if 'matched_booking' in t)
        unmatched_count = len(all_tickets) - matched_count

        # Count tickets classified by each method
        room_entity_count = sum(1 for t in all_tickets if t.get('classification_method') == 'room-entity')
        resos_match_count = sum(1 for t in all_tickets if t.get('classification_method') == 'resos-booking-match')
        default_count = sum(1 for t in all_tickets if t.get('classification_method') == 'non-resident-default')

        logger.info(f"Classification breakdown: {room_entity_count} by room entity, {resos_match_count} by Resos match, {default_count} defaulted to non-resident")

        # Daily breakdown using ALL tickets
        daily_breakdown = self._calculate_daily_breakdown(all_tickets, from_date, to_date)

        # Service period breakdown using ALL tickets and ALL bookings
        service_period_breakdown = self._calculate_service_period_breakdown(all_tickets, bookings, settings, opening_hours_data)

        # Daily breakdown by service period
        daily_service_breakdown = self._calculate_daily_service_breakdown(all_tickets, bookings, settings, opening_hours_data)
        logger.info(f"📊 Daily service breakdown calculated: {len(daily_service_breakdown)} days")
        if len(daily_service_breakdown) > 0:
            first_day = daily_service_breakdown[0]
            logger.info(f"📊 First day: {first_day['date']}, periods: {list(first_day['periods'].keys())}")

        return {
            'total_spend': float(total_spend),
            'food_spend': float(food_spend),
            'beverage_spend': float(beverage_spend),
            'resident_spend': float(resident_spend),
            'non_resident_spend': float(non_resident_spend),
            'resident_covers': resident_covers,
            'non_resident_covers': non_resident_covers,
            'total_tickets': len(all_tickets),
            'resident_tickets': len(resident_tickets),
            'non_resident_tickets': len(non_resident_tickets),
            'matched_to_resos': matched_count,
            'unmatched_to_resos': unmatched_count,
            'classification': {
                'room_entity': room_entity_count,
                'resos_booking_match': resos_match_count,
                'non_resident_default': default_count
            },
            'daily_breakdown': daily_breakdown,
            'service_period_breakdown': service_period_breakdown,
            'daily_service_breakdown': daily_service_breakdown
        }

    def _empty_stats(self) -> dict:
        """Return empty statistics structure."""
        return {
            'total_spend': 0.0,
            'food_spend': 0.0,
            'beverage_spend': 0.0,
            'resident_spend': 0.0,
            'non_resident_spend': 0.0,
            'resident_covers': 0,
            'non_resident_covers': 0,
            'matched_tickets': 0,
            'unmatched_tickets': 0,
            'daily_breakdown': [],
            'daily_service_breakdown': [],
            'service_period_breakdown': []
        }

    def _calculate_daily_breakdown(
        self,
        matched_tickets: list[dict],
        from_date: date,
        to_date: date
    ) -> list[dict]:
        """Calculate daily spend breakdown."""
        # Group by date
        daily_data = {}
        current = from_date
        while current <= to_date:
            daily_data[current] = {
                'date': current.isoformat(),
                'total_spend': 0.0,
                'food_spend': 0.0,
                'beverage_spend': 0.0,
                'resident_spend': 0.0,
                'non_resident_spend': 0.0,
                'ticket_count': 0
            }
            current += timedelta(days=1)

        for ticket in matched_tickets:
            ticket_date = ticket['ticket_date']
            if ticket_date not in daily_data:
                continue

            daily_data[ticket_date]['total_spend'] += float(ticket['total_spend'])
            daily_data[ticket_date]['food_spend'] += float(ticket['food_total'])
            daily_data[ticket_date]['beverage_spend'] += float(ticket['beverage_total'])
            daily_data[ticket_date]['ticket_count'] += 1

            if ticket['is_resident']:
                daily_data[ticket_date]['resident_spend'] += float(ticket['total_spend'])
            else:
                daily_data[ticket_date]['non_resident_spend'] += float(ticket['total_spend'])

        return sorted(daily_data.values(), key=lambda x: x['date'])

    def _infer_service_period_from_time(
        self,
        ticket_time,
        opening_hours_data,
        ticket_datetime=None,
        settings=None
    ) -> str:
        """
        Infer service period from ticket time using actual opening hours from database.

        Two-pass matching:
        1. First tries exact match with defined service period times (including manual breakfast if configured)
        2. If no match, applies 30-minute buffer to EARLIEST period only (to catch breakfast/early arrivals)
           For example, if Lunch is 12:00-16:00 (earliest), tickets from 11:30-11:59 count as Lunch

        If multiple periods overlap, the later period (by start_time) takes precedence.
        For example, if Lunch is 12:00-15:00 and Dinner is 14:30-22:00, a ticket at 14:45
        will be classified as Dinner (the later period).

        Args:
            ticket_time: Time object from ticket
            opening_hours_data: List of dicts with start_time, end_time, display_name
            ticket_datetime: Optional datetime object to determine day of week for manual breakfast periods
            settings: Optional KitchenSettings object for manual breakfast configuration

        Returns:
            Display name of matched service period or 'Unknown'
        """
        if not ticket_time or not opening_hours_data:
            return 'Unknown'

        from datetime import time as time_type, datetime, timedelta

        # Convert ticket_time to time object if needed
        if not isinstance(ticket_time, time_type):
            return 'Unknown'

        # Merge manual breakfast periods if enabled and ticket_datetime is available
        merged_hours_data = list(opening_hours_data)  # Copy to avoid modifying original

        if (settings and
            ticket_datetime and
            settings.resos_enable_manual_breakfast and
            settings.resos_manual_breakfast_periods):

            # Get day of week from ticket datetime (1=Monday, 7=Sunday)
            # Python's weekday(): Monday=0, Sunday=6, so we add 1
            ticket_day_of_week = ticket_datetime.weekday() + 1

            # Filter manual breakfast periods for this day
            for breakfast_period in settings.resos_manual_breakfast_periods:
                if breakfast_period.get('day') == ticket_day_of_week:
                    # Parse time strings to time objects
                    try:
                        start_str = breakfast_period.get('start')
                        end_str = breakfast_period.get('end')

                        if start_str and end_str:
                            start_time_obj = datetime.strptime(start_str, '%H:%M').time()
                            end_time_obj = datetime.strptime(end_str, '%H:%M').time()

                            merged_hours_data.append({
                                'start_time': start_time_obj,
                                'end_time': end_time_obj,
                                'display_name': 'Breakfast',
                                'resos_id': None,  # Manual periods have no Resos ID
                                'is_manual': True
                            })
                            logger.debug(f"Added manual breakfast period for day {ticket_day_of_week}: {start_str} - {end_str}")
                    except Exception as e:
                        logger.warning(f"Failed to parse manual breakfast period: {e}")

        # Use merged data for matching
        periods_to_check = merged_hours_data

        # 30-minute buffer before each service period to catch early arrivals
        BUFFER_MINUTES = 30

        # Sort periods by start_time (descending) so later periods take precedence
        # Use datetime for proper sorting, handling midnight-crossing periods
        def time_to_minutes(t):
            """Convert time to minutes since midnight for sorting."""
            if not t:
                return -1
            return t.hour * 60 + t.minute

        def subtract_minutes_from_time(t, minutes):
            """Subtract minutes from a time object, handling midnight wraparound."""
            # Convert to datetime, subtract, convert back to time
            temp_dt = datetime.combine(datetime.today(), t)
            result_dt = temp_dt - timedelta(minutes=minutes)
            return result_dt.time()

        def sort_key(period):
            start = period.get('start_time')
            if not start:
                return -1  # Invalid entries sort first (will be skipped)

            start_mins = time_to_minutes(start)
            # If start time is very early (00:00 - 05:59), treat as late night (next day)
            # This ensures late night periods like 22:00-02:00 sort correctly
            if start.hour < 6:
                start_mins += 24 * 60  # Add 24 hours worth of minutes

            return start_mins

        sorted_periods = sorted(periods_to_check, key=sort_key, reverse=True)

        # FIRST PASS: Try to match using actual service period times (no buffer)
        # Later periods are checked first due to reverse sorting
        for period in sorted_periods:
            start_time = period.get('start_time')
            end_time = period.get('end_time')
            display_name = period.get('display_name')

            if not start_time or not end_time or not display_name:
                continue

            # Handle periods that cross midnight (e.g., 22:00 - 02:00)
            if start_time <= end_time:
                # Normal period (e.g., 12:00 - 15:00)
                if start_time <= ticket_time <= end_time:
                    return display_name
            else:
                # Period crosses midnight (e.g., 22:00 - 02:00)
                if ticket_time >= start_time or ticket_time <= end_time:
                    return display_name

        # SECOND PASS: Handle gaps between periods - assign to following period
        # If ticket falls in a gap, assign it to the next period
        # Sort periods by start time (ascending) for this check
        periods_ascending = sorted(periods_to_check, key=sort_key)

        ticket_mins = time_to_minutes(ticket_time)

        for i, period in enumerate(periods_ascending):
            start_time = period.get('start_time')
            end_time = period.get('end_time')
            display_name = period.get('display_name')

            if not start_time or not end_time or not display_name:
                continue

            start_mins = time_to_minutes(start_time)
            end_mins = time_to_minutes(end_time)

            # Check if ticket is in a gap before this period starts
            if i == 0:
                # First period - check if ticket is before it
                if ticket_mins < start_mins:
                    # Ticket is before first period, assign to first period
                    logger.info(f"Ticket {ticket_time} is before first period - assigning to {display_name}")
                    return display_name
            else:
                # Check gap between previous period end and this period start
                prev_period = periods_ascending[i - 1]
                prev_end = prev_period.get('end_time')

                if prev_end:
                    prev_end_mins = time_to_minutes(prev_end)

                    # If ticket is in the gap (after previous period end, before this period start)
                    if prev_end_mins < ticket_mins < start_mins:
                        # Assign to following period (this period)
                        logger.info(f"Ticket {ticket_time} is in gap - assigning to following period {display_name}")
                        return display_name

            # Check if this is the last period and ticket is after it
            if i == len(periods_ascending) - 1:
                if ticket_mins > end_mins:
                    # Ticket is after last period, assign to last period
                    logger.info(f"Ticket {ticket_time} is after last period - assigning to {display_name}")
                    return display_name

        # THIRD PASS: Comprehensive fallback (should rarely be needed now)
        # This handles "No opening hour" bookings and edge cases
        if sorted_periods:
            # Get earliest and latest periods
            earliest_period = sorted_periods[-1]
            latest_period = sorted_periods[0]

            earliest_start = earliest_period.get('start_time')
            earliest_name = earliest_period.get('display_name')
            latest_end = latest_period.get('end_time')
            latest_name = latest_period.get('display_name')

            # Find if there's a manual breakfast period
            breakfast_period = None
            for period in periods_to_check:
                if period.get('display_name', '').lower() == 'breakfast':
                    breakfast_period = period
                    break

            ticket_mins = time_to_minutes(ticket_time)

            # Handle very early tickets (before earliest period)
            if earliest_start:
                earliest_mins = time_to_minutes(earliest_start)

                # If ticket is before earliest period
                if ticket_mins < earliest_mins:
                    # If there's a manual breakfast and ticket is before it, include in breakfast
                    if breakfast_period:
                        breakfast_start = breakfast_period.get('start_time')
                        if breakfast_start and ticket_mins < time_to_minutes(breakfast_start):
                            logger.info(f"Ticket {ticket_time} is before breakfast - including in Breakfast period")
                            return 'Breakfast'

                    # If ticket is after breakfast but before first mapped period, map to first period
                    logger.info(f"Ticket {ticket_time} is before earliest period ({earliest_start}) - mapping to {earliest_name}")
                    return earliest_name

            # Handle very late tickets (after latest period)
            if latest_end:
                latest_end_mins = time_to_minutes(latest_end)

                # Handle midnight-crossing periods
                if latest_period.get('start_time') and latest_period.get('start_time') > latest_end:
                    # Period crosses midnight, latest_end is early morning
                    # Ticket is late if it's after period start and before midnight
                    if ticket_mins > time_to_minutes(latest_period.get('start_time')):
                        logger.info(f"Ticket {ticket_time} is after latest period end - mapping to {latest_name}")
                        return latest_name
                else:
                    # Normal period
                    if ticket_mins > latest_end_mins:
                        logger.info(f"Ticket {ticket_time} is after latest period ({latest_end}) - mapping to {latest_name}")
                        return latest_name

        # Log tickets that couldn't be matched to any period
        logger.warning(f"⚠️ Could not infer service period for ticket time {ticket_time}. Available periods: {len(periods_to_check)}")
        return 'Unknown'

    def _calculate_service_period_breakdown(self, all_tickets: list[dict], all_bookings: list, settings, opening_hours_data: list[dict]) -> list[dict]:
        """
        Calculate spend breakdown by service period, grouped by display name from settings.

        Counts:
        - resos_covers: ALL Resos bookings (matched or unmatched)
        - samba_covers: ALL SambaPOS tickets (matched or unmatched)
        - covers: Max of resos_covers and samba_covers (or resos if matched)
        """
        period_data = {}

        # Build a lookup map from opening_hour_id to display_name
        opening_hours_map = {}
        if settings.resos_opening_hours_mapping:
            for mapping in settings.resos_opening_hours_mapping:
                resos_id = mapping.get('resos_id')
                display_name = mapping.get('display_name')
                if resos_id and display_name:
                    opening_hours_map[resos_id] = display_name

        # Track which Resos bookings we've already counted to avoid double-counting covers
        counted_bookings = set()

        for ticket in all_tickets:
            # Skip tickets with zero spend (all items void/cancelled)
            if float(ticket.get('total_spend', 0)) == 0:
                continue
            # Try to get service period from matched booking first
            if 'matched_booking' in ticket:
                # Try to get display name from mapping first
                opening_hour_id = ticket['matched_booking'].get('opening_hour_id')
                if opening_hour_id and opening_hour_id in opening_hours_map:
                    period = opening_hours_map[opening_hour_id]
                else:
                    # Fall back to opening_hour_name if no mapping found
                    period = ticket['matched_booking'].get('opening_hour_name')

                    # If opening_hour_name is "No opening hour", infer from booking time
                    if period == 'No opening hour':
                        logger.info(f"Booking has 'No opening hour' - inferring from booking time")
                        booking_time = ticket['matched_booking'].get('booking_time')
                        booking_date = ticket['matched_booking'].get('booking_date')

                        if booking_time and booking_date:
                            # Create datetime for day-of-week calculation
                            from datetime import datetime
                            booking_datetime = datetime.combine(booking_date, booking_time)

                            # Infer service period using the same logic as unmatched tickets
                            inferred_period = self._infer_service_period_from_time(
                                booking_time,
                                opening_hours_data,
                                ticket_datetime=booking_datetime,
                                settings=settings
                            )
                            logger.info(f"Inferred period '{inferred_period}' for booking at {booking_time}")

                            # Use inferred period if it's not 'Unknown' or 'No opening hour'
                            if inferred_period and inferred_period not in ('Unknown', 'No opening hour'):
                                period = inferred_period
                                logger.info(f"✓ Using inferred period '{period}'")
                            else:
                                logger.warning(f"⚠️ Inference returned '{inferred_period}', keeping 'No opening hour'")
                        else:
                            logger.warning(f"⚠️ Missing booking time or date for inference")

                    if not period:  # None or empty string
                        period = 'No opening hour'
                        logger.warning(f"⚠️ Matched booking has no opening_hour_name: booking_id={ticket['matched_booking'].get('resos_booking_id')}")

                # Get covers from Resos booking
                people = ticket['matched_booking'].get('people', 0)
                samba_covers = ticket.get('estimated_covers', 0)  # Covers from SambaPOS ticket

                # Only count Resos covers once per booking (avoid double-counting split bills)
                booking_id = ticket['matched_booking'].get('resos_booking_id')
                if booking_id and booking_id not in counted_bookings:
                    resos_covers = people
                    counted_bookings.add(booking_id)
                else:
                    resos_covers = 0  # This booking already counted
            else:
                # For unmatched tickets, infer service period from ticket time using actual opening hours
                ticket_time = ticket.get('ticket_time')
                ticket_datetime = ticket.get('ticket_datetime')
                period = self._infer_service_period_from_time(
                    ticket_time,
                    opening_hours_data,
                    ticket_datetime=ticket_datetime,
                    settings=settings
                )
                # Use estimated covers from SambaPOS for unmatched tickets
                people = ticket.get('estimated_covers', 0)
                resos_covers = 0  # No Resos booking for unmatched tickets
                samba_covers = people

            if period not in period_data:
                period_data[period] = {
                    'service_period': period,
                    'total_spend': 0.0,
                    'food_spend': 0.0,
                    'beverage_spend': 0.0,
                    'covers': 0,
                    'resos_covers': 0,  # Track Resos booking covers separately
                    'samba_covers': 0,  # Track SambaPOS estimated covers separately
                    'ticket_count': 0
                }

            period_data[period]['total_spend'] += float(ticket['total_spend'])
            period_data[period]['food_spend'] += float(ticket['food_total'])
            period_data[period]['beverage_spend'] += float(ticket['beverage_total'])
            period_data[period]['covers'] += people  # Use Resos covers for matched, SambaPOS for unmatched
            period_data[period]['resos_covers'] += resos_covers
            period_data[period]['samba_covers'] += samba_covers
            period_data[period]['ticket_count'] += 1

        # Now add ALL Resos bookings that weren't matched (e.g., no-shows, cancellations, unmatched)
        for booking in all_bookings:
            # Skip if this booking was already counted via ticket match
            if booking.resos_booking_id in counted_bookings:
                continue

            # This is an unmatched booking - add its covers to resos_covers
            # Determine service period from booking's opening hour
            opening_hour_id = booking.opening_hour_id
            if opening_hour_id and opening_hour_id in opening_hours_map:
                period = opening_hours_map[opening_hour_id]
            else:
                period = booking.opening_hour_name

                # Infer period for "No opening hour" bookings
                if period == 'No opening hour' and booking.booking_time:
                    from datetime import datetime
                    booking_datetime = datetime.combine(booking.booking_date, booking.booking_time)
                    inferred_period = self._infer_service_period_from_time(
                        booking.booking_time,
                        opening_hours_data,
                        ticket_datetime=booking_datetime,
                        settings=settings
                    )
                    if inferred_period and inferred_period not in ('Unknown', 'No opening hour'):
                        period = inferred_period

            if not period:
                period = 'Unknown'

            # Initialize period if not exists
            if period not in period_data:
                period_data[period] = {
                    'service_period': period,
                    'total_spend': 0.0,
                    'food_spend': 0.0,
                    'beverage_spend': 0.0,
                    'covers': 0,
                    'resos_covers': 0,
                    'samba_covers': 0,
                    'ticket_count': 0
                }

            # Add unmatched booking covers to resos_covers
            period_data[period]['resos_covers'] += booking.people
            period_data[period]['covers'] += booking.people  # Also add to total covers
            logger.debug(f"Added unmatched booking {booking.resos_booking_id} ({booking.people} people) to {period}")

        # Calculate average per cover
        result = []
        for period, data in period_data.items():
            if data['covers'] > 0:
                data['avg_spend_per_cover'] = data['total_spend'] / data['covers']
            else:
                data['avg_spend_per_cover'] = 0.0
            result.append(data)

        return sorted(result, key=lambda x: x['total_spend'], reverse=True)

    def _calculate_daily_service_breakdown(self, all_tickets: list[dict], all_bookings: list, settings, opening_hours_data: list[dict]) -> list[dict]:
        """
        Calculate daily breakdown by service period.

        Counts ALL Resos bookings (matched or unmatched) and ALL SambaPOS tickets.

        Returns list of dicts with format:
        {
            'date': '2026-01-20',
            'periods': {
                'Lunch': {'covers': 10, 'resos_covers': 12, 'samba_covers': 10, 'food': 200.0, 'beverage': 50.0, 'total_spend': 250.0},
                'Dinner': {'covers': 25, 'resos_covers': 28, 'samba_covers': 24, 'food': 600.0, 'beverage': 150.0, 'total_spend': 750.0},
                ...
            }
        }
        """
        # Build a lookup map from opening_hour_id to display_name
        opening_hours_map = {}
        if settings.resos_opening_hours_mapping:
            for mapping in settings.resos_opening_hours_mapping:
                resos_id = mapping.get('resos_id')
                display_name = mapping.get('display_name')
                if resos_id and display_name:
                    opening_hours_map[resos_id] = display_name

        # Group by date
        daily_data = {}

        # Track which Resos bookings we've already counted to avoid double-counting covers
        counted_bookings = set()

        for ticket in all_tickets:
            # Skip tickets with zero spend (all items void/cancelled)
            if float(ticket.get('total_spend', 0)) == 0:
                continue

            ticket_date = ticket.get('ticket_date')
            if hasattr(ticket_date, 'date'):
                ticket_date = ticket_date.date()
            date_str = ticket_date.isoformat()

            # Get service period for this ticket
            if 'matched_booking' in ticket:
                opening_hour_id = ticket['matched_booking'].get('opening_hour_id')
                if opening_hour_id and opening_hour_id in opening_hours_map:
                    period = opening_hours_map[opening_hour_id]
                else:
                    period = ticket['matched_booking'].get('opening_hour_name')

                    # Infer period for "No opening hour" bookings
                    if period == 'No opening hour':
                        booking_time = ticket['matched_booking'].get('booking_time')
                        booking_date = ticket['matched_booking'].get('booking_date')

                        if booking_time and booking_date:
                            from datetime import datetime
                            booking_datetime = datetime.combine(booking_date, booking_time)
                            inferred_period = self._infer_service_period_from_time(
                                booking_time,
                                opening_hours_data,
                                ticket_datetime=booking_datetime,
                                settings=settings
                            )
                            if inferred_period and inferred_period not in ('Unknown', 'No opening hour'):
                                period = inferred_period

                if not period:
                    period = 'No opening hour'

                # Get covers from Resos booking
                people = ticket['matched_booking'].get('people', 0)
                samba_covers = ticket.get('estimated_covers', 0)  # Covers from SambaPOS ticket

                # Only count Resos covers once per booking (avoid double-counting split bills)
                booking_id = ticket['matched_booking'].get('resos_booking_id')
                if booking_id and booking_id not in counted_bookings:
                    resos_covers = people
                    counted_bookings.add(booking_id)
                else:
                    resos_covers = 0  # This booking already counted
            else:
                ticket_time = ticket.get('ticket_time')
                ticket_datetime = ticket.get('ticket_datetime')
                period = self._infer_service_period_from_time(
                    ticket_time,
                    opening_hours_data,
                    ticket_datetime=ticket_datetime,
                    settings=settings
                )
                # Use estimated covers from SambaPOS for unmatched tickets
                people = ticket.get('estimated_covers', 0)
                resos_covers = 0  # No Resos booking for unmatched tickets
                samba_covers = people

            # Initialize date if not exists
            if date_str not in daily_data:
                daily_data[date_str] = {}

            # Initialize period if not exists
            if period not in daily_data[date_str]:
                daily_data[date_str][period] = {
                    'covers': 0,
                    'resos_covers': 0,  # Track Resos booking covers separately
                    'samba_covers': 0,  # Track SambaPOS estimated covers separately
                    'food': 0.0,
                    'beverage': 0.0,
                    'total_spend': 0.0,
                    'ticket_count': 0
                }

            # Add ticket data
            daily_data[date_str][period]['covers'] += people  # Use Resos covers for matched, SambaPOS for unmatched
            daily_data[date_str][period]['resos_covers'] += resos_covers
            daily_data[date_str][period]['samba_covers'] += samba_covers
            daily_data[date_str][period]['food'] += float(ticket['food_total'])
            daily_data[date_str][period]['beverage'] += float(ticket['beverage_total'])
            daily_data[date_str][period]['total_spend'] += float(ticket['total_spend'])
            daily_data[date_str][period]['ticket_count'] += 1

        # Now add ALL Resos bookings that weren't matched (e.g., no-shows, cancellations, unmatched)
        for booking in all_bookings:
            # Skip if this booking was already counted via ticket match
            if booking.resos_booking_id in counted_bookings:
                continue

            # This is an unmatched booking - add its covers to resos_covers
            date_str = booking.booking_date.isoformat()

            # Determine service period from booking's opening hour
            opening_hour_id = booking.opening_hour_id
            if opening_hour_id and opening_hour_id in opening_hours_map:
                period = opening_hours_map[opening_hour_id]
            else:
                period = booking.opening_hour_name

                # Infer period for "No opening hour" bookings
                if period == 'No opening hour' and booking.booking_time:
                    from datetime import datetime
                    booking_datetime = datetime.combine(booking.booking_date, booking.booking_time)
                    inferred_period = self._infer_service_period_from_time(
                        booking.booking_time,
                        opening_hours_data,
                        ticket_datetime=booking_datetime,
                        settings=settings
                    )
                    if inferred_period and inferred_period not in ('Unknown', 'No opening hour'):
                        period = inferred_period

            if not period:
                period = 'Unknown'

            # Initialize date if not exists
            if date_str not in daily_data:
                daily_data[date_str] = {}

            # Initialize period if not exists
            if period not in daily_data[date_str]:
                daily_data[date_str][period] = {
                    'covers': 0,
                    'resos_covers': 0,
                    'samba_covers': 0,
                    'food': 0.0,
                    'beverage': 0.0,
                    'total_spend': 0.0,
                    'ticket_count': 0
                }

            # Add unmatched booking covers to resos_covers
            daily_data[date_str][period]['resos_covers'] += booking.people
            daily_data[date_str][period]['covers'] += booking.people  # Also add to total covers
            logger.debug(f"Added unmatched booking {booking.resos_booking_id} ({booking.people} people) to {date_str} {period}")

        # Convert to list format
        result = []
        for date_str in sorted(daily_data.keys()):
            result.append({
                'date': date_str,
                'periods': daily_data[date_str]
            })

        return result
