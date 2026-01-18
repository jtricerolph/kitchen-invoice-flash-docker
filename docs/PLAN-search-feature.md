# Search Feature Implementation Plan

## Overview
Add a new "Search" main menu dropdown with three search pages:
1. **Invoices Search** - Search/filter invoices (optionally including line item content)
2. **Line Items Search** - Consolidated unique line items with price change detection
3. **Unit/Portion Definitions Search** - Search ProductDefinition records

**Plus**: Reusable price history system with:
- Price change detection on new invoices
- Acknowledgement system to mark price changes as reviewed
- History modal with graphs for any line item

All pages share common patterns: live search, session persistence, date filtering, grouping, and links to source records.

---

## Data Models

### Existing Models

**Invoice**: `id`, `invoice_number`, `invoice_date`, `total`, `net_total`, `supplier_id`, `vendor_name`, `status`, `category`, `document_type`

**LineItem**: `id`, `invoice_id`, `product_code`, `description`, `unit`, `quantity`, `unit_price`, `amount`, `pack_quantity`, `unit_size`, `unit_size_type`, `portions_per_unit`

**ProductDefinition**: `id`, `kitchen_id`, `supplier_id`, `product_code`, `description_pattern`, `pack_quantity`, `unit_size`, `unit_size_type`, `portions_per_unit`, `portion_description`, `source_invoice_id`, `updated_at`

### New Model: AcknowledgedPrice
**File**: `backend/models/acknowledged_price.py` (NEW)

Tracks when a user acknowledges a price change so it doesn't keep flagging.

```python
class AcknowledgedPrice(Base):
    __tablename__ = "acknowledged_prices"

    id: Mapped[int] = mapped_column(primary_key=True)
    kitchen_id: Mapped[int] = mapped_column(ForeignKey("kitchens.id"))
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"))

    # Product identification (same logic as line item consolidation)
    product_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # The acknowledged price point
    acknowledged_price: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    acknowledged_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    acknowledged_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    # Which invoice triggered this acknowledgement
    source_invoice_id: Mapped[int | None] = mapped_column(ForeignKey("invoices.id"))
    source_line_item_id: Mapped[int | None] = mapped_column(ForeignKey("line_items.id"))

    # Unique: one acknowledged price per product per supplier per kitchen
    __table_args__ = (
        UniqueConstraint('kitchen_id', 'supplier_id', 'product_code', 'description',
                        name='uix_acknowledged_price'),
    )
```

### New Settings Fields
**File**: `backend/models/settings.py`

```python
# Price change detection settings
price_change_lookback_days: Mapped[int] = mapped_column(Integer, default=30)
price_change_amber_threshold: Mapped[int] = mapped_column(Integer, default=10)  # %
price_change_red_threshold: Mapped[int] = mapped_column(Integer, default=20)    # %
```

---

## Backend Changes

### 1. New Search API Router
**File**: `backend/api/search.py` (NEW)

```python
router = APIRouter(prefix="/api/search", tags=["search"])

# ============ Invoice Search ============
@router.get("/invoices")
async def search_invoices(
    q: str = "",                    # Search term (invoice_number, vendor_name)
    include_line_items: bool = False,  # Also search line item product_code/description
    supplier_id: int | None = None,
    status: str | None = None,
    date_from: date | None = None,  # Default: 30 days ago
    date_to: date | None = None,    # Default: today
    group_by: str | None = None,    # "supplier", "month", or null
    limit: int = 100,
    offset: int = 0
) -> InvoiceSearchResponse

# ============ Line Items Search (Consolidated) ============
@router.get("/line-items")
async def search_line_items(
    q: str = "",                    # Search term (product_code, description)
    supplier_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    group_by: str | None = None,    # "supplier", "invoice", "month"
    limit: int = 100,
    offset: int = 0
) -> LineItemSearchResponse
# Returns DISTINCT line items by (product_code OR description + supplier)
# With: most_recent_price, price_change_status, total_qty, occurrence_count

# ============ Unit/Portion Definitions Search ============
@router.get("/definitions")
async def search_definitions(
    q: str = "",                    # Search term (product_code, description_pattern)
    supplier_id: int | None = None,
    has_portions: bool | None = None,  # Filter by portions_per_unit is set
    limit: int = 100,
    offset: int = 0
) -> DefinitionSearchResponse

# ============ Line Item History (Reusable) ============
@router.get("/line-items/history")
async def get_line_item_history(
    product_code: str | None = None,
    description: str | None = None,
    supplier_id: int,
    date_from: date | None = None,  # Default: 12 months ago
    date_to: date | None = None,
) -> LineItemHistoryResponse
# Returns price history, qty stats for a specific product

# ============ Price Acknowledgement ============
@router.post("/line-items/acknowledge-price")
async def acknowledge_price_change(
    product_code: str | None,
    description: str | None,
    supplier_id: int,
    new_price: Decimal,
    source_invoice_id: int | None = None,
    source_line_item_id: int | None = None,
) -> AcknowledgePriceResponse
# Creates/updates AcknowledgedPrice record
```

### 2. Price History Service (Reusable)
**File**: `backend/services/price_history.py` (NEW)

```python
class PriceHistoryService:
    """Reusable service for price change detection - used by search AND invoice review"""

    async def get_price_status(
        self,
        db: AsyncSession,
        kitchen_id: int,
        supplier_id: int,
        product_code: str | None,
        description: str | None,
        current_price: Decimal,
        lookback_days: int = 30,
        amber_threshold: int = 10,
        red_threshold: int = 20,
    ) -> PriceStatus:
        """
        Returns price status for a line item:
        - "consistent": Price matches history (green tick)
        - "no_history": First time seeing this item (no icon)
        - "amber": Small price change within threshold
        - "red": Large price change above threshold
        - "acknowledged": Price was flagged but user acknowledged it
        """

    async def get_history(
        self,
        db: AsyncSession,
        kitchen_id: int,
        supplier_id: int,
        product_code: str | None,
        description: str | None,
        date_from: date,
        date_to: date,
    ) -> LineItemHistory:
        """
        Returns full history for a product:
        - price_history: list of {date, price, invoice_id, invoice_number}
        - total_occurrences: int
        - total_quantity: Decimal
        - avg_qty_per_invoice: Decimal
        - avg_qty_per_week: Decimal
        - avg_qty_per_month: Decimal
        """

    async def acknowledge_price(
        self,
        db: AsyncSession,
        kitchen_id: int,
        user_id: int,
        supplier_id: int,
        product_code: str | None,
        description: str | None,
        new_price: Decimal,
        source_invoice_id: int | None,
        source_line_item_id: int | None,
    ) -> AcknowledgedPrice:
        """Creates or updates acknowledged price record"""
```

### 3. Response Models

```python
class InvoiceSearchItem(BaseModel):
    id: int
    invoice_number: str | None
    invoice_date: date | None
    total: Decimal | None
    net_total: Decimal | None
    supplier_id: int | None
    supplier_name: str | None
    vendor_name: str | None
    status: str
    document_type: str | None

class InvoiceSearchResponse(BaseModel):
    items: list[InvoiceSearchItem]
    total_count: int
    grouped_by: str | None
    groups: list[GroupSummary] | None  # If grouped: [{name, count, total}]

class LineItemSearchItem(BaseModel):
    product_code: str | None
    description: str | None
    supplier_id: int | None
    supplier_name: str | None
    unit: str | None
    # Price info
    most_recent_price: Decimal | None      # Latest unit_price
    earliest_price_in_period: Decimal | None
    price_change_percent: float | None     # % change from earliest to most recent
    price_change_status: str               # "consistent", "amber", "red", "no_history"
    # Quantity info
    total_quantity: Decimal | None
    occurrence_count: int
    # Links
    most_recent_invoice_id: int
    most_recent_invoice_number: str | None
    most_recent_date: date | None
    # Definition info
    has_definition: bool
    portions_per_unit: int | None

class LineItemSearchResponse(BaseModel):
    items: list[LineItemSearchItem]
    total_count: int
    grouped_by: str | None
    groups: list[GroupSummary] | None

class DefinitionSearchItem(BaseModel):
    id: int
    product_code: str | None
    description_pattern: str | None
    supplier_id: int | None
    supplier_name: str | None
    pack_quantity: int | None
    unit_size: Decimal | None
    unit_size_type: str | None
    portions_per_unit: int | None
    portion_description: str | None
    source_invoice_id: int | None
    source_invoice_number: str | None
    updated_at: datetime

class DefinitionSearchResponse(BaseModel):
    items: list[DefinitionSearchItem]
    total_count: int

class GroupSummary(BaseModel):
    name: str           # Group name (supplier name, month "Jan 2024", etc.)
    count: int          # Number of items in group
    total: Decimal | None  # Sum of totals if applicable

# ============ History Modal Response ============
class PriceHistoryPoint(BaseModel):
    date: date
    price: Decimal
    invoice_id: int
    invoice_number: str | None

class LineItemHistoryResponse(BaseModel):
    product_code: str | None
    description: str | None
    supplier_name: str | None
    # Price history for chart
    price_history: list[PriceHistoryPoint]
    # Stats for period
    total_occurrences: int
    total_quantity: Decimal
    avg_qty_per_invoice: Decimal
    avg_qty_per_week: Decimal
    avg_qty_per_month: Decimal
    # Current status
    current_price: Decimal | None
    price_change_status: str
```

### 4. Register Router
**File**: `backend/main.py`

```python
from api import search
app.include_router(search.router)
```

### 5. Update Invoice Line Items Response
**File**: `backend/api/invoices.py`

Add price status to line items when fetching invoice details:
```python
# In get_invoice endpoint, for each line item:
price_status = await price_history_service.get_price_status(
    db, kitchen_id, supplier_id, product_code, description, unit_price
)
# Return: price_status ("consistent", "amber", "red", "no_history", "acknowledged")
```

---

## Frontend Changes

### 1. Add Search Dropdown to Navigation
**File**: `frontend/src/App.tsx`

Add "Search" dropdown similar to "Reports" dropdown:

```tsx
// In Header component, add state:
const [searchOpen, setSearchOpen] = useState(false)

// Add showSearch check:
const showSearch = showNavItem('/search-invoices') ||
                   showNavItem('/search-line-items') ||
                   showNavItem('/search-definitions')

// Add dropdown after Invoices link:
{showSearch && (
  <div style={styles.dropdownContainer}
       onMouseEnter={() => setSearchOpen(true)}
       onMouseLeave={() => setSearchOpen(false)}>
    <span style={styles.navLink}>Search ▾</span>
    {searchOpen && (
      <div style={styles.dropdown}>
        {showNavItem('/search-invoices') &&
          <a href="/search/invoices" style={styles.dropdownLink}>Invoices</a>}
        {showNavItem('/search-line-items') &&
          <a href="/search/line-items" style={styles.dropdownLink}>Line Items</a>}
        {showNavItem('/search-definitions') &&
          <a href="/search/definitions" style={styles.dropdownLink}>Unit/Portion Definitions</a>}
      </div>
    )}
  </div>
)}
```

Add routes:
```tsx
<Route path="/search/invoices" element={...} />
<Route path="/search/line-items" element={...} />
<Route path="/search/definitions" element={...} />
```

### 2. Create Search Components

#### 2a. SearchInvoices.tsx (NEW)
**File**: `frontend/src/components/SearchInvoices.tsx`

**Features**:
- Text search input (debounced 300ms for live search)
- **☑ Include line items** checkbox - when enabled, also searches line item product_code/description
- Supplier dropdown filter
- Status dropdown filter
- Date range (default: last 30 days)
- Group by dropdown: None / Supplier / Month
- Session storage persistence for all filters
- Results table with columns: Invoice #, Supplier, Date, Net Total, Status
- Invoice # links to `/invoice/{id}` (opens in new tab)
- When grouped: collapsible sections with group headers showing count/total

**Layout**:
```
┌───────────────────────────────────────────────────────────────────────────┐
│ Search Invoices                                                            │
├───────────────────────────────────────────────────────────────────────────┤
│ [Search input...] [☑ Include line items] [Supplier ▼] [Status ▼] [Group ▼]│
│ From: [____] To: [____]                                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ Invoice #    │ Supplier    │ Date       │ Net Total │ Status              │
│ INV-001 ↗    │ Brakes      │ 15/01/2026 │ £234.50   │ confirmed           │
│ INV-002 ↗    │ Brakes      │ 14/01/2026 │ £156.20   │ confirmed           │
└───────────────────────────────────────────────────────────────────────────┘
```

#### 2b. SearchLineItems.tsx (NEW)
**File**: `frontend/src/components/SearchLineItems.tsx`

**Features**:
- Text search input (debounced 300ms)
- Supplier dropdown filter
- Date range (default: last 30 days)
- Group by dropdown: None / Supplier / Invoice / Month
- Session storage persistence
- Results show consolidated items with:
  - Product Code, Description, Supplier
  - **Most Recent Price** with price change indicator:
    - 🟢 Green tick: Price consistent with history
    - 🟡 Amber ?: Small change (≤ amber threshold %)
    - 🔴 Red !: Large change (> red threshold %)
    - No icon: First time seeing this item
  - **📊 Price History button**: Opens history modal
  - Total Qty with **📦 Qty History button**: Opens history modal
  - # Occurrences
  - Most Recent Invoice # (link to invoice)
  - Portions icon if definition exists

**Consolidation Logic**:
- Group by: `COALESCE(product_code, '') || '||' || COALESCE(description, '') || '||' || supplier_id`
- Show most recent values for each unique item
- Aggregate: SUM(quantity), COUNT(*)
- Compare earliest vs latest price in period for change detection

**Layout**:
```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Search Line Items                                                                │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [Search...] [Supplier ▼] [From] [To] [Group ▼]                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Code    │ Description      │ Supplier │ Price 📊    │ Qty 📦  │ # │ Invoice    │
│ ABC123  │ Chicken Breast   │ Brakes   │ £5.50 🟢    │ 45      │ 8 │ INV-001 ↗  │
│ XYZ789  │ Beef Mince 500g  │ Brakes   │ £6.20 🔴!   │ 30      │ 5 │ INV-003 ↗  │
│ -       │ Mixed Salad Bag  │ Booker   │ £3.20 🟡?   │ 120     │12 │ INV-015 ↗  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 2c. SearchDefinitions.tsx (NEW)
**File**: `frontend/src/components/SearchDefinitions.tsx`

**Features**:
- Text search input (debounced 300ms)
- Supplier dropdown filter
- "Has Portions Defined" checkbox filter
- Session storage persistence
- Results show:
  - Product Code, Description Pattern, Supplier
  - Pack Info (e.g., "120x15g")
  - Portions per Unit
  - Last Updated, Source Invoice (link)

**Layout**:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Search Unit/Portion Definitions                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ [Search...] [Supplier ▼] [☑ Has Portions Defined]                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ Code    │ Description      │ Supplier │ Pack      │ Portions │ Source       │
│ ABC123  │ Chicken Breast   │ Brakes   │ 4x2.5kg   │ 40       │ INV-001 ↗    │
│ XYZ789  │ Orange Juice 1L  │ Booker   │ 12x1L     │ 48       │ INV-022 ↗    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. Shared Search Utilities
**File**: `frontend/src/utils/searchHelpers.ts` (NEW)

```typescript
// Session storage keys
export const SEARCH_STORAGE_KEYS = {
  invoices: {
    query: 'search-invoices-query',
    includeLineItems: 'search-invoices-include-line-items',
    supplier: 'search-invoices-supplier',
    status: 'search-invoices-status',
    dateFrom: 'search-invoices-from',
    dateTo: 'search-invoices-to',
    groupBy: 'search-invoices-group',
  },
  lineItems: { ... },
  definitions: { ... },
}

// Debounce hook for live search
export function useDebounce<T>(value: T, delay: number): T

// Date helpers
export function getDefaultDateRange(): { from: string, to: string }
export function formatDateForDisplay(date: string): string
```

### 4. Line Item History Modal (Reusable)
**File**: `frontend/src/components/LineItemHistoryModal.tsx` (NEW)

A reusable modal component used by:
- SearchLineItems.tsx (📊 and 📦 buttons)
- Review.tsx (price indicator clicks)

**Props**:
```typescript
interface LineItemHistoryModalProps {
  isOpen: boolean
  onClose: () => void
  productCode: string | null
  description: string | null
  supplierId: number
  supplierName: string
  currentPrice?: Decimal  // For highlighting current price in chart
  onAcknowledge?: (newPrice: Decimal) => void  // Callback when price acknowledged
}
```

**Layout**:
```
┌─────────────────────────────────────────────────────────────────┐
│ Price History: Chicken Breast (ABC123)                      [X] │
│ Supplier: Brakes                                                │
├─────────────────────────────────────────────────────────────────┤
│ Date Range: [From: ____] [To: ____] (default: last 12 months)  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   📈 Price History Chart (Line chart with dates on X axis)      │
│      £6.00 ─────────────────────•                               │
│      £5.50 ────•────────────────┘                               │
│      £5.00 ────┘                                                │
│           Jan   Feb   Mar   Apr   May                           │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Stats for Period:                                               │
│ • Total Occurrences: 12                                        │
│ • Total Quantity: 45                                           │
│ • Avg Qty per Invoice: 3.75                                    │
│ • Avg Qty per Week: 1.2                                        │
│ • Avg Qty per Month: 5.0                                       │
├─────────────────────────────────────────────────────────────────┤
│ Current Price: £6.00 (🔴 +9% from previous £5.50)              │
│                                                                 │
│ [Acknowledge Price Change]  ← Only shown if price flagged      │
└─────────────────────────────────────────────────────────────────┘
```

**Chart Library**: Use `recharts` (lightweight, React-native)

### 5. Invoice Review Price Indicators
**File**: `frontend/src/components/Review.tsx` (MODIFY)

Add price status indicators next to each line item's unit price:

**Per Line Item**:
- Fetch price_status from backend (included in line item response)
- Display icon next to unit_price:
  - 🟢 ✓ (green): Price consistent with history
  - 🟡 ? (amber): Small change ≤ threshold
  - 🔴 ! (red): Large change > threshold
  - No icon: No history (first purchase)
- Clicking icon opens LineItemHistoryModal
- In modal, "Acknowledge Price Change" button updates AcknowledgedPrice record

**Layout Change in Line Items Table**:
```
│ Code    │ Description      │ Qty │ Unit Price      │ Amount │
│ ABC123  │ Chicken Breast   │ 4   │ £5.50 🟢        │ £22.00 │
│ XYZ789  │ Beef Mince 500g  │ 2   │ £6.20 🔴! [📊] │ £12.40 │
                                      ↑ Click to see history
```

### 6. Search Settings Section
**File**: `frontend/src/pages/Settings.tsx` (MODIFY)

Add new "Search Settings" section in Settings page:

```
┌─────────────────────────────────────────────────┐
│ Search Settings                                  │
├─────────────────────────────────────────────────┤
│ Price Change Detection                          │
│                                                 │
│ Lookback Period: [30] days                      │
│ (How far back to compare prices)               │
│                                                 │
│ Amber Threshold: [10] %                         │
│ (Highlight as warning if change ≤ this)        │
│                                                 │
│ Red Threshold: [20] %                           │
│ (Highlight as alert if change > amber)         │
│                                                 │
│ [Save]                                          │
└─────────────────────────────────────────────────┘
```

---

## Files to Create/Modify

| File | Change |
|------|--------|
| **Backend** | |
| `backend/models/acknowledged_price.py` | NEW - AcknowledgedPrice model |
| `backend/models/settings.py` | Add price change threshold settings |
| `backend/services/price_history.py` | NEW - Reusable price history service |
| `backend/api/search.py` | NEW - Search endpoints + history + acknowledge |
| `backend/api/invoices.py` | Add price_status to line items response |
| `backend/main.py` | Register search router, run migration |
| `backend/migrations/add_price_settings.py` | NEW - Migration for new settings + acknowledged_prices table |
| **Frontend** | |
| `frontend/package.json` | Add recharts dependency |
| `frontend/src/App.tsx` | Add Search dropdown + routes |
| `frontend/src/utils/searchHelpers.ts` | NEW - Debounce hook, session storage keys |
| `frontend/src/components/SearchInvoices.tsx` | NEW - Invoice search page |
| `frontend/src/components/SearchLineItems.tsx` | NEW - Line items search with price flags |
| `frontend/src/components/SearchDefinitions.tsx` | NEW - Definitions search page |
| `frontend/src/components/LineItemHistoryModal.tsx` | NEW - Reusable history modal with chart |
| `frontend/src/components/Review.tsx` | Add price status icons to line items |
| `frontend/src/pages/Settings.tsx` | Add Search Settings section + Access Control paths |

---

## Implementation Steps

### Phase 1: Backend Foundation
1. Create `backend/models/acknowledged_price.py`
2. Add price change settings to `backend/models/settings.py`
3. Create migration `backend/migrations/add_price_settings.py`
4. Create `backend/services/price_history.py` service
5. Create `backend/api/search.py` with all endpoints
6. Update `backend/api/invoices.py` to include price_status
7. Register router in `backend/main.py`

### Phase 2: Frontend Search Pages
8. Install recharts: `npm install recharts`
9. Create `frontend/src/utils/searchHelpers.ts`
10. Create `SearchInvoices.tsx`
11. Create `SearchLineItems.tsx`
12. Create `SearchDefinitions.tsx`

### Phase 3: History Modal & Review Integration
13. Create `LineItemHistoryModal.tsx` with chart
14. Update `Review.tsx` with price status icons
15. Add "Search Settings" section to Settings.tsx
16. Add Search access control paths to Settings.tsx
17. Update `App.tsx` with Search dropdown and routes

### Phase 4: Test & Verify
18. Rebuild containers
19. Test all search pages
20. Test price change detection on invoice review
21. Test acknowledgement flow

---

## Access Control Paths

Add to Settings Access Control checkboxes:
- `/search-invoices` - Invoice Search
- `/search-line-items` - Line Items Search
- `/search-definitions` - Unit/Portion Definitions Search

---

## Session Storage Keys

All search state persists during browser session:

**Invoices**:
- `search-invoices-query`, `search-invoices-supplier`, `search-invoices-status`
- `search-invoices-from`, `search-invoices-to`, `search-invoices-group`

**Line Items**:
- `search-line-items-query`, `search-line-items-supplier`
- `search-line-items-from`, `search-line-items-to`, `search-line-items-group`

**Definitions**:
- `search-definitions-query`, `search-definitions-supplier`, `search-definitions-has-portions`

---

## Live Search Implementation

Use debounced input (300ms delay) with react-query:

```typescript
const [searchInput, setSearchInput] = useState('')
const debouncedSearch = useDebounce(searchInput, 300)

const { data, isLoading } = useQuery({
  queryKey: ['search-invoices', debouncedSearch, supplier, status, dateFrom, dateTo, groupBy],
  queryFn: () => fetchSearchResults(...)
})
```

Filter changes trigger immediate re-query (no debounce needed for dropdowns).

---

## Verification

### Search Pages
1. **Navigation**: Search dropdown appears between Invoices and Reports
2. **Invoice Search**:
   - Type in search box, results filter after 300ms
   - "Include line items" checkbox finds invoices by product names
   - Filter by supplier/status works
   - Date range defaults to last 30 days
   - Group by Supplier shows collapsible sections
   - Invoice # links open invoice in new tab
3. **Line Items Search**:
   - Consolidated view shows unique items (not duplicates)
   - Shows most recent price with change indicator (🟢/🟡/🔴)
   - 📊 button opens history modal with price chart
   - 📦 button opens history modal with qty stats
   - Links to most recent invoice
4. **Definitions Search**:
   - Shows all ProductDefinition records
   - "Has Portions" filter works
   - Links to source invoice

### Price Change Detection
5. **Invoice Review Page**:
   - Line items show price status icon next to unit price
   - 🟢 = consistent, 🟡 = small change, 🔴 = large change
   - Clicking icon opens history modal
   - "Acknowledge Price Change" button marks price as reviewed
   - After acknowledgement, icon changes to 🟢 on future invoices

### History Modal
6. **Price History Chart**:
   - Line chart shows price over time
   - Default range: last 12 months
   - Date range picker works
7. **Stats Display**:
   - Total occurrences, total qty
   - Avg qty per invoice/week/month

### Settings
8. **Search Settings Section**:
   - Lookback period (default 30 days)
   - Amber threshold % (default 10%)
   - Red threshold % (default 20%)
   - Changes apply to price detection

### Session Persistence
9. Enter search term, navigate away, come back - search term preserved
10. Close tab, reopen - state cleared (session storage)

### Access Control
11. Restrict search pages via Settings → Access Control
12. Non-admin users don't see restricted search options
