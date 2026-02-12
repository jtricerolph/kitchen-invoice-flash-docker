# Purchase Order System

## Context
Users want to pre-allocate budget for known upcoming orders on the Spend Budget page. Clicking on a budget table cell (supplier × date) opens a PO creation modal. POs appear on the budget table in blue/italic (distinct from green invoices). When a real invoice arrives, it can be linked to the PO, which replaces the PO value in the budget. This gives visibility into planned spend before invoices arrive.

## Phased Plan

### Phase 1: Core PO System (DB, API, Modal, Budget Integration, List Page)
### Phase 2: Supplier & Kitchen Settings (order_email, account_number, kitchen details)
### Phase 3: Preview & Email (print view, Save & Email using existing SMTP)
### Phase 4: Invoice Matching (auto-suggest, banner, linking)

---

## Phase 1: Core PO System

### 1.1 Database Tables

**`purchase_orders`** table:
```sql
CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    order_date DATE NOT NULL,                    -- budget date this PO sits on
    order_type VARCHAR(20) NOT NULL,             -- 'itemised' or 'single_value'
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- DRAFT, PENDING, LINKED, CLOSED, CANCELLED
    total_amount NUMERIC(12,2),                  -- for single_value orders
    order_reference VARCHAR(200),                -- external order number
    notes TEXT,
    attachment_path VARCHAR(500),                -- uploaded photo/file
    attachment_original_name VARCHAR(255),
    linked_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_kitchen_date ON purchase_orders(kitchen_id, order_date);
CREATE INDEX IF NOT EXISTS idx_po_kitchen_supplier ON purchase_orders(kitchen_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_kitchen_status ON purchase_orders(kitchen_id, status);
```

**`purchase_order_line_items`** table:
```sql
CREATE TABLE IF NOT EXISTS purchase_order_line_items (
    id SERIAL PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id),
    product_id INTEGER,                       -- nullable for manual entries
    product_code VARCHAR(100),
    description VARCHAR(500) NOT NULL,
    unit VARCHAR(50),
    unit_price NUMERIC(12,4) NOT NULL,
    quantity NUMERIC(10,3) NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    line_number INTEGER DEFAULT 0,
    source VARCHAR(20) DEFAULT 'manual',      -- 'search' or 'manual'
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 1.2 Files to Create

| File | Purpose |
|------|---------|
| `backend/models/purchase_order.py` | SQLAlchemy models: PurchaseOrder + PurchaseOrderLineItem |
| `backend/migrations/add_purchase_orders.py` | Migration creating both tables + indexes |
| `backend/api/purchase_orders.py` | Full CRUD API router |
| `frontend/src/components/PurchaseOrderModal.tsx` | Create/edit PO modal |
| `frontend/src/components/PurchaseOrderList.tsx` | PO list page with filters |

### 1.3 Files to Modify

| File | Changes |
|------|---------|
| `backend/models/__init__.py` | Import + register PurchaseOrder, PurchaseOrderLineItem |
| `backend/models/supplier.py` | Add `purchase_orders` relationship |
| `backend/main.py` | Register router + migration |
| `backend/api/budget.py` | Include POs in SupplierBudgetRow, add `purchase_orders_by_date` |
| `frontend/src/App.tsx` | Add route `/purchase-orders` + nav item in Invoices dropdown |
| `frontend/src/components/Budget.tsx` | Render POs in cells, add cell click → PO modal, PO styles |

### 1.4 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/purchase-orders/` | Create PO (with line items) |
| `GET` | `/api/purchase-orders/` | List POs (query: status, supplier_id, date_from, date_to, limit, offset) |
| `GET` | `/api/purchase-orders/{po_id}` | Get PO detail with line items |
| `PUT` | `/api/purchase-orders/{po_id}` | Update PO (full replacement of line items) |
| `DELETE` | `/api/purchase-orders/{po_id}` | Delete PO (only DRAFT/CANCELLED) |
| `PUT` | `/api/purchase-orders/{po_id}/status` | Update status only (close, cancel) |
| `POST` | `/api/purchase-orders/{po_id}/attachment` | Upload attachment (multipart) |
| `DELETE` | `/api/purchase-orders/{po_id}/attachment` | Remove attachment |
| `GET` | `/api/purchase-orders/products/search` | Search products filtered by supplier_id |
| `GET` | `/api/purchase-orders/by-date` | POs for budget table (week_start, week_end) → `{supplier_id: {date: [PO]}}` |

### 1.5 PO Modal Structure (PurchaseOrderModal.tsx)

Follows WastageLogbook `CreateEntryModal` pattern (same modal overlay, header, CSS-in-JS):

```
┌──────────────────────────────────────────────────┐
│ Purchase Order                          [× Close]│
├──────────────────────────────────────────────────┤
│ Date: [2026-02-12]  │ Notes: [optional textarea] │
│ Supplier: [name ▾]  │                             │
├──────────────────────────────────────────────────┤
│ [Itemised Order] | [Single Value]    ← tab btns  │
├──────────────────────────────────────────────────┤
│ IF Itemised:                                     │
│  Line Items (3)                                  │
│  ┌──────────────┬───────┬─────┬────────┬──┐      │
│  │ Product      │ Price │ Qty │ Total  │ ×│      │
│  ├──────────────┼───────┼─────┼────────┼──┤      │
│  │ Chicken 1kg  │ 5.50  │ 10  │ 55.00  │ ×│      │
│  │ [manual]     │ [inp] │[inp]│ [calc] │ ×│      │
│  └──────────────┴───────┴─────┴────────┴──┘      │
│  [+ Add Manual Item]                             │
│                                                  │
│  Search Products (filtered to supplier):         │
│  [🔍 Search by name or code...]                  │
│  ┌──────┬────────────┬──────┬───────┬─────┐      │
│  │ Code │ Product    │ Unit │ Price │ Add │      │
│  └──────┴────────────┴──────┴───────┴─────┘      │
│                                                  │
│ IF Single Value:                                 │
│  Order Value: [£ ___.__]                         │
│  Order Ref:   [optional]                         │
│  Attachment:  [Upload] or [preview / remove]     │
│                                                  │
│ Total: £XX.XX                                    │
├──────────────────────────────────────────────────┤
│              [Cancel] [Save Draft] [Save & Submit]│
└──────────────────────────────────────────────────┘
```

Key behaviors:
- Opened from budget cell click: supplier_id + order_date pre-populated
- Opened from PO list or budget PO button: loads existing PO for editing
- Product search filtered by supplier via `/api/purchase-orders/products/search?query=X&supplier_id=Y`
- Unit Price column before Qty (as requested)
- Auto-calc: `total = unit_price × quantity`
- Search result items show product_code when defined
- File upload via FormData to `/api/purchase-orders/{id}/attachment`

### 1.6 Budget Table Integration

**Backend** (`budget.py`): Add to `get_weekly_budget()`:
- Query `purchase_orders` where kitchen_id matches, status IN ('DRAFT','PENDING'), order_date in week range
- Group by supplier_id + order_date
- Add `purchase_orders_by_date` field to `SupplierBudgetRow`
- PO totals are shown visually but **not** added to `actual_spent` (they're planned, not actual)
- Ensure suppliers with POs but no invoices still appear in the table

**Frontend** (`Budget.tsx`): In the supplier row cell rendering (lines 952-981):
- After rendering invoices, also render POs from `supplier.purchase_orders_by_date[d]`
- PO buttons styled differently: blue text, dashed border, italic, "PO" suffix
- Empty future cells become clickable → open PO modal with that supplier+date
- Clicking existing PO button → open PO modal in edit mode

**PO button style** (distinct from invoiceBtn):
```typescript
poBtn: {
    padding: '0.25rem 0.5rem',
    background: '#e3f2fd',
    border: '1px dashed #42a5f5',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontStyle: 'italic',
    color: '#1565c0',
    whiteSpace: 'nowrap',
}
```

**Invoice buttons changed to green** (user requested invoices = green, POs = blue):
```typescript
invoiceBtn: {
    ...existing,
    background: '#d4edda',  // was #e3f2fd (blue)
    border: '1px solid #28a745',  // was #90caf9
    color: '#155724',
}
```

### 1.6b Budget Table Columns Update

Current columns: Supplier | days... | Budget | Spent | Remaining | Status

New columns: Supplier | days... | Budget | Spent | **Ordered** | Remaining | Status

- **Spent** = actual invoices only (unchanged)
- **Ordered** (NEW) = sum of pending PO totals (DRAFT + PENDING) for this supplier this week
- **Remaining** = Budget − Spent − **Ordered** (POs count as committed spend)
- Remove "OVER" text label from remaining column — red negative value is clear enough
- Status badge logic unchanged (uses remaining value which now factors in POs)

Backend `SupplierBudgetRow` additions:
```python
po_ordered: Decimal  # sum of PO totals for this supplier this week (DRAFT + PENDING)
# remaining recalculated: allocated_budget - actual_spent - po_ordered
```

### 1.7 PO List Page (PurchaseOrderList.tsx)

Route: `/purchase-orders` (added to Invoices dropdown after "Disputes")

Layout similar to Disputes.tsx:
- Header: "Purchase Orders" + [+ New PO] button
- Filter bar: Status tabs (All | Draft | Pending | Linked | Closed), Supplier dropdown, Date range
- Default filter: Draft + Pending (open POs)
- Table: Date | Supplier | Type | Reference | Total | Status | Created
- Status badges: DRAFT=grey, PENDING=blue, LINKED=green, CLOSED=dark grey, CANCELLED=red
- Row click → open PO in edit modal

### 1.8 Verification (Phase 1)

1. Click empty future cell on budget table → PO modal opens with correct supplier+date
2. Create itemised PO with search items + manual items → appears on budget table in blue/italic/dashed
3. Create single-value PO with attachment → appears correctly
4. Click PO on budget table → edit modal opens with all data
5. PO list page shows all POs with working status filters
6. Edit PO, change line items → total recalculates
7. Delete PO (DRAFT only) → disappears from budget + list
8. Close PO → status changes, no longer on budget table, removed from "Ordered"
9. "Ordered" column shows PO totals; "Remaining" = Budget − Spent − Ordered
10. Invoice buttons now green, PO buttons blue/dashed/italic
11. No "OVER" text on remaining column — red negative value is sufficient

---

## Phase 2: Supplier & Kitchen Settings

### 2.1 Supplier Model Additions

Add to `backend/models/supplier.py`:
```python
order_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
account_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
```

**Migration**: `backend/migrations/add_supplier_po_fields.py`
- `ALTER TABLE suppliers ADD COLUMN order_email VARCHAR(255)`
- `ALTER TABLE suppliers ADD COLUMN account_number VARCHAR(100)`

**Modify**: `backend/api/suppliers.py` - add fields to create/update schemas
**Modify**: `frontend/src/components/Suppliers.tsx` - add form fields for order_email + account_number

### 2.2 Kitchen Details Settings Tab

Add to `backend/models/settings.py`:
```python
kitchen_display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
kitchen_address_line1: Mapped[str | None] = mapped_column(String(255), nullable=True)
kitchen_address_line2: Mapped[str | None] = mapped_column(String(255), nullable=True)
kitchen_city: Mapped[str | None] = mapped_column(String(100), nullable=True)
kitchen_postcode: Mapped[str | None] = mapped_column(String(20), nullable=True)
kitchen_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
kitchen_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
```

**Migration**: `backend/migrations/add_kitchen_details.py`
**Modify**: `backend/api/settings.py` - add GET/PUT for kitchen details
**Modify**: `frontend/src/pages/Settings.tsx` - new "Kitchen Details" tab with form fields

### 2.3 SMTP Already Exists

SMTP settings already in `KitchenSettings` (lines 96-102). Email service at `backend/services/email_service.py` with `send_email()`. Settings UI already exposes SMTP fields. Test endpoint at `POST /api/settings/test-smtp`. **No new work needed for SMTP infrastructure.**

### 2.4 Verification (Phase 2)

1. Add order_email + account_number to a supplier → verify saved/displayed
2. Fill in Kitchen Details in Settings → verify persisted
3. Verify SMTP test still works from Settings

---

## Phase 3: Preview & Email

### 3.1 PO Preview/Print View

**Add endpoint**: `GET /api/purchase-orders/{po_id}/preview`
- Returns clean HTML page with:
  - Kitchen letterhead (name, address, phone, email from KitchenSettings)
  - "PURCHASE ORDER" title + PO number (PO-{id})
  - Date, Supplier name, Supplier account number
  - Items table (Code | Description | Unit | Price | Qty | Total) or single value
  - Total
  - Notes
  - Print-friendly CSS (`@media print` styles)

**Frontend**: Add buttons to PO modal footer:
- "Save & Preview" → saves PO, opens `/api/purchase-orders/{id}/preview` in new tab
- "Preview" (when no unsaved changes) → opens preview directly

### 3.2 PO Email Sending

**Add endpoint**: `POST /api/purchase-orders/{po_id}/send-email`
- Loads PO + supplier → checks supplier.order_email exists
- Checks SMTP configured in settings
- Generates PO HTML (reuse preview template)
- Sends via existing `EmailService.send_email()` from `backend/services/email_service.py`
- Updates PO status to PENDING if currently DRAFT

**Frontend**: Add "Save & Email" button to PO modal (shown only when supplier has order_email AND SMTP configured)
- Saves PO, calls send-email endpoint, shows success/error message

### 3.3 Verification (Phase 3)

1. Click "Save & Preview" → new tab with clean formatted PO
2. Print PO from preview → verify layout
3. Set supplier order_email + SMTP config → "Save & Email" button appears
4. Send PO email → verify received with correct content
5. PO status changes to PENDING after email sent

---

## Phase 4: Invoice Matching

### 4.1 PO Matching Service

**File**: `backend/services/po_matching.py` (NEW)

```python
class POMatchingService:
    async def find_matching_pos(db, kitchen_id, supplier_id, invoice_date=None):
        """Find pending POs for supplier, ordered by date proximity"""
        # status IN ('DRAFT', 'PENDING'), order_date within ±7 days

    def calculate_match_confidence(po, invoice) -> float:
        """Score 0-1: supplier match (+0.4), date proximity (+0.3), amount similarity (+0.3)"""

    async def link_po_to_invoice(db, po_id, invoice_id, user_id):
        """Set PO status=LINKED, linked_invoice_id=invoice_id"""

    async def unlink_po(db, po_id, user_id):
        """Reset PO status=PENDING, linked_invoice_id=None"""
```

### 4.2 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/purchase-orders/matching?invoice_id={id}` | Find POs matching an invoice |
| `POST` | `/api/purchase-orders/{po_id}/link` | Link PO to invoice `{invoice_id}` |
| `POST` | `/api/purchase-orders/{po_id}/unlink` | Unlink PO from invoice |

### 4.3 Invoice Detail — PO Banner & Linked PO Display

**Modify**: `frontend/src/components/Review.tsx`

**A) Already-linked PO indicator** (shown when invoice has a linked PO):
- At top of invoice detail, show a compact info bar: "Linked to PO-42 (£125.00, Mon 10 Feb)" with a [View PO] button
- Clicking [View PO] opens the PurchaseOrderModal in read/edit mode for that PO
- Also show [Unlink] button to remove the link (returns PO to PENDING)

**B) Matching PO banner** (shown when invoice has NO linked PO but supplier has pending POs):
- Fetch matching POs via `/api/purchase-orders/matching?invoice_id={id}`
- Show info banner: "This supplier has N pending Purchase Orders"
- List each PO: `PO-42: £125.00 (Mon 10 Feb) [Link to this Invoice]`
- High-confidence matches (>0.8) highlighted with "Suggested match" label
- "Link" button calls POST link endpoint → PO becomes LINKED, banner switches to linked indicator (A)

### 4.4 Budget Table Behavior When Linked

When PO status = LINKED:
- PO **no longer** appears in `purchase_orders_by_date` on budget table
- The linked invoice naturally appears in `invoices_by_date` (it's a real invoice)
- Budget transitions seamlessly from showing planned PO → actual invoice

### 4.5 Verification (Phase 4)

1. Create PO for supplier + date, then upload invoice from same supplier
2. Invoice review page shows matching PO banner with pending POs
3. Link PO → status changes to LINKED, disappears from budget, invoice takes its place
4. Invoice review page now shows "Linked to PO-42" indicator with [View PO] button
5. Click [View PO] → PO modal opens with correct data
6. Unlink PO → returns to PENDING, reappears on budget, banner switches back to matching list
7. Auto-suggest works for high-confidence match (same supplier + close date + similar amount)
8. Banner always shows when supplier has any pending POs

---

## Key Existing Code to Reuse

| Existing Code | File | Reuse For |
|---------------|------|-----------|
| Modal overlay + header pattern | `WastageLogbook.tsx:541-997` | PO modal structure |
| Line item builder (add/update/remove) | `WastageLogbook.tsx` state handlers | PO itemised line items |
| Product search (debounced, deduped) | `WastageLogbook.tsx` + `/api/logbook/products/search` | PO product search (add supplier filter) |
| File upload (FormData + UUID naming) | `invoices.py` upload handler | PO attachment upload |
| Email sending (SMTP) | `backend/services/email_service.py` | PO email (Phase 3) |
| Invoice cell rendering on budget | `Budget.tsx:958-975` | PO cell rendering (same pattern, different style) |
| Dispute status badges | `Disputes.tsx` | PO status badges |
| Settings tab pattern | `Settings.tsx` | Kitchen Details tab (Phase 2) |
| Supplier form | `Suppliers.tsx` | Add order_email/account_number fields (Phase 2) |

## Complete File List (All Phases)

### New Files
1. `backend/models/purchase_order.py` — PO + line item models (Phase 1)
2. `backend/migrations/add_purchase_orders.py` — Create tables (Phase 1)
3. `backend/api/purchase_orders.py` — Full PO API (Phase 1, extended Phase 3-4)
4. `frontend/src/components/PurchaseOrderModal.tsx` — Create/edit modal (Phase 1)
5. `frontend/src/components/PurchaseOrderList.tsx` — PO list page (Phase 1)
6. `backend/migrations/add_supplier_po_fields.py` — Supplier order_email + account_number (Phase 2)
7. `backend/migrations/add_kitchen_details.py` — Kitchen detail columns (Phase 2)
8. `backend/services/po_matching.py` — PO-invoice matching service (Phase 4)

### Modified Files
1. `backend/models/__init__.py` — Register PO models (Phase 1)
2. `backend/models/supplier.py` — Add purchase_orders relationship + order_email + account_number (Phase 1+2)
3. `backend/main.py` — Register router + migrations (Phase 1+2)
4. `backend/api/budget.py` — Include POs in budget response (Phase 1)
5. `frontend/src/App.tsx` — Route + nav item (Phase 1)
6. `frontend/src/components/Budget.tsx` — PO cells + click handler + invoice color change (Phase 1)
7. `backend/api/suppliers.py` — Add new fields to schemas (Phase 2)
8. `frontend/src/components/Suppliers.tsx` — Add form fields (Phase 2)
9. `backend/models/settings.py` — Kitchen detail columns (Phase 2)
10. `backend/api/settings.py` — Kitchen details endpoints (Phase 2)
11. `frontend/src/pages/Settings.tsx` — Kitchen Details tab (Phase 2)
12. `frontend/src/components/Review.tsx` — PO matching banner (Phase 4)
