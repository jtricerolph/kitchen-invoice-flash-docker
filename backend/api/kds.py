"""
KDS (Kitchen Display System) API Endpoints

Provides endpoints for:
- Fetching open tickets with kitchen orders
- Course flow: PENDING → AWAY → SENT
- KDS settings management

Course Flow:
- When a ticket arrives, the first course is auto-set to "away" (called away from kitchen)
- Staff presses SENT when food is delivered to the table
- Staff presses AWAY on next course when clearing previous course / calling away next
- Strictly sequential: must SENT current before AWAY on next
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from sqlalchemy.orm.attributes import flag_modified
from pydantic import BaseModel

from database import get_db
from auth.jwt import get_current_user
from models.user import User
from models.settings import KitchenSettings
from models.kds import KDSTicket, KDSCourseBump
from services.kds_graphql import (
    SambaPOSGraphQLClient,
    transform_ticket_for_kds,
    parse_kitchen_course
)
from services.signalr_listener import kds_event_bus

logger = logging.getLogger(__name__)
router = APIRouter()


# =============================================================================
# Pydantic Schemas
# =============================================================================

class KDSSettingsResponse(BaseModel):
    kds_enabled: bool = False
    kds_graphql_url: Optional[str] = None
    kds_graphql_username: Optional[str] = None
    kds_graphql_password_set: bool = False
    kds_graphql_client_id: Optional[str] = None
    kds_poll_interval_seconds: int = 6000
    kds_timer_green_seconds: int = 300
    kds_timer_amber_seconds: int = 600
    kds_timer_red_seconds: int = 900
    kds_away_timer_green_seconds: int = 600
    kds_away_timer_amber_seconds: int = 900
    kds_away_timer_red_seconds: int = 1200
    kds_course_order: list = ["Starters", "Mains", "Desserts"]
    kds_show_completed_for_seconds: int = 30
    kds_bookings_refresh_seconds: int = 60

    class Config:
        from_attributes = True


class KDSSettingsUpdate(BaseModel):
    kds_enabled: Optional[bool] = None
    kds_graphql_url: Optional[str] = None
    kds_graphql_username: Optional[str] = None
    kds_graphql_password: Optional[str] = None
    kds_graphql_client_id: Optional[str] = None
    kds_poll_interval_seconds: Optional[int] = None
    kds_timer_green_seconds: Optional[int] = None
    kds_timer_amber_seconds: Optional[int] = None
    kds_timer_red_seconds: Optional[int] = None
    kds_away_timer_green_seconds: Optional[int] = None
    kds_away_timer_amber_seconds: Optional[int] = None
    kds_away_timer_red_seconds: Optional[int] = None
    kds_course_order: Optional[list] = None
    kds_show_completed_for_seconds: Optional[int] = None
    kds_bookings_refresh_seconds: Optional[int] = None


class KDSOrderTagResponse(BaseModel):
    tag: str
    tagName: str
    quantity: Optional[float] = 1


class KDSOrderResponse(BaseModel):
    id: int
    uid: Optional[str] = None
    name: str
    portion: Optional[str] = None
    quantity: float
    price: Optional[float] = None
    kitchen_course: Optional[str] = None
    status: str
    kitchen_print: Optional[str] = None
    is_voided: bool = False
    voided_at: Optional[str] = None  # ISO timestamp when voided
    is_sent: bool = False  # This individual order has been sent to table
    is_addition: bool = False  # Order was added after ticket first appeared in KDS
    tags: list[KDSOrderTagResponse] = []


class KDSTicketResponse(BaseModel):
    id: int
    sambapos_ticket_id: int
    ticket_number: str
    table_name: Optional[str] = None
    covers: Optional[int] = None
    received_at: datetime
    time_elapsed_seconds: int
    orders: list[KDSOrderResponse]
    orders_by_course: dict
    course_states: dict
    is_bumped: bool = False


class CourseActionRequest(BaseModel):
    ticket_id: int  # Local KDS ticket ID
    course_name: str


class CourseActionResponse(BaseModel):
    success: bool
    message: str
    ticket_id: int
    course_name: str
    action: str  # "away" or "sent"
    timestamp: datetime


# Keep old schema for backward compat
class CourseBumpRequest(BaseModel):
    ticket_id: int
    course_name: str


class CourseBumpResponse(BaseModel):
    success: bool
    message: str
    ticket_id: int
    course_name: str
    bumped_at: datetime


class KDSBookingItem(BaseModel):
    booking_time: str
    people: int
    status: str
    table_name: Optional[str] = None
    seating_area: Optional[str] = None
    is_hotel_guest: Optional[bool] = None
    is_dbb: Optional[bool] = None
    is_package: Optional[bool] = None
    is_flagged: bool = False
    flag_reasons: Optional[str] = None
    allergies: Optional[str] = None
    kds_stage: Optional[str] = None


class KDSBookingsResponse(BaseModel):
    period_name: Optional[str] = None
    total_bookings: int = 0
    total_covers: int = 0
    flag_icon_mapping: Optional[dict] = None
    bookings: list[KDSBookingItem] = []


# =============================================================================
# Helper Functions
# =============================================================================

async def get_kds_settings(db: AsyncSession, kitchen_id: int) -> Optional[KitchenSettings]:
    """Get KDS settings for a kitchen."""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    return result.scalar_one_or_none()


def normalize_course_config(course_order: list, settings: KitchenSettings) -> list[dict]:
    """Convert old string-based course_order to new object format with per-course timers.

    Old format: ["Starters", "Mains", "Desserts"]
    New format: [{"name": "Starters", "prep_green": 300, ...}, ...]

    Falls back to global timer thresholds for old string entries.
    """
    if not course_order:
        return []
    result = []
    for entry in course_order:
        if isinstance(entry, str):
            result.append({
                "name": entry,
                "prep_green": settings.kds_timer_green_seconds or 300,
                "prep_amber": settings.kds_timer_amber_seconds or 600,
                "prep_red": settings.kds_timer_red_seconds or 900,
                "away_green": settings.kds_away_timer_green_seconds or 600,
                "away_amber": settings.kds_away_timer_amber_seconds or 900,
                "away_red": settings.kds_away_timer_red_seconds or 1200,
            })
        elif isinstance(entry, dict) and "name" in entry:
            result.append(entry)
    return result


def extract_course_names(course_order: list) -> list[str]:
    """Extract course names from course config (handles both old string and new object format)."""
    names = []
    for entry in (course_order or []):
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict) and "name" in entry:
            names.append(entry["name"])
    return names


def normalize_table_number(table_name: Optional[str]) -> Optional[int]:
    """Extract numeric table number from a table name string.

    Strips all non-digit characters and converts to int.
    Handles various formats: "Table 1" -> 1, "T01" -> 1, "12" -> 12.
    Returns None if no digits found.
    """
    if not table_name:
        return None
    import re
    digits = re.sub(r'\D', '', table_name)
    if not digits:
        return None
    return int(digits)


def derive_kds_stage(ticket: "KDSTicket", course_order: list) -> Optional[str]:
    """Derive current KDS stage label from a ticket's course states.

    Returns a stage string like "ORDERED", "STARTERS SENT", "MAINS AWAY",
    "COMPLETE", or None if no stage can be determined.

    Handles tickets that don't have all courses by skipping missing ones.
    """
    if ticket.is_bumped:
        return "COMPLETE"

    course_states = ticket.course_states or {}
    if not course_states:
        return "ORDERED"

    ordered_courses = get_ordered_courses_for_ticket(
        ticket.orders_data or [], course_order
    )
    if not ordered_courses:
        return "ORDERED"

    # Walk through courses to find the furthest progressed state
    latest_stage = "ORDERED"
    for course_name in ordered_courses:
        state = course_states.get(course_name, {})
        status = state.get("status", "pending")
        course_label = course_name.upper()

        if status == "away":
            latest_stage = f"{course_label} AWAY"
        elif status in ("sent", "cleared"):
            latest_stage = f"{course_label} SENT"

    return latest_stage


def get_ordered_courses_for_ticket(orders_data: list, course_order: list) -> list[str]:
    """Get the ordered list of courses present in a ticket."""
    ticket_courses = []
    seen = set()
    for order in orders_data:
        course = order.get("kitchen_course", "Uncategorized")
        if course not in seen:
            seen.add(course)
            ticket_courses.append(course)

    # Extract names from course config (handles both string and object format)
    config_names = extract_course_names(course_order)

    # Sort by configured course order, then append any not in config
    ordered = [c for c in config_names if c in seen]
    ordered.extend([c for c in ticket_courses if c not in set(ordered)])
    return ordered


def initialize_course_states(ordered_courses: list, received_at: datetime) -> dict:
    """Initialize course states for a new ticket.

    First course is auto-set to 'away' (called away when ticket created).
    All others start as 'pending'.
    """
    states = {}
    for i, course in enumerate(ordered_courses):
        if i == 0:
            states[course] = {
                "status": "away",
                "called_away_at": received_at.isoformat(),
                "sent_at": None,
                "sent_by": None,
                "sent_order_ids": [],
            }
        else:
            states[course] = {
                "status": "pending",
                "called_away_at": None,
                "sent_at": None,
                "sent_by": None,
                "sent_order_ids": [],
            }
    return states


def migrate_old_course_states(course_states: dict) -> dict:
    """Convert old format course_states to new format.

    Old: {"Starters": {"bumped": true, "bumped_at": "...", "bumped_by": "..."}}
    New: {"Starters": {"status": "sent", "called_away_at": null, "sent_at": "...", "sent_by": "..."}}
    """
    migrated = {}
    for course, state in course_states.items():
        if isinstance(state, dict) and "status" in state:
            # Already new format
            migrated[course] = state
        elif isinstance(state, dict) and "bumped" in state:
            # Old format
            if state.get("bumped"):
                migrated[course] = {
                    "status": "sent",
                    "called_away_at": None,
                    "sent_at": state.get("bumped_at"),
                    "sent_by": state.get("bumped_by"),
                }
            else:
                migrated[course] = {
                    "status": "pending",
                    "called_away_at": None,
                    "sent_at": None,
                    "sent_by": None,
                }
        else:
            migrated[course] = {
                "status": "pending",
                "called_away_at": None,
                "sent_at": None,
                "sent_by": None,
            }
    return migrated


async def get_or_create_kds_ticket(
    db: AsyncSession,
    kitchen_id: int,
    sambapos_ticket: dict,
    course_order: list
) -> KDSTicket:
    """Get existing KDS ticket or create new one from SambaPOS data."""
    # Check if ticket already exists
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == kitchen_id,
                KDSTicket.sambapos_ticket_id == sambapos_ticket["id"],
                KDSTicket.is_active == True
            )
        )
    )
    kds_ticket = result.scalar_one_or_none()

    if kds_ticket:
        # Detect new orders BEFORE overwriting orders_data
        old_order_ids = {o.get("id") for o in (kds_ticket.orders_data or [])}
        incoming_orders = sambapos_ticket.get("orders", [])
        new_order_ids = {o.get("id") for o in incoming_orders}
        added_order_ids = new_order_ids - old_order_ids

        if added_order_ids:
            logger.info(f"KDS: Ticket {sambapos_ticket.get('number')} — detected {len(added_order_ids)} new order(s): {added_order_ids}")

        # Update with latest data
        kds_ticket.table_name = sambapos_ticket.get("table")
        kds_ticket.covers = sambapos_ticket.get("covers")
        kds_ticket.orders_data = incoming_orders
        kds_ticket.last_sambapos_update = datetime.utcnow()
        kds_ticket.updated_at = datetime.utcnow()

        # Un-bump completed tickets if new orders were added
        if added_order_ids and kds_ticket.is_bumped:
            kds_ticket.is_bumped = False
            kds_ticket.bumped_at = None
            logger.info(f"KDS: Ticket {kds_ticket.ticket_number} un-bumped — {len(added_order_ids)} new order(s) added")

        # Migrate old course_states format if needed
        if kds_ticket.course_states:
            first_state = next(iter(kds_ticket.course_states.values()), None)
            if isinstance(first_state, dict) and "bumped" in first_state and "status" not in first_state:
                kds_ticket.course_states = migrate_old_course_states(kds_ticket.course_states)

        # Ensure course_states covers all courses in ticket
        ordered_courses = get_ordered_courses_for_ticket(incoming_orders, course_order)
        # IMPORTANT: dict() creates a shallow copy so SQLAlchemy detects the change
        # when we reassign kds_ticket.course_states later (same-object assignment
        # is silently ignored by SQLAlchemy's JSONB dirty tracking)
        current_states = dict(kds_ticket.course_states or {})
        for course in ordered_courses:
            if course not in current_states:
                current_states[course] = {
                    "status": "pending",
                    "called_away_at": None,
                    "sent_at": None,
                    "sent_by": None,
                    "sent_order_ids": [],
                }

        # Backfill sent_order_ids for existing course states that don't have it
        for course_name in current_states:
            if "sent_order_ids" not in current_states[course_name]:
                current_states[course_name]["sent_order_ids"] = []

        # Reactivate cleared/sent courses that received new orders
        if added_order_ids:
            courses_with_new_orders = {
                o.get("kitchen_course", "Uncategorized")
                for o in incoming_orders if o.get("id") in added_order_ids
            }
            now_iso = datetime.utcnow().isoformat()
            for course_name in courses_with_new_orders:
                if course_name in current_states:
                    status = current_states[course_name].get("status")
                    if status in ("cleared", "sent"):
                        logger.info(f"KDS: Reopening course '{course_name}' on ticket {kds_ticket.ticket_number} — new orders added")
                        current_states[course_name] = {
                            "status": "away",
                            "called_away_at": now_iso,
                            "sent_at": None,
                            "sent_by": None,
                            "sent_order_ids": current_states[course_name].get("sent_order_ids", []),
                        }

        # If no course states exist at all, initialize (first course as away)
        if not kds_ticket.course_states or len(kds_ticket.course_states) == 0:
            kds_ticket.course_states = initialize_course_states(
                ordered_courses, kds_ticket.received_at
            )
        else:
            kds_ticket.course_states = current_states

        # Ensure SQLAlchemy persists JSONB changes (belt-and-braces)
        flag_modified(kds_ticket, "course_states")
        flag_modified(kds_ticket, "orders_data")
    else:
        # Create new ticket
        now = datetime.utcnow()

        # Use SambaPOS ticket creation time as the timer start
        # (when the first order was submitted), falling back to now
        submitted_at = now
        submitted_at_str = sambapos_ticket.get("submitted_at")
        if submitted_at_str:
            try:
                parsed = datetime.fromisoformat(submitted_at_str.replace("Z", "+00:00"))
                # Convert to naive UTC for consistency with DB
                submitted_at = parsed.replace(tzinfo=None)
            except (ValueError, AttributeError):
                logger.warning(f"Failed to parse submitted_at: {submitted_at_str}, using current time")

        orders = sambapos_ticket.get("orders", [])
        ordered_courses = get_ordered_courses_for_ticket(orders, course_order)

        kds_ticket = KDSTicket(
            kitchen_id=kitchen_id,
            sambapos_ticket_id=sambapos_ticket["id"],
            sambapos_ticket_uid=sambapos_ticket.get("uid"),
            ticket_number=str(sambapos_ticket.get("number", "")),
            table_name=sambapos_ticket.get("table"),
            covers=sambapos_ticket.get("covers"),
            total_amount=sambapos_ticket.get("total_amount"),
            orders_data=orders,
            initial_order_ids=[o.get("id") for o in orders],
            course_states=initialize_course_states(ordered_courses, submitted_at),
            received_at=submitted_at,
            last_sambapos_update=now
        )
        db.add(kds_ticket)

    await db.commit()
    await db.refresh(kds_ticket)
    return kds_ticket


# =============================================================================
# API Endpoints
# =============================================================================

@router.get("/settings", response_model=KDSSettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get KDS settings for the current kitchen."""
    settings = await get_kds_settings(db, current_user.kitchen_id)

    if not settings:
        return KDSSettingsResponse()

    # Normalize course order: convert old string format to new object format
    raw_course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"]
    normalized_courses = normalize_course_config(raw_course_order, settings)

    return KDSSettingsResponse(
        kds_enabled=settings.kds_enabled or False,
        kds_graphql_url=settings.kds_graphql_url,
        kds_graphql_username=settings.kds_graphql_username,
        kds_graphql_password_set=bool(settings.kds_graphql_password),
        kds_graphql_client_id=settings.kds_graphql_client_id,
        kds_poll_interval_seconds=settings.kds_poll_interval_seconds or 6000,
        kds_timer_green_seconds=settings.kds_timer_green_seconds or 300,
        kds_timer_amber_seconds=settings.kds_timer_amber_seconds or 600,
        kds_timer_red_seconds=settings.kds_timer_red_seconds or 900,
        kds_away_timer_green_seconds=settings.kds_away_timer_green_seconds or 600,
        kds_away_timer_amber_seconds=settings.kds_away_timer_amber_seconds or 900,
        kds_away_timer_red_seconds=settings.kds_away_timer_red_seconds or 1200,
        kds_course_order=normalized_courses,
        kds_show_completed_for_seconds=settings.kds_show_completed_for_seconds or 30,
        kds_bookings_refresh_seconds=settings.kds_bookings_refresh_seconds or 60,
    )


@router.patch("/settings", response_model=KDSSettingsResponse)
async def update_settings(
    update: KDSSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update KDS settings for the current kitchen."""
    settings = await get_kds_settings(db, current_user.kitchen_id)

    if not settings:
        raise HTTPException(status_code=404, detail="Kitchen settings not found")

    # Update only provided fields
    update_data = update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if hasattr(settings, field):
            setattr(settings, field, value)

    settings.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(settings)

    return await get_settings(current_user, db)


@router.get("/tickets", response_model=list[KDSTicketResponse])
async def get_tickets(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get all active KDS tickets for the current kitchen.

    This endpoint:
    1. Fetches open tickets from SambaPOS via GraphQL
    2. Updates local KDS ticket state
    3. Returns tickets with timing and course state info
    """
    settings = await get_kds_settings(db, current_user.kitchen_id)

    if not settings:
        raise HTTPException(status_code=404, detail="Kitchen settings not found")

    course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"]

    # Check if KDS is enabled and configured
    kds_url = settings.kds_graphql_url
    kds_username = settings.kds_graphql_username
    kds_password = settings.kds_graphql_password
    kds_client_id = settings.kds_graphql_client_id

    if not all([kds_url, kds_username, kds_password, kds_client_id]):
        # Return local tickets only if not configured
        return await get_local_tickets(db, current_user.kitchen_id)

    # Fetch from SambaPOS
    client = SambaPOSGraphQLClient(
        server_url=kds_url,
        username=kds_username,
        password=kds_password,
        client_id=kds_client_id
    )

    result = await client.get_open_tickets()

    if "error" in result:
        logger.error(f"KDS GraphQL error: {result['error']}")
        # Fall back to local tickets
        return await get_local_tickets(db, current_user.kitchen_id)

    # Process tickets
    tickets_data = result.get("data", {}).get("getTickets", [])
    active_sambapos_ids = set()
    response_tickets = []

    for ticket_data in tickets_data:
        transformed = transform_ticket_for_kds(ticket_data)
        if not transformed:
            continue  # Skip tickets with no kitchen orders

        active_sambapos_ids.add(transformed["id"])

        # Get or create local KDS ticket
        kds_ticket = await get_or_create_kds_ticket(
            db, current_user.kitchen_id, transformed, course_order
        )

        # Skip tickets that have been bumped (completed)
        if kds_ticket.is_bumped:
            continue

        # Calculate elapsed time
        now = datetime.utcnow()
        elapsed = (now - kds_ticket.received_at).total_seconds()

        # Annotate orders with is_sent and is_addition flags
        initial_ids = set(kds_ticket.initial_order_ids or [])
        ticket_course_states = kds_ticket.course_states or {}
        annotated_orders = []
        for o in transformed.get("orders", []):
            course_name = o.get("kitchen_course", "Uncategorized")
            sent_ids = set(ticket_course_states.get(course_name, {}).get("sent_order_ids", []))
            order_is_sent = o.get("id") in sent_ids
            annotated_orders.append(KDSOrderResponse(
                **o,
                is_sent=order_is_sent,
                # Clear addition flag once the order has been sent
                is_addition=False if order_is_sent else (o.get("id") not in initial_ids if initial_ids else False),
            ))

        # Build response
        response_tickets.append(KDSTicketResponse(
            id=kds_ticket.id,
            sambapos_ticket_id=kds_ticket.sambapos_ticket_id,
            ticket_number=kds_ticket.ticket_number,
            table_name=kds_ticket.table_name,
            covers=kds_ticket.covers,
            received_at=kds_ticket.received_at,
            time_elapsed_seconds=int(elapsed),
            orders=annotated_orders,
            orders_by_course=transformed.get("orders_by_course", {}),
            course_states=kds_ticket.course_states or {},
            is_bumped=kds_ticket.is_bumped
        ))

    # Include SignalR-captured tickets not in the SambaPOS open set.
    # These are instantly-closed tickets (free breakfast, bar tabs, etc.)
    # persisted by the SignalR listener's _fetch_and_persist_ticket().
    signalr_filter = (
        KDSTicket.sambapos_ticket_id.notin_(active_sambapos_ids)
        if active_sambapos_ids
        else True
    )
    signalr_result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == current_user.kitchen_id,
                KDSTicket.is_active == True,
                KDSTicket.is_bumped == False,
                signalr_filter,
            )
        ).order_by(KDSTicket.received_at)
    )
    signalr_tickets = signalr_result.scalars().all()

    now_local = datetime.utcnow()
    for kds_ticket in signalr_tickets:
        orders = kds_ticket.orders_data or []
        if not orders:
            continue

        elapsed = (now_local - kds_ticket.received_at).total_seconds()

        # Group orders by course
        orders_by_course = {}
        for order in orders:
            course = order.get("kitchen_course", "Uncategorized")
            if course not in orders_by_course:
                orders_by_course[course] = []
            orders_by_course[course].append(order)

        # Annotate orders
        initial_ids = set(kds_ticket.initial_order_ids or [])
        ticket_course_states = kds_ticket.course_states or {}
        annotated_orders = []
        for o in orders:
            course_name = o.get("kitchen_course", "Uncategorized")
            sent_ids = set(ticket_course_states.get(course_name, {}).get("sent_order_ids", []))
            order_is_sent = o.get("id") in sent_ids
            annotated_orders.append(KDSOrderResponse(
                **o,
                is_sent=order_is_sent,
                is_addition=False if order_is_sent else (o.get("id") not in initial_ids if initial_ids else False),
            ))

        response_tickets.append(KDSTicketResponse(
            id=kds_ticket.id,
            sambapos_ticket_id=kds_ticket.sambapos_ticket_id,
            ticket_number=kds_ticket.ticket_number,
            table_name=kds_ticket.table_name,
            covers=kds_ticket.covers,
            received_at=kds_ticket.received_at,
            time_elapsed_seconds=int(elapsed),
            orders=annotated_orders,
            orders_by_course=orders_by_course,
            course_states=kds_ticket.course_states or {},
            is_bumped=kds_ticket.is_bumped,
        ))

    # Mark tickets no longer in SambaPOS as inactive
    await mark_closed_tickets(db, current_user.kitchen_id, active_sambapos_ids)

    return response_tickets


async def get_local_tickets(db: AsyncSession, kitchen_id: int) -> list[KDSTicketResponse]:
    """Get locally stored KDS tickets when GraphQL is unavailable."""
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == kitchen_id,
                KDSTicket.is_active == True,
                KDSTicket.is_bumped == False
            )
        ).order_by(KDSTicket.received_at)
    )
    kds_tickets = result.scalars().all()

    response_tickets = []
    now = datetime.utcnow()

    for kds_ticket in kds_tickets:
        elapsed = (now - kds_ticket.received_at).total_seconds()
        orders = kds_ticket.orders_data or []

        # Group orders by course
        orders_by_course = {}
        for order in orders:
            course = order.get("kitchen_course", "Uncategorized")
            if course not in orders_by_course:
                orders_by_course[course] = []
            orders_by_course[course].append(order)

        # Annotate orders with is_sent and is_addition flags
        initial_ids = set(kds_ticket.initial_order_ids or [])
        ticket_course_states = kds_ticket.course_states or {}
        annotated_orders = []
        for o in orders:
            course_name = o.get("kitchen_course", "Uncategorized")
            sent_ids = set(ticket_course_states.get(course_name, {}).get("sent_order_ids", []))
            order_is_sent = o.get("id") in sent_ids
            annotated_orders.append(KDSOrderResponse(
                **o,
                is_sent=order_is_sent,
                # Clear addition flag once the order has been sent
                is_addition=False if order_is_sent else (o.get("id") not in initial_ids if initial_ids else False),
            ))

        response_tickets.append(KDSTicketResponse(
            id=kds_ticket.id,
            sambapos_ticket_id=kds_ticket.sambapos_ticket_id,
            ticket_number=kds_ticket.ticket_number,
            table_name=kds_ticket.table_name,
            covers=kds_ticket.covers,
            received_at=kds_ticket.received_at,
            time_elapsed_seconds=int(elapsed),
            orders=annotated_orders,
            orders_by_course=orders_by_course,
            course_states=kds_ticket.course_states or {},
            is_bumped=kds_ticket.is_bumped
        ))

    return response_tickets


async def mark_closed_tickets(
    db: AsyncSession,
    kitchen_id: int,
    active_sambapos_ids: set
):
    """Mark tickets that are no longer in SambaPOS as inactive.

    Only deactivates tickets that have been bumped (kitchen is done) or
    are stale (>4 hours old). Non-bumped tickets are preserved because
    they may be instantly-closed tickets (free breakfast, bar tabs)
    captured by the SignalR listener that never appear in
    getTickets(isClosed: false). The kitchen is the authority on when
    a ticket is done (via bumping).
    """
    from datetime import timedelta

    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == kitchen_id,
                KDSTicket.is_active == True
            )
        )
    )
    local_tickets = result.scalars().all()
    now = datetime.utcnow()
    stale_threshold = timedelta(hours=4)

    for ticket in local_tickets:
        if ticket.sambapos_ticket_id in active_sambapos_ids:
            continue  # Still open in SambaPOS — keep active

        # Ticket is NOT in SambaPOS open list
        if ticket.is_bumped:
            # Kitchen bumped it — safe to deactivate
            ticket.is_active = False
            ticket.updated_at = now
        elif (now - ticket.received_at) > stale_threshold:
            # Stale safety net: >4 hours without being bumped
            logger.info(
                f"KDS: Deactivating stale ticket {ticket.ticket_number} "
                f"(SambaPOS ID {ticket.sambapos_ticket_id}, age={now - ticket.received_at})"
            )
            ticket.is_active = False
            ticket.updated_at = now
        # else: not bumped and not stale — keep active for kitchen to process

    await db.commit()


# =============================================================================
# Bookings Panel (Resos integration for KDS)
# =============================================================================

@router.get("/bookings", response_model=KDSBookingsResponse)
async def get_kds_bookings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get bookings for the current service period from Resos.

    Determines the active service period from cached opening hours,
    then returns all bookings for today matching that period.
    """
    from datetime import date, time as dt_time
    from models.resos import ResosBooking, ResosOpeningHour

    settings = await get_kds_settings(db, current_user.kitchen_id)
    if not settings:
        return KDSBookingsResponse()

    today = date.today()
    now_time = datetime.now().time()
    # Python isoweekday: Mon=1..Sun=7
    day_of_week = today.isoweekday()

    # Build opening hours mapping: resos_id -> {service_type, display_name}
    oh_mapping = {}
    for entry in (settings.resos_opening_hours_mapping or []):
        rid = entry.get("resos_id")
        if rid:
            oh_mapping[rid] = entry

    # Find current service period from settings or opening hours
    display_name = None
    matched_resos_ids: list[str] = []

    # Check for manual override via arrival widget filter (a service_type like "dinner")
    service_filter = settings.resos_arrival_widget_service_filter
    if service_filter:
        # Translate service_type to matching resos_ids via the mapping
        for rid, entry in oh_mapping.items():
            if entry.get("service_type", "").lower() == service_filter.lower():
                matched_resos_ids.append(rid)
                if not display_name:
                    display_name = entry.get("display_name", service_filter.title())
        if not display_name:
            display_name = service_filter.title()
    else:
        # Auto-detect from opening hours
        result = await db.execute(
            select(ResosOpeningHour).where(
                and_(
                    ResosOpeningHour.kitchen_id == current_user.kitchen_id,
                    ResosOpeningHour.is_special == False,
                )
            )
        )
        opening_hours = result.scalars().all()

        # Filter to today's day of week
        todays_hours = []
        for oh in opening_hours:
            if oh.days_of_week:
                days = [int(d.strip()) for d in oh.days_of_week.split(',') if d.strip()]
                if day_of_week in days:
                    todays_hours.append(oh)
            else:
                # No days_of_week set — check via mapping if this period applies today
                # by matching against today's bookings (fallback)
                todays_hours.append(oh)

        # Find period where current time falls between start and end
        for oh in todays_hours:
            if oh.start_time and oh.end_time:
                if oh.start_time <= now_time <= oh.end_time:
                    matched_resos_ids = [oh.resos_opening_hour_id]
                    entry = oh_mapping.get(oh.resos_opening_hour_id, {})
                    display_name = entry.get("display_name") or oh.name
                    break

        # If no current period, find next upcoming one today
        if not matched_resos_ids:
            upcoming = [
                oh for oh in todays_hours
                if oh.start_time and oh.start_time > now_time
            ]
            if upcoming:
                upcoming.sort(key=lambda oh: oh.start_time)
                best = upcoming[0]
                matched_resos_ids = [best.resos_opening_hour_id]
                entry = oh_mapping.get(best.resos_opening_hour_id, {})
                display_name = entry.get("display_name") or best.name

        # If still nothing (past all periods), use the last period
        if not matched_resos_ids and todays_hours:
            todays_hours.sort(key=lambda oh: oh.start_time or dt_time(0, 0))
            last = todays_hours[-1]
            matched_resos_ids = [last.resos_opening_hour_id]
            entry = oh_mapping.get(last.resos_opening_hour_id, {})
            display_name = entry.get("display_name") or last.name

    # Query bookings for today, filtered by matched opening hour IDs
    booking_query = select(ResosBooking).where(
        and_(
            ResosBooking.kitchen_id == current_user.kitchen_id,
            ResosBooking.booking_date == today,
        )
    )
    if matched_resos_ids:
        booking_query = booking_query.where(
            ResosBooking.opening_hour_id.in_(matched_resos_ids)
        )
    booking_query = booking_query.order_by(ResosBooking.booking_time)

    result = await db.execute(booking_query)
    bookings = result.scalars().all()

    total_covers = sum(b.people for b in bookings)
    flag_icon_mapping = settings.resos_flag_icon_mapping

    # Query active KDS tickets to match bookings to kitchen stages
    course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"]
    kds_tickets_result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == current_user.kitchen_id,
                KDSTicket.is_active == True,
            )
        )
    )
    kds_tickets = kds_tickets_result.scalars().all()

    # Build normalized table number -> stage lookup
    table_stage_lookup: dict[int, str] = {}
    for kt in kds_tickets:
        table_num = normalize_table_number(kt.table_name)
        if table_num is not None:
            stage = derive_kds_stage(kt, course_order)
            if stage:
                existing = table_stage_lookup.get(table_num)
                if existing is None or not kt.is_bumped:
                    table_stage_lookup[table_num] = stage

    booking_items = [
        KDSBookingItem(
            booking_time=b.booking_time.strftime("%H:%M") if b.booking_time else "",
            people=b.people,
            status=b.status,
            table_name=b.table_name,
            seating_area=b.seating_area,
            is_hotel_guest=b.is_hotel_guest,
            is_dbb=b.is_dbb,
            is_package=b.is_package,
            is_flagged=b.is_flagged,
            flag_reasons=b.flag_reasons,
            allergies=b.allergies,
            kds_stage=table_stage_lookup.get(normalize_table_number(b.table_name)) if b.table_name else None,
        )
        for b in bookings
    ]

    return KDSBookingsResponse(
        period_name=display_name,
        total_bookings=len(booking_items),
        total_covers=total_covers,
        flag_icon_mapping=flag_icon_mapping,
        bookings=booking_items,
    )


# =============================================================================
# Course Flow Endpoints
# =============================================================================

@router.post("/course-away", response_model=CourseActionResponse)
async def course_away(
    request: CourseActionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Mark a course as 'away' (called away from kitchen).

    This starts the prep timer for the course. Only allowed if the previous
    course has been marked as 'sent'.
    """
    # Get the KDS ticket
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.id == request.ticket_id,
                KDSTicket.kitchen_id == current_user.kitchen_id
            )
        )
    )
    kds_ticket = result.scalar_one_or_none()

    if not kds_ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    if kds_ticket.is_bumped:
        raise HTTPException(status_code=400, detail="Ticket already completed")

    now = datetime.utcnow()
    course_states = dict(kds_ticket.course_states or {})

    # Validate the course exists
    course_state = course_states.get(request.course_name)
    if not course_state:
        raise HTTPException(status_code=400, detail=f"Course '{request.course_name}' not found in ticket")

    # Validate course is currently pending
    if course_state.get("status") != "pending":
        raise HTTPException(
            status_code=400,
            detail=f"Course '{request.course_name}' is already '{course_state.get('status')}'"
        )

    # Validate sequential: previous course must be sent
    settings = await get_kds_settings(db, current_user.kitchen_id)
    course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"]
    ordered_courses = get_ordered_courses_for_ticket(kds_ticket.orders_data or [], course_order)

    course_idx = None
    for i, c in enumerate(ordered_courses):
        if c == request.course_name:
            course_idx = i
            break

    if course_idx is not None and course_idx > 0:
        prev_course = ordered_courses[course_idx - 1]
        prev_state = course_states.get(prev_course, {})
        if prev_state.get("status") not in ("sent", "cleared"):
            raise HTTPException(
                status_code=400,
                detail=f"Previous course '{prev_course}' must be sent before calling away '{request.course_name}'"
            )

        # Mark previous course as "cleared" (table cleared for next course)
        if prev_state.get("status") == "sent":
            course_states[prev_course] = {
                **prev_state,
                "status": "cleared",
                "cleared_at": now.isoformat(),
            }
            # Audit log for cleared
            cleared_bump = KDSCourseBump(
                ticket_id=kds_ticket.id,
                course_name=prev_course,
                action="cleared",
                bumped_at=now,
                bumped_by_user_id=current_user.id,
            )
            db.add(cleared_bump)

    # Update course state to "away"
    course_states[request.course_name] = {
        "status": "away",
        "called_away_at": now.isoformat(),
        "sent_at": course_state.get("sent_at"),
        "sent_by": course_state.get("sent_by"),
        "sent_order_ids": course_state.get("sent_order_ids", []),
    }
    kds_ticket.course_states = course_states
    kds_ticket.updated_at = now

    # Create audit record
    bump = KDSCourseBump(
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        action="away",
        bumped_at=now,
        bumped_by_user_id=current_user.id,
    )
    db.add(bump)

    await db.commit()

    return CourseActionResponse(
        success=True,
        message=f"Course '{request.course_name}' called away",
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        action="away",
        timestamp=now
    )


@router.post("/course-sent", response_model=CourseActionResponse)
async def course_sent(
    request: CourseActionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Mark a course as 'sent' (food delivered to table).

    This stops the prep timer and starts the away timer.
    Course must currently be in 'away' status.
    """
    # Get the KDS ticket
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.id == request.ticket_id,
                KDSTicket.kitchen_id == current_user.kitchen_id
            )
        )
    )
    kds_ticket = result.scalar_one_or_none()

    if not kds_ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    if kds_ticket.is_bumped:
        raise HTTPException(status_code=400, detail="Ticket already completed")

    now = datetime.utcnow()
    course_states = dict(kds_ticket.course_states or {})

    # Validate the course exists
    course_state = course_states.get(request.course_name)
    if not course_state:
        raise HTTPException(status_code=400, detail=f"Course '{request.course_name}' not found in ticket")

    # Validate course is currently away
    if course_state.get("status") != "away":
        raise HTTPException(
            status_code=400,
            detail=f"Course '{request.course_name}' must be 'away' before marking as 'sent' (current: '{course_state.get('status')}')"
        )

    # Get previous bump for time calculation
    prev_bump_result = await db.execute(
        select(KDSCourseBump)
        .where(KDSCourseBump.ticket_id == kds_ticket.id)
        .order_by(KDSCourseBump.bumped_at.desc())
        .limit(1)
    )
    prev_bump = prev_bump_result.scalar_one_or_none()
    time_since_previous = None
    if prev_bump:
        time_since_previous = int((now - prev_bump.bumped_at).total_seconds())

    # Gather all non-voided order IDs in this course and mark as sent
    course_order_ids = [
        o.get("id") for o in (kds_ticket.orders_data or [])
        if o.get("kitchen_course") == request.course_name and not o.get("is_voided")
    ]
    existing_sent = set(course_state.get("sent_order_ids", []))
    all_sent = list(existing_sent | set(course_order_ids))

    # Update course state to "sent"
    course_states[request.course_name] = {
        "status": "sent",
        "called_away_at": course_state.get("called_away_at"),
        "sent_at": now.isoformat(),
        "sent_by": current_user.name or current_user.email,
        "sent_order_ids": all_sent,
    }
    kds_ticket.course_states = course_states
    kds_ticket.updated_at = now

    # Create audit record
    bump = KDSCourseBump(
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        action="sent",
        bumped_at=now,
        bumped_by_user_id=current_user.id,
        time_since_previous_seconds=time_since_previous
    )
    db.add(bump)

    await db.commit()

    return CourseActionResponse(
        success=True,
        message=f"Course '{request.course_name}' marked as sent",
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        action="sent",
        timestamp=now
    )


# Keep backward-compatible bump-course endpoint (acts as course-sent)
@router.post("/bump-course", response_model=CourseBumpResponse)
async def bump_course(
    request: CourseBumpRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Legacy endpoint: Bump a course (mark as sent).
    Redirects to course-sent logic.
    """
    action_req = CourseActionRequest(ticket_id=request.ticket_id, course_name=request.course_name)
    result = await course_sent(action_req, current_user, db)
    return CourseBumpResponse(
        success=result.success,
        message=result.message,
        ticket_id=result.ticket_id,
        course_name=result.course_name,
        bumped_at=result.timestamp
    )


@router.post("/bump-ticket/{ticket_id}")
async def bump_full_ticket(
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Bump entire ticket (mark as complete). Used after all courses are sent."""
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.id == ticket_id,
                KDSTicket.kitchen_id == current_user.kitchen_id
            )
        )
    )
    kds_ticket = result.scalar_one_or_none()

    if not kds_ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    now = datetime.utcnow()
    kds_ticket.is_bumped = True
    kds_ticket.bumped_at = now
    kds_ticket.updated_at = now

    await db.commit()

    return {"success": True, "message": "Ticket bumped", "ticket_id": ticket_id}


@router.post("/sync")
async def trigger_sync(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Manually trigger a sync with SambaPOS."""
    # This just returns the current tickets - the actual sync happens in get_tickets
    tickets = await get_tickets(current_user, db)
    return {
        "success": True,
        "message": f"Synced {len(tickets)} active tickets",
        "ticket_count": len(tickets)
    }


@router.get("/debug-graphql")
async def debug_graphql(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Debug endpoint to show raw GraphQL response."""
    settings = await get_kds_settings(db, current_user.kitchen_id)

    if not settings:
        return {"error": "Kitchen settings not found"}

    kds_url = settings.kds_graphql_url
    kds_username = settings.kds_graphql_username
    kds_password = settings.kds_graphql_password
    kds_client_id = settings.kds_graphql_client_id

    if not all([kds_url, kds_username, kds_password, kds_client_id]):
        return {"error": "KDS not configured"}

    client = SambaPOSGraphQLClient(
        server_url=kds_url,
        username=kds_username,
        password=kds_password,
        client_id=kds_client_id
    )

    result = await client.get_open_tickets()
    return result


@router.get("/test-connection")
async def test_connection(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Test the GraphQL connection to SambaPOS."""
    settings = await get_kds_settings(db, current_user.kitchen_id)

    if not settings:
        return {"success": False, "error": "Kitchen settings not found"}

    kds_url = settings.kds_graphql_url
    kds_username = settings.kds_graphql_username
    kds_password = settings.kds_graphql_password
    kds_client_id = settings.kds_graphql_client_id

    if not all([kds_url, kds_username, kds_password, kds_client_id]):
        return {
            "success": False,
            "error": "KDS GraphQL settings not configured",
            "missing": [
                k for k, v in {
                    "url": kds_url,
                    "username": kds_username,
                    "password": kds_password,
                    "client_id": kds_client_id
                }.items() if not v
            ]
        }

    client = SambaPOSGraphQLClient(
        server_url=kds_url,
        username=kds_username,
        password=kds_password,
        client_id=kds_client_id
    )

    # Try to authenticate
    auth_success = await client.authenticate()
    if not auth_success:
        return {"success": False, "error": "Authentication failed"}

    # Try a simple query
    result = await client.graphql_query("{ __typename }")
    if "error" in result:
        return {"success": False, "error": result["error"]}

    return {
        "success": True,
        "message": "Connected to SambaPOS GraphQL API",
        "server": kds_url
    }


# =============================================================================
# Recipe Link (links KDS menu items to dish recipes)
# =============================================================================

@router.get("/recipe-link/{menu_item_name}")
async def get_recipe_link(
    menu_item_name: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Look up a linked recipe for a KDS order item by menu_item_name.

    Returns a lightweight recipe summary suitable for KDS overlay display:
    plating photo, ingredients, key steps, and flag badges.
    """
    from models.recipe import Recipe, RecipeIngredient, RecipeStep, RecipeImage
    from models.ingredient import Ingredient
    from models.food_flag import FoodFlag, RecipeFlag
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(Recipe)
        .options(selectinload(Recipe.images))
        .where(
            Recipe.kitchen_id == current_user.kitchen_id,
            Recipe.kds_menu_item_name == menu_item_name,
            Recipe.is_archived == False,
        )
    )
    recipe = result.scalar_one_or_none()
    if not recipe:
        return None

    # Get ingredients
    ri_result = await db.execute(
        select(RecipeIngredient)
        .options(selectinload(RecipeIngredient.ingredient))
        .where(RecipeIngredient.recipe_id == recipe.id)
        .order_by(RecipeIngredient.sort_order)
    )
    ingredients = [
        {
            "name": ri.ingredient.name if ri.ingredient else "?",
            "quantity": float(ri.quantity),
            "unit": ri.ingredient.standard_unit if ri.ingredient else "",
            "notes": ri.notes,
        }
        for ri in ri_result.scalars().all()
    ]

    # Get steps
    steps_result = await db.execute(
        select(RecipeStep)
        .where(RecipeStep.recipe_id == recipe.id)
        .order_by(RecipeStep.step_number)
    )
    steps = [
        {"step_number": s.step_number, "instruction": s.instruction}
        for s in steps_result.scalars().all()
    ]

    # Get flags
    from api.food_flags import compute_recipe_flags
    flags_raw = await compute_recipe_flags(recipe.id, current_user.kitchen_id, db)
    flags = [
        {"name": f.flag_name, "code": f.flag_code, "icon": f.flag_icon, "category": f.category_name}
        for f in flags_raw if f.is_active
    ]

    # Plating image
    plating_image = None
    for img in (recipe.images or []):
        if img.image_type == "plating":
            plating_image = {"id": img.id, "caption": img.caption}
            break
    if not plating_image and recipe.images:
        plating_image = {"id": recipe.images[0].id, "caption": recipe.images[0].caption}

    return {
        "recipe_id": recipe.id,
        "name": recipe.name,
        "description": recipe.description,
        "batch_portions": recipe.batch_portions,
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "plating_image": plating_image,
        "ingredients": ingredients,
        "steps": steps,
        "flags": flags,
    }


# =============================================================================
# SSE (Server-Sent Events) for Real-Time Updates
# =============================================================================

@router.get("/events")
async def kds_events(request: Request):
    """
    Server-Sent Events stream for real-time KDS updates.

    The SignalR listener pushes events here when SambaPOS broadcasts
    TICKET_REFRESH messages. Frontend subscribes to this for instant
    refresh instead of relying solely on polling.

    No auth required for SSE (connection is long-lived and the
    KDS display may not have convenient auth headers for EventSource).
    """
    import json

    async def event_generator():
        queue = kds_event_bus.subscribe()
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    # Send keepalive comment to prevent connection timeout
                    yield ": keepalive\n\n"
        finally:
            kds_event_bus.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
