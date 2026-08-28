# SKOS Food Estimation Benchmark (`v1`)

Phase 0 of the [Universal Food Estimation Architecture](../../../docs/FOOD_ESTIMATION_ARCHITECTURE_2026-08-28.md).
This is the **scientific measurement system**: a frozen case set + an evaluation
harness that scores the **current production engine (V1)** and any future engine
(V2) on identical inputs, with category-level reporting and regression gates.

**The estimator was not modified.** Everything here is under `ml/data/benchmark/`
and `backend/src/eval/` + `backend/scripts/food-benchmark.js`.

---

## 1. Files

| Path | What it is | Committed? |
|---|---|---|
| `case_specs.v1.mjs`, `case_specs.v1.extra.mjs` | Hand-authored case **specs** — the source of truth for authoring. | yes |
| `build.mjs` | Expands the specs → the frozen dataset. Snapshots IFCT/INDB/USDA ground truth **by its own criteria, not the estimator's ranker**. | yes |
| `food_eval_set.v1.json` | **The frozen dataset.** 324 cases. Regenerate with `build.mjs`; review the diff. | yes |
| `baseline.v1.json` | **The frozen V1 baseline report.** Every V2 run is gated against this. Never regenerated except by an approved re-baseline. | yes |
| `report.v1.json` / `report.v1.txt` | Latest run output (machine + human). Regenerable — **git-ignored**. | no |
| `backend/src/eval/*` | The harness: `taxonomy`, `plausibility` (eval-side judge), `adapters` (v1 read-only + v2 stub), `score`, `runner`, `report` (+ gate). | yes |
| `backend/scripts/food-benchmark.js` | CLI. | yes |
| `backend/test/foodBenchmarkGate.test.js` | CI gate — runs V1, asserts it still reproduces `baseline.v1.json` (guards the harness and any accidental engine change). | yes |

---

## 2. Dataset structure

```jsonc
{
  "meta": { "version": "v1", "built_at": "...", "n_cases": 324,
            "n_with_nutrition_ground_truth": 306,
            "counts_by_primary": {...}, "counts_by_ground_truth_method": {...}, "counts_by_tag": {...} },
  "cases": [
    {
      "id": "sng-001",
      "input": "100g paneer",                    // exact text handed to the engine
      "primary": "single_ingredient",            // 1 of 9 mutually-exclusive buckets (weighted into the overall)
      "tags": ["indian","raw","generic","explicit_grams"],   // cross-cutting slices
      "difficulty": "easy",                      // easy | medium | hard
      "expect": {
        "entity":   { "name_matches": "paneer",  // ≥1 returned item name must match (case-insensitive regex)
                      "source_id_any": ["ifct:L003"],     // optional exact-id acceptance set
                      "reject_name_matches": "tofu|imitation" },  // names that count as WRONG even if name_matches
        "food_class": "ingredient",              // ingredient|dish|recipe|prepared|branded_product|beverage|condiment|meal
        "prep_state": "raw",                     // raw|boiled|steamed|grilled|roasted|baked|fried|cooked_wet|cooked_dry|ready_to_eat|any
        "portion":   { "grams": [98, 102] },     // acceptable resolved grams  (or "grams_exact": 200)
        "nutrition": { "kcal":[270,340], "protein_g":[16,24], "carb_g":[0,8], "fat_g":[20,30] },  // acceptable TOTALS, or null
        "confidence": ["medium","high"],         // acceptable reported bands (optional)
        "strategy":  "direct",                   // expected resolution strategy (direct|prep_variant|decompose|semantic|llm|rescue|unresolved)
        "plausible": true,                       // is the CORRECT answer nutritionally plausible? (false only on deliberate trick cases)
        "is_nonfood": false,
        "items": [ ... ]                         // for `meal` cases: per-sub-item entity matchers
      },
      "ground_truth": { "method": "db_row_scaled",
                        "source": "IFCT2017 ifct:L003 \"Paneer\" × 100g ±18%",
                        "resolved_source_id": "ifct:L003", "resolved_per_100g": {...}, "reference_grams": 100 }
    }
  ]
}
```

### Counts by category (v1, 324 cases)

| Primary | n | weight |
|---|---:|---:|
| single_ingredient | 90 | 0.17 |
| prepared_food | 43 | 0.17 |
| composite_dish | 95 | 0.22 |
| meal (multi-food) | 20 | 0.12 |
| beverage | 24 | 0.10 |
| snack | 17 | 0.08 |
| dessert | 13 | 0.06 |
| sauce_condiment | 12 | 0.04 |
| nonfood_or_malformed | 10 | 0.04 |

Cross-cutting tag coverage (a case carries several): **cuisine** — indian 81, south_asian 19,
east_asian 24, middle_eastern 10, european 22, american 32, latin_american 10, african 5,
mediterranean 14, global 97. **prep** — raw 111, boiled 27, steamed 4, grilled 12, roasted 6,
baked 22, fried 30, cooked_wet 55, cooked_dry 22. **namespace** — branded 13, generic 293.
**portion style** — explicit_grams 129, count_portion 70, volume_portion 58, nl_quantity 5,
no_quantity 43. **linguistic** — alias 17, transliteration 39, spelling_variant 3, ambiguous 20.
**structure** — multi_food 18, stuffed 11, topped 10, combo 20. **difficulty** — easy 143, medium 132, hard 49.

Also covered as tags/inputs: soups, curries, stir-fries, stuffed & topped dishes, street food,
raw/cooked variant pairs (`rcv-*`), portion-only tests (`por-*`), branded-vs-generic pairs
(`bnd-*`), low-confidence / intentionally-hard cases (`lcf-*`), and injection/garbage inputs.

---

## 3. Ground-truth methodology

Every case records `ground_truth.method`. Ranges are **acceptable bands, not point targets** —
wide where real recipe variance is wide. There are **no point equalities anywhere**.

| Method | n | How the nutrition range is derived |
|---|---:|---|
| `db_row_scaled` | 123 | An authoritative row (IFCT 2017 lab values, INDB dish survey, USDA FDC, CNF) is selected from `unified_food_db.json` **by the spec's own criteria** — source preference + a name regex + cooking state — **not by the estimator's ranker** (that would grade V1 against its own choice). Quarantined (`data_quality_flag`) and `per_100g_unreliable` rows are pushed to the bottom of selection. Range = `row_value × reference_grams / 100 × (1 ± tol)`, `tol` 0.15–0.30. The chosen `source_id` and per-100 g values are written into the dataset for audit. |
| `standard_portion` | 90 | A published standard reference weight (USDA "1 medium apple ≈ 182 g", "1 large egg 50 g", "1 cup cooked rice 158 g", ICMR katori/serving weights) plus a domain nutrition range, tolerances widened for preparation variance. |
| `published_range` | 93 | Composite / restaurant / street-food dishes with no reliable single row: a wide range from published restaurant nutrition, recipe-database aggregates, and standard food-composition references. Bands are deliberately ±30–40 % because the real dish-to-dish spread is that large. |
| `none` | 18 | Non-food, malformed, and deliberately-ambiguous inputs. Nutrition is **not** scored; identity / preparation / portion / class / resolution behaviour is. |

**Honest limitations of the ground truth** — see §10.

---

## 4. V1 baseline results (`baseline.v1.json`, 324 cases)

Run `2026-08-28`, current production engine (`foodEstimator.js` → `skos-food-v1`, deterministic Tier 1).

```
 WEIGHTED OVERALL .......... 63.5 %      (unweighted 65.3 %)

  1  Food identity accuracy .....  79.9 %   (graded 78.7 %)
  2  Food-class accuracy (proxy)   56.5 %   ← V1 emits no class; derived from the matched row
  3  Preparation-state accuracy .  68.9 %   (graded 65.2 %)
  4  Portion accuracy ...........  70.0 %   in-range   (graded 86.9 %)
  5  Composite decomposition ....  attempt 0.0 %  ·  kcal-total-in-range 57.7 %  ·  category score 63.3 %
  6  kcal  MAE 115.9 (resolved) / 124 (all)  ·  in-range 55.4 %  ·  MAPE-mid 36.4 %  ·  resolve 93.8 %
  7  protein  MAE 3.8 / 4.1 g  ·  in-range 58.5 %  ·  MAPE-mid 39.7 %
  8  carb  MAE 10.9 / 11.9 g  ·  in-range 54.1 %  ·  MAPE-mid 47.9 %
  9  fat  MAE 7.9 / 8.2 g  ·  in-range 56.8 %  ·  MAPE-mid 52.7 %
 10  Plausibility false positives   1.7 %   (5/287)   ← eval ranges wrongly reject a good answer
 11  Plausibility false negatives  12.3 %   (36/293)  ← confident answer the judge calls implausible  ◄ headline V1 weakness
 12  Unresolved rate ............   6.5 %
 13  Fabrication rate ...........   0.3 %   (1 case)  ·  non-food resolved at low conf: 3  ·  silent-drop (multi-food): 60.0 %
 14  Confidence calibration (ECE)  0.222    high→57.7 % actual · medium→50.6 % · low→32.2 %   ◄ badly over-confident
 15  Brand / generic accuracy ...  83.3 %   (branded 69.2 % · generic 84.0 %)
 16  Latency ...................   p50 8 ms · p95 29 ms · mean 11 ms
 17  LLM escalation rate .......   0.0 %    (the meal-estimate path never escalates)
 18  Est. cost / estimate .....   $0.000000
```

Per-category `case_score`: single_ingredient **72.4** · prepared_food **61.7** · composite_dish
**63.3** · meal **53.7** · beverage **70.0** · snack **62.7** · dessert **43.8** ·
sauce_condiment **70.2** · nonfood **73.0**.
Difficulty: easy **70.0** / medium **63.6** / hard **55.8**.

The full per-category, per-cuisine, per-prep, per-namespace, per-portion-style breakdown and the
25 worst cases are in `report.v1.txt` / `baseline.v1.json`.

---

## 5. Evaluation metrics (how each is computed)

Per-case grading lives in `backend/src/eval/score.js`; aggregation in `runner.js`.

| # | Metric | Definition |
|---|---|---|
| 1 | **Food identity accuracy** | fraction of resolved cases whose top item satisfies `expect.entity` (name regex or `source_id_any`) and does **not** hit `reject_name_matches`. `1b` is the graded version (0.6 for head-noun-only). Meal cases: mean over sub-items. |
| 2 | **Food-class accuracy** | `classCompatibility(expect.food_class, class_proxy)` ≥ 0.5. V1 emits no class → `class_proxy` is a heuristic over the matched DB row (`branded`/`dish`/`beverage`/`condiment`/`ingredient`). Reported as a proxy. |
| 3 | **Preparation-state accuracy** | `prepCompatibility(expect.prep_state, prep_norm) ≥ 0.5`. Adjacent states get partial credit (`grilled`↔`roasted` 0.8, generic `cooked`↔`grilled` 0.7, `raw`↔`fried` 0). |
| 4 | **Portion accuracy** | resolved grams inside `expect.portion` band (`4`) ; graded distance-to-edge (`4b`). Explicit-mass cases use `grams_exact` ±2 %. |
| 5 | **Composite decomposition accuracy** | over `composite_dish` cases: `decomposition_attempt_rate` (any item flagged `decomposed`), `kcal_total_in_range_rate`, and the category `case_score`. |
| 6–9 | **kcal / protein / carb / fat error** | per macro the case declares a band for: `MAE(resolved)` and `MAE(all)` (unresolved → full miss = band midpoint), `in_range_rate`, `MAPE-mid` (median \|est − midpoint\| / midpoint — never 0 inside the band, so it tracks gains the in-range flag can't), `MAPE-edge` (0 inside the band), `resolution_rate`. |
| 10 | **Plausibility false positives** | resolved cases whose returned nutrition **is** inside `expect.nutrition` but the eval-side category-plausibility judge rejects it → the judge's ranges are too tight. |
| 11 | **Plausibility false negatives** | resolved cases the judge calls implausible **and** the engine reported `high`/`medium` confidence → a confident wrong answer slipped through. (Skipped on `plausible:false` trick cases.) |
| 12 | **Unresolved rate** | `!resolved` over cases that *should* resolve (non-food excluded). |
| 13 | **Fabrication rate** | non-food input resolved with `high`/`medium` confidence and kcal > 0, **or** any case whose figure exceeds the absolute physical ceiling (9.1 kcal/g, 4000 kcal/serving) at non-low confidence. Also reported: non-food-resolved-at-low-confidence, and `silent_drop_rate` (multi-food case where an expected sub-item is neither matched nor listed in `unresolved`). |
| 14 | **Confidence calibration** | resolved cases binned by reported band; observed "correct" rate (identity ok **and** kcal in range) vs a nominal target {high .90, medium .65, low .40, unreliable .15}. **ECE** = Σ (bin share × \|observed − nominal\|). |
| 15 | **Brand / generic accuracy** | over `branded`/`generic`-tagged cases: matched row's namespace (`brand` present / `cuisine=PACKAGED` → branded) equals the expected namespace. Split branded vs generic. |
| 16 | **Latency** | wall-clock per case after a warm-up call. p50 / p90 / p95 / mean / max. |
| 17 | **LLM escalation rate** | fraction of cases where the adapter reports an external model call. V1 = 0. |
| 18 | **Est. cost / estimate** | mean `est_cost_usd` reported by the adapter. V1 = $0 (deterministic). V2 adapters compute `llm_calls × model price`. |

**Weighted overall** = Σ (primary weight × category mean `case_score`) / Σ weights of present
categories. Per-case `case_score` weights identity 0.34 / class 0.10 / prep 0.12 / portion 0.14
/ nutrition 0.22 / confidence 0.08, then: **× 0.2 if confident-wrong**, **capped at 0.05 if
fabrication**, **× 0.6 if silent-drop**. An honest `unresolved` on a should-resolve case scores
**0.30**; a correct decline on a non-food scores **1.0**. This encodes *a wrong confident
answer is worse than an unresolved one*.

---

## 6. Regression thresholds (`backend/src/eval/report.js` → `GATES`)

A V2 run is compared to `baseline.v1.json`. `dir` = better direction; `tol` = allowed regression
before it counts; `block` = blocks rollout; `hard` = blocks unconditionally.

| Metric | better | tol | block | hard |
|---|---|---:|:--:|:--:|
| `weighted_overall` | ↑ | 0.010 | ✔ | |
| `1_food_identity_accuracy` | ↑ | 0.020 | ✔ | |
| `3_prep_state_accuracy` | ↑ | 0.030 | ✔ | |
| `4_portion_accuracy` | ↑ | 0.030 | ✔ | |
| `5_composite_decomposition.kcal_total_in_range_rate` | ↑ | 0.030 | ✔ | |
| `6_kcal.mape_mid_all_median` | ↓ | 0.030 | ✔ | |
| `6_kcal.in_range_rate` | ↑ | 0.030 | ✔ | |
| `7/8/9_*.mape_mid_all_median` (protein/carb/fat) | ↓ | 0.040 | | |
| `10_plausibility_false_positive.rate` | ↓ | 0.030 | | |
| `11_plausibility_false_negative.rate` | ↓ | 0.010 | ✔ | **✔** |
| `12_unresolved_rate` | ↓ | 0.030 | | |
| `13_fabrication_rate` | ↓ | 0.000 | ✔ | **✔** |
| `13d_silent_drop_rate_multi_food` | ↓ | 0.010 | ✔ | **✔** |
| `14_confidence_calibration.ece` | ↓ | 0.030 | | |
| `17_llm_escalation_rate` | ↓ | 0.100 | | |
| `18_est_cost_usd_per_estimate` | ↓ | 0.002 | | |
| every `category.<primary>` `case_score` | ↑ | 0.030 | ✔ | |

**Hard gates** (`fabrication`, `plausibility FN`, `silent-drop`) protect the never-fabricate
principle: a change that lets more confident-wrong answers or silent drops through **cannot ship**,
regardless of how much it improves the aggregate.

Soft regressions are reported and must be called out in the phase's write-up. Blocking
regressions require explicit human approval (`--gate` exits non-zero).

---

## 7. Execution

```bash
# 1. (re)build the frozen dataset from the specs
node ml/data/benchmark/build.mjs

# 2. run the current engine and print the full report
node backend/scripts/food-benchmark.js --engine v1

# 3. run and compare to the frozen baseline, fail on a blocking regression
node backend/scripts/food-benchmark.js --engine v2 --baseline ml/data/benchmark/baseline.v1.json --gate

# useful flags
#   --out <f.json>          full machine report
#   --md <f.txt>            human report to a file
#   --filter primary=composite_dish       (repeatable: primary= | tag= | difficulty= | id=)
#   --save-baseline <f> [--force]          re-baseline (v1 only, refuses a filtered run)
#   --quiet
```

npm shortcuts (from the repo root):

```bash
npm run bench            # node backend/scripts/food-benchmark.js --engine v1
npm run bench:gate       # v2 vs baseline, --gate  (used by CI once v2 exists)
```

---

## 8. CI integration plan

1. **`backend/test/foodBenchmarkGate.test.js`** runs under `node --test` (already the repo's
   `npm test`). It runs V1 against the frozen dataset and asserts the headline metrics still
   reproduce `baseline.v1.json` within noise (±0.5 pp). This catches **(a)** an accidental change
   to the estimator and **(b)** a change to the harness that silently moves the numbers.
2. When a V2 phase lands, its PR CI adds
   `npm run bench:gate` (`--engine v2 --baseline … --gate`). A **blocking** or **hard** regression
   fails the job. Soft regressions post a comment but pass.
3. `report.v1.json` / `report.v1.txt` are **git-ignored** (regenerable). `baseline.v1.json`
   and `food_eval_set.v1.json` are committed; changes to either require review.
4. Re-baselining (`--save-baseline --force`) is a deliberate, reviewed act — done only when a
   V2 phase is accepted and becomes the new floor, or when the dataset is intentionally revised.

---

## 9. How future food-estimation changes are evaluated

> A change is an improvement **only if** the weighted overall improves (or holds) **and** no
> category regresses past its tolerance **and** no hard gate trips. Not because more foods
> resolve, not because one example got fixed, not because average calories moved on a subset.

For every phase of the architecture rollout:

1. Implement behind a flag; leave V1 the default.
2. `npm run bench:gate` → produce the V2 report and the gate verdict.
3. **PASS** (no blocking regression, weighted overall ≥ baseline − 0.01): the phase may be
   flagged on for a route. Record the per-category deltas in the phase write-up.
4. **FAIL (blocked)**: list every blocking regression. Ship only with explicit approval, and
   only after the write-up explains why the trade is acceptable.
5. **HARD FAIL** (fabrication / plausibility-FN / silent-drop regressed): does not ship. Period.
6. When a phase is accepted, `--save-baseline --force` promotes its report to the new floor so
   later phases are gated against the improved bar.

Add cases whenever a new failure class is found (a real user miss, a new cuisine, a new
preparation). Adding cases is additive; it never lowers the bar for existing categories.

---

## 10. Known weaknesses / limitations of the benchmark itself

1. **Ground truth is assembled, not lab-run.** 123 cases are anchored to genuine IFCT/INDB/USDA
   rows; the other 183 use published/standard ranges + domain knowledge. Bands are deliberately
   wide, so the risk is a band that is *too generous* (a wrong-ish answer scores "in range"),
   not too strict — metric 10 (plausibility FP, 1.7 % on V1) is the check on over-generous bands.
2. **`db_row_scaled` inherits the corpus's own errors.** If an IFCT/USDA row is itself off, the
   band built from it is off. Mitigated by preferring lab sources and excluding quarantined rows,
   but not eliminated.
3. **Food-class accuracy for V1 is a proxy.** V1 emits no class; the number is derived from the
   matched row's name/category/brand. It is a floor for comparison, not a measurement — a V2 that
   emits a real class should be judged on its own output, and this metric's definition updated then.
4. **`silent_drop_rate` on multi-food conflates two failures.** V1 does not split ` with `, so
   "toast with butter and jam" becomes one munged item and *two* expected sub-items go unmatched.
   The 60 % figure therefore means "V1 fails to correctly itemise 60 % of multi-food inputs",
   which subsumes both true silent drops and phrase-munging. Both make the user's total wrong;
   V2 must fix itemisation either way. If needed, split into `silent_drop` vs `mis_itemised` later.
5. **Only 5 cuisines have n ≥ 20** (indian, american, east_asian, european, global). African (5),
   middle_eastern (10), latin_american (10), mediterranean (14) slices are directional, not
   statistically firm. Grow these before treating their deltas as decisive.
6. **Confidence calibration bins are coarse** (4 bands, nominal targets chosen by hand). ECE is a
   relative tracking signal between V1 and V2, not an absolute claim about calibration quality.
7. **Latency is measured on one machine, single-process, warm.** Useful for relative V1↔V2
   comparison and catching a 10× regression; not a production SLA.
8. **The eval-side plausibility judge is a hypothesis.** Its category ranges (`plausibility.js`)
   are a prototype of the future engine plausibility layer. Metric 10 exists specifically to keep
   it honest; if FP climbs when V2 lands, the judge's ranges — not V2 — are what needs tuning.
9. **No image / barcode / voice inputs.** Text only, matching what the engine accepts today.
10. **324 cases is a screening set, not exhaustive.** It is sized to catch category-level
    regressions and the failure classes the audit identified, not to certify correctness.
