# LLM Integration Plan — Review & Enhancements

> **Supersedes** the original 3-feature plan. Reviewed and expanded to cover 11 features across 6 phases, with master kill switch, removal manifest, cost guardrails, and detailed UX specification.

## Context

The kitchen-invoice-flash system has several manual data entry bottlenecks where an LLM can reduce friction. Using **Claude Haiku** via the Anthropic Python SDK. Estimated cost: ~$0.50-1/month for a single kitchen. Mixed trigger approach: auto for cheap label parsing, user-triggered button for invoice analysis and ingredient matching.

**Scope**: Original 3 features + Tier 1 (A, B, C) + Tier 2 (D, E, F, G) + new Feature H (line item reconciliation).
**Instance model**: Single instance (not multi-kitchen). Settings are global, not per-kitchen.
**API key storage**: Plaintext in DB (matching existing pattern for Azure, NewBook, etc.).

---

## 1. What the Plan Gets Right

- **Model choice**: Claude Haiku is correct — structured extraction, not creative generation.
- **API key in Settings**: Follows the established `KitchenSettings` pattern (same as `azure_key`, `resos_api_key`, etc.).
- **Structured output via `tool_use`**: Guarantees parseable JSON. Right approach over prompt-based JSON.
- **Graceful degradation**: LLM features are additive, never blocking. Existing regex/trigram still works without a key.
- **Trigger strategy**: Auto for cheap label parsing, user-triggered buttons for invoice assist and ingredient matching.

---

## 2. Infrastructure Enhancements

### 2a. Client Instantiation
Single shared client instance, re-initialized if API key changes in settings.

### 2b. Response Caching
New `llm_analysis_cache` table:
- Columns: `id`, `feature`, `input_hash` (SHA-256), `result_json`, `model_used`, `prompt_version`, `created_at`
- Unique constraint: `(feature, input_hash, prompt_version)`
- Feature 1 (labels): cache by text hash, TTL 30 days. Feature 3 (matching): TTL 7 days. Feature 2 (invoices): skip caching.

### 2c. Usage Tracking
New `llm_usage_log` table:
- Columns: `id`, `feature`, `model`, `input_tokens`, `output_tokens`, `latency_ms`, `success`, `error_message`, `created_at`
- `GET /api/settings/llm-usage` endpoint (aggregated last 30 days). Display on Settings page.

### 2d. Configurable Model
`llm_model` column in `KitchenSettings` (default `"claude-haiku-4-5-latest"`). Settings UI shows dropdown (Haiku / Sonnet).

### 2e. Prompt Versioning
Constants in `llm_service.py`. Cache lookup includes `prompt_version` — version bump auto-invalidates stale cache.

### 2f. Error UX
Three-state `llm_status` in API responses: `"success"`, `"unavailable"` (no key), `"error"` (call failed + message).

### 2g. Rate Limiting
`asyncio.Semaphore(5)` caps concurrent LLM calls.

### 2h. Master Kill Switch
`llm_enabled` (Boolean, default **False**) in `KitchenSettings`. When disabled: zero AI footprint in frontend, no API calls, no logging. See `LLM-MANIFEST.md` for full details.

### 2i. Removal Manifest
`LLM-MANIFEST.md` in project root — updated each phase. All LLM code marked with breadcrumb comments: `LLM FEATURE — see LLM-MANIFEST.md for removal instructions`.

### 2j. Cost Guardrails (5 layers)
1. **Per-feature toggles** — `llm_features_enabled` JSONB column, individually disable features
2. **Monthly token budget** — `llm_monthly_token_limit` (default 500,000 tokens ~$1.25/month)
3. **Auto-trigger throttle** — per-entity cooldown via cache check
4. **Single-call token cap** — `max_tokens` on every API call
5. **Cost visibility** — Usage stats card on Settings page

### 2k. Prompt Injection Mitigation
`tool_use` structured output mitigates this. System messages note input is "untrusted product/invoice text".

---

## 3. Features

### Original Features

#### Feature 1: Product Label Allergen Parsing (Auto)
- Trigger: automatic when `product_ingredients` text is populated
- `analyse_product_label(ingredients_text, flag_categories)` → `[{flag_id, status: "contains"|"may_contain"|"suitable_for", reason}]`
- ~550 tokens/call, ~$0.001

#### Feature 2: Invoice OCR Assist (User-triggered)
- "AI Assist" button on Review page
- `assist_invoice_ocr(ocr_data, supplier_list, line_items)` → supplier match, date correction, pack size extraction, OCR corrections
- Batches line items in groups of 15-20 for 50+ line invoices
- ~1,900 tokens/call, ~$0.003

#### Feature 3: Smart Ingredient Matching (User-triggered)
- "AI Match" button when trigram results have low confidence
- `rank_ingredient_matches(description, candidates)` → re-ranked list with confidence scores
- ~650 tokens/call, ~$0.001

### Tier 1 — High Value

#### A. Recipe Text Allergen Scanning
Same `analyse_product_label()` function with recipe text as input. Catches contextual allergens regex misses.

#### B. Menu Description Generation
"Generate Description" button in PublishToMenuModal. Customer-facing descriptions with allergen callout.

#### C. Dispute Email Drafting
"Draft Email" button on DisputeDetailModal. Professional supplier email requesting credit.

### Tier 2 — Medium Value

#### D. Smart Duplicate Detection
"AI Check" button when creating ingredients. Reuses `rank_ingredient_matches()`.

#### E. OCR Field Extraction Fallback
Automatic when regex returns null. Mark LLM-extracted fields with `source: "llm"`.

#### F. Supplier Alias Resolution
LLM fallback when `identify_supplier()` returns no match.

#### G. Ingredient Yield Estimation
Auto-hint on ingredient creation: "Typical yield: ~85%".

#### H. Invoice Line Item Reconciliation (Auto)
Matches unmatched line items against supplier's own historical naming from past 90 days.

---

## 4. Frontend UX

### Core Principles
1. **Suggestions only, never auto-change data** (except allergen "Contains" following existing Brakes pattern)
2. **Visible loading + notification** for auto-triggered features
3. **Sparkle icon** as consistent AI indicator

### Auto-triggered Features
| Feature | Where | Visual |
|---------|-------|--------|
| Label Parsing | IngredientModal | Spinner → toast → sparkle icon suggestions |
| Recipe Scanning | RecipeEditor | Spinner on flag matrix → sparkle suggestions |
| OCR Fallback | Invoice upload | Dashed amber border + "AI extracted" tooltip |
| Reconciliation | Review page | Amber "AI match" badge |

### User-triggered Features
| Feature | Where | Trigger |
|---------|-------|---------|
| AI Assist | Review top bar | Button → yellow-highlighted suggestions |
| AI Match | IngredientModal | Button → re-sorted dropdown |
| Menu Description | PublishToMenuModal | "Generate" button → pre-filled textarea |
| Dispute Email | DisputeDetailModal | "Draft Email" button → pre-filled text |
| Duplicate Detection | IngredientModal | "AI Check" button → warning panel |
| Supplier Alias | Review page | Auto suggestion banner |
| Yield Estimation | IngredientModal | Auto hint below field |

---

## 5. OCR Correction Enhancements (Feature 2)

LLM significantly enhances 7 existing OCR correction scenarios:
1. **Qty × Price ≠ Total** — identifies which field Azure misread
2. **Line items vs invoice total mismatch** — identifies delivery charges, subtotal rows
3. **Description content vs value** — recommends which is the correct description
4. **SKU in description** — distinguishes product codes from descriptions
5. **Weight-as-quantity** — handles non-standard weight formats
6. **Subtotal/discount row detection** — catches "Goods Total", "Delivery Surcharge", etc.
7. **Gross-to-net VAT** — identifies VAT treatment from invoice context

---

## 6. Implementation Order

### Phase 1: Infrastructure ✅
- `backend/services/llm_service.py` — client, caching, logging, rate limiting
- `backend/requirements.txt` — `anthropic>=0.40.0`
- `backend/models/settings.py` — LLM columns
- `backend/models/llm.py` — usage log + cache models
- `backend/migrations/add_llm_infrastructure.py`
- `backend/api/settings.py` — LLM fields, usage stats endpoint
- `LLM-MANIFEST.md` — removal manifest

### Phase 2: Label Parsing + Recipe Text (Features 1 + A)
- `analyse_product_label()` with caching
- `/analyse-label` endpoint
- Frontend auto-trigger + sparkle suggestions

### Phase 3: Invoice OCR Assist + Reconciliation (Features 2 + E + H)
- `assist_invoice_ocr()` with batching
- `reconcile_line_items()` for supplier history
- "AI Assist" button + suggestion UI
- LLM fallback for regex field extraction

### Phase 4: Ingredient Matching + Supplier (Features 3 + D + F)
- `rank_ingredient_matches()`, supplier alias matching
- "AI Match" button, duplicate detection

### Phase 5: Text Generation (Features B + C)
- Menu description generation
- Dispute email drafting

### Phase 6: Polish + Yield (Feature G)
- Yield estimation hints
- Usage dashboard
- Prompt tuning

---

## 7. Verification Checklist

1. Add API key in Settings → saved, model dropdown works
2. `llm_enabled = False` (default) → zero AI footprint anywhere
3. Enable → full LLM settings section appears
4. Ingredient with "Contains: wheat flour, milk" → Gluten, Dairy suggestions
5. Upload invoice → "AI Assist" → corrections + suggestions
6. Invalid API key → toast error, regex/trigram still works
7. Budget exceeded → graceful degradation
8. All AI suggestions visually distinct with sparkle icon
