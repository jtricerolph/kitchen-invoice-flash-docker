# Plan: LLM Integration — Allergen Label Parsing, Invoice OCR Assist, Smart Ingredient Matching

## Context

The kitchen-invoice-flash system has several manual data entry bottlenecks where an LLM can reduce friction:
1. **Product ingredient labels** sit as uninterpreted text in `product_ingredients` — allergen assessment is fully manual
2. **Invoice OCR** gets ~80-90% accuracy from Azure, but users manually fix supplier names, dates, and pack sizes
3. **Ingredient mapping** uses basic trigram similarity which misses semantic matches

Using **Claude Haiku 3.5** via the Anthropic Python SDK. Estimated cost: ~$0.50-1/month for a single kitchen. Mixed trigger approach: auto for cheap label parsing, user-triggered button for invoice analysis and ingredient matching.

## Infrastructure

### New Service: `backend/services/llm_service.py`
- Thin wrapper around `anthropic.AsyncAnthropic` client
- Single shared client instance, initialized on startup
- Graceful fallback: if `ANTHROPIC_API_KEY` is not set, all LLM functions return `None` (features degrade silently)
- Structured output via tool_use (Haiku supports this well)

### Dependencies
- Add `anthropic>=0.40.0` to `requirements.txt`

### API Key Storage
Stored in `KitchenSettings` (same pattern as `azure_key`, `newbook_api_key`, `resos_api_key`):
- New column: `anthropic_api_key` (String(500), nullable)
- Migration: add column to `kitchen_settings` table
- Settings UI: add field in the existing settings page (masked input like Azure key)
- LLM service reads key per-request from the kitchen's settings (not a global env var)

### Core function pattern:
```python
async def analyse_product_label(api_key: str, text: str, flag_categories: list[dict]) -> list[dict] | None:
    """Returns suggested flags or None if LLM unavailable."""
    if not api_key:
        return None
    client = anthropic.AsyncAnthropic(api_key=api_key)
    # ... call Haiku with tool_use for structured output
```

---

## Feature 1: Product Label Allergen Parsing (Auto)

### Trigger
Automatic when `product_ingredients` text is populated — either via Brakes auto-fetch or manual entry in IngredientModal.

### Backend

**File:** `backend/services/llm_service.py` (new)

`analyse_product_label(ingredients_text, flag_categories)`:
- Input: the raw product_ingredients string + kitchen's food flag categories with their flags
- Prompt: "Given this product ingredient list, identify which allergens/dietary flags apply. For each, state whether it CONTAINS, MAY CONTAIN (cross-contamination), or is SUITABLE FOR."
- Output via tool_use: `[{flag_id, flag_name, status: "contains"|"may_contain"|"suitable_for", reason}]`
- ~400 input tokens, ~150 output tokens → ~$0.001/call

**File:** `backend/api/food_flags.py`

New endpoint: `POST /api/food-flags/analyse-label`
- Accepts: `{ingredients_text: str}` (or `{ingredient_id: int}` to read from DB)
- Loads kitchen's flag categories + flags
- Calls `analyse_product_label()`
- Returns suggestions in same format as existing `match_allergen_keywords()` output, with added `confidence` and `status` fields
- Falls back to regex keyword matching if LLM unavailable

### Frontend

**File:** `frontend/src/components/IngredientModal.tsx`

- After Brakes auto-fetch populates `formProductIngredients`, also call the LLM analyse endpoint
- OR: when user manually types/pastes product ingredients text and blurs the field, trigger analysis
- Show results in the existing suggestion display area (same UI as Brakes `suggested_flags`)
- "May contain" items shown with amber styling (distinct from red "contains")
- Existing dismiss flow works unchanged

### Integration with existing flow
- Brakes lookup already returns `suggested_flags` from regex keyword matching → LLM suggestions merge with or replace these
- The existing `pendingFlagIds` / `supplierAutoApplyIds` pattern in IngredientModal handles applying suggestions
- `source: "contains"` auto-applies, `source: "may_contain"` shows as suggestion only

---

## Feature 2: Invoice OCR Assist (User-triggered)

### Trigger
"AI Assist" button on the Review page, after Azure OCR has processed the invoice.

### Backend

**File:** `backend/services/llm_service.py`

`assist_invoice_ocr(ocr_data, supplier_list, line_items)`:
- Input: Azure OCR raw fields + list of known supplier names/aliases + extracted line items
- Prompt: asks Haiku to:
  1. Match vendor_name to the most likely known supplier (or flag unknown)
  2. Validate/correct invoice_date format
  3. For each line item: extract pack_quantity, unit_size, unit_size_type from the description/raw_content
  4. Flag any line items that look like subtotals/discounts (not real products)
- Output via tool_use: `{supplier_match, corrected_date, line_item_enhancements: [{idx, pack_quantity, unit_size, unit_size_type, is_subtotal}]}`
- ~1500 input tokens, ~400 output → ~$0.003/call

**File:** `backend/api/invoices.py`

New endpoint: `POST /api/invoices/{invoice_id}/ai-assist`
- Loads invoice + line items + kitchen's suppliers
- Calls `assist_invoice_ocr()`
- Returns suggestions (does NOT auto-apply — user reviews and accepts)

### Frontend

**File:** `frontend/src/components/Review.tsx`

- Add "AI Assist" button (sparkle icon) in the top action bar
- On click: calls the endpoint, shows loading spinner
- Results shown as yellow-highlighted suggestions next to each field:
  - Supplier: "Did you mean: Brakes?" with Accept button
  - Date: "Suggested: 15 Feb 2026" with Accept button
  - Per line item: pack size suggestions shown inline with Accept buttons
- User can accept individual suggestions or "Accept All"
- Accepting updates the field values and marks the suggestion as applied

---

## Feature 3: Smart Ingredient Matching (User-triggered)

### Trigger
"AI Match" button when mapping a line item to an ingredient, shown when trigram results have low confidence.

### Backend

**File:** `backend/services/llm_service.py`

`rank_ingredient_matches(line_item_desc, candidates)`:
- Input: line item description + product code + top 15 trigram candidates (name + category)
- Prompt: "Rank these ingredients by how likely they match this invoice line item. Consider abbreviations, brand names, pack variations."
- Output via tool_use: `[{ingredient_id, confidence: 0-100, reason}]`
- ~500 input tokens, ~150 output → ~$0.001/call

**File:** `backend/api/ingredients.py`

New endpoint: `POST /api/ingredients/ai-match`
- Accepts: `{description: str, product_code: str | null, candidates: list[{id, name}]}`
- Calls `rank_ingredient_matches()`
- Returns re-ranked list with confidence scores

Alternatively: enhance existing `GET /api/ingredients/suggest` to optionally include AI ranking when `?ai=true` query param is passed.

### Frontend

**File:** `frontend/src/components/IngredientModal.tsx` (or MapLineItemsModal.tsx)

- When trigram results are shown, add "AI Match" button if top result similarity < 0.5
- On click: sends description + candidates to backend
- Results replace/re-sort the dropdown with AI confidence scores
- High-confidence match (>80%) gets a green highlight

---

## Files Summary

| File | Change |
|------|--------|
| `backend/services/llm_service.py` | **New** — Anthropic client wrapper + 3 LLM functions |
| `backend/requirements.txt` | Add `anthropic>=0.40.0` |
| `backend/models/settings.py` | Add `anthropic_api_key` column |
| `backend/migrations/add_anthropic_key.py` | **New** — migration for settings column |
| `backend/api/settings.py` | Expose new field in settings CRUD |
| `backend/api/food_flags.py` | New `/analyse-label` endpoint |
| `backend/api/invoices.py` | New `/{id}/ai-assist` endpoint |
| `backend/api/ingredients.py` | New `/ai-match` endpoint |
| `frontend/src/components/IngredientModal.tsx` | Auto-trigger label analysis, show LLM suggestions |
| `frontend/src/components/Review.tsx` | "AI Assist" button + suggestion display/accept UI |

## Implementation Order

1. **Phase 1**: Infrastructure (`llm_service.py`, deps, settings migration)
2. **Phase 2**: Label parsing (#1) — smallest scope, auto-trigger, highest safety value
3. **Phase 3**: Invoice OCR assist (#2) — user-triggered, most visible time saving
4. **Phase 4**: Ingredient matching (#3) — enhances existing flow

## Verification

1. Add Anthropic API key in Settings page → saved to kitchen_settings
2. Without key set → all features degrade gracefully (existing regex/trigram still works)
3. Create ingredient with product_ingredients "Contains: wheat flour, milk, soy lecithin" → LLM suggests Gluten, Dairy, Soy flags
4. Upload invoice → click "AI Assist" → supplier matched, pack sizes suggested
5. Map line item "CHK BRST SKNLS 2.5KG" → AI Match ranks "Chicken Breast" highest despite low trigram score
