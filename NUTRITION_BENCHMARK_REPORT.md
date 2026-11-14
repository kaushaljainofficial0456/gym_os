# Gym OS Nutrition — Benchmark Report (baseline vs improved)

**Branch:** `feature/nutrition-engine-overhaul` · **Date:** 2026-11-14
**Compared:** the *original* engine (`main` @ `04c0389`, before this overhaul) vs the *improved* engine (this branch), **same scorer, same datasets**, both run in this session. Raw output: `docs/nutrition/benchmark/final/`. Reproduce: see §9.

Nothing in this report is estimated or assumed: every number was produced by `backend/scripts/food-benchmark.js` (or the slice/calibration scripts in §9) against the committed datasets.

---

## 1. Summary

| | Original | Improved |
|---|---|---|
| **Silent food drops** (multi-food cases, v2) | **28.1%** (25 cases) | **0%** |
| Food identity accuracy (v2, 534 cases) | 92.2% | **95.3%** |
| Indian food identity (255 cases) | 90.9% | **96.8%** |
| Confident-wrong answers slipping through (v2) | 8.2% | **3.6%** |
| Unresolved (v2) | 4.2% | **2.3%** |
| Fabrication (confident number for a non-food) | 0% | 0% |
| Weighted overall (v2) | 78.5% | **86.0%** |
| Cases scoring lower than the original engine | — | **0 of 534** |
| Calibration error, independently measurable cases (§5) | 0.133 | **0.078** |

What did **not** improve, stated plainly: calorie and macro *accuracy* on foods that were already identified correctly is essentially unchanged (kcal in range 75.5% → 75.5% on v2), because it is bounded by the database values and the default portion sizes, which this overhaul did not change. International composite dishes remain the weakest category (median kcal error 17.3%).

## 2. Datasets

| Dataset | Cases | Nutrition-scored | Purpose |
|---|---:|---:|---|
| **v1** (`food_eval_set.v1.json`) | 324 | 306 | The pre-existing frozen benchmark. Kept for historical comparison. |
| **v2** (`food_eval_set.v2.json`) | **534** | **426** | v1 + 210 cases added by this overhaul (`case_specs.v2.mjs`). |

The 210 new cases:

| Group | n | Ground truth |
|---|---:|---|
| Indian dishes at an explicit weight ("200g rajma curry") | 40 | INDB row × grams ±22% (`db_row_scaled`) |
| Indian ingredients at an explicit weight ("50g moth beans") | 20 | IFCT 2017 / USDA row × grams ±20% |
| Weighed Indian multi-food meals ("150g rice, 150g dal makhani and 50g curd") | 15 | **sum** of independently selected rows ±22% (`db_sum_scaled`, new) |
| Natural-language Indian meals ("2 homemade aloo parathas with curd and chai") | 40 | identity of every item + silent-drop check |
| Regional dishes priced from the engine's own recipes (misal, thalipeeth, pithla…) | 20 | **identity only** — see §6 |
| International foods at an explicit weight | 25 | USDA / CNF row × grams ±22% |
| Weighed international meals | 8 | sum of rows ±22% |
| International dishes/drinks by name | 15 | identity only |
| Packaged / branded (Open Food Facts labels) | 12 | label row × grams ±25% |
| Ambiguity, honesty and silent-drop traps | 15 | identity / unresolved behaviour |

**Reference rows are chosen by each case's own criteria** (source preference + name regex + cooking state), never by the engine's ranker. All 243 database anchors resolved (0 unmatched). Every case records its ground-truth method and source in the dataset.

## 3. Headline results

| Metric | v1 original | v1 improved | v2 original | v2 improved |
|---|---|---|---|---|
| Weighted overall | 79.0% | **82.9%** | 78.5% | **86.0%** |
| Food identity accuracy | 93.3% | 93.7% | 92.2% | **95.3%** |
| Portion accuracy | 81.1% | 81.4% | 85.9% | 86.2% |
| kcal in range | 70.0% | 69.7% | 75.5% | 75.5% |
| kcal median error (vs range mid) | 20.2% | 20.6% | 9.9% | 9.6% |
| kcal MAE (resolved) | 55.1 kcal | 53.6 kcal | 41.9 kcal | 40.9 kcal |
| Protein in range / median error | 74.1% / 23.3% | 74.1% / 24.2% | 77.7% / 14.3% | 77.7% / 14.3% |
| Carbs in range / median error | 67.8% / 27.8% | 68.2% / 25.9% | 73.2% / 15.6% | 73.9% / 15.3% |
| Fat in range / median error | 68.0% / 36.0% | 68.4% / 35.5% | 72.1% / 22.1% | 72.4% / 22.5% |
| Confident-wrong (plausibility false negatives) | 8.0% | **4.0%** | 8.2% | **3.6%** |
| Unresolved rate | 3.5% | 3.2% | 4.2% | **2.3%** |
| Fabrication rate | 0% | 0% | 0% | 0% |
| **Silent drops (multi-food cases)** | **10.0%** | **0%** | **28.1%** | **0%** |
| Calibration error (ECE, all cases — see §5) | 0.127 | 0.095 | 0.089 | 0.202 |
| Latency p50 / p95 | 7.5 / 40.9 ms | 12.1 / 63.7 ms | 8.1 / 53 ms | 13.9 / 65.3 ms |
| Cases better / worse than original | | 28 / **0** | | 74 / **0** |

The v1 and v2 numbers differ for the same engine because v2 adds 210 cases with a different mix (many explicit-weight cases, which are easier for calories).

## 4. Per category (v2) — weak categories are not averaged away

| Slice | n | Score | Identity | kcal in range | median kcal error | Unresolved | Silent drops | Confident-wrong |
|---|---:|---|---|---|---|---|---|---|
| ALL | 534 | 78.5% → **86.0%** | 92.2% → **95.3%** | 75.5% → **75.5%** | 9.9% → **9.6%** | 4.2% → **2.3%** | 25 → **0** | 54 → **21** |
| **Indian (all)** | 255 | 82.0% → **89.9%** | 90.9% → **96.8%** | 85.2% → **85.2%** | 2.6% → **2.4%** | 4.7% → **1.2%** | 24 → **0** | 24 → **9** |
| Indian v2 additions | 135 | 75.9% → **92.5%** | 88.0% → **97.8%** | 89.3% → **89.3%** | 0.2% → **0.2%** | 7.4% → **0.7%** | 19 → **0** | 16 → **5** |
| **International** | 267 | 76.7% → **81.0%** | 93.3% → **93.8%** | 67.9% → **67.9%** | 17.9% → **17.3%** | 3.8% → **3.4%** | 1 → **0** | 30 → **12** |
| **Packaged / branded** | 25 | 59.8% → **75.1%** | 96.0% → **96.0%** | 68.0% → **68.0%** | 2.4% → **2.4%** | 0% → **0%** | 0 → **0** | 3 → **0** |
| **Composite dishes** | 164 | 74.7% → **85.3%** | 84.5% → **91.4%** | 78.9% → **78.9%** | 18.8% → **18.8%** | 12.9% → **6.7%** | 0 → **0** | 16 → **5** |
| **Multi-food meals** | 89 | 75.2% → **95.3%** | 93.0% → **98.8%** | 90.2% → **87.8%** | 3.9% → **3.2%** | 1.1% → **1.1%** | 25 → **0** | 6 → **1** |
| Regional recipe dishes | 20 | 33.5% → **100%** | 36.4% → **100%** | — | — | 45% → **0%** | 0 → **0** | 5 → **0** |
| Explicit weight (well specified) | 249 | 87.9% → **89.7%** | 94.7% → **94.7%** | 81.2% → **81.6%** | 1.3% → **1.2%** | 1.6% → **1.6%** | 0 → **0** | 23 → **13** |
| Traps / ambiguity | 15 | 71.4% → **98.9%** | 84.6% → **100%** | — | — | 0% → **0%** | 4 → **0** | 0 → **0** |

**Weak spots:**
- **International identity 93.8% (below the 95% target)** and international composite calories (median error 17.3%, in range 67.9%). The overhaul focused on Indian food; international dishes still rely on single-row matching.
- **Composite dishes: median kcal error 18.8%.** Recipe variance is real (bands are ±30–40%), but this is the category where users will see the largest disagreements with their own expectations.
- **Multi-food meals: kcal in range fell 90.2% → 87.8%.** Traced to one case: "2 slices toast with butter and jam" is now correctly three items, but the default spread portions (1 tsp butter, 1 tsp jam) total 184 kcal against a reference band of 200–460 that assumes 10 g butter + 15 g jam. The original engine landed in range with a *wrong* identity. The plate flags these amounts as guessed.
- **Packaged: only 25 cases.** Too few to make claims about packaged-food accuracy.

## 5. Confidence calibration — three views

Calibration asks: of items labelled *high / medium / low*, how often is the estimate actually right (identity correct **and** calories in the reference band)? Nominal targets are 90% / 65% / 40%.

| View | Original (ECE · high · medium · low) | Improved |
|---|---|---|
| All 534 cases | 0.089 · 80% · 70% · 52% | 0.202 · 87% · 83% · 68% |
| Nutrition-scored only (426) | 0.090 · 78% · 68% · 50% | 0.131 · 87% · 82% · 52% |
| **Independently measurable** (nutrition-scored, excluding same-row cases) | **0.133 · 70% · 61% · 45%** | **0.078 · 81% · 73% · 47%** |

Why three views, and which one is right:
- **108 v2 cases are identity-only by design.** There, an item correctly marked "amount unsure" still counts as fully correct, which makes honest uncertainty look like *under*-confidence. That inflates the all-case ECE.
- **113 v2 cases are priced from the same row the reference was taken from** (e.g. "200g rajma curry" vs INDB's rajma curry). They are correct by construction: they test parsing and arithmetic, not real-world recipe variance. Excluding them is the only view that measures whether a confidence label predicts real-world error.
- On that view the improved engine is **much better calibrated (ECE 0.133 → 0.078)**, and crucially it no longer over-claims: the original said "high" for answers that were right 70% of the time; the improved engine's "high" is right 81% of the time.
- The remaining gap is mild *under*-confidence on medium/low, the safe direction. I did not tune thresholds to this benchmark, because the same-row cases would have pulled the thresholds towards false precision.

On v1 (all cases) calibration improved 0.127 → 0.095.

## 6. Release targets from the brief

| Target | Result (v2) | Status |
|---|---|---|
| Food identification ≥ 95% | 95.3% overall; Indian 96.8%; **international 93.8%**; composite 91.4% | Met overall and for Indian food; **not met** for international and composite |
| Median kcal error < 10% for sufficiently specified meals | 1.2% on explicit-weight cases (but 113 same-row cases make this optimistic); 9.6% overall | Met on this benchmark; **needs real weighed meals to confirm** |
| Zero silent food omissions | 0 of 89 multi-food cases (was 25); enforced by a CI test | **Met** |
| Ingredient identification ≥ 95% on supported cases | 98.8% of items in multi-food meals | Met |
| Macro thresholds | Protein 14.3% / carbs 15.3% / fat 22.5% median error; in-range 78% / 74% / 72% | Measured; **no threshold has been agreed** — fat is the weakest |
| Confidence corresponds to observed accuracy | ECE 0.078 on independently measurable cases; "high" = 81% observed | Improved; mild under-confidence remains |
| No unexplained numerical inconsistencies | Totals = Σ items (tested); recipe values Atwater-consistent (tested) | Met |
| No data loss during logging | Idempotent, transactional logging and the server-side record of knowingly-excluded items are tested; the second-tap "Log anyway" confirmation is UI code covered by its pure helpers, not by a browser test | Met in backend tests; **UI flow not browser-tested; not load-tested on Postgres** |

**Recipe-priced dishes (misal, thalipeeth, pithla, bhakri, pongal, paneer bhurji/tikka, bhatura, kachori, aloo tikki, sabudana vada, modak, sheera, zunka, usal) have no independent calorie validation.** They identify correctly (100% of 20 cases), and their values are computed from measured ingredients by documented recipes. But no measured reference exists to score them against, and scoring them against the engine's own recipes would be circular. They need lab or weighed-recipe validation before their calorie numbers are claimed as accurate.

## 7. Changes to the scorer and dataset during the overhaul (full disclosure)

Every change below is in git history with its reason:
1. **Clarification counts as reported.** A word the engine could not account for but *reported* (`needs_clarification`) is not a silent drop. Affects `mel-008` "paneer bhurji with 2 rotis", which was later resolved properly by the paneer bhurji recipe anyway.
2. **Decompose-strategy cases** (`expect.strategy: 'decompose'`) answered with several items are judged on the combined dish and weight, not `items[0]` alone. Affects `cmp-007` (+0.55) and `cmp-008` (−0.03).
3. **Four v1 case regexes corrected** (`sng-026`, `sng-048`, `x-sng-018`, `x-bev-005`): they rejected the correct USDA row on word order alone ("Beans, kidney, …" vs `kidney bean`). Dated comments in the specs. The original engine was re-run on the corrected sets, so the comparison above is like-for-like.
4. The original frozen baseline is preserved unchanged as `baseline.v1.pre-overhaul.json`.

## 8. Limitations of this benchmark

- **It is synthetic.** Inputs are written by engineers, not logged by users, and portions are reference portions, not weighed plates. Real-world accuracy is unknown until real logged meals with weighed portions are collected (even 50–100 would help).
- **Database values are taken as truth.** Some INDB rows look low (dal makhani 74 kcal/100 g, palak paneer 78), and when the engine and reference use the same row, a wrong row is invisible.
- **Published-range cases (93)** come from the original benchmark authors' references and are wide by design.
- **Packaged foods are under-represented (25 cases).**

## 9. Reproduce

```bash
npm run setup
npm run bench:build:v2
npm run bench
npm run bench:v2
```

`bench` runs the live engine on v1 (the CI test `foodBenchmarkGate.test.js` compares it with `baseline.v1.json`); `bench:v2` runs it on v2 and compares with `baseline.v2.json`. `backend/test/foodBenchmarkV2Gate.test.js` fails CI on any silent drop or fabrication. To compare against the original engine, check out `04c0389` in a worktree, copy `backend/src/eval/*.js` from this branch into it, and run its `food-benchmark.js` with `--dataset` pointing at this branch's `food_eval_set.v2.json`. That's exactly how the numbers above were produced.
