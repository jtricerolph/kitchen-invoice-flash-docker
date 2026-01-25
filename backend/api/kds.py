"""
KDS (Kitchen Display System) API Endpoints

Provides endpoints for:
- Fetching open tickets with kitchen orders
- Course bumping
- KDS settings management
"""

import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
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
    kds_poll_interval_seconds: int = 5
    kds_timer_green_seconds: int = 300
    kds_timer_amber_seconds: int = 600
    kds_timer_red_seconds: int = 900
    kds_course_order: list = ["Starters", "Mains", "Desserts"]
    kds_show_completed_for_seconds: int = 30

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
    kds_course_order: Optional[list] = None
    kds_show_completed_for_seconds: Optional[int] = None


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


class CourseBumpRequest(BaseModel):
    ticket_id: int  # Local KDS ticket ID
    course_name: str


class CourseBumpResponse(BaseModel):
    success: bool
    message: str
    ticket_id: int
    course_name: str
    bumped_at: datetime


# =============================================================================
# Helper Functions
# =============================================================================

async def get_kds_settings(db: AsyncSession, kitchen_id: int) -> Optional[KitchenSettings]:
    """Get KDS settings for a kitchen."""
    result = await db.execute(
        select(KitchenSettings).where(KitchenSettings.kitchen_id == kitchen_id)
    )
    return result.scalar_one_or_none()


async def get_or_create_kds_ticket(
    db: AsyncSession,
    kitchen_id: int,
    sambapos_ticket: dict
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
        # Update with latest data
        kds_ticket.table_name = sambapos_ticket.get("table")
        kds_ticket.covers = sambapos_ticket.get("covers")
        kds_ticket.orders_data = sambapos_ticket.get("orders", [])
        kds_ticket.last_sambapos_update = datetime.utcnow()
        kds_ticket.updated_at = datetime.utcnow()
    else:
        # Create new ticket
        kds_ticket = KDSTicket(
            kitchen_id=kitchen_id,
            sambapos_ticket_id=sambapos_ticket["id"],
            sambapos_ticket_uid=sambapos_ticket.get("uid"),
            ticket_number=str(sambapos_ticket.get("number", "")),
            table_name=sambapos_ticket.get("table"),
            covers=sambapos_ticket.get("covers"),
            total_amount=sambapos_ticket.get("total_amount"),
            orders_data=sambapos_ticket.get("orders", []),
            course_states={},
            received_at=datetime.utcnow(),
            last_sambapos_update=datetime.utcnow()
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

    return KDSSettingsResponse(
        kds_enabled=settings.kds_enabled or False,
        kds_graphql_url=settings.kds_graphql_url,
        kds_graphql_username=settings.kds_graphql_username,
        kds_graphql_password_set=bool(settings.kds_graphql_password),
        kds_graphql_client_id=settings.kds_graphql_client_id,
        kds_poll_interval_seconds=settings.kds_poll_interval_seconds or 5,
        kds_timer_green_seconds=settings.kds_timer_green_seconds or 300,
        kds_timer_amber_seconds=settings.kds_timer_amber_seconds or 600,
        kds_timer_red_seconds=settings.kds_timer_red_seconds or 900,
        kds_course_order=settings.kds_course_order or ["Starters", "Mains", "Desserts"],
        kds_show_completed_for_seconds=settings.kds_show_completed_for_seconds or 30
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
            db, current_user.kitchen_id, transformed
        )

        # Skip tickets that have been bumped (completed)
        if kds_ticket.is_bumped:
            continue

        # Calculate elapsed time
        now = datetime.utcnow()
        elapsed = (now - kds_ticket.received_at).total_seconds()

        # Build response
        response_tickets.append(KDSTicketResponse(
            id=kds_ticket.id,
            sambapos_ticket_id=kds_ticket.sambapos_ticket_id,
            ticket_number=kds_ticket.ticket_number,
            table_name=kds_ticket.table_name,
            covers=kds_ticket.covers,
            received_at=kds_ticket.received_at,
            time_elapsed_seconds=int(elapsed),
            orders=[KDSOrderResponse(**o) for o in transformed.get("orders", [])],
            orders_by_course=transformed.get("orders_by_course", {}),
            course_states=kds_ticket.course_states or {},
            is_bumped=kds_ticket.is_bumped
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

        response_tickets.append(KDSTicketResponse(
            id=kds_ticket.id,
            sambapos_ticket_id=kds_ticket.sambapos_ticket_id,
            ticket_number=kds_ticket.ticket_number,
            table_name=kds_ticket.table_name,
            covers=kds_ticket.covers,
            received_at=kds_ticket.received_at,
            time_elapsed_seconds=int(elapsed),
            orders=[KDSOrderResponse(**o) for o in orders],
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
    """Mark tickets that are no longer in SambaPOS as inactive."""
    result = await db.execute(
        select(KDSTicket).where(
            and_(
                KDSTicket.kitchen_id == kitchen_id,
                KDSTicket.is_active == True
            )
        )
    )
    local_tickets = result.scalars().all()

    for ticket in local_tickets:
        if ticket.sambapos_ticket_id not in active_sambapos_ids:
            ticket.is_active = False
            ticket.updated_at = datetime.utcnow()

    await db.commit()


@router.post("/bump-course", response_model=CourseBumpResponse)
async def bump_course(
    request: CourseBumpRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Bump a course for a ticket (mark it as sent to table).

    This records the bump locally and updates the ticket's course state.
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
        raise HTTPException(status_code=400, detail="Ticket already fully bumped")

    now = datetime.utcnow()

    # Get previous bump for time calculation
    prev_bump_result = await db.execute(
        select(KDSCourseBump)
        .where(KDSCourseBump.ticket_id == kds_ticket.id)
        .order_by(KDSCourseBump.bumped_at.desc())
    )
    prev_bump = prev_bump_result.scalar_one_or_none()

    time_since_previous = None
    if prev_bump:
        time_since_previous = int((now - prev_bump.bumped_at).total_seconds())

    # Create bump record
    bump = KDSCourseBump(
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        bumped_at=now,
        bumped_by_user_id=current_user.id,
        time_since_previous_seconds=time_since_previous
    )
    db.add(bump)

    # Update ticket's course states
    course_states = kds_ticket.course_states or {}
    course_states[request.course_name] = {
        "bumped": True,
        "bumped_at": now.isoformat(),
        "bumped_by": current_user.name or current_user.email
    }
    kds_ticket.course_states = course_states

    # Check if all courses are bumped
    settings = await get_kds_settings(db, current_user.kitchen_id)
    course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"] if settings else ["Starters", "Mains", "Desserts"]

    # Get courses present in this ticket
    orders_data = kds_ticket.orders_data or []
    ticket_courses = set()
    for order in orders_data:
        course = order.get("kitchen_course", "Uncategorized")
        ticket_courses.add(course)

    # Check if all ticket courses are bumped
    all_bumped = all(
        course_states.get(course, {}).get("bumped", False)
        for course in ticket_courses
    )

    if all_bumped:
        kds_ticket.is_bumped = True
        kds_ticket.bumped_at = now

    kds_ticket.updated_at = now
    await db.commit()

    return CourseBumpResponse(
        success=True,
        message=f"Course '{request.course_name}' bumped successfully",
        ticket_id=kds_ticket.id,
        course_name=request.course_name,
        bumped_at=now
    )


@router.post("/bump-ticket/{ticket_id}")
async def bump_full_ticket(
    ticket_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Bump entire ticket (mark all courses as complete)."""
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
