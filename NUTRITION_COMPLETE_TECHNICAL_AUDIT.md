# Gym OS — Nutrition Module: Complete Technical Audit

**Branch:** `feature/nutrition-engine-overhaul` (cut from `main` @ `04c0389`)
**Audit date:** 2026-11-13
**Method:** read the code paths end to end, ran the full backend suite, ran the existing food benchmark (V1/V2/V3), and probed the live engine with real meal text. Nothing below is assumed from file names alone; every "WORKING" was observed, every "BROKEN" was reproduced.

Status vocabulary: **WORKING** · **PARTIALLY WORKING** · **BROKEN** · **NOT IMPLEMENTED** · **NEEDS VALIDATION**.

---

## 0. Executive summary

The Nutrition module is **far more developed than a 5.5/10 prototype in some places and weaker than it looks in others.**

*Strong:* a real measured food database (21,353 rows from IFCT 2017, INDB, USDA FDC, Canadian Nutrient File, Open Food Facts India), a hand-curated "staples" layer that maps everyday Indian words to the right measured row, food-specific portion sizing (a katori of dal ≠ a katori of poha), deterministic per-100 g arithmetic, an AI tier that grounds every AI-proposed ingredient against the measured DB, provider failover with cooldowns and daily budgets, a 324-case benchmark harness with 18 metrics, and 2,050 backend tests (all passing).

*Weak — and these are the problems that would hurt a paying customer:*

1. **Silent food drops still happen in the live engine** on common Indian phrasing ("masala dosa with sambar" loses the sambar; "rice with rajma…" loses the rice; "chole bhature" loses the bhature).
2. **Confident wrong identities** on flagship Indian foods: "2 homemade aloo parathas" → USDA *Potato pancake* (high confidence); "puran poli" → *Polish sausage*; "misal pav" → *Pav bhaji*; "rajma" (in a phrase) → *raw dried kidney beans*, 100 g assumed, labelled high.
3. **The UI lets a user log a plate while "not found" items are still listed** — the unresolved food is shown, then not logged, with no acknowledgement. It is a visible drop, but a drop.
4. **Provenance is lost at write time.** A verified-database match is stored in `meal_logs.source` as `'manual'`. Grams, `source_id`, fibre/sugar/sodium and the verified/estimated distinction are not persisted.
5. **The server trusts client-computed calories** for every plate log; it never re-prices a database-matched item.
6. **No idempotency** on meal logging — a retried request double-logs a meal.
7. The improved engines (V2 plausibility, V3 composite decomposition) **exist but are not wired into any live route**; production runs V1.
8. The benchmark has **324 cases (target ≥ 500)**, misses most of the failures above, and its own calibration shows `high` confidence is right only **72%** of the time (nominal 90%).
9. Confidence is a **single label** taken from the matched row; it does not separate identity vs portion vs composition certainty.
10. Data-licence compliance is **unverified** for INDB and IFCT; Open Food Facts (ODbL) data is used with **no attribution anywhere in the product**.

---

## 1. Architecture map (as it actually executes)

```
                         ┌──────────────────────────── FRONTEND (React/Vite) ─────────────────────────────┐
                         │ pages/client/Nutrition.jsx  (Today's Fuel, rings, water, supplements, log list) │
                         │   ├─ LogCard.jsx ─────────────┐   inline "what did you eat?" card               │
                         │   ├─ PlateSheet.jsx (lazy) ───┤   plate logger: describe → adjust → log         │
                         │   │    ├─ FoodResults.jsx     │   type-ahead search                             │
                         │   │    ├─ PlateRow.jsx        │   qty / unit / oil chips, swap alternatives     │
                         │   │    └─ plate.js / ai.js    │   pure pricing math (proportion only)           │
                         │   ├─ FoodLogSheet.jsx (2,304 lines) "classic": search, barcode, label scan, AI  │
                         │   ├─ CustomizeMealSheet / MyDietCard / MealFoodRow  (saved meals & my foods)    │
                         │   ├─ NutritionTargetSetup.jsx, CalorieBalance.jsx (flexible balance)            │
                         │   └─ NetEnergyCard, FuelRings, MealInfoSheet, ShareMealsSheet                   │
                         │ pages/client/NutritionTracker.jsx (history calendar) · DailyHistory.jsx         │
                         │ pages/trainer/NutritionBuilder.jsx, ClientProfile.jsx (plans)                   │
                         └──────────────┬─────────────────────────────────────────────────────────────────┘
                                        │ fetch (httpOnly cookie auth)
┌───────────────────────────────────────▼──── BACKEND (Express 5, Node 22) ─────────────────────────────────┐
│ routes/me.js          /me/nutrition/{describe,item,log-batch,usuals,recent-meals,repeat,targets,balance*}  │
│                       /me/foods/{search,resolve,ai-estimate,ai-estimate/adjust,from-model,recent}, /me/meals│
│                       /me/meal-logs/:id (PUT/DELETE), /me/food-feedback, /me/energy/balance               │
│ routes/nutrition.js   /nutrition/plans*, /clients/:id/{meals,meals/log,meals/toggle,meals/ai-estimate,     │
│                       nutrition-summary,history}, /estimate-items, /ai-estimate (trainer)                  │
│ routes/tracking.js    /tracking/clients/:id/{water,supplements}                                            │
│ routes/intelligence.js /intel/{foods/barcode/:code, label-scan, foods/label, meal-photo, parse-food, ...}  │
│                                                                                                            │
│   services/food/index.js ── engine.js  estimateMeal(V1 default │ V2 │ V3)  ◄── LIVE ROUTES CALL V1 ONLY      │
│                               │   ├─ plausibility.js  (V2: confidence downgrade + quarantine rescue)         │
│                               │   ├─ classify.js + decompose.js (V3: composite_map templates)               │
│                               │   └─ pipeline.js / types.js (staged IR — scaffold, not live)                │
│                               ▼                                                                            │
│   services/foodEstimator.js  splitItems → expandFragments → parseFragment → search → resolveGrams →        │
│                              scaleNutrition → items[] + unresolved[]      (THE live meal parser)           │
│        ├─ food/staples.js  ~150 curated everyday foods → measured row + natural units                      │
│        └─ ml/models/skos-food-v1/*.reference.js  FoodSearch, toGrams, portionToGrams, adjustOil,            │
│                              CompositionalCalculator, FallbackKnnIndex, BarcodeIndex (CommonJS, shared w/ Py) │
│                                                                                                            │
│   services/intelligence/foodAI.js  Tier 4: LLM proposes components → each grounded via the measured DB     │
│        ├─ aiProvider.js   Groq → Gemini → OpenRouter → Ollama, timeouts, JSON mode                          │
│        ├─ foodAICache.js  shared per-dish cache (ai_food_estimates)                                         │
│        └─ foodFeedback.js user corrections → aggregated → may update shared cache                          │
│   services/nutrition/flexibleBalance.js   surplus redistribution across days                               │
│   services/barcodeLookup.js  local OFF snapshot → DB cache → live OFF API                                  │
└───────────────────────────────────────┬────────────────────────────────────────────────────────────────────┘
                                        ▼
        SQLite (dev/test) │ PostgreSQL on Neon with RLS (staging/prod)  — schema: database/schema.sql + init-db.js MIGRATIONS
        Static model data: ml/data/processed/unified_food_db.json (14.6 MB, loaded lazily once per process)
```

---

## 2. Frontend component map

| Component | Mounted? | Calls | Status |
|---|---|---|---|
| `pages/client/Nutrition.jsx` | Yes (`/client/nutrition`) | `/me/nutrition/balance`, `/me/nutrition/usuals`, `/me/meal-logs/:id` PUT/DELETE, `/nutrition/clients/:id/meals/{log,toggle}`, `/tracking/.../{water,supplements}` | WORKING |
| `logger/LogCard.jsx` | Yes (inline on Nutrition) | `/me/nutrition/describe`, `/me/nutrition/log-batch` | PARTIALLY WORKING — can log while unresolved items are listed |
| `logger/PlateSheet.jsx` | Yes (lazy) | describe, item, log-batch, recent-meals, repeat, usuals | PARTIALLY WORKING — same unresolved-at-log issue; no idempotency key |
| `logger/plate.js` | Yes | — (pure) | WORKING (proportional re-pricing); `toLogItems` stamps DB matches as `source:'manual'` → provenance loss |
| `logger/ai.js` | Yes | `/me/foods/ai-estimate` | WORKING (explicit tap only) |
| `FoodLogSheet.jsx` (2,304 lines) | Yes ("classic" mode: search / barcode / label / AI) | `/me/foods/*`, `/intel/foods/barcode/*`, `/intel/label-scan`, `/me/food-feedback` | WORKING but oversized; NEEDS VALIDATION in browser |
| `CustomizeMealSheet`, `MyDietCard`, `MealFoodRow`, `AIEstimateCard` | Yes | `/me/meals*`, `/me/foods*` | WORKING (saved meals / my foods) |
| `NutritionTargetSetup.jsx` | Yes | `/me/nutrition/targets`, `/confirm` | WORKING |
| `CalorieBalance.jsx` | Yes | `/me/nutrition/balance/*` | WORKING (65+ tests) |
| `NetEnergyCard`, `FuelRings(Scene)`, `MealInfoSheet`, `ShareMealsSheet` | Yes | `/me/energy/balance`, `/me/share` | WORKING |
| `NutritionTracker.jsx`, `DailyHistory.jsx` | Yes (routes in App.jsx) | `/nutrition/clients/:id/history` | WORKING; historical days are compared against the *current* plan target |
| `components/AskSK.jsx` | **No — imported nowhere** | `/intel/parse-food`, `/intel/confirm-food`, `/intel/meal-photo`, label scan | DEAD CODE (keeps 3 backend routes reachable but unused by the UI) |
| `nutritionCalc.js` | Yes | — | WORKING (4/4/9 helper, `sumEatenTotals`) |

## 3. Backend API map (nutrition surface)

| Endpoint | Used by UI | Notes | Status |
|---|---|---|---|
| `POST /me/nutrition/describe` | LogCard, PlateSheet | free text → plate items (V1 engine) | PARTIALLY WORKING (see §5, §9) |
| `POST /me/nutrition/item` | PlateSheet | one food by `source_id` → plate item | WORKING |
| `POST /me/nutrition/log-batch` | LogCard, PlateSheet | transactional insert of N items | PARTIALLY WORKING — trusts client numbers, no idempotency, provenance lost |
| `GET /me/nutrition/usuals`, `/recent-meals`, `POST /repeat` | PlateSheet, Nutrition | quick re-log | WORKING |
| `GET/PUT /me/nutrition/targets`, `POST /confirm` | NutritionTargetSetup | Mifflin-St Jeor | PARTIALLY WORKING (activity = training experience; see §9) |
| `/me/nutrition/balance*` (7 routes) | CalorieBalance | flexible balance | WORKING |
| `GET /me/foods/search`, `POST /me/foods/resolve` | FoodLogSheet, FoodResults | ranked + contains search, portion → grams, oil | WORKING |
| `POST /me/foods/ai-estimate`, `/adjust` | ai.js, FoodLogSheet, MealFoodRow | Tier 4 single dish | WORKING when a provider is configured; 503 otherwise |
| `POST /me/food-feedback` | FoodLogSheet | correction → aggregation | PARTIALLY WORKING (§10) |
| `/me/meals*`, `/me/meals/:id/items*` | saved meals | templates | WORKING |
| `PUT/DELETE /me/meal-logs/:id` | Nutrition | edit qty / delete | WORKING |
| `/nutrition/clients/:id/{meals,meals/log,meals/toggle,history,nutrition-summary}` | Nutrition, Tracker, trainer | plan meals + history | WORKING |
| `/nutrition/plans*`, `/estimate-items`, `/ai-estimate` | NutritionBuilder | trainer plans | WORKING |
| `/tracking/clients/:id/water` | Nutrition | one row/day, absolute litres | WORKING |
| `/tracking/clients/:id/supplements` (GET/POST/DELETE) | Nutrition | list only | PARTIALLY WORKING — **POST has no input validation**; no intake ("taken today") tracking |
| `/intel/foods/barcode/:code`, `/manual`, `/label-scan`, `/foods/label` | FoodLogSheet | packaged foods | WORKING (NEEDS VALIDATION with real labels) |
| `/intel/parse-food`, `/confirm-food`, `/meal-photo` | **AskSK only (dead)** | | UNUSED |

## 4. Database schema overview (nutrition)

| Table | Purpose | Gaps |
|---|---|---|
| `meal_logs` | every logged food row | **no** `grams`, `source_id`, `nutrition_source`, fibre/sugar/sodium, `confidence` (except `ai_confidence`), no idempotency key. `source` ∈ plan/ai/manual/custom/ai_estimated…; DB matches are written as `manual`. |
| `foods` | global + gym + client ("My Foods") foods, barcode cache | `source` column exists (VERIFIED_DATABASE / USER_ENTERED / PACKAGING_LABEL / OCR_EXTRACTED / ESTIMATED) — good model, not mirrored onto logs |
| `client_meal_templates` + `meal_items` | saved meals | `meal_items.source` distinguishes database vs AI — good |
| `nutrition_plans` + `meals` | trainer / self targets | history compares every past day to the latest plan |
| `nutrition_balance_*` (3 tables) | flexible balance | well tested |
| `ai_food_estimates`, `ai_food_feedback`, `ai_provider_cost_state` | AI cache, corrections, cost state | see §10 |
| `water_logs` | litres per day | no unique (client_id, date) — check-then-insert race can create two rows |
| `supplements` | supplement list | no intake log table |
| `intelligence_events` | trace of intelligent actions | exists; not used by the plate logger |

Migrations: additive `MIGRATIONS` list in `backend/scripts/init-db.js` (runs on SQLite and PG). RLS policies in `database/rls.sql` (PG only). Pattern is sound and is reused for the changes in this overhaul.

## 5. Food intelligence execution flow (live path)

`POST /me/nutrition/describe {text}` → `describeMeal(text)` → `estimateFood(text)` (V1):

1. `splitItems` — split on `, ; + & \n` and the word **and**.
2. `expandFragments` — `X with Y` split *only if both halves independently match a trustworthy row and the whole phrase is not itself a catalogued dish*; "rajma chawal"-style pair split when both halves are staples.
3. `parseFragment` — strip leading narration, read quantity (digits, words, fractions, "150g"), unit (mass/volume or a portion-catalogue word), countable-food-as-unit ("2 rotis"), companion food ("two rotis with dal").
4. `search.search(name)` — **staples first** (curated), then the 21,353-row index (`FoodSearch`: exact → alias → token/prefix scoring).
5. trust gate — a row with a `data_quality_flag` is reported unresolved, never summed.
6. `resolveGrams` — pack weight → staple unit → explicit g/ml → portion catalogue (food-specific) → the row's measured serving → **100 g flagged assumed**.
7. `scaleNutrition(row, grams)` — per-100 g × grams / 100. **Deterministic. Good.**
8. Totals, worst-item confidence, `unresolved[]`, disclaimer.

**Where values originate:** measured rows (IFCT/INDB/USDA/CNF/OFF), a few staple `inline` values with a written basis, kNN neighbours (V2 rescue only), AI components (Tier 4). **Where calculations happen:** `scaleNutrition` (server); the plate re-prices client-side by proportion from server-supplied per-100 g values. **Where data is persisted:** `meal_logs` via `log-batch` with **client-computed** numbers.

### 5.1 Live probes (V1, exactly as returned)

| Input | What the live engine logged | Verdict |
|---|---|---|
| 2 homemade aloo parathas with curd and chai | **Potato pancake, homemade** (USDA) 2×76 g, 407 kcal, *high*; curd; chai | **BROKEN** identity (staple exists but "homemade" + plural defeat it) |
| paneer bhurji with 2 rotis | **Paneer** (plain) 100 g 305 kcal *high* + 2 roti | **BROKEN** — bhurji identity lost |
| rice with rajma and a side salad | **Rajmah raw dried** 100 g assumed 299 kcal *high*; potato salad; **rice missing** | **BROKEN** — silent drop + wrong state |
| masala dosa with sambar | masala dosa only, 346 kcal | **BROKEN** — sambar silently dropped |
| chole bhature | chickpea curry only | **BROKEN** — bhature dropped |
| 1 plate misal pav | **Pav bhaji** 581 g | **BROKEN** identity |
| puran poli | **Polish sausage** 337 kcal (low) | **BROKEN** — counted in total |
| pongal | **Instant Rava Pongal *Mix*** (dry), 100 g assumed | **BROKEN** state |
| thalipeeth, pithla bhakri | unresolved | NOT IMPLEMENTED (honest) |
| kachori | unresolved (frying-bath data flag) | honest, but a top-20 snack has no answer |
| I ate 2 rotis, one bowl of dal, 100 grams of rice and some aloo sabzi | 4 correct items, 834 kcal | WORKING |
| poha, vada pav, pav bhaji, rava dosa, uttapam, samosa, dhokla, thepla, upma, curd rice, lemon rice, dal makhani, palak paneer, kadhi, 1 glass milk, 2 eggs and toast, 200 g chicken breast | correct identity, sensible portions | WORKING |
| xyzzy blorf | unresolved | WORKING (no fabrication) |

## 6. AI provider execution flow

`POST /me/foods/ai-estimate` → `estimateFoodAI` → cache lookup (`canonicalizeFoodQuery`, skips "my mom's…" personal queries) → `callWithFallback`: for each provider in `groq → gemini → openrouter → ollama` skip if unconfigured / on 5-min rate-limit cooldown / over daily budget; call with JSON mode and a 15 s timeout; parse; `validateAIFoodResponse` (schema, weight ≤ 3 kg, kcal ≤ 4000, Atwater 0.5–1.8×); first success wins. Each AI component is then **re-priced from the measured DB** (`resolveComponents`), only ungrounded components keep AI numbers; confidence is **derived by the backend** from grounded fraction + interval width, never trusted from the model. Keys live only in server env (`grep` finds no `VITE_*` AI keys). **Status: WORKING** for single dishes.

Gaps: AI handles **one dish per call** — there is no AI meal decomposition (a multi-food sentence is never sent to AI); no retry-with-backoff on transient 5xx (it fails over instead — acceptable); cost is tracked as a daily *count*, not money; no per-user/day AI cap beyond the route rate limit. **PARTIALLY WORKING** for the brief's "AI identifies → DB resolves → engine calculates" loop: true for components, absent for whole meals.

## 7. Existing benchmark performance (re-run 2026-11-13, dataset v1, 324 cases)

| Metric | V1 (live) | V2 | V3 |
|---|---|---|---|
| Weighted overall | 78.6% | — | 78.0% |
| Food identity accuracy | 92.0% | — | 89.1% |
| kcal median APE (mid-range) | 20.2% | — | 20.0% |
| kcal in reference range | 70.0% | — | 69.0% |
| Unresolved rate | 3.5% | — | 2.6% |
| Fabrication (confident number for a non-food) | 0.0% | 0.0% | 0.0% |
| **Silent drop rate (multi-food cases)** | **10.0%** (2/20) | — | **10.0%** |
| Confidence ECE | 0.113 | — | 0.116 (high: 72% observed vs 90% nominal) |
| Latency p50 / p95 | — | — | 6 ms / 39 ms |

Full reports: `ml/data/benchmark/` (dataset), regenerate with `npm run bench`. **The benchmark is too small (324 < 500), under-represents Maharashtrian/South-Indian composite dishes and "X with Y" phrasing, and therefore overstates real-world identity accuracy** — the probes in §5.1 fail far more often than 92%.

Test suite: `node --test` in `backend/` → **2,050 tests, 2,045 pass, 0 fail, 5 skipped** (Postgres-only tests skip without `TEST_DATABASE_URL`).

## 8. Incomplete implementations

| Item | Status |
|---|---|
| V2/V3 engines (plausibility, composite decomposition) | PARTIALLY WORKING — built + tested, **not wired into any route** |
| Staged pipeline (`pipeline.js`: classify/retrieve/filter/rank/strategy) | NOT IMPLEMENTED beyond scaffold |
| Recipe engine with variants (poha with/without peanuts, oil level) | PARTIALLY — `composite_map` has 60 fixed-fraction templates, no variants, not live; oil "less/more" exists in the plate |
| Multi-dimensional confidence | NOT IMPLEMENTED |
| Provenance on logs | NOT IMPLEMENTED |
| Idempotent logging | NOT IMPLEMENTED |
| Supplement intake tracking | NOT IMPLEMENTED (list only) |
| Micronutrients on the log | NOT IMPLEMENTED (DB has fibre/sugar/sodium + 9 micros; logs drop them) |
| Dietary preference / restriction awareness | NOT IMPLEMENTED |
| Medical safeguards on targets (minors, pregnancy, conditions) | NOT IMPLEMENTED |
| AI meal-level decomposition | NOT IMPLEMENTED |
| Image (meal photo) estimation in the UI | NOT IMPLEMENTED in live UI (route exists, caller is dead `AskSK`) |
| Correction → controlled release pipeline | PARTIALLY (feedback aggregation exists; no review/benchmark gate) |

## 9. Bugs and architectural weaknesses (prioritised)

| # | Finding | Severity | Status |
|---|---|---|---|
| B1 | Silent drop when one fragment names two foods and the whole phrase hits a staple/dish ("masala dosa with sambar", "chole bhature", "rice with rajma") | Critical | BROKEN |
| B2 | Modifier words ("homemade", "home made", "restaurant", "fresh") stay in the search name and defeat staple matching → "Potato pancake" for aloo paratha | Critical | BROKEN |
| B3 | A match sharing **no whole word** with the query is still summed (puran poli → Polish sausage; misal → pav bhaji) | Critical | BROKEN |
| B4 | Dish identity collapses to an ingredient ("paneer bhurji" → plain paneer, *high*) | High | BROKEN |
| B5 | Plate/LogCard can log while unresolved items are listed — no acknowledgement | High | BROKEN |
| B6 | `log-batch` stores client-supplied calories/macros; a DB match is never re-priced server-side | High | PARTIALLY WORKING |
| B7 | DB-matched items stored as `source:'manual'`; grams/source_id/fibre/sugar/sodium discarded | High | BROKEN (provenance) |
| B8 | No idempotency key on `log-batch` / `meals/:id/log` / `repeat` → retries double-log | High | NOT IMPLEMENTED |
| B9 | Confidence = matched row's label; `high` is right 72% of the time | High | PARTIALLY WORKING |
| B10 | Targets: activity multiplier comes from **training experience**, not activity level; protein from `0.82 × weight` overshoots for high body weight; no minors/pregnancy/medical guard | Medium | PARTIALLY WORKING |
| B11 | `POST /tracking/.../supplements` has no schema validation | Medium | BROKEN (validation) |
| B12 | History compares all past days to the latest plan's target | Low | PARTIALLY WORKING |
| B13 | `water_logs` check-then-insert without a unique key | Low | PARTIALLY WORKING |
| B14 | `FoodLogSheet.jsx` is 2,304 lines; `AskSK.jsx` + 3 routes are dead | Low (maintainability) | — |
| B15 | Benchmark too small and blind to B1–B4 | High (process) | PARTIALLY WORKING |

## 10. Security and reliability concerns

| Concern | Finding | Status |
|---|---|---|
| AI keys in frontend | none (server env only) | WORKING |
| AuthN | httpOnly cookie JWT, alg pinned (tests exist) | WORKING |
| AuthZ / isolation | `getClient` / `resolveClient` scope every query by `client_id`; PG RLS on top; `meal-logs/:id` checks `client_id` | WORKING (NEEDS VALIDATION on PG with RLS for new tables) |
| Rate limits | describe/log-batch 40/min, AI estimate limited, feedback 10/min | WORKING |
| Input validation | zod on most routes; **supplements POST unvalidated** | PARTIALLY WORKING |
| Duplicate logging | no idempotency | NOT IMPLEMENTED |
| Transactions | `log-batch`, `repeat` use `db.tx` (all-or-nothing) | WORKING |
| Shared AI cache poisoning | `foodFeedback.js` replaces the shared cached estimate after `MIN_FEEDBACK_COUNT` (default 5) mutually-consistent corrections, labelled `COMMUNITY_VALIDATED_CANDIDATE`; never sets `VERIFIED`. No check against a trusted source and no benchmark gate before the shared value changes | NEEDS VALIDATION / policy decision |
| Data licences | OFF = ODbL → **attribution + share-alike required, not shown anywhere in the app**; INDB licence recorded as "open academic" (unverified); IFCT 2017 is an NIN/ICMR publication (commercial redistribution terms unverified). AGPL IFCT repo correctly avoided | NEEDS VALIDATION (legal) |
| Model artefact availability | engine degrades to "unavailable" (503) if `ml/` missing — not a crash | WORKING |
| Backups / recovery | Neon (PITR is a Neon plan feature) — not verifiable from code | NEEDS VALIDATION |
| Observability | events table + `track()`; AI attempts logged with latency; no per-request nutrition trace | PARTIALLY WORKING |

## 11. Retain (works, keep as the foundation)

- Measured unified food DB + `FoodSearch` + `scaleNutrition` (deterministic per-100 g math).
- Staples layer (`food/staples.js`) — curated everyday-word → measured-row mapping, natural units.
- Food-specific portion catalogue (`portionToGrams`) and the "assumed" flag.
- Trust gate (`data_quality_flag`), never-fabricate contract, `unresolved[]` reporting.
- Tier 4 AI design: AI proposes composition → DB prices components → backend derives confidence; provider chain with cooldown/budget.
- Plate UX (describe → adjust → log), usuals, repeat, saved meals, flexible balance, history.
- Benchmark harness (`backend/src/eval/*`, regression gate) and the 2,050-test suite.
- Additive `MIGRATIONS` pattern, `db.tx`, zod validation, rate limits.

## 12. Improve

- Meal parser: modifier stripping, coverage accounting (no silent drops), whole-word overlap guard, dish-vs-ingredient preference.
- Logging: provenance columns, server re-pricing of DB items, idempotency, unresolved acknowledgement.
- Confidence: identity / portion / composition dimensions with evidence; overall = weakest.
- Targets: activity level separate from experience, adjusted-weight protein for high BMI, safeguards + disclaimer.
- Supplements: validation (+ later: intake log).
- Benchmark: ≥ 500 cases, Indian regional + "X with Y" + composite + packaged slices, per-category reporting.

## 13. Rebuild / build new

- **Recipe-based Indian dish layer** — dishes priced from measured *ingredients* with documented standard recipes, cooking yield and oil, and visible variants. (`composite_map` fixed fractions are a starting point, not sufficient.)
- **Coverage validator** — explicit comparison of identified components against the original text (required by "ZERO SILENT FOOD DROPS").
- **Correction → release pipeline** — corrections stored separately (exists), plus review, trusted-source check and benchmark gate before any shared value changes.

## 14. Prioritised task list

| P | Task | Phase |
|---|---|---|
| P0 | Coverage validator + fix B1–B4 in the live parser | 1 |
| P0 | Unresolved acknowledgement at log time (B5) | 1 |
| P0 | Provenance + server re-pricing + idempotency on `log-batch` (B6–B8) | 1 |
| P1 | Recipe layer for missing/incorrect Indian dishes (puran poli, misal, thalipeeth, pithla, bhakri, pongal, kachori, paneer bhurji, bhature …) | 2–4 |
| P1 | Multi-dimensional confidence (B9) | 5 |
| P1 | Benchmark ≥ 500 cases + report | 8 |
| P2 | Targets: activity level, protein basis, safeguards (B10) | 6 |
| P2 | Supplements validation (B11), water uniqueness (B13) | 7 |
| P2 | Licence attribution (OFF ODbL) + legal confirmation for INDB/IFCT | 7 |
| P3 | Wire V2 plausibility into live path (after benchmark proves no regression) | 5 |
| P3 | Retire `AskSK` dead code, split `FoodLogSheet.jsx` | 7 |

## 15. What I need from you (cannot be resolved in code)

1. **Legal confirmation** of commercial-use terms for INDB and IFCT 2017, and sign-off on adding an Open Food Facts (ODbL) attribution line in the app.
2. **Real-user validation data**: a set of real logged meals with weighed portions (even 50–100) is the only way to measure true portion error; synthetic benchmarks cannot.
3. **Production AI keys / budgets** decision (which providers, monthly cap) — the code supports Groq/Gemini/OpenRouter/Ollama.
4. **Policy decision** on community-corrected AI cache values (§10): keep auto-replacement at N=5, or require reviewer approval.
5. Whether the unmerged remote branches `feat/nutrition-simple-log`, `fix/nutrition-sheets`, `calorie-overhaul` contain work that should be considered (not inspected; they are not on `main`).
