"""
Residents Table Chart API

Gantt-style visualization showing hotel bookings with restaurant table indicators.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from datetime import date, timedelta
from typing import Optional
from pydantic import BaseModel

from auth.jwt import get_current_user
from database import get_db
from models.user import User
from models.newbook import NewbookDailyOccupancy
from models.resos import ResosBooking

router = APIRouter(prefix="/residents-table-chart", tags=["Residents Table Chart"])


class RestaurantBookingDetail(BaseModel):
    has_booking: bool
    time: Optional[str] = None
    people: Optional[int] = None
    table_name: Optional[str] = None
    opening_hour_name: Optional[str] = None


class BookingSegment(BaseModel):
    booking_id: str | None
    bookings_group_id: Optional[str] = None
    check_in: str
    check_out: str
    nights: list[str]
    is_dbb: Optional[bool] = None
    is_package: Optional[bool] = None
    restaurant_bookings: dict[str, RestaurantBookingDetail]


class RoomRow(BaseModel):
    room_number: str | None
    bookings: list[BookingSegment]  # Multiple bookings in the same room


class ResidentsTableChartResponse(BaseModel):
    date_range: dict
    rooms: list[RoomRow]  # Changed from 'bookings' to 'rooms'
    summary: dict
    metrics: Optional[dict] = None  # Aggregated metrics for different time periods


@router.get("")
async def get_residents_table_chart(
    start_date: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> ResidentsTableChartResponse:
    """
    Get Gantt-style chart data showing hotel bookings with restaurant table indicators.

    Args:
        start_date: First day of 7-day period (defaults to today)

    Returns:
        Chart data with hotel stays and restaurant booking indicators
    """
    import logging
    logger = logging.getLogger(__name__)

    if start_date is None:
        start_date = date.today()

    logger.info(f"ResidentsTableChart API called with start_date={start_date}")

    end_date = start_date + timedelta(days=6)  # 7-day period
    date_range = {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "dates": [(start_date + timedelta(days=i)).isoformat() for i in range(7)]
    }

    # Fetch Newbook occupancy data for 7-day period
    result = await db.execute(
        select(NewbookDailyOccupancy).where(
            and_(
                NewbookDailyOccupancy.kitchen_id == current_user.kitchen_id,
                NewbookDailyOccupancy.date >= start_date,
                NewbookDailyOccupancy.date <= end_date,
                NewbookDailyOccupancy.rooms_breakdown.isnot(None)  # Only records with room breakdown
            )
        ).order_by(NewbookDailyOccupancy.date)
    )
    occupancy_records = result.scalars().all()
    logger.info(f"Found {len(occupancy_records)} occupancy records")

    # Group by room number only (one row per room in Gantt chart)
    # Key: room_number, Value: dict of bookings for that room
    rooms_dict = {}
    for record in occupancy_records:
        # Parse JSONB array - each element is a room object for this date
        rooms = record.rooms_breakdown or []

        for room in rooms:
            room_number = room.get("room_number")
            booking_id = room.get("booking_id")

            if room_number not in rooms_dict:
                rooms_dict[room_number] = {}

            # Track each booking within this room
            if booking_id not in rooms_dict[room_number]:
                rooms_dict[room_number][booking_id] = {
                    'booking_id': booking_id,
                    'bookings_group_id': room.get("bookings_group_id"),
                    'nights': [],
                    'is_dbb': room.get("is_dbb", False),
                    'is_package': room.get("is_package", False)
                }

            rooms_dict[room_number][booking_id]['nights'].append(record.date)

    # Log rooms with multiple bookings to diagnose stacking issue
    for room_number, bookings in rooms_dict.items():
        if len(bookings) > 1:
            logger.warning(f"Room {room_number} has {len(bookings)} different bookings:")
            for booking_id, booking_data in bookings.items():
                nights_str = ', '.join(sorted([n.isoformat() for n in booking_data['nights']]))
                logger.warning(f"  - Booking {booking_id}: nights={nights_str}")

    # Convert to list - one entry per room with all its bookings
    hotel_stays = []
    for room_number, bookings in rooms_dict.items():
        # Collect all bookings for this room
        room_bookings = []
        all_nights = []

        for booking_data in bookings.values():
            nights = sorted(booking_data['nights'])
            if nights:
                all_nights.extend(nights)
                check_in = nights[0]
                check_out = nights[-1] + timedelta(days=1)

                room_bookings.append({
                    'booking_id': booking_data['booking_id'],
                    'bookings_group_id': booking_data.get('bookings_group_id'),
                    'check_in': check_in.isoformat(),
                    'check_out': check_out.isoformat(),
                    'nights': [n.isoformat() for n in nights],
                    'is_dbb': booking_data['is_dbb'],
                    'is_package': booking_data['is_package']
                })

        # Create one entry per room with all bookings
        if room_bookings:
            all_nights_sorted = sorted(set(all_nights))
            hotel_stays.append({
                'room_number': room_number,
                'bookings': room_bookings,  # Array of all bookings in this room
                'all_nights': [n.isoformat() for n in all_nights_sorted]  # All occupied nights for this room
            })

    logger.info(f"Built {len(hotel_stays)} room entries")

    # Fetch Resos bookings for hotel guests in this period
    result = await db.execute(
        select(ResosBooking).where(
            and_(
                ResosBooking.kitchen_id == current_user.kitchen_id,
                ResosBooking.booking_date >= start_date,
                ResosBooking.booking_date <= end_date,
                ResosBooking.is_hotel_guest == True,
                ResosBooking.hotel_booking_number.isnot(None)
            )
        )
    )
    resos_bookings = result.scalars().all()

    # Build lookup: booking_id -> {date -> resos_booking}
    resos_lookup = {}
    for resos_booking in resos_bookings:
        booking_id = resos_booking.hotel_booking_number
        booking_date = resos_booking.booking_date.isoformat()

        if booking_id not in resos_lookup:
            resos_lookup[booking_id] = {}

        resos_lookup[booking_id][booking_date] = {
            'has_booking': True,
            'time': resos_booking.booking_time.strftime('%H:%M') if resos_booking.booking_time else None,
            'people': resos_booking.people,
            'table_name': resos_booking.table_name,
            'opening_hour_name': resos_booking.opening_hour_name
        }

    logger.info(f"Built resos_lookup with {len(resos_lookup)} booking IDs")

    # Combine rooms with restaurant bookings
    room_rows = []
    total_room_nights = 0
    nights_with_restaurant = 0

    try:
        for room_data in hotel_stays:
            booking_segments = []

            # Process each booking within this room
            for booking_data in room_data['bookings']:
                # Build restaurant bookings dict for each night in the 7-day period
                restaurant_bookings = {}

                for date_str in date_range['dates']:
                    # Check if this date is within this specific booking's nights
                    if date_str in booking_data['nights']:
                        total_room_nights += 1

                        # Check if there's a restaurant booking for this date
                        resos_data = resos_lookup.get(booking_data['booking_id'], {}).get(date_str)

                        if resos_data:
                            restaurant_bookings[date_str] = resos_data
                            nights_with_restaurant += 1
                        else:
                            restaurant_bookings[date_str] = {'has_booking': False}
                    else:
                        # Not staying this night
                        restaurant_bookings[date_str] = {'has_booking': False}

                # Create booking segment with restaurant data
                booking_segments.append(BookingSegment(
                    booking_id=booking_data['booking_id'],
                    bookings_group_id=booking_data.get('bookings_group_id'),
                    check_in=booking_data['check_in'],
                    check_out=booking_data['check_out'],
                    nights=booking_data['nights'],
                    is_dbb=booking_data['is_dbb'],
                    is_package=booking_data['is_package'],
                    restaurant_bookings=restaurant_bookings
                ))

            # Create room row with all its bookings
            room_rows.append(RoomRow(
                room_number=room_data['room_number'],
                bookings=booking_segments
            ))
    except Exception as e:
        logger.error(f"Error building room_rows: {e}", exc_info=True)
        raise

    logger.info(f"Built {len(room_rows)} room rows")

    # Sort rooms by room number (natural sort for numeric rooms)
    def natural_sort_key(room: RoomRow):
        """Natural sort key for room numbers (handles both numeric and alphanumeric)"""
        if not room.room_number:
            return (float('inf'), '')  # Put None/empty at end

        # Extract numeric part for sorting (e.g., "102" -> 102, "A-12" -> 12)
        import re
        numbers = re.findall(r'\d+', room.room_number)
        if numbers:
            return (int(numbers[0]), room.room_number)
        return (float('inf'), room.room_number)

    room_rows.sort(key=natural_sort_key)

    # Calculate summary
    coverage_pct = (nights_with_restaurant / total_room_nights * 100) if total_room_nights > 0 else 0.0

    # Count total bookings across all rooms
    total_bookings = sum(len(room.bookings) for room in room_rows)

    summary = {
        'total_rooms': len(room_rows),
        'total_bookings': total_bookings,
        'total_room_nights': total_room_nights,
        'nights_with_restaurant': nights_with_restaurant,
        'coverage_percentage': round(coverage_pct, 1)
    }

    # Calculate aggregated metrics for different time periods
    def get_week_start(d: date) -> date:
        """Get Monday of the week containing date d"""
        return d - timedelta(days=d.weekday())

    async def calculate_period_metrics(period_start: date, period_end: date, is_forecast: Optional[bool] = None) -> dict:
        """Calculate metrics for a specific date range"""
        query = select(NewbookDailyOccupancy).where(
            and_(
                NewbookDailyOccupancy.kitchen_id == current_user.kitchen_id,
                NewbookDailyOccupancy.date >= period_start,
                NewbookDailyOccupancy.date <= period_end,
                NewbookDailyOccupancy.rooms_breakdown.isnot(None)
            )
        )

        # Filter by forecast status if specified
        if is_forecast is not None:
            query = query.where(NewbookDailyOccupancy.is_forecast == is_forecast)

        result = await db.execute(query.order_by(NewbookDailyOccupancy.date))
        records = result.scalars().all()

        # Count metrics
        total_room_nights_period = 0
        unique_bookings = set()
        nights_with_rest = 0

        for record in records:
            rooms = record.rooms_breakdown or []
            for room in rooms:
                booking_id = room.get("booking_id")
                if booking_id:
                    unique_bookings.add(booking_id)
                    total_room_nights_period += 1

                    # Check if has restaurant booking for this date
                    date_str = record.date.isoformat()
                    resos_data = resos_lookup.get(booking_id, {}).get(date_str)
                    if resos_data:
                        nights_with_rest += 1

        coverage_pct_period = (nights_with_rest / total_room_nights_period * 100) if total_room_nights_period > 0 else 0.0

        # Calculate average occupancy
        total_available = 0
        total_occupied = 0
        for record in records:
            if record.total_rooms and record.occupied_rooms:
                total_available += record.total_rooms
                total_occupied += record.occupied_rooms

        avg_occupancy = (total_occupied / total_available * 100) if total_available > 0 else 0.0

        return {
            'total_bookings': len(unique_bookings),
            'total_room_nights': total_room_nights_period,
            'nights_with_restaurant': nights_with_rest,
            'coverage_percentage': round(coverage_pct_period, 1),
            'avg_occupancy_percentage': round(avg_occupancy, 1)
        }

    today = date.today()

    # This week (Monday to Sunday)
    this_week_start = get_week_start(today)
    this_week_end = this_week_start + timedelta(days=6)

    # Last week (previous Monday to Sunday)
    last_week_start = this_week_start - timedelta(days=7)
    last_week_end = last_week_start + timedelta(days=6)

    # Last 30 days rolling (from yesterday)
    yesterday = today - timedelta(days=1)
    rolling_30_start = yesterday - timedelta(days=29)
    rolling_30_end = yesterday

    # Calculate metrics for each period - always return metrics with default values
    default_metrics = {
        'total_bookings': 0,
        'total_room_nights': 0,
        'nights_with_restaurant': 0,
        'coverage_percentage': 0.0,
        'avg_occupancy_percentage': 0.0
    }

    try:
        metrics = {
            'this_week_actual': await calculate_period_metrics(this_week_start, this_week_end, is_forecast=False),
            'this_week_forecast': await calculate_period_metrics(this_week_start, this_week_end, is_forecast=True),
            'last_week_actual': await calculate_period_metrics(last_week_start, last_week_end, is_forecast=False),
            'last_30_days_rolling': await calculate_period_metrics(rolling_30_start, rolling_30_end, is_forecast=False),
        }
        logger.info(f"Calculated metrics: {metrics}")
    except Exception as e:
        logger.error(f"Error calculating metrics: {e}", exc_info=True)
        # Return default metrics structure instead of None
        metrics = {
            'this_week_actual': default_metrics.copy(),
            'this_week_forecast': default_metrics.copy(),
            'last_week_actual': default_metrics.copy(),
            'last_30_days_rolling': default_metrics.copy(),
        }

    return ResidentsTableChartResponse(
        date_range=date_range,
        rooms=room_rows,
        summary=summary,
        metrics=metrics
    )
