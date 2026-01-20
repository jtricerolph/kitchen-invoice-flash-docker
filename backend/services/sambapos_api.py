"""
SambaPOS MSSQL Database Client

Connects to SambaPOS EPOS database to fetch menu categories and top sellers data.
"""
import logging
from datetime import date
from decimal import Decimal
from typing import Optional
import aioodbc

logger = logging.getLogger(__name__)


class SambaPOSClient:
    """Client for querying SambaPOS MSSQL database."""

    def __init__(self, host: str, port: int, database: str, username: str, password: str):
        """
        Initialize SambaPOS client with connection parameters.

        Args:
            host: SQL Server host (e.g., 'localhost\\SQLEXPRESS17')
            port: SQL Server port (default 1433)
            database: Database name (e.g., 'clean')
            username: SQL Server username
            password: SQL Server password
        """
        self.host = host
        self.port = port
        self.database = database
        self.username = username
        self.password = password

        # Build connection string
        # Note: For named instances like 'localhost\SQLEXPRESS17', the port is ignored
        # and the instance name is used for connection
        if '\\' in host:
            # Named instance - don't use port
            self.connection_string = (
                f"DRIVER={{ODBC Driver 17 for SQL Server}};"
                f"SERVER={host};"
                f"DATABASE={database};"
                f"UID={username};"
                f"PWD={password};"
                f"TrustServerCertificate=yes;"
                f"Connection Timeout=30"
            )
        else:
            # Default instance - use port
            self.connection_string = (
                f"DRIVER={{ODBC Driver 17 for SQL Server}};"
                f"SERVER={host},{port};"
                f"DATABASE={database};"
                f"UID={username};"
                f"PWD={password};"
                f"TrustServerCertificate=yes;"
                f"Connection Timeout=30"
            )

        # Log connection details (without password)
        logger.info(f"SambaPOS connection configured: host={host}, database={database}, user={username}")

    async def test_connection(self) -> dict:
        """
        Test database connectivity.

        Returns:
            dict with 'success' bool and 'message' str
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute("SELECT 1")
                    await cursor.fetchone()
            return {"success": True, "message": "Connection successful"}
        except Exception as e:
            logger.error(f"SambaPOS connection test failed: {e}")
            return {"success": False, "message": str(e)}

    async def get_categories(self) -> list[dict]:
        """
        Fetch all unique values from the 'Kitchen Course' product tag.

        Returns:
            List of dicts with 'id' and 'name' for each Kitchen Course value
        """
        # Query to get unique Kitchen Course tag values from MenuItems.CustomTags JSON
        # CustomTags format: [{"TN":"Kitchen Course","TV":"Starters"},{"TN":"Kitchen Print","TV":"Y"}]
        # Using CROSS APPLY to safely calculate positions before SUBSTRING
        query = """
            SELECT DISTINCT
                ROW_NUMBER() OVER (ORDER BY KitchenCourse) as Id,
                KitchenCourse as Name
            FROM (
                SELECT DISTINCT
                    CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as KitchenCourse
                FROM MenuItems
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"Kitchen Course"', CustomTags) as tn_pos
                ) tn
                CROSS APPLY (
                    SELECT CASE WHEN tn.tn_pos > 0
                                THEN CHARINDEX('"TV":"', CustomTags, tn.tn_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                WHERE CustomTags LIKE '%"TN":"Kitchen Course"%'
            ) sub
            WHERE KitchenCourse IS NOT NULL AND KitchenCourse != ''
            ORDER BY KitchenCourse
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query)
                    rows = await cursor.fetchall()
                    result = [{"id": int(row[0]), "name": row[1].strip()} for row in rows]
                    logger.info(f"Found {len(result)} Kitchen Course categories: {[r['name'] for r in result]}")
                    return result
        except Exception as e:
            logger.error(f"Failed to fetch SambaPOS Kitchen Course categories: {e}")
            raise

    async def debug_menu_items(self) -> dict:
        """
        Debug method to explore MenuItems table structure and sample data.
        Returns column names and sample CustomTags values.
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    # Get column names from MenuItems table
                    await cursor.execute("""
                        SELECT COLUMN_NAME
                        FROM INFORMATION_SCHEMA.COLUMNS
                        WHERE TABLE_NAME = 'MenuItems'
                        ORDER BY ORDINAL_POSITION
                    """)
                    columns = [row[0] for row in await cursor.fetchall()]

                    # Get sample of CustomTags values (if column exists)
                    sample_tags = []
                    if 'CustomTags' in columns:
                        await cursor.execute("""
                            SELECT TOP 20 Name, CustomTags
                            FROM MenuItems
                            WHERE CustomTags IS NOT NULL AND CustomTags != ''
                        """)
                        sample_tags = [{"name": row[0], "custom_tags": row[1]} for row in await cursor.fetchall()]

                    # Also check for any tag-related tables
                    await cursor.execute("""
                        SELECT TABLE_NAME
                        FROM INFORMATION_SCHEMA.TABLES
                        WHERE TABLE_NAME LIKE '%Tag%' OR TABLE_NAME LIKE '%Property%'
                        ORDER BY TABLE_NAME
                    """)
                    tag_tables = [row[0] for row in await cursor.fetchall()]

                    return {
                        "menuitem_columns": columns,
                        "sample_custom_tags": sample_tags,
                        "tag_related_tables": tag_tables
                    }
        except Exception as e:
            logger.error(f"Debug MenuItems failed: {e}")
            raise

    async def debug_table_schema(self) -> dict:
        """
        Debug method to inspect column names in key SambaPOS tables.
        Used to identify correct column names for SQL queries.
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    result = {}

                    # Check key tables used in restaurant spend query
                    tables = ['Tickets', 'Orders', 'TicketEntities', 'MenuItems']

                    for table in tables:
                        await cursor.execute(f"""
                            SELECT COLUMN_NAME, DATA_TYPE
                            FROM INFORMATION_SCHEMA.COLUMNS
                            WHERE TABLE_NAME = '{table}'
                            ORDER BY ORDINAL_POSITION
                        """)
                        columns = [{"name": row[0], "type": row[1]} for row in await cursor.fetchall()]
                        result[table] = columns

                    return result
        except Exception as e:
            logger.error(f"Debug table schema failed: {e}")
            raise

    async def get_product_tag_groups(self) -> list[dict]:
        """
        Discover available product tag groups from the CustomTags field.

        Returns:
            List of unique tag group names found in CustomTags
        """
        query = """
            SELECT DISTINCT
                CASE
                    WHEN CHARINDEX(':', value) > 0
                    THEN LTRIM(RTRIM(LEFT(value, CHARINDEX(':', value) - 1)))
                    ELSE NULL
                END as TagGroup
            FROM MenuItems
            CROSS APPLY STRING_SPLIT(CustomTags, ',')
            WHERE CustomTags IS NOT NULL AND CustomTags != ''
            ORDER BY TagGroup
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query)
                    rows = await cursor.fetchall()
                    return [{"name": row[0]} for row in rows if row[0]]
        except Exception as e:
            logger.error(f"Failed to fetch SambaPOS tag groups: {e}")
            raise

    async def get_top_sellers(
        self,
        from_date: date,
        to_date: date,
        categories: list[str],
        limit: int = 10,
        excluded_categories: list[str] | None = None
    ) -> dict[str, list[dict]]:
        """
        Get top sellers grouped by Kitchen Course tag.

        Args:
            from_date: Start date for the query (inclusive)
            to_date: End date for the query (inclusive)
            categories: List of Kitchen Course values to include (e.g., ['Starters', 'Mains', 'Desserts'])
            limit: Max items per category (default 10)
            excluded_categories: List of ScreenMenuCategory names to exclude from results

        Returns:
            Dict mapping Kitchen Course to list of items with:
            - item_name: str
            - qty: int
            - revenue: Decimal
        """
        if not categories:
            return {}

        # Build placeholders for categories
        cat_placeholders = ','.join(['?' for _ in categories])

        # Build exclusion filter for MenuItems.GroupCode if provided
        exclusion_filter = ""
        exclusion_params = []
        if excluded_categories:
            # Filter out items where GroupCode matches excluded groups
            excl_placeholders = ','.join(['?' for _ in excluded_categories])
            exclusion_filter = f"AND (mi.GroupCode IS NULL OR mi.GroupCode NOT IN ({excl_placeholders}))"
            exclusion_params = excluded_categories

        # Query using Kitchen Course tag from MenuItems.CustomTags JSON
        # CustomTags format: [{"TN":"Kitchen Course","TV":"Starters"},...]
        # Using CROSS APPLY to safely calculate positions before SUBSTRING
        query = f"""
            SELECT
                KitchenCourse as Category,
                MenuItemName,
                SUM(CAST(Quantity AS DECIMAL(18,2))) as TotalQty,
                SUM(Price * Quantity) as TotalRevenue
            FROM (
                SELECT
                    o.MenuItemName,
                    o.Quantity,
                    o.Price,
                    CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(mi.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as KitchenCourse
                FROM Orders o
                JOIN Tickets t ON o.TicketId = t.Id
                JOIN MenuItems mi ON o.MenuItemId = mi.Id
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"Kitchen Course"', mi.CustomTags) as tn_pos
                ) tn
                CROSS APPLY (
                    SELECT CASE WHEN tn.tn_pos > 0
                                THEN CHARINDEX('"TV":"', mi.CustomTags, tn.tn_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', mi.CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                WHERE t.Date >= CAST(? AS DATE) AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
                  AND t.IsClosed = 1
                  AND mi.CustomTags LIKE '%"TN":"Kitchen Course"%'
                  AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Void"%')
                  AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Canceled"%')
                  {exclusion_filter}
            ) OrdersWithCourse
            WHERE KitchenCourse IN ({cat_placeholders})
            GROUP BY KitchenCourse, MenuItemName
            ORDER BY KitchenCourse, TotalQty DESC
        """

        # Parameters: from_date, to_date, excluded categories, then Kitchen Course categories
        params = [from_date.isoformat(), to_date.isoformat()] + exclusion_params + categories

        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query, params)
                    rows = await cursor.fetchall()

                    # Group results by category
                    results: dict[str, list[dict]] = {cat: [] for cat in categories}

                    for row in rows:
                        category = row[0]
                        if category in results and len(results[category]) < limit:
                            results[category].append({
                                "item_name": row[1],
                                "qty": int(row[2]) if row[2] else 0,
                                "revenue": Decimal(str(row[3])) if row[3] else Decimal("0")
                            })

                    logger.info(f"SambaPOS top sellers: fetched {len(rows)} rows for {len(categories)} Kitchen Course categories")
                    return results

        except Exception as e:
            logger.error(f"Failed to fetch SambaPOS top sellers: {e}")
            raise

    async def get_top_sellers_by_revenue(
        self,
        from_date: date,
        to_date: date,
        categories: list[str],
        limit: int = 10,
        excluded_categories: list[str] | None = None
    ) -> dict[str, list[dict]]:
        """
        Get top sellers grouped by Kitchen Course tag, sorted by revenue.

        Args:
            from_date: Start date for the query (inclusive)
            to_date: End date for the query (inclusive)
            categories: List of Kitchen Course values to include
            limit: Max items per category (default 10)
            excluded_categories: List of MenuItems.GroupCode values to exclude from results

        Returns:
            Dict mapping Kitchen Course to list of items with:
            - item_name: str
            - qty: int
            - revenue: Decimal
        """
        if not categories:
            return {}

        # Build placeholders for categories
        cat_placeholders = ','.join(['?' for _ in categories])

        # Build exclusion filter for MenuItems.GroupCode if provided
        exclusion_filter = ""
        exclusion_params = []
        if excluded_categories:
            excl_placeholders = ','.join(['?' for _ in excluded_categories])
            exclusion_filter = f"AND (mi.GroupCode IS NULL OR mi.GroupCode NOT IN ({excl_placeholders}))"
            exclusion_params = excluded_categories

        # Query using Kitchen Course tag from MenuItems.CustomTags JSON
        # CustomTags format: [{"TN":"Kitchen Course","TV":"Starters"},...]
        # Using CROSS APPLY to safely calculate positions before SUBSTRING
        query = f"""
            SELECT
                KitchenCourse as Category,
                MenuItemName,
                SUM(CAST(Quantity AS DECIMAL(18,2))) as TotalQty,
                SUM(Price * Quantity) as TotalRevenue
            FROM (
                SELECT
                    o.MenuItemName,
                    o.Quantity,
                    o.Price,
                    CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(mi.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as KitchenCourse
                FROM Orders o
                JOIN Tickets t ON o.TicketId = t.Id
                JOIN MenuItems mi ON o.MenuItemId = mi.Id
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"Kitchen Course"', mi.CustomTags) as tn_pos
                ) tn
                CROSS APPLY (
                    SELECT CASE WHEN tn.tn_pos > 0
                                THEN CHARINDEX('"TV":"', mi.CustomTags, tn.tn_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', mi.CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                WHERE t.Date >= CAST(? AS DATE) AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
                  AND t.IsClosed = 1
                  AND mi.CustomTags LIKE '%"TN":"Kitchen Course"%'
                  AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Void"%')
                  AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Canceled"%')
                  {exclusion_filter}
            ) OrdersWithCourse
            WHERE KitchenCourse IN ({cat_placeholders})
            GROUP BY KitchenCourse, MenuItemName
            ORDER BY KitchenCourse, TotalRevenue DESC
        """

        # Parameters: from_date, to_date, excluded categories, then Kitchen Course categories
        params = [from_date.isoformat(), to_date.isoformat()] + exclusion_params + categories

        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query, params)
                    rows = await cursor.fetchall()

                    # Group results by category
                    results: dict[str, list[dict]] = {cat: [] for cat in categories}

                    for row in rows:
                        category = row[0]
                        if category in results and len(results[category]) < limit:
                            results[category].append({
                                "item_name": row[1],
                                "qty": int(row[2]) if row[2] else 0,
                                "revenue": Decimal(str(row[3])) if row[3] else Decimal("0")
                            })

                    return results

        except Exception as e:
            logger.error(f"Failed to fetch SambaPOS top sellers by revenue: {e}")
            raise

    async def get_menu_group_codes(self) -> list[dict]:
        """
        Fetch all distinct GroupCode values from MenuItems table.

        GroupCode is used for categorizing menu items (e.g., 'Drinks', 'Extras').
        Used for excluding entire groups from top sellers reports.

        Returns:
            List of dicts with 'name' for each group code
        """
        query = """
            SELECT DISTINCT GroupCode
            FROM MenuItems
            WHERE GroupCode IS NOT NULL AND GroupCode != ''
            ORDER BY GroupCode
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query)
                    rows = await cursor.fetchall()
                    result = [{"name": row[0].strip()} for row in rows]
                    logger.info(f"Found {len(result)} MenuItems GroupCodes: {[r['name'] for r in result]}")
                    return result
        except Exception as e:
            logger.error(f"Failed to fetch MenuItems GroupCodes: {e}")
            raise

    async def get_gl_codes(self) -> list[dict]:
        """
        Fetch all unique GL codes from NewBook GLA custom tags.

        NewBook GLA format in CustomTags: [{"TN":"NewBook GLA","TV":"3101"},...]

        Returns:
            List of dicts with 'code' for each unique GL code (sorted)
        """
        query = """
            SELECT DISTINCT
                GLACode
            FROM (
                SELECT
                    CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as GLACode
                FROM MenuItems
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"NewBook GLA"', CustomTags) as gla_pos
                ) gla
                CROSS APPLY (
                    SELECT CASE WHEN gla.gla_pos > 0
                                THEN CHARINDEX('"TV":"', CustomTags, gla.gla_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                WHERE CustomTags LIKE '%"TN":"NewBook GLA"%'
            ) sub
            WHERE GLACode IS NOT NULL AND GLACode != ''
            ORDER BY GLACode
        """
        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    await cursor.execute(query)
                    rows = await cursor.fetchall()
                    result = [{"code": row[0].strip()} for row in rows if row[0] and row[0].strip()]
                    logger.info(f"Found {len(result)} unique GL codes from ProductTag: {[r['code'] for r in result][:10]}...")
                    return result
        except Exception as e:
            logger.error(f"Failed to fetch GL codes from ProductTag: {e}")
            raise

    async def get_restaurant_spend(
        self,
        from_date: date,
        to_date: date,
        tracked_categories: list[str],
        food_gl_codes: list[str],
        beverage_gl_codes: list[str]
    ) -> list[dict]:
        """
        Get restaurant spend data for Resos booking matching (Phase 8).

        Filters tickets to restaurant tables with tracked course items,
        extracts GL codes from NewBook GLA custom tags, and splits spend
        by food/beverage categories.

        Args:
            from_date: Start date (inclusive)
            to_date: End date (inclusive)
            tracked_categories: Kitchen Course values to include (e.g., ['Starters', 'Mains'])
            food_gl_codes: GL codes for food items (e.g., ['3101'])
            beverage_gl_codes: GL codes for beverage items (e.g., ['2101', '2102'])

        Returns:
            List of ticket data dicts with:
            - ticket_id: int
            - ticket_date: date
            - ticket_time: time
            - table_name: str (for fallback matching)
            - ticket_tag: str | None (for primary matching - "BOOKING_ID - Name")
            - booking_id: str | None (extracted from ticket_tag)
            - food_total: Decimal
            - beverage_total: Decimal
            - total_spend: Decimal
            - service_period: str | None (based on timestamp)
        """
        if not tracked_categories:
            logger.warning("get_restaurant_spend called with empty tracked_categories")
            return []

        # Build placeholders for categories
        cat_placeholders = ','.join(['?' for _ in tracked_categories])

        # Build GL code IN clauses
        food_gl_placeholders = ','.join(['?' for _ in food_gl_codes]) if food_gl_codes else "''"
        beverage_gl_placeholders = ','.join(['?' for _ in beverage_gl_codes]) if beverage_gl_codes else "''"

        # Query tickets with table entities and tracked course items
        # Calculate food and beverage spend separately based on GL codes
        query = f"""
            WITH FoodSpend AS (
                SELECT
                    t.Id,
                    SUM(o.Price * o.Quantity) as FoodTotal
                FROM Orders o
                INNER JOIN Tickets t ON o.TicketId = t.Id
                INNER JOIN MenuItems mi ON o.MenuItemId = mi.Id
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"NewBook GLA"', mi.CustomTags) as gla_pos
                ) gla
                CROSS APPLY (
                    SELECT CASE WHEN gla.gla_pos > 0
                                THEN CHARINDEX('"TV":"', mi.CustomTags, gla.gla_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', mi.CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                CROSS APPLY (
                    SELECT CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(mi.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as GLACode
                ) tag
                WHERE t.Date >= CAST(? AS DATE)
                AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
                AND t.IsClosed = 1
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Void"%')
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Canceled"%')
                AND tag.GLACode IN ({food_gl_placeholders})
                GROUP BY t.Id
            ),
            BeverageSpend AS (
                SELECT
                    t.Id,
                    SUM(o.Price * o.Quantity) as BeverageTotal
                FROM Orders o
                INNER JOIN Tickets t ON o.TicketId = t.Id
                INNER JOIN MenuItems mi ON o.MenuItemId = mi.Id
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"NewBook GLA"', mi.CustomTags) as gla_pos
                ) gla
                CROSS APPLY (
                    SELECT CASE WHEN gla.gla_pos > 0
                                THEN CHARINDEX('"TV":"', mi.CustomTags, gla.gla_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', mi.CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                CROSS APPLY (
                    SELECT CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(mi.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as GLACode
                ) tag
                WHERE t.Date >= CAST(? AS DATE)
                AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
                AND t.IsClosed = 1
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Void"%')
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Canceled"%')
                AND tag.GLACode IN ({beverage_gl_placeholders})
                GROUP BY t.Id
            ),
            MainCourseCount AS (
                SELECT
                    t.Id,
                    COUNT(o.Id) as MainCourseCount
                FROM Orders o
                INNER JOIN Tickets t ON o.TicketId = t.Id
                INNER JOIN MenuItems mi ON o.MenuItemId = mi.Id
                CROSS APPLY (
                    SELECT CHARINDEX('"TN":"Kitchen Course"', mi.CustomTags) as kc_pos
                ) kc
                CROSS APPLY (
                    SELECT CASE WHEN kc.kc_pos > 0
                                THEN CHARINDEX('"TV":"', mi.CustomTags, kc.kc_pos) + 6
                                ELSE 0 END as tv_start
                ) tv
                CROSS APPLY (
                    SELECT CASE WHEN tv.tv_start > 6
                                THEN CHARINDEX('"', mi.CustomTags, tv.tv_start)
                                ELSE 0 END as tv_end
                ) pos
                CROSS APPLY (
                    SELECT CASE
                        WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                        THEN SUBSTRING(mi.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                        ELSE NULL
                    END as KitchenCourse
                ) course
                WHERE t.Date >= CAST(? AS DATE)
                AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
                AND t.IsClosed = 1
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Void"%')
                AND (o.OrderStates IS NULL OR o.OrderStates NOT LIKE '%"S":"Canceled"%')
                AND course.KitchenCourse IN ({cat_placeholders})
                GROUP BY t.Id
            )
            SELECT DISTINCT
                t.Id as TicketId,
                t.Date as TicketDate,
                t.Date as TicketDateTime,
                t.TicketTags as TicketTags,

                -- Extract table name from TicketEntities
                (
                    SELECT TOP 1 EntityName
                    FROM TicketEntities te
                    WHERE te.Ticket_Id = t.Id
                    AND te.EntityTypeId = 2
                ) as TableName,

                -- Check if ticket has a Room entity (EntityTypeId = 3)
                -- If this returns a value, the customer selected their room = they're a resident
                (
                    SELECT TOP 1 EntityName
                    FROM TicketEntities te
                    WHERE te.Ticket_Id = t.Id
                    AND te.EntityTypeId = 3
                ) as RoomEntity,

                -- Food and beverage spend from GL codes
                ISNULL(fs.FoodTotal, 0) as FoodTotal,
                ISNULL(bs.BeverageTotal, 0) as BeverageTotal,

                -- Main course count for fallback cover estimation
                ISNULL(mcc.MainCourseCount, 0) as MainCourseCount

            FROM Tickets t
            LEFT JOIN FoodSpend fs ON fs.Id = t.Id
            LEFT JOIN BeverageSpend bs ON bs.Id = t.Id
            LEFT JOIN MainCourseCount mcc ON mcc.Id = t.Id
            WHERE t.Date >= CAST(? AS DATE)
              AND t.Date < DATEADD(day, 1, CAST(? AS DATE))
              AND t.IsClosed = 1
              -- Must have table entity
              AND EXISTS (
                  SELECT 1 FROM TicketEntities te
                  WHERE te.Ticket_Id = t.Id AND te.EntityTypeId = 2
              )
              -- Must have at least one tracked course item
              AND EXISTS (
                  SELECT 1
                  FROM Orders ord
                  JOIN Tickets tck ON ord.TicketId = tck.Id
                  JOIN MenuItems mi2 ON ord.MenuItemId = mi2.Id
                  CROSS APPLY (
                      SELECT CHARINDEX('"TN":"Kitchen Course"', mi2.CustomTags) as kc_pos
                  ) kc
                  CROSS APPLY (
                      SELECT CASE WHEN kc.kc_pos > 0
                                  THEN CHARINDEX('"TV":"', mi2.CustomTags, kc.kc_pos) + 6
                                  ELSE 0 END as tv_start
                  ) tv
                  CROSS APPLY (
                      SELECT CASE WHEN tv.tv_start > 6
                                  THEN CHARINDEX('"', mi2.CustomTags, tv.tv_start)
                                  ELSE 0 END as tv_end
                  ) pos
                  CROSS APPLY (
                      SELECT CASE
                          WHEN tv.tv_start > 0 AND pos.tv_end > tv.tv_start
                          THEN SUBSTRING(mi2.CustomTags, tv.tv_start, pos.tv_end - tv.tv_start)
                          ELSE NULL
                      END as KitchenCourse
                  ) course
                  WHERE tck.Id = t.Id
                  AND course.KitchenCourse IN ({cat_placeholders})
                  AND (ord.OrderStates IS NULL OR ord.OrderStates NOT LIKE '%"S":"Void"%')
                  AND (ord.OrderStates IS NULL OR ord.OrderStates NOT LIKE '%"S":"Canceled"%')
              )
            ORDER BY t.Date
        """

        # Build params:
        # - FoodSpend CTE: from_date, to_date, food_gl_codes (if any)
        # - BeverageSpend CTE: from_date, to_date, beverage_gl_codes (if any)
        # - MainCourseCount CTE: from_date, to_date, tracked_categories
        # - Main query: from_date, to_date, tracked_categories
        params = [
            from_date.isoformat(),  # FoodSpend CTE from_date
            to_date.isoformat(),    # FoodSpend CTE to_date
        ]
        if food_gl_codes:
            params.extend(food_gl_codes)  # FoodSpend CTE GL codes

        params.extend([
            from_date.isoformat(),  # BeverageSpend CTE from_date
            to_date.isoformat(),    # BeverageSpend CTE to_date
        ])
        if beverage_gl_codes:
            params.extend(beverage_gl_codes)  # BeverageSpend CTE GL codes

        params.extend([
            from_date.isoformat(),  # MainCourseCount CTE from_date
            to_date.isoformat(),    # MainCourseCount CTE to_date
        ])
        params.extend(tracked_categories)  # MainCourseCount CTE Kitchen Course categories

        params.extend([
            from_date.isoformat(),  # Main query from_date
            to_date.isoformat()     # Main query to_date
        ])
        params.extend(tracked_categories)  # Main query Kitchen Course categories

        try:
            async with aioodbc.connect(dsn=self.connection_string) as conn:
                async with conn.cursor() as cursor:
                    # Log the query for debugging
                    logger.info(f"Executing restaurant spend query with {len(params)} parameters")
                    logger.info(f"Params: {params}")
                    logger.info(f"Query:\n{query}")
                    await cursor.execute(query, params)
                    rows = await cursor.fetchall()

                    results = []
                    for row in rows:
                        ticket_id = row[0]
                        ticket_date = row[1]
                        ticket_datetime = row[2]
                        ticket_tags = row[3] if row[3] else ""
                        table_name = row[4]
                        room_entity = row[5]  # Room entity name if customer selected their room
                        food_total = Decimal(str(row[6])) if row[6] else Decimal("0")
                        beverage_total = Decimal(str(row[7])) if row[7] else Decimal("0")
                        main_course_count = int(row[8]) if row[8] else 0
                        total_spend = food_total + beverage_total

                        # Extract booking ID from ticket tags
                        # Tag format: "BOOKING_ID - Guest Name" or similar
                        booking_id = None
                        # Placeholder for future implementation:
                        # if " - " in ticket_tags:
                        #     booking_id = ticket_tags.split(" - ")[0].strip()

                        # Parse "Covers" from ticket tags (JSON array format)
                        # Tags format: [{"TN":"Tag Name","TV":"Tag Value"}, ...]
                        covers = 0
                        if ticket_tags:
                            import json
                            try:
                                tags_list = json.loads(ticket_tags)
                                for tag in tags_list:
                                    if tag.get('TN') == 'Covers':
                                        covers = int(tag.get('TV', 0))
                                        break
                            except (json.JSONDecodeError, ValueError, KeyError):
                                pass

                        # Fallback to main course count if covers tag is 0 or not found
                        if covers == 0 and main_course_count > 0:
                            covers = main_course_count

                        # Extract time from datetime for service period matching
                        ticket_time = ticket_datetime.time() if ticket_datetime else None

                        results.append({
                            "ticket_id": ticket_id,
                            "ticket_date": ticket_date,
                            "ticket_time": ticket_time,
                            "ticket_datetime": ticket_datetime,
                            "table_name": table_name,
                            "room_entity": room_entity,
                            "has_room_entity": bool(room_entity),
                            "ticket_tag": ticket_tags if ticket_tags else None,
                            "booking_id": booking_id,
                            "food_total": food_total,
                            "beverage_total": beverage_total,
                            "total_spend": total_spend,
                            "estimated_covers": covers,  # NEW: Estimated covers from tags or main course count
                            "main_course_count": main_course_count  # NEW: For debugging/validation
                        })

                    logger.info(f"SambaPOS restaurant spend: fetched {len(results)} tickets with table entities")
                    return results

        except Exception as e:
            logger.error(f"Failed to fetch SambaPOS restaurant spend: {e}")
            raise
