from datetime import date, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from pydantic import BaseModel

from database import get_db
from models.user import User
from models.calendar_events import CalendarEvent
from auth.jwt import get_current_user

router = APIRouter()


# Pydantic schemas
class CalendarEventCreate(BaseModel):
    event_date: date
    event_type: str  # reminder, event, note
    title: str
    description: str | None = None


class CalendarEventUpdate(BaseModel):
    event_date: date | None = None
    event_type: str | None = None
    title: str | None = None
    description: str | None = None


class CalendarEventResponse(BaseModel):
    id: int
    event_date: date
    event_type: str
    title: str
    description: str | None
    created_at: str

    class Config:
        from_attributes = True


# Endpoints
@router.get("/")
async def list_events(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> list[CalendarEventResponse]:
    """List events for date range"""
    query = select(CalendarEvent).where(
        CalendarEvent.kitchen_id == current_user.kitchen_id
    )

    if from_date:
        query = query.where(CalendarEvent.event_date >= from_date)
    if to_date:
        query = query.where(CalendarEvent.event_date <= to_date)

    query = query.order_by(CalendarEvent.event_date, CalendarEvent.created_at)
    result = await db.execute(query)
    events = result.scalars().all()

    return [
        CalendarEventResponse(
            id=e.id,
            event_date=e.event_date,
            event_type=e.event_type,
            title=e.title,
            description=e.description,
            created_at=e.created_at.isoformat()
        )
        for e in events
    ]


@router.get("/{date}")
async def get_events_for_date(
    date: date,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> list[CalendarEventResponse]:
    """Get all events for a specific date"""
    result = await db.execute(
        select(CalendarEvent).where(
            and_(
                CalendarEvent.kitchen_id == current_user.kitchen_id,
                CalendarEvent.event_date == date
            )
        ).order_by(CalendarEvent.created_at)
    )
    events = result.scalars().all()

    return [
        CalendarEventResponse(
            id=e.id,
            event_date=e.event_date,
            event_type=e.event_type,
            title=e.title,
            description=e.description,
            created_at=e.created_at.isoformat()
        )
        for e in events
    ]


@router.post("/")
async def create_event(
    event: CalendarEventCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> CalendarEventResponse:
    """Create new event"""
    new_event = CalendarEvent(
        kitchen_id=current_user.kitchen_id,
        event_date=event.event_date,
        event_type=event.event_type,
        title=event.title,
        description=event.description,
        created_by=current_user.id
    )
    db.add(new_event)
    await db.commit()
    await db.refresh(new_event)

    return CalendarEventResponse(
        id=new_event.id,
        event_date=new_event.event_date,
        event_type=new_event.event_type,
        title=new_event.title,
        description=new_event.description,
        created_at=new_event.created_at.isoformat()
    )


@router.put("/{id}")
async def update_event(
    id: int,
    update: CalendarEventUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update existing event"""
    result = await db.execute(
        select(CalendarEvent).where(
            and_(
                CalendarEvent.id == id,
                CalendarEvent.kitchen_id == current_user.kitchen_id
            )
        )
    )
    event = result.scalar_one_or_none()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if update.event_date is not None:
        event.event_date = update.event_date
    if update.event_type is not None:
        event.event_type = update.event_type
    if update.title is not None:
        event.title = update.title
    if update.description is not None:
        event.description = update.description

    await db.commit()
    await db.refresh(event)

    return CalendarEventResponse(
        id=event.id,
        event_date=event.event_date,
        event_type=event.event_type,
        title=event.title,
        description=event.description,
        created_at=event.created_at.isoformat()
    )


@router.delete("/{id}")
async def delete_event(
    id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete event"""
    result = await db.execute(
        select(CalendarEvent).where(
            and_(
                CalendarEvent.id == id,
                CalendarEvent.kitchen_id == current_user.kitchen_id
            )
        )
    )
    event = result.scalar_one_or_none()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    await db.delete(event)
    await db.commit()

    return {"message": "Event deleted"}


@router.get("/dashboard/upcoming")
async def get_upcoming_events(
    limit: int = 3,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get next N upcoming events for dashboard widget"""
    today = date.today()

    result = await db.execute(
        select(CalendarEvent).where(
            and_(
                CalendarEvent.kitchen_id == current_user.kitchen_id,
                CalendarEvent.event_date >= today
            )
        ).order_by(CalendarEvent.event_date, CalendarEvent.created_at).limit(limit)
    )
    events = result.scalars().all()

    return {
        "total_count": len(events),
        "upcoming_events": [
            {
                "id": e.id,
                "event_date": e.event_date.isoformat(),
                "event_type": e.event_type,
                "title": e.title
            }
            for e in events
        ]
    }
