# Gym OS Nutrition — Phase 2 Audit

**Date:** 2026-11-15 · **Branch:** `feature/nutrition-engine-overhaul` @ `10ce745` · **Method:** read the Phase 1 reports, re-ran every test suite and both benchmarks, then pushed the meals from the Phase 2 brief through the live engine (`estimateFood`, the function behind `POST /me/nutrition/describe`) and traced the UI code paths. Every finding below was reproduced in this session.

## 1. Repository verification

| Check | Result |
|---|---|
| Current branch | `feature/nutrition-engine-overhaul` |
| Local HEAD | `10ce745` |
| Remote branch | `10ce745` — identical, **no divergence**, no extra remote commits |
| Working tree | clean |
| Remote-tracking issue (previous session) | Root cause: the repo was cloned single-branch, so `remote.origin.fetch` only mapped `main`. Fixed last session with a local fetch mapping for this branch; upstream now resolves and `git status` shows the branch in sync. Nothing was ever unpushed. |
| `main` | `3fab43a` (teammates' PRs #23/#25/#26). Untouched by this work. |

## 2. Phase 1 claims re-verified

| Claim | Verified? | Evidence |
|---|---|---|
| Backend tests pass | ✅ | 2,114 tests, 0 fail, 6 skipped (PostgreSQL-only) |
| Frontend tests pass | ✅ | 213 / 213 |
| Benchmark v1 82.9%, v2 86.0%, gates pass | ✅ | re-run, identical |
| Zero silent drops | ⚠️ **Partially** | 0 on the benchmark, but the parser can now **add** foods that were not eaten (F2, F3) |
| Server-side re-pricing + idempotency | ⚠️ **Partially** | Wired in the plate logger only; the classic sheet (search / barcode / AI) bypasses both (F7) |
| Provenance distinguishes verified vs AI | ⚠️ **Partially** | Stored per log; **not shown anywhere in the UI** after logging (F8) |
| Correction safety ("one user can't change shared values") | ❌ | A single user can rewrite a shared, cross-tenant AI value (F1) |
| Image estimation | ❌ Not in product | `/intel/meal-photo` exists; its only caller (`AskSK.jsx`) is mounted nowhere |

## 3. Findings

Severity: **Critical** (wrong or fabricated numbers, security) · **High** (systematic accuracy error) · **Medium** (partial feature, UX) · **Low**.

| # | Sev | Finding | Evidence (reproduced) | Files | Impact | Fix |
|---|---|---|---|---|---|---|
| F1 | Critical | **One user can rewrite a shared AI nutrition value for every gym.** Promotion counts feedback *rows* (threshold 5), not distinct people; nothing limits one user to one row; the cache is cross-tenant. | `aggregateAndMaybePromote` uses `rows.length`; `ai_food_feedback` has no per-client uniqueness; limit is 10/min | `intelligence/foodFeedback.js`, `schema.sql` | Data poisoning across tenants | Count distinct clients; never auto-apply — queue for admin review (Part 9) |
| F2 | Critical | **A quantity phrase becomes a food.** "Had chicken biryani, half a plate, with raita" → "half a plate" resolves to USDA *"Veal, breast, plate half"* (141 kcal); the biryani stays a full plate. | probe | `foodEstimator.js` (fragment split, `sharesFoodWord` returns true for no content words) | Fabricated item + wrong portion | A fragment with no food words is a quantity for its neighbour, never a food |
| F3 | Critical | **Double count introduced by Phase 1 coverage.** "sabudana khichdi" → Sago khichdi **+** a separate dal khichdi (866 kcal; Phase 0 gave 508 as one item). INDB spells it "khitchdi/khichri", so coverage treated "khichdi" as unaccounted and recovered it as a second food. | probe | `food/coverage.js` | Any spelling variant in a measured title can double count | Spelling-distance matching in coverage; regression test |
| F4 | High | **Container sizes are inconsistent.** For bowl/katori/plate/piece the shared model substitutes the dish's INDB serving whatever container it describes. INDB "bowl" ranges 98 g (poha) – 353 g (dal makhani); a *katori* (≈150 ml) request takes a *bowl* weight: 1 katori sambar = 257 g, dal makhani = 353 g; "1 plate poha" = 98 g. | probe + `portionToGrams` lines 986–993 | `foodEstimate.reference.js` (shared), `foodEstimator.js` | Systematic portion error on most Indian curries | Use a measured serving only for the SAME container and only when plausible for it; otherwise container volume × density |
| F5 | High | **Size words block parsing.** "2 medium rotis" → unresolved. | probe | `foodEstimator.js` parseFragment | Common phrasing lost | Parse small/medium/large; apply documented size ratios; lower portion confidence |
| F6 | High | **Questionable reference values.** "Dal" maps to USDA FNDDS `usda:2707427` at 145 kcal / 8.6 g protein per 100 g (1 bowl = 363 kcal) — dense for everyday Indian dal; 23 staples carry hand-entered values; 18 recipe dishes unvalidated. | probe, `staples.js` | `staples.js`, `recipes.js` | Calorie error on the most-logged foods | Reference review against IFCT/INDB; convert hand values to computed recipes; document |
| F7 | High | **Classic logging bypasses server pricing and idempotency.** `Nutrition.jsx` `logEntry` posts name + numbers only — no `source_id`, `grams`, `client_request_id`. | code | `pages/client/Nutrition.jsx` | Search/barcode logs unverified + retry duplicates | Send row id, grams, request id |
| F8 | Medium | **Provenance invisible after logging.** No list/history component reads `nutrition_source`. | grep | `TodayLog.jsx`, `NutritionTracker.jsx` | Users can't tell verified from estimated | Show a compact source marker |
| F9 | Medium | **No personal corrections.** Plate edits are not recorded; corrections exist only for AI estimates, with no review status, tenant context or personal override. | code | routes, schema | No learning, no audit trail | Corrections table + personal overrides + review queue |
| F10 | Medium | **Image estimation not in the live UI** (dead `AskSK.jsx`). | grep | `AskSK.jsx`, `intelligence.js` | Feature advertised in code only | Decide: wire behind explicit estimate labelling, or remove |
| F11 | Medium | **Personalisation gaps:** activity derived from training experience; `diet_type` / `food_exclusions` unused. | code | `targets.js`, profile | Generic targets | Activity-level field; diet-aware suggestions |
| F12 | Medium | **Compound "X with Y" where Y is an ingredient of X** ("poha with peanuts") adds a separate handful though recipes may already include it. | probe | parser | Possible double count of garnish | Treat as variant / flag rather than add, where the dish already contains it |
| F13 | Blocker (non-eng.) | **Licensing unresolved:** Open Food Facts (ODbL) attribution missing; INDB / IFCT commercial terms unverified. | Phase 1 audit | product, data | Commercial release blocker | Research + documentation; attribution change needs owner approval |
| F14 | Blocker (evidence) | **No real-world validation data.** All accuracy evidence is synthetic. | — | — | 9/10 cannot be claimed | Validation protocol + capture of weighed meals and corrections |

## 4. What works correctly (re-verified)

Deterministic per-100 g arithmetic; totals = Σ items; explicit grams/ml preserved (150 g paneer, 250 ml milk, 10 g butter, 15 g jam); container counts (2 plates misal pav → 2 misal + 4 pav); scoop of whey; cups of cooked rice; multi-food sentences with commas/"and"/"with"; Indian staple identification; recipe-priced regional dishes; calibrated confidence by dimension; idempotent plate logging (SQLite + PostgreSQL); RLS isolation of `meal_log_requests`; target safeguards.

## 5. The five biggest obstacles to 9/10 (ranked)

| Rank | Obstacle | Impact | Difficulty | Can it be closed in code? |
|---|---|---|---|---|
| 1 | **Calorie/portion accuracy defects** (F2–F6, F12) | Very high — wrong numbers on everyday meals | Medium | Yes, largely |
| 2 | **No real-world validation** (F14) | Very high — caps any honest score | External | Tooling yes; data no |
| 3 | **Correction & learning integrity** (F1, F9) | High — trust and cross-tenant data safety | Medium | Yes |
| 4 | **Licensing** (F13) | Blocker for commercial release | Needs legal/owner decision | Research yes; decision no |
| 5 | **Logging path consistency + transparency** (F7, F8) | High — two logging paths with different guarantees; provenance hidden | Low–medium | Yes |

## 6. Implementation order

1. **Critical correctness:** F2 quantity phrases, F3 spelling-variant double count, F1 shared-correction safety — each with regression tests.
2. **Portion accuracy:** F4 container consistency, F5 size words, F12 garnish double count — measured on the benchmark.
3. **Data quality:** F6 reference review, hand-entered staples → computed recipes where measured ingredients exist.
4. **Logging consistency + transparency:** F7, F8.
5. **Corrections system:** F9 (personal corrections, tenant-scoped, review status, admin approval for shared data).
6. **Benchmark v3** toward 1,000 independent cases, with false-identification and portion error reported separately.
7. **Licensing research** → `NUTRITION_DATA_LICENSING.md` (no attribution change without approval).
8. **Personalisation** (F11) and image decision (F10), then validation tooling (F14) and final reports.
