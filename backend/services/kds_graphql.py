"""
SambaPOS GraphQL Client for KDS

Connects to SambaPOS Message Server GraphQL API to fetch open tickets
with kitchen orders for the Kitchen Display System.
"""

import logging
from typing import Optional
from datetime import datetime
import httpx

logger = logging.getLogger(__name__)


class SambaPOSGraphQLClient:
    """Client for SambaPOS Message Server GraphQL API."""

    def __init__(
        self,
        server_url: str,
        username: str,
        password: str,
        client_id: str
    ):
        self.server_url = server_url.rstrip('/')
        self.username = username
        self.password = password
        self.client_id = client_id
        self.access_token: Optional[str] = None
        self.token_expires_at: Optional[datetime] = None

    async def authenticate(self) -> bool:
        """
        Authenticate with SambaPOS and get access token.

        POST /Token with:
          grant_type=password
          username=<user>
          password=<pass>
          client_id=<app_key>
        """
        token_url = f"{self.server_url}/Token"

        data = {
            "grant_type": "password",
            "username": self.username,
            "password": self.password,
            "client_id": self.client_id,
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    token_url,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"}
                )
                if response.status_code == 200:
                    result = response.json()
                    self.access_token = result.get("access_token")
                    expires_in = result.get("expires_in", 86400)
                    self.token_expires_at = datetime.utcnow()
                    logger.info(f"KDS: Authenticated with SambaPOS (expires in {expires_in}s)")
                    return True
                else:
                    logger.error(f"KDS: Authentication failed: {response.status_code} - {response.text}")
                    return False
        except httpx.ConnectError:
            logger.error(f"KDS: Could not connect to {token_url}")
            return False
        except Exception as e:
            logger.error(f"KDS: Authentication error: {e}")
            return False

    async def ensure_authenticated(self) -> bool:
        """Ensure we have a valid token, re-authenticating if needed."""
        if not self.access_token:
            return await self.authenticate()
        return True

    async def graphql_query(self, query: str, variables: Optional[dict] = None) -> dict:
        """Execute a GraphQL query against SambaPOS."""
        if not await self.ensure_authenticated():
            return {"error": "Authentication failed"}

        graphql_url = f"{self.server_url}/api/graphql"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.access_token}"
        }

        payload = {
            "query": query,
            "variables": variables,
            "operationName": None
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    graphql_url,
                    json=payload,
                    headers=headers
                )
                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 401:
                    # Token expired, try re-auth
                    self.access_token = None
                    if await self.authenticate():
                        return await self.graphql_query(query, variables)
                    return {"error": "Re-authentication failed"}
                else:
                    return {"error": f"HTTP {response.status_code}: {response.text}"}
        except httpx.ConnectError:
            return {"error": f"Could not connect to {graphql_url}"}
        except Exception as e:
            return {"error": str(e)}

    async def get_open_tickets(self) -> dict:
        """
        Query for open (not closed) tickets with full order details.

        Returns tickets with:
        - Ticket info (id, number, date, table)
        - Orders with Kitchen Course and Kitchen Print states
        """
        query = """
        {
          getTickets(isClosed: false, orderBy: date) {
            id
            uid
            number
            date
            lastUpdateTime
            totalAmount
            remainingAmount
            note
            tags {
              tag
              tagName
            }
            states {
              stateName
              state
            }
            orders {
              id
              uid
              name
              portion
              quantity
              price
              priceTag
              date
              tags {
                tag
                tagName
                quantity
              }
              states {
                stateName
                state
                stateValue
              }
            }
            entities {
              type
              name
            }
          }
        }
        """
        return await self.graphql_query(query)

    async def get_ticket_by_id(self, ticket_id: int) -> dict:
        """Query for a specific ticket by ID."""
        query = """
        query GetTicket($ticketId: Int!) {
          getTicket(id: $ticketId) {
            id
            uid
            number
            date
            lastUpdateTime
            totalAmount
            tags {
              tag
              tagName
            }
            states {
              stateName
              state
            }
            orders {
              id
              uid
              name
              portion
              quantity
              price
              date
              tags {
                tag
                tagName
                quantity
              }
              states {
                stateName
                state
                stateValue
              }
            }
            entities {
              type
              name
            }
          }
        }
        """
        return await self.graphql_query(query, {"ticketId": ticket_id})


def parse_kitchen_course(order: dict) -> Optional[str]:
    """Extract Kitchen Course from order states."""
    states = order.get("states", [])
    for state in states:
        if state.get("stateName") == "Kitchen Course":
            return state.get("state")
    return None


def parse_order_status(order: dict) -> str:
    """Extract Status state from order (e.g., Submitted, New)."""
    states = order.get("states", [])
    for state in states:
        if state.get("stateName") == "Status":
            return state.get("state", "Unknown")
    return "Unknown"


def parse_kitchen_print_state(order: dict) -> Optional[str]:
    """Extract Kitchen Print state from order."""
    states = order.get("states", [])
    for state in states:
        if state.get("stateName") == "Kitchen Print":
            return state.get("state")
    return None


def parse_gstatus(order: dict) -> tuple[Optional[str], Optional[str]]:
    """Extract GStatus state and timestamp from order (used for void detection)."""
    states = order.get("states", [])
    for state in states:
        if state.get("stateName") == "GStatus":
            return state.get("state"), state.get("stateDateTime")
    return None, None


def get_table_name(ticket: dict) -> Optional[str]:
    """Extract table name from ticket entities."""
    entities = ticket.get("entities", [])
    for entity in entities:
        if entity.get("type") == "Tables":
            return entity.get("name")
    return None


def transform_ticket_for_kds(ticket: dict) -> dict:
    """
    Transform a SambaPOS ticket into KDS-friendly format.

    Groups orders by Kitchen Course and filters for kitchen-relevant items.
    """
    table_name = get_table_name(ticket)

    # Group orders by kitchen course
    orders_by_course = {}
    all_orders = []
    deferred_voided = []
    earliest_kitchen_order_date = None  # Track earliest kitchen-printable order time

    for order in ticket.get("orders", []):
        kitchen_course = parse_kitchen_course(order) or "Uncategorized"
        order_status = parse_order_status(order)
        kitchen_print = parse_kitchen_print_state(order)
        gstatus, gstatus_datetime = parse_gstatus(order)

        # Log order states for debugging
        logger.debug(f"Order '{order.get('name')}': status={order_status}, gstatus={gstatus}, kitchen_print={kitchen_print}")

        # Must have Kitchen Print state set (meaning it's a kitchen item)
        if not kitchen_print:
            continue

        # Determine if item is voided (show with strikethrough)
        is_voided = (
            kitchen_print in ["Canceled", "Void"] or
            gstatus in ["Void", "Cancelled", "Canceled"] or
            order_status in ["Void", "Cancelled", "Canceled"]
        )

        # Get void timestamp if available
        voided_at = gstatus_datetime if is_voided and gstatus in ["Void", "Cancelled", "Canceled"] else None

        # Skip non-voided items that are not submitted (e.g., "New" status)
        if not is_voided and order_status not in ["Submitted"]:
            logger.debug(f"Skipping order '{order.get('name')}' - status is '{order_status}', not 'Submitted'")
            continue

        # Extract order tags (modifiers like "Rare", "No sauce", etc.)
        order_tags = order.get("tags", [])

        order_data = {
            "id": order.get("id"),
            "uid": order.get("uid"),
            "name": order.get("name"),
            "portion": order.get("portion"),
            "quantity": order.get("quantity"),
            "price": order.get("price"),
            "kitchen_course": kitchen_course,
            "status": order_status,
            "kitchen_print": kitchen_print,
            "is_voided": is_voided,
            "voided_at": voided_at,
            "tags": order_tags,
        }

        if is_voided:
            # Defer voided orders - only add to existing course groups later
            deferred_voided.append((kitchen_course, order_data))
        else:
            if kitchen_course not in orders_by_course:
                orders_by_course[kitchen_course] = []
            orders_by_course[kitchen_course].append(order_data)
            all_orders.append(order_data)

            # Track earliest kitchen-printable order date
            order_date = order.get("date")
            if order_date:
                if earliest_kitchen_order_date is None or order_date < earliest_kitchen_order_date:
                    earliest_kitchen_order_date = order_date

    # Add voided orders only to course groups that already exist (avoids "Uncategorized" ghost courses)
    for course, order_data in deferred_voided:
        if course in orders_by_course:
            orders_by_course[course].append(order_data)
            all_orders.append(order_data)

    # Skip tickets with no kitchen orders
    if not all_orders:
        return None

    # Get covers from tags
    covers = None
    for tag in ticket.get("tags", []):
        if tag.get("tagName") == "Covers":
            try:
                covers = int(tag.get("tag"))
            except (ValueError, TypeError):
                pass

    return {
        "id": ticket.get("id"),
        "uid": ticket.get("uid"),
        "number": ticket.get("number"),
        "date": ticket.get("date"),
        "last_update": ticket.get("lastUpdateTime"),
        "table": table_name,
        "covers": covers,
        "total_amount": ticket.get("totalAmount"),
        "orders": all_orders,
        "orders_by_course": orders_by_course,
        "submitted_at": earliest_kitchen_order_date or ticket.get("date"),  # First kitchen order time, fallback to ticket date
    }
