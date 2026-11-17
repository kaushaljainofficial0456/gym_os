# Nutrition Phase 3 — Audit

Branch `feature/nutrition-engine-overhaul` · audited at `576a96c` · 2026-11-17

Every example below was run through the live engine (`estimateFood` / `describeMeal`) at `576a96c`. Each one is reproducible with `node <scratch>/p2probe.mjs "<text>"`, or with the equivalent regression test that now pins it.

## 0. Repository state before any change

| Check | Result |
|---|---|
| Branch | `feature/nutrition-engine-overhaul` |
| Working tree | Clean, with no uncommitted or unknown changes |
| Local vs remote feature branch | Both `576a96c`; 0 ahead, 0 behind; tracking set |
| `main` | `74ea2cd`, 36 commits from teammates since our branch point `04c0389`. Nothing of ours is on it. |
| Divergence risk | `main` has changed `backend/src/routes/me.js` (≈420 lines), `database/schema.sql` and `database/rls.sql` since the branch point, so a future merge needs care. **No merge was attempted.** |
| `docs/RLS-BOUNDARY.md` | Read. RLS policies only engage inside `db.tx()`, where `app.org_id` is set; `db.q()`/`db.q1()`/`db.run()` rely on application filters. **Phase 3 does not change the shared RLS architecture.** |

**Baseline at `576a96c`, before any Phase 3 change:**
- backend: 2,161 tests, 2,155 pass, 0 fail, 6 skipped;
- frontend: 218 pass;
- benchmark gates v1/v2/v3: PASS (84.0% / 87.1% / 90.4%).

## 1. What Phase 1 and 2 actually implemented (verified against code)

| Claim | Verified? | Note |
|---|---|---|
| Live engine is `foodEstimator.js` (V1 deterministic); curated staples → 21,353-row index; computed recipes | Yes | 164 staples, 35 recipes |
| Zero silent drops (coverage accounting) | Yes on the benchmark (CI-enforced) | — |
| Raw/dry vs cooked state-aware staples | Yes for listed staples | Not for cooked *dishes* named after leaves (§3 D2) |
| Server-side pricing + idempotency on both logging paths | Yes (tests, incl. PostgreSQL concurrency) | — |
| Provenance stored and shown | Yes | — |
| Corrections: recorded, personal, shared needs 3 people + admin | Yes (tests) | No explicit **reverse** action (§3 D9) |
| Corrections "RLS-verified" | **Partly.** The writer inserts inside `db.tx()`, so RLS applies, and that is verified on PostgreSQL. The *reads* in `describe` use `db.q()`, so their isolation is the application's `WHERE client_id = ?` filter (tested, but not RLS). | Correcting the Phase 2 wording |
| Activity level, diet defaults, avoid flags; safeguards | Yes (tests) | — |
| v3 headline numbers (identity 97.5%, kcal in range 83.5%, unresolved 1.3%, confidently wrong 18, 945 cases) | **Reproduced exactly** | Benchmark only; same-row caveat stands |
| "Average calorie error 25.3 kcal" (Phase 2 reports) | **Misleading.** In the harness, `mae_resolved` is the distance to the nearest **edge of the accepted band**, which is 0 anywhere inside the band. | Point error against the reference value is **51.2 kcal** (median 6.5). Fixed in Phase 3 by adding `point_error` metrics (§2). |

## 2. Corrected baseline metrics (v3, 945 cases, `576a96c`)

`point_error` was added to the harness in Phase 3. It measures |estimate − reference midpoint| and leaves the historical keys untouched.

| Nutrient | Cases | Edge "MAE" (old) | **Point MAE** | Median abs error | Within ±10% | Within ±20% |
|---|---:|---:|---:|---:|---:|---:|
| kcal | 675 | 25.3 | **51.2 kcal** | 6.5 kcal | 59.6% | 74.5% |
| Protein | 674 | 0.7 | **2.0 g** | 0.4 g | 51.7% | 66.5% |
| Carbohydrate | 632 | 2.6 | **6.0 g** | 1.4 g | 46.3% | 62.5% |
| Fat | 672 | 1.9 | **3.5 g** | 0.3 g | 37.8% | 52.0% |

Fat is the weakest nutrient, consistent with oil being the largest unmodelled variable.

## 3. Reproduced defects

| ID | Severity | Input → output at `576a96c` | Root cause | Fix | Proof |
|---|---|---|---|---|---|
| **D1** | **Critical** | "One medium paneer paratha with curd, **no butter**" → adds *"Cookie, peanut butter with rice cereal, no bake"* (100 g, **+417 kcal**). "coffee **without sugar**" → *"Coffee, pre-sweetened with sugar"* | No negation handling. "no butter" is split off as its own fragment and searched as a food; "without" is ignored, so "sugar" drives the match. | Recognise exclusion phrases (no / without / zero / minus …). An excluded food is never added; it is recorded as a modifier on the item it qualifies, and a sugar-free variant is chosen where one exists. | Regression tests on all of these phrasings, plus a benchmark trap set |
| **D2** | **High** | "1 katori palak paneer" → **37.5 g** (29 kcal). Same for saag paneer and aloo palak; "palak chicken" also 37.5 g | The reference density table (`DENSITY_PATTERNS`) gives "palak/spinach/leaves" **0.25 g/ml**, the figure for raw leaves. `effectiveDensity`'s wet-dish list lacks paneer/saag/palak dishes, so a cooked curry is weighed as raw leaves. | In the JS engine (the reference stays byte-identical for Python parity): a **cooked** dish never uses a raw-leaf or spice-powder density in a container; it uses a cooked-dish density | Tests on palak paneer, saag paneer, aloo palak, sarson ka saag |
| **D3** | **High** | "I had half a plate biryani and **a little raita.**" → raita **unresolved** (*no confident match for "little raita."*). "a little rice" → *"Rice, cooked, NFS"* at low identification | The cleaner keeps "." for decimals, so a sentence-final "raita." is searched with its full stop. "a little" / "a bit of" are not quantity words, so "little" stays in the food name. | Strip sentence punctuation that isn't a decimal. Read "a little / a bit of / a small amount of" as a **small assumed portion** (about half the default), flagged as assumed. | Tests on these two sentences and variants |
| **D4** | **High** | "One bowl **oats with milk**, banana and almonds" → oats *cooked in water* (300 g) **plus a separate 250 g glass of milk**, double-counting the milk | `splitWithConjunction` treats "with milk" as a second food. Its whole-dish guard searches the phrase *with* the leading amount ("One bowl oats with milk"), which matches no staple, so it splits. | Check the whole phrase *without* its amount against the curated names ("oats with milk" → oats porridge) before splitting. The liquid a food is prepared in is part of the food. | Tests: oats/porridge with milk, tea/coffee with milk |
| **D5** | **High** | "mushroom masala" → **raw enoki** (55 kcal/katori); "keema" → **keema pancake**; "palak chicken" → **lasagna**; "kadai paneer" → paneer butter masala; "tandoori / rumali / missi roti" → plain roti (flagged); "makki di roti" → unresolved | No curated entry for these common dishes, so the token-overlap search returns the nearest *title*, not the right *food* | Curated entries priced from measured rows or computed recipes; never an invented reference | Identity tests per dish |
| D6 | Medium | Default (unstated) servings taken from INDB `serving_grams`: pesarattu **26.6 g**, veg pulao plate **472 g**, appam **153 g at 268 kcal/100 g, 22.6 g fat** (an appam is steamed, not fried) | INDB serving weights are used as defaults without a plausibility check; the INDB appam composition looks like a frying-oil error | Plausibility bounds on default servings; quarantine implausible compositions and price them from a recipe | Tests |
| D7 | Medium | Phase 2 reported an edge-distance "MAE" as "average calorie error" | Harness metric naming | `point_error` metrics added (§2); reports use them | Harness output |
| D8 | Medium | An unmeasured nutrient (IFCT paneer carbohydrate) is **stored as 0** in `meal_logs` | `carbs/protein/fat` are `NOT NULL` | Backward-compatible nullable migration; writer, totals, API and UI distinguish unknown from 0; history not rewritten | Tests (SQLite + PostgreSQL) |
| D9 | Medium | No way to **reverse** a recorded correction; reversal is only implicit (swap back) | Not built in Phase 2 | Reverse endpoint: the person marks a correction reversed, with history kept and learning updated | Tests incl. cross-gym |
| D10 | Medium | Calibration: overall ECE 0.213, under-confident (meals labelled "low" are right ~95%) | Meal confidence = weakest item, and an assumed default portion always makes the portion dimension "low" | Calibrate on a **held-out** split, never on the scored set | Held-out ECE before/after |
| D11 | Low | "idli sambar" → **1** idli by default | Default count 1 for a food normally served in pairs | Customary-pair default (as for pav) | Test |

## 4. Order of work

1. **D1 Negation** (critical: it fabricates food and inverts meaning)
2. **D2 Cooked-dish density** (4× under-count on everyday curries)
3. **D3 Punctuation and vague amounts**
4. **D4 Preparation liquid is not a second food**
5. **D5 Missing everyday dishes and breads**

Then D6 → D8 → D9 → D10, followed by benchmark expansion, load and end-to-end tests, and the final reports.

## 5. Out of scope, or needing approval

- **Photo estimation:** not started. A paid provider needs approval.
- **Licensing:** IFCT permission and INDB licence. **Blocked** on third parties; attribution needs owner approval.
- **Shared RLS architecture (`db.q` org scoping):** not changed. It is owned by the RLS workstream (`docs/RLS-BOUNDARY.md`).
- **Real-world weighed meals:** no data exists. Validation stays **pending real-world evidence**.
