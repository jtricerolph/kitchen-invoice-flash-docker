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


class HotelStayDetail(BaseModel):
    booking_id: str
    room_number: str
    guest_name: Optional[str]
    check_in: str
    check_out: str
    nights: list[str]
    restaurant_bookings: dict[str, RestaurantBookingDetail]
    is_dbb: Optional[bool] = None
    is_package: Optional[bool] = None


class ResidentsTableChartResponse(BaseModel):
    date_range: dict
    bookings: list[HotelStayDetail]
    summary: dict


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
    if start_date is None:
        start_date = date.today()

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
                NewbookDailyOccupancy.date <= end_date
            )
        ).order_by(NewbookDailyOccupancy.room_number, NewbookDailyOccupancy.date)
    )
    occupancy_records = result.scalars().all()

    # Group occupancy into continuous stays
    # Key: (room_number, booking_id), Value: list of dates
    stays_dict = {}
    for record in occupancy_records:
        key = (record.room_number, record.booking_id)
        if key not in stays_dict:
            stays_dict[key] = {
                'booking_id': record.booking_id,
                'room_number': record.room_number,
                'guest_name': record.guest_name,
                'nights': [],
                'is_dbb': record.is_dbb,
                'is_package': record.is_package
            }
        stays_dict[key]['nights'].append(record.date)

    # Convert to list and calculate check-in/check-out
    hotel_stays = []
    for stay_data in stays_dict.values():
        nights = sorted(stay_data['nights'])
        if not nights:
            continue

        # Check-in is first night, check-out is day after last night
        check_in = nights[0]
        check_out = nights[-1] + timedelta(days=1)

        hotel_stays.append({
            'booking_id': stay_data['booking_id'],
            'room_number': stay_data['room_number'],
            'guest_name': stay_data['guest_name'],
            'check_in': check_in,
            'check_out': check_out,
            'nights': nights,
            'is_dbb': stay_data['is_dbb'],
            'is_package': stay_data['is_package']
        })

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

    # Combine hotel stays with restaurant bookings
    combined_bookings = []
    total_room_nights = 0
    nights_with_restaurant = 0

    for stay in hotel_stays:
        # Build restaurant bookings dict for each night in the 7-day period
        restaurant_bookings = {}
        for date_str in date_range['dates']:
            stay_date = date.fromisoformat(date_str)

            # Check if this date is within the hotel stay
            if stay_date in stay['nights']:
                total_room_nights += 1

                # Check if there's a restaurant booking for this date
                resos_data = resos_lookup.get(stay['booking_id'], {}).get(date_str)

                if resos_data:
                    restaurant_bookings[date_str] = resos_data
                    nights_with_restaurant += 1
                else:
                    restaurant_bookings[date_str] = {'has_booking': False}
            else:
                # Not staying this night
                restaurant_bookings[date_str] = {'has_booking': False}

        combined_bookings.append(HotelStayDetail(
            booking_id=stay['booking_id'],
            room_number=stay['room_number'],
            guest_name=stay['guest_name'],
            check_in=stay['check_in'].isoformat(),
            check_out=stay['check_out'].isoformat(),
            nights=[night.isoformat() for night in stay['nights']],
            restaurant_bookings=restaurant_bookings,
            is_dbb=stay['is_dbb'],
            is_package=stay['is_package']
        ))

    # Calculate summary
    coverage_pct = (nights_with_restaurant / total_room_nights * 100) if total_room_nights > 0 else 0.0

    summary = {
        'total_bookings': len(combined_bookings),
        'total_room_nights': total_room_nights,
        'nights_with_restaurant': nights_with_restaurant,
        'coverage_percentage': round(coverage_pct, 1)
    }

    return ResidentsTableChartResponse(
        date_range=date_range,
        bookings=combined_bookings,
        summary=summary
    )
