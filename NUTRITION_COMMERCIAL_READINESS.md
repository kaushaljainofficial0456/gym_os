# Gym OS Nutrition — Commercial Readiness Report

**Branch:** `feature/nutrition-engine-overhaul` (from `main` @ `04c0389`; `main` never modified) · **Date:** 2026-11-15
**Companion documents:** `NUTRITION_COMPLETE_TECHNICAL_AUDIT.md` (Phase 0), `NUTRITION_BENCHMARK_REPORT.md` (all measurements), `NUTRITION_PROGRESS.md` (log).

## Verdict

**Score: 7.0 / 10** (audit estimate before the overhaul: about 5.5).
**Recommendation: ready for a controlled pilot, not for general commercial release.** A pilot means one or two gyms, with values labelled as estimates and weighed-meal validation data collected. The engineering blockers found in the audit are fixed and measured. What separates this from a 9 is **evidence that doesn't exist yet**:

- real users' meals with weighed portions;
- independent validation of the recipe-priced dishes;
- legal clearance of two datasets.

Plus a few features the brief asked for that were not built (§6).

---

## 1. Final architecture

```
POST /me/nutrition/describe ─► describeMeal ─► estimateFood (foodEstimator.js, the live engine)
   │   splitItems → expandFragments ─┬─ "X with Y" split (only if the whole-phrase row names both)      [fixed]
   │                                 ├─ curry+rice / roti pairs
   │                                 └─ N curated foods side by side; amounts never dropped           [new]
   │   parseFragment (context words "homemade" recorded, not searched)                                 [new]
   │   search: 144 curated staples (incl. 18 recipe-priced dishes) → 21,353-row measured index
   │   guard: a match sharing no food word with the input is unresolved, not summed                  [new]
   │   resolveGrams → scaleNutrition (per-100 g × grams; liquids in ml weigh ~1 g/ml)                  [fixed]
   │   food/coverage.js: every food word → an item, `unresolved`, or `needs_clarification`             [new]
   │   food/confidence.js: identification · portion · composition; overall = weakest                   [new]
   ▼
Plate (PlateSheet / LogCard) — "not found" needs a second, deliberate tap; weakest dimension in words
   ▼
POST /me/nutrition/log-batch  (and the classic /nutrition/clients/:id/meals/log)
   services/nutrition/mealLogWriter.js — one transaction: meal_log_requests (idempotency + what was
   knowingly excluded) + meal_logs; services/nutrition/provenance.js re-prices database items on the
   SERVER and stamps nutrition_source (verified_database | brand_label | recipe_calculation |
   ai_estimate | user_provided | previous_log | plan) — a client can never claim a trusted class.

food/recipes.js — dishes with no usable row, priced from ingredient rows pinned by source_id
services/nutrition/targets.js — Mifflin-St Jeor targets with safeguards, assumptions, disclaimer
Tier 4 AI (intelligence/foodAI.js) — unchanged: AI proposes components, the database prices them
```

## 2. What was implemented (commit by commit, all on this branch)

| Commit | Change |
|---|---|
| `e461ddb` | Phase 0 audit; baseline benchmark preserved. |
| `082ed82` | **Zero silent drops**: coverage accounting; "X with Y" fix; context words; no-shared-word guard; plural staples. |
| `1ea6668` | **Logging**: idempotent transactional writer; server re-pricing; provenance + grams + fibre/sugar/sodium persisted; "log anyway" confirmation for unresolved items; supplements validation. |
| `df503eb` | **Indian coverage**: 16 standard recipes from measured ingredients; puran poli, pav, jam, papad; N-food segmentation with customary pairs (misal pav → 2 pav). |
| `72d7b6b` | **Calibrated confidence by dimension**, shown in plain words. |
| `2004e4d` | **534-case v2 benchmark** (+ CI gate). Fixed what it exposed: weighed amounts lost by the segmenter; sugar-in-the-name liquid density. |
| `d410882` | Benchmark report (original vs improved, same scorer). |
| `4b4b494` | **Target safeguards**: minors, underweight, BMI ≥ 30 protein, calorie/macro consistency, medical notes, disclaimer. |
| `e4988f4` | **PostgreSQL proof**: concurrent idempotency + RLS isolation test, added to CI. |
| `518789d` | Egg-led dishes (egg fried rice / biryani / roll / sandwich) no longer double count. |

## 3. Results (full detail in `NUTRITION_BENCHMARK_REPORT.md`)

| v2 benchmark, 534 cases | Original | Improved |
|---|---|---|
| Silent food drops (multi-food cases) | 28.1% | **0%** (CI-enforced) |
| Food identity | 92.2% | **95.3%** |
| Indian food identity (255 cases) | 90.9% | **96.8%** |
| International food identity (267 cases) | 93.3% | 93.8% |
| Multi-food meals: items identified | 93.0% | **98.8%** |
| Confident-wrong answers | 8.2% | **3.6%** |
| Unresolved | 4.2% | **2.3%** |
| Fabrication | 0% | 0% |
| Calibration error, independently measurable cases | 0.133 | **0.078** |
| kcal in reference range | 75.5% | 75.5% (unchanged) |
| Median kcal error, explicit-weight cases | 1.3% | 1.2% (optimistic: 113 same-row cases) |
| Cases worse than the original engine | — | **0** (v1: 28 better; v2: 74 better) |

## 4. Score by dimension (evidence-based)

| Dimension | Before | Now | Evidence | What holds it back |
|---|---:|---:|---|---|
| Food identification & meal decomposition | 6 | **8.5** | 95.3% identity, 98.8% meal items, 0 silent drops (534 cases) | International 93.8%; synthetic inputs only |
| Nutrition calculation & provenance | 6 | **8.5** | Server-priced, deterministic, Σ items = total (tested), provenance persisted, Atwater-consistent recipes | — |
| Indian food coverage | 6 | **8** | 96.8% identity; misal, thalipeeth, pithla, bhakri, pongal, bhatura, kachori… now resolve | **Recipe calories have no independent validation**; 23 staples still hand-entered |
| Portion estimation | 6 | **6.5** | Assumed amounts flagged; food-specific units; container counts | Defaults unvalidated against weighed meals; size words recorded but not applied; no photo estimation |
| Confidence & uncertainty | 4 | **8** | ECE 0.133 → 0.078; "high" right 81% (was 70%); reasons in plain words | Mild under-confidence on medium/low |
| AI estimation layer | 6.5 | **6.5** | Unchanged: grounded components, 4-provider failover, cooldowns | No meal-level AI decomposition; cost tracked as call counts, not money |
| Corrections & learning | 5 | **5** | Unchanged: corrections stored separately, aggregated | No reviewed release pipeline; shared AI cache auto-updates after 5 agreeing corrections |
| Personalisation & safety | 5 | **6.5** | Safeguards + disclaimer (tested); medical notes acknowledged | Activity level inferred from training experience; diet type / exclusions unused in suggestions |
| Logging UX | 6.5 | **7** | Unresolved needs explicit confirmation; weakest dimension shown | Not browser-tested end to end |
| Backend security & reliability | 6.5 | **8** | Idempotency incl. 6-way concurrency on PostgreSQL; RLS isolation on PostgreSQL; validation; transactions | No production-like load test |
| Performance | 7 | **7** | 47 meals/s per core; p50 13 ms, p95 69 ms, p99 106 ms | 641 ms + ~75 MB index load per cold start (serverless) |
| Real-world validation | 2 | **3** | 534-case benchmark with documented references | **No real users' weighed meals** |

Overall 7.0 is the judgement across these, weighted towards what a paying user experiences (identification, totals, honesty about uncertainty) and capped by the absence of real-world validation. It isn't an average dressed up as a measurement.

## 5. Security assessment

- **Isolation:** every nutrition query is scoped by the authenticated client. The new `meal_log_requests` table is under forced RLS, **verified on PostgreSQL**: one gym cannot read another's requests or write a log for another gym's client. A request id is scoped to its owner (tested), so one member's id can never replay another's log.
- **Integrity:** the server re-prices database items and ignores client calories for them (a tampered 9,999 kcal is stored as the real value; tested). "Verified" provenance can't be claimed by a client (schema-rejected; tested).
- **Duplicates:** retries and concurrent duplicates write once (SQLite and PostgreSQL tests).
- **Validation:** all new fields zod-validated; the supplements route, previously unvalidated, now is.
- **Secrets:** AI provider keys remain server-only (no `VITE_*` AI keys).
- **Not done:** no independent penetration test; rate limits unchanged (40/min plate, AI limited).

## 6. Outstanding risks, remaining bugs and known limitations

**Release blockers (not engineering):**
1. **Data licences.** Open Food Facts (ODbL) requires attribution and share-alike; **the app shows no attribution**. INDB ("open academic") and IFCT 2017 (NIN/ICMR) commercial terms are **unverified**. Needs a legal decision; I didn't change any product text.
2. **Recipe-priced dish calories are unvalidated** (18 dishes). They identify correctly and are computed transparently from measured ingredients, but proportions, yields and absorbed oil are curated assumptions.

**Not built from the brief:** AI meal-level decomposition; the corrections → review → benchmark-gated release pipeline (the shared AI cache still auto-updates after 5 agreeing corrections, which is a policy decision for you); supplement intake tracking (list only); use of diet type / food exclusions; an activity-level field; photo-based portion estimation in the live UI; refactoring the 2,304-line `FoodLogSheet.jsx`; removing the dead `AskSK.jsx`.

**Known bugs / limitations still present:**
- **23 curated staples still carry hand-entered per-100 g values** (vada pav, dal, kadhi, chai, butter chicken and others), each with a one-line basis note. The audit flagged them; they were not converted to computed recipes in this pass.
- Nutrition history compares every past day with the *current* plan target (audit B12).
- `water_logs` uses check-then-insert with no unique key (B13; low impact).
- Size words ("large roti") are recorded and lower portion confidence, but don't change grams.
- Default spreads (1 tsp butter/jam) can under-count. The plate flags them as guessed.
- International composite dishes: median kcal error 17.3%, identity 93.8%.
- A leading countable food in front of an *uncurated* dish can still be read as two foods. Fixed for egg fried rice, egg biryani, egg roll and egg sandwich only.
- V2/V3 engine layers remain opt-in. All live improvements are in the live engine.

**Branch hygiene:** `main` has since advanced (teammates merged [kaushaljainofficial0456/gym_os#23](https://github.com/kaushaljainofficial0456/gym_os/pull/23), [#25](https://github.com/kaushaljainofficial0456/gym_os/pull/25), [#26](https://github.com/kaushaljainofficial0456/gym_os/pull/26)). A trial merge of this branch with the latest `main` is **conflict-free**.

## 7. Performance assessment

- **Meal parsing:** 47 meals/second per CPU core, measured over every v2 benchmark input three times. Median 13 ms, p95 69 ms, p99 106 ms, max 148 ms. In the benchmark harness the median per-meal time rose from 8.1 ms (original engine) to 13.9 ms, the cost of the coverage and segmentation passes. That is still far below anything a user can perceive.
- **Cold start:** loading the food index takes 641 ms and about 75 MB per process. Fine on a long-running server; on serverless it is paid on every cold start (already true before this work).
- **Not done:** HTTP load test of the nutrition endpoints (they sit behind a 40/min per-user limit, so a load test would mostly measure the limiter), and a Postgres pool test under concurrent logging.

## 8. What it takes to reach 9/10

1. **Real-world validation.** 50–100 real logged meals with weighed portions, Indian and international, scored with the existing harness. This is the single largest gap.
2. **Validate the recipe dishes**, either against weighed home recipes or lab values, and adjust proportions, yields and oil.
3. **Legal sign-off** on INDB / IFCT terms and add Open Food Facts attribution.
4. **International coverage pass** (identity ≥ 95%), using the same staple/recipe approach that lifted Indian food.
5. **AI meal decomposition** for sentences the engine can't resolve, through the existing grounded pipeline.
6. **Corrections pipeline:** reviewer approval plus a benchmark gate before any shared value changes.
7. **Browser end-to-end tests** for the plate flow (Playwright is already set up), and a load test on Postgres.

## 9. Test status at hand-off

| Suite | Result |
|---|---|
| Backend `node --test` (SQLite) | 2,114 tests, **0 failures**, 6 skipped (Postgres-only tests without a database URL) |
| Postgres integration (local PostgreSQL 16, at `e4988f4`) | communityPg, financialRls, groupByParamsPg, mealLogPg: **33/33 pass** |
| Frontend `vitest` | 213 tests, **0 failures** |
| Frontend production build | OK |
| Benchmark gates v1 / v2 | PASS; v2 invariants: 0 silent drops, 0 fabrication |
