# LLM Feature Manifest

Files that can be safely removed/reverted to fully remove LLM features.
Updated with each implementation phase. Keep this current when making LLM-related changes.

## How to Use This Manifest

1. **Quick disable**: Set `llm_enabled = False` in kitchen_settings — all LLM UI disappears, no API calls made.
2. **Full removal**: Follow the sections below to remove all LLM code and database objects.
3. **Code search**: All LLM code is marked with `LLM FEATURE — see LLM-MANIFEST.md` comments.

---

## New Files (delete entirely)

| File | Purpose | Phase |
|------|---------|-------|
| `backend/services/llm_service.py` | Central LLM wrapper — client, caching, logging, rate limiting | 1 |
| `backend/models/llm.py` | `LlmUsageLog` + `LlmAnalysisCache` models | 1 |
| `backend/migrations/add_llm_infrastructure.py` | Migration for all LLM tables + settings columns | 1 |

## Modified Files (sections to remove)

### Phase 1 — Infrastructure

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/requirements.txt` | `anthropic>=0.40.0` line | `anthropic` |
| `backend/models/settings.py` | 7 columns: `llm_enabled`, `anthropic_api_key`, `llm_model`, `llm_confidence_threshold`, `llm_monthly_token_limit`, `llm_features_enabled` | `llm_` or `anthropic_` |
| `backend/api/settings.py` | LLM fields in `SettingsResponse`, `SettingsUpdate`, `_build_settings_response()`, `LlmUsageStatsResponse`, `/llm-usage` endpoint, `/test-llm` endpoint | `llm` or `LLM` or `anthropic` |
| `backend/main.py` | Import + call of `run_llm_infrastructure_migration` | `llm_infrastructure` |

### Phase 2 — Label Parsing + Recipe Text (Features 1 + A)

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/services/llm_service.py` | `analyse_product_label()` function + `LABEL_ANALYSIS_SYSTEM_MSG` constant | `analyse_product_label` |
| `backend/api/food_flags.py` | `POST /analyse-label` endpoint, LLM integration in recipe text scanning (`GET /recipes/{id}/flags`) — LLM call + merge block | `llm_service` or `analyse_product_label` or `llm_recipe_suggestions` |
| `frontend/src/components/IngredientFlagEditor.tsx` | `llmSuggestions` + `llmAnalysing` props, LLM suggestion merge logic, AI spinner/indicator | `llmSuggestions` or `llmAnalysing` or `LLM FEATURE` |
| `frontend/src/components/IngredientModal.tsx` | `llmAnalysing` + `llmSuggestions` + `debouncedProductIngredients` state, settings query for `llm_enabled`, `/analyse-label` useEffect, LLM props passed to IngredientFlagEditor | `llmAnalysing` or `llmSuggestions` or `analyse-label` or `LLM FEATURE` |
| `frontend/src/pages/Settings.tsx` | `'llm'` in SettingsSection type, sidebar item, LLM fields in SettingsData interface, LLM state variables, LLM queries/mutations, `handleSaveLlmSettings`, entire `activeSection === 'llm'` block | `llm` or `LLM` |

### Phase 3 — Invoice OCR Assist + Reconciliation (Features 2 + E + H)

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/services/llm_service.py` | `assist_invoice_ocr()`, `reconcile_line_items()`, `extract_invoice_fields_llm()` functions | `assist_invoice_ocr` or `reconcile_line_items` or `extract_invoice_fields_llm` |
| `backend/api/invoices.py` | `POST /{invoice_id}/ai-assist` endpoint | `ai-assist` or `ai_assist` or `LLM FEATURE` |
| `backend/ocr/extractor.py` | LLM fallback block in `process_invoice_image()` — field extraction when Azure returns null | `extract_invoice_fields_llm` or `LLM FEATURE` |
| `frontend/src/components/Review.tsx` | `AiAssistSuggestions` + `AiReconciliationMatch` interfaces, `aiAssist*` state variables, `handleAiAssist` + `handleApplyAiCorrection` + `handleApplyAiSupplier` functions, AI Assist button, AI suggestions panel, pack size suggestions panel + pre-fill in `toggleCostBreakdown` | `aiAssist` or `aiReconciliation` or `AiAssist` or `pack_size_suggestions` or `LLM FEATURE` |

### Phase 4 — Ingredient Matching + Supplier (Features 3 + D + F)

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/services/llm_service.py` | `rank_ingredient_matches()`, `match_supplier_llm()`, `check_duplicate_ingredient_llm()` functions | `rank_ingredient_matches` or `match_supplier_llm` or `check_duplicate_ingredient_llm` |
| `backend/api/ingredients.py` | `GET /ai-match` endpoint, `GET /ai-check-duplicate` endpoint | `ai-match` or `ai-check-duplicate` or `LLM FEATURE` |
| `backend/ocr/parser.py` | LLM fallback block at end of `identify_supplier()` | `match_supplier_llm` or `LLM FEATURE` |
| `frontend/src/components/Review.tsx` | `aiMatchLoading` + `aiMatchResults` state, `handleAiMatch` function, AI Match button + results in cost breakdown modal | `aiMatch` or `ai-match` or `LLM FEATURE` |

### Phase 5 — Text Generation (Features B + C)

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/services/llm_service.py` | `generate_menu_description()`, `draft_dispute_email()` functions | `generate_menu_description` or `draft_dispute_email` |
| `backend/api/menus.py` | `GenerateDescriptionRequest` model, `POST /generate-description` endpoint | `generate-description` or `generate_menu_description` or `LLM FEATURE` |
| `backend/api/disputes.py` | `POST /{dispute_id}/draft-email` endpoint | `draft-email` or `draft_dispute_email` or `LLM FEATURE` |
| `frontend/src/components/PublishToMenuModal.tsx` | `aiDescLoading` state, `llmSettings` query, `handleGenerateDescription` function, Generate button next to Description label | `aiDescLoading` or `handleGenerateDescription` or `LLM FEATURE` |
| `frontend/src/components/DisputeDetailModal.tsx` | `aiEmail*` state variables, settings query, `handleDraftEmail` function, Draft Email section with subject/body/actions | `aiEmail` or `handleDraftEmail` or `LLM FEATURE` |

### Phase 6 — Polish + Yield (Feature G)

| File | What to Remove | Search Pattern |
|------|---------------|----------------|
| `backend/services/llm_service.py` | `estimate_yield()` function | `estimate_yield` |
| `backend/api/ingredients.py` | `GET /ai-estimate-yield` endpoint | `ai-estimate-yield` or `estimate_yield` or `LLM FEATURE` |
| `frontend/src/components/IngredientModal.tsx` | `yieldHint` + `yieldHintLoading` + `debouncedFormName` state, yield estimation useEffect, yield hint display below Yield % input | `yieldHint` or `yieldHintLoading` or `ai-estimate-yield` or `LLM FEATURE` |

---

## Database (migration to drop)

### Tables
- `llm_usage_log` — LLM API call tracking
- `llm_analysis_cache` — Response caching

### Columns on `kitchen_settings`
- `llm_enabled` (Boolean)
- `anthropic_api_key` (String)
- `llm_model` (String)
- `llm_confidence_threshold` (Numeric)
- `llm_monthly_token_limit` (Integer)
- `llm_features_enabled` (JSONB)

### Removal SQL
```sql
DROP TABLE IF EXISTS llm_usage_log;
DROP TABLE IF EXISTS llm_analysis_cache;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS llm_enabled;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS anthropic_api_key;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS llm_model;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS llm_confidence_threshold;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS llm_monthly_token_limit;
ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS llm_features_enabled;
```

---

## Design Principles for Clean Removal

1. **Conditional imports**: All LLM imports use `from services.llm_service import X` only inside functions, not at module top level (except main.py migration import).
2. **Kill switch**: All LLM UI elements gated behind `if (!llmEnabled)` — removing the settings column and defaulting to False effectively removes all UI.
3. **No existing signatures changed**: LLM features are additive (new endpoints, new UI elements), never modify existing function behaviour.
4. **Existing logic untouched**: Regex/trigram logic untouched — LLM runs alongside, not instead of.
5. **Breadcrumb comments**: Every LLM-related function and component includes `LLM FEATURE — see LLM-MANIFEST.md for removal instructions`.
