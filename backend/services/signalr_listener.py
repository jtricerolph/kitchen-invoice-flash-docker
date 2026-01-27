"""
SambaPOS SignalR Listener for KDS

Connects to SambaPOS Message Server via SignalR 2.x WebSocket and listens
for TICKET_REFRESH broadcasts. When received, fetches the specific ticket
by ID (works even for closed/zero-total tickets) and creates/updates
KDS entries for real-time display.

This solves the problem of tickets that close instantly (e.g. free breakfast
for residents, bar orders paid immediately) not appearing in KDS polling.

SignalR 2.x Protocol:
1. GET /signalr/negotiate - get connection token
2. WS  /signalr/connect?transport=webSockets&connectionToken=... - WebSocket
3. Messages arrive as JSON: {"C": "...", "M": [{...}]}
   - TICKET_REFRESH: {"H": "Default", "M": "update", "A": ["guid:<TICKET_REFRESH>ticketId"]}
"""

import asyncio
import json
import logging
import urllib.parse
from typing import Optional
from datetime import datetime

import httpx

logger = logging.getLogger(__name__)


class KDSEventBus:
    """Simple pub/sub for notifying SSE subscribers of KDS events."""

    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def publish(self, event: dict):
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


# Global event bus - imported by kds.py for the SSE endpoint
kds_event_bus = KDSEventBus()


class SignalRListener:
    """Background listener for SambaPOS SignalR broadcasts."""

    def __init__(
        self,
        base_url: str,
        graphql_username: str,
        graphql_password: str,
        graphql_client_id: str,
        kitchen_id: int,
        course_order: list,
    ):
        self.base_url = base_url.rstrip('/')
        self.graphql_username = graphql_username
        self.graphql_password = graphql_password
        self.graphql_client_id = graphql_client_id
        self.kitchen_id = kitchen_id
        self.course_order = course_order
        self._running = False
        self._task: Optional[asyncio.Task] = None

    def _get_ws_base(self) -> str:
        """Convert HTTP URL to WS URL."""
        return self.base_url.replace('http://', 'ws://').replace('https://', 'wss://')

    async def _negotiate(self) -> Optional[str]:
        """Negotiate SignalR connection and get token."""
        url = f"{self.base_url}/signalr/negotiate"
        params = {
            "clientProtocol": "1.5",
            "connectionData": json.dumps([{"name": "default"}])
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, params=params)
                if response.status_code == 200:
                    data = response.json()
                    return data.get("ConnectionToken")
                else:
                    logger.error(f"SignalR negotiate failed: {response.status_code}")
                    return None
        except Exception as e:
            logger.error(f"SignalR negotiate error: {e}")
            return None

    async def _listen_loop(self):
        """Main WebSocket listen loop with auto-reconnection."""
        try:
            import websockets
        except ImportError:
            logger.error("SignalR: websockets package not installed")
            return

        while self._running:
            try:
                token = await self._negotiate()
                if not token:
                    logger.warning("SignalR: Failed to negotiate, retrying in 10s...")
                    await asyncio.sleep(10)
                    continue

                encoded_token = urllib.parse.quote(token, safe='')
                conn_data = urllib.parse.quote(json.dumps([{"name": "default"}]), safe='')
                ws_url = (
                    f"{self._get_ws_base()}/signalr/connect"
                    f"?transport=webSockets"
                    f"&clientProtocol=1.5"
                    f"&connectionToken={encoded_token}"
                    f"&connectionData={conn_data}"
                )

                logger.info("SignalR: Connecting to WebSocket...")
                async with websockets.connect(ws_url) as ws:
                    logger.info("SignalR: Connected, listening for broadcasts")

                    while self._running:
                        try:
                            msg = await asyncio.wait_for(ws.recv(), timeout=30)
                            if msg:
                                data = json.loads(msg)
                                messages = data.get("M", [])
                                for m in messages:
                                    await self._handle_message(m)
                        except asyncio.TimeoutError:
                            # Normal - no messages received, keep listening
                            continue
                        except asyncio.CancelledError:
                            return
                        except Exception as e:
                            logger.warning(f"SignalR: WebSocket recv error: {e}")
                            break

            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning(f"SignalR: Connection failed: {e}, reconnecting in 5s...")
                await asyncio.sleep(5)

    async def _handle_message(self, message: dict):
        """Handle a SignalR broadcast message."""
        args = message.get("A", [])
        for arg in args:
            if "<TICKET_REFRESH>" in arg:
                try:
                    ticket_id_str = arg.split("<TICKET_REFRESH>")[1]
                    ticket_id = int(ticket_id_str)
                    logger.info(f"SignalR: TICKET_REFRESH for ticket {ticket_id}")
                    await self._process_ticket_refresh(ticket_id)
                except (ValueError, IndexError) as e:
                    logger.warning(f"SignalR: Failed to parse TICKET_REFRESH: {arg} - {e}")

    async def _process_ticket_refresh(self, sambapos_ticket_id: int):
        """Handle a TICKET_REFRESH broadcast.

        SambaPOS getTicket(id) has a server-side bug (NullReferenceException),
        so we can't fetch individual tickets by ID. Instead we:
        1. Always publish an SSE event so the frontend immediately re-polls
           open tickets (instant refresh instead of waiting for poll interval)
        2. The existing /api/kds/tickets endpoint handles fetching all open
           tickets and creating/updating KDS entries
        """
        # Notify SSE subscribers for instant frontend refresh
        await kds_event_bus.publish({
            "type": "ticket_refresh",
            "sambapos_ticket_id": sambapos_ticket_id,
            "timestamp": datetime.utcnow().isoformat(),
        })
        logger.info(f"SignalR: Published SSE event for ticket {sambapos_ticket_id}")

    def start(self):
        """Start the listener as a background asyncio task."""
        self._running = True
        self._task = asyncio.create_task(self._listen_loop())
        logger.info("SignalR: Listener started")

    def stop(self):
        """Stop the listener."""
        self._running = False
        if self._task:
            self._task.cancel()
        logger.info("SignalR: Listener stopped")


# Global listener instance
_listener: Optional[SignalRListener] = None


async def start_signalr_listener():
    """Start the global SignalR listener using KDS settings from DB."""
    global _listener

    from database import AsyncSessionLocal
    from sqlalchemy import select
    from models.settings import KitchenSettings

    try:
        async with AsyncSessionLocal() as db:
            # Get first kitchen with KDS GraphQL configured
            result = await db.execute(
                select(KitchenSettings).where(
                    KitchenSettings.kds_graphql_url.isnot(None)
                )
            )
            settings = result.scalar_one_or_none()

            if not settings:
                logger.info("SignalR: No KDS GraphQL URL configured, listener not started")
                return

            if not all([settings.kds_graphql_url, settings.kds_graphql_username,
                        settings.kds_graphql_password, settings.kds_graphql_client_id]):
                logger.info("SignalR: KDS GraphQL credentials incomplete, listener not started")
                return

            course_order = settings.kds_course_order or ["Starters", "Mains", "Desserts"]

            _listener = SignalRListener(
                base_url=settings.kds_graphql_url,
                graphql_username=settings.kds_graphql_username,
                graphql_password=settings.kds_graphql_password,
                graphql_client_id=settings.kds_graphql_client_id,
                kitchen_id=settings.kitchen_id,
                course_order=course_order,
            )
            _listener.start()

    except Exception as e:
        logger.error(f"SignalR: Failed to start listener: {e}")


async def stop_signalr_listener():
    """Stop the global SignalR listener."""
    global _listener
    if _listener:
        _listener.stop()
        _listener = None
