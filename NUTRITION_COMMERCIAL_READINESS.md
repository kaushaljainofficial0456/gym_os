# Gym OS Nutrition — Commercial Readiness Report (Phase 2)

**Branch:** `feature/nutrition-engine-overhaul`, at `8b5f93d` plus this report. It branched from `main` @ `04c0389`. `main` was never modified, merged into, or pushed to. **Date:** 2026-11-16.

**Companion documents:**
- `NUTRITION_PHASE2_AUDIT.md`: findings F1–F14
- `NUTRITION_ACCURACY_REPORT.md`
- `NUTRITION_DATA_LICENSING.md`
- `NUTRITION_REAL_WORLD_VALIDATION.md`
- `NUTRITION_PHASE2_PROGRESS.md`
- Phase 1: `NUTRITION_COMPLETE_TECHNICAL_AUDIT.md`, `NUTRITION_BENCHMARK_REPORT.md`

## Verdict

**Weighted score: 7.4 / 10.** On the same weighted scorecard, the end of Phase 1 re-scores at about 6.5. Phase 1 reported 7.0 on a different, unweighted rubric; §4 explains the difference.

**Recommendation: ready for a controlled pilot. Not ready for general commercial release.** Two things block release, and neither is engineering:

1. **Data licensing.** IFCT 2017 needs NIN's written permission for product use, INDB's dataset licence is unconfirmed, and the Open Food Facts and CNF attribution notices are not shown. IFCT and INDB alone price about 37% of benchmark items. See `NUTRITION_DATA_LICENSING.md`.
2. **No real-world validation.** Every accuracy number comes from typed benchmark descriptions, not weighed real meals. See `NUTRITION_REAL_WORLD_VALIDATION.md`.

A genuine 9/10 is not reachable from this repository alone. The scorecard marks every dimension that rests on unverified evidence, and §6 lists what would close the gap.

---

## 1. What Phase 2 changed (all on the feature branch)

| Commit | Change |
|---|---|
| `ab44aae` | Phase 2 audit: 14 findings, top 5 obstacles |
| `a6dcda5` | **Critical defects.** One user could rewrite a shared AI value (now a review queue keyed on distinct people). "Half a plate" was logged as USDA veal. "Sabudana khichdi" was counted twice. |
| `08c98e6` | Container sizes consistent with the food (a katori is no longer a bowl-sized serving); size words applied ("2 large eggs", "1 big bowl") |
| `2e671ac` | 14 hand-typed staples recomputed from measured ingredients. Dal 145 → 87 kcal/100 g and mutton curry 198 → 138, both now inside INDB's ranges. Oil choices use each recipe's known cooking oil. |
| `8569add` | **Raw/dry vs cooked** ("raw rice" was puffed rice; "uncooked moong dal" a cooked dal at a fifth of its energy). Amounts written after the food; a bowl of a dry food counts as cooked; nut toppings |
| `1e316b6` | Accuracy report; estimate totals name nutrients a source never measured |
| `b3eb7a3` | The classic food sheet is now server-priced and idempotent, like the plate. Logged items show where their numbers came from. |
| `c4422e7` | **User corrections**: recorded with full audit fields; personal learning applies only to that person; shared mappings need 3+ people and an admin; RLS verified on PostgreSQL |
| `317fd36` | **Personalization**: activity level drives TDEE; diet-aware defaults; foods-to-avoid flags; safeguards intact |
| `267fba3` | **Benchmark v3, 945 cases**: multi-source ground truth; metrics for false identification, portion error and calibration by category. Engine fixes it exposed (raw vegetables, cup weights, spellings, narration, tomato rice) |
| `8b5f93d` | Data licensing, real-world validation protocol, image-estimation decision |

## 2. Results

Same scorer, same 945-case v3 dataset, Phase 1 final engine vs now:

| Metric | Phase 1 final | Now |
|---|---:|---:|
| Weighted benchmark score | 86.5% | **90.4%** |
| Food identification | 95.2% | **97.5%** |
| False identification (resolved cases) | — | **2.5%**, and 0 of 252 at "high" confidence |
| Unresolved | 6.5% | **1.3%** |
| Silent food drops (multi-food) | 0% | 0% (CI-enforced) |
| Fabrication (number for a non-food) | 0% | 0% (CI-enforced) |
| Portion accuracy | 87.1% | **93.0%** (89% within 25% of reference grams) |
| kcal in reference range, all nutrition-scored (n=675) | 73.6% | **83.5%** |
| kcal MAE, resolved | 37.5 kcal | **25.3 kcal** |
| kcal in range, **independent references only** | 63.6% | **72.1%** (MAE 53 → 43 kcal) |
| Confidently wrong cases | 31 | **18** |
| Calibration error (ECE), all cases | 0.189 | **0.213 (worse)** |
| ECE, independent nutrition references | — | **0.063** |
| Cases better / worse than Phase 1 final | — | **147 better / 7 worse** (worst −0.05) |

**How to read this:**

- The "independent references" rows exclude cases whose reference is the row the engine itself uses; those score about 99% by construction.
- The independent sets differ slightly in composition between the two engines (481 vs 399 cases), because "same-row" depends on the engine's choice. The engine-independent subsets are fixed:
  - standard portions: 62.6% → 67.0% in range;
  - published ranges: 75.6% → 76.7%.
- Calibration got **worse overall**. The engine became more accurate without its labels becoming more confident, so it is now *under*-confident: meals labelled "low" are right about 95% of the time. That is the safe direction, but it is still miscalibrated. It is listed as open work, not tuned to the benchmark at the last minute.

## 3. Status against the Phase 2 brief

| Area | Status |
|---|---|
| Repo/branch verification, remote-tracking issue | **Completed** (Phase 2 audit) |
| Phase 2 audit with severities | **Completed** |
| Calorie/macro accuracy: raw vs cooked, dry vs prepared, oil, yield, double counting | **Completed** for the listed staples and recipes; **Partially completed** for database dishes (oil approximated) |
| Missing values never zero | **Completed** in items, recipes and estimate totals; **Not implemented** in stored logs (macros are `NOT NULL`) |
| Indian recipe coverage | **Completed**: 35 computed recipes, 13 raw/dry staples, 9 raw vegetables; **Requires external validation** of recipe proportions |
| Realistic portions | **Completed** (containers, sizes, trailing amounts, toppings, USDA cup weights); **Requires external validation** for real kitchens |
| Multi-food sentences (the brief's four examples) | **Completed**, pinned by tests |
| Image estimation | **Not implemented**: kept unexposed; a paid provider needs owner approval; grounded design recorded |
| Confidence by category | **Completed** (metric 21); under-confidence is open |
| Benchmark toward 1,000 with independent ground truth | **Completed**: 945 cases, multi-source ranges, independence split reported |
| Corrections system (audit fields, isolation, review, RLS) | **Completed** |
| Data licensing document | **Completed**; two **Blocked** items await the owner and third parties |
| Personalization | **Completed** |
| UX improvements | **Completed** for provenance, personalised notes, avoid flags and the raw/dry alternative; **Unverified** in a browser end-to-end |
| Backend security/performance tests | **Partially completed**: idempotency, RLS, validation and concurrency tested on PostgreSQL; no load test |
| Tests for every change, none weakened | **Completed** (one oil assertion made *more* precise for recipe dishes; documented) |

## 4. Weighted scorecard

Weights are those in the brief. Scores are 0–10. "Unverified" marks a dimension whose score rests on benchmark or synthetic evidence only; those scores are capped below 9 for that reason.

| # | Dimension | Weight | P1 end* | Now | Evidence | Caps / unverified |
|---|---|---:|---:|---:|---|---|
| 1 | Food identification | 15% | 8.0 | **8.5** | v3: 97.5% identity; 2.5% false ID, 0/252 at high confidence; 1.3% unresolved; 0 silent drops | **Unverified** on real typed logs |
| 2 | Calorie & macro accuracy | 20% | 6.0 | **7.0** | 83.5% in range (all), 72.1% on independent references, MAE 25 kcal; dal/mutton corrected against INDB; raw/cooked fixed | **Unverified** on weighed meals; recipe proportions curated; stored logs turn unmeasured macros into 0 |
| 3 | Portion estimation | 15% | 6.0 | **7.0** | 93% portion accuracy; 89% within 25%; containers, sizes and trailing amounts; USDA cup weights | **Unverified** real katori/bowl sizes; standard-portion MAE still 104 kcal |
| 4 | Indian food & recipe coverage | 10% | 7.5 | **8.5** | 35 computed recipes, raw/dry staples and vegetables; Indian identity high on v2/v3 | Recipe calories **unverified**; data licences counted under #10 |
| 5 | AI intelligence & meal understanding | 10% | 6.5 | **7.5** | The brief's sentences, narration, trailing amounts, toppings, raw/dry alternatives; personal learning | No AI meal decomposition for unresolved sentences; no photo path |
| 6 | Confidence & uncertainty | 5% | 7.5 | **7.5** | ECE 0.063 on independent references; 0 wrong at "high" on v3; reasons in words | Overall ECE 0.213 (under-confident); meal-level labels too low |
| 7 | User experience | 10% | 6.0 | **7.0** | Provenance on every logged item; personalised and avoid notes; one-tap back; retry-safe classic logging | **Unverified** in a browser end-to-end |
| 8 | Backend reliability & security | 5% | 7.5 | **8.0** | Both logging paths idempotent; corrections RLS verified on PostgreSQL; strict validation; transactions; trial merge with `main` passes 2,226 tests | No load test; no penetration test |
| 9 | Personalization | 5% | 5.0 | **8.0** | Activity level, diet defaults, avoid flags, personal corrections; safeguards tested | Avoid flags see names/recipes only (stated in UI) |
| 10 | Commercial readiness & data compliance | 5% | 3.0 | **3.0** | Licensing researched and documented; attribution drafted | **Blocked**: IFCT permission, INDB licence, OFF/CNF attribution not shown |
| | **Weighted total** | 100% | **6.5** | **7.4** | | |

\* "P1 end" re-scores the Phase 1 final state on this weighted rubric, using the same v3 measurements. Phase 1's own report said 7.0 on an unweighted rubric that did not separate licensing and gave more weight to engineering.

**Why not higher.** Dimensions 2, 3 and 10 carry 40% of the weight, and each is capped by evidence this repository cannot produce: weighed real meals, and licences signed by third parties. With both resolved and the engineering unchanged, the same rubric would put this at about 8.2–8.5. Reaching 9 also needs the work in §6.

## 5. Security assessment

- **Tenant isolation.** `meal_log_requests` and the new `nutrition_corrections` are under forced RLS, **verified on PostgreSQL 16**: another gym can neither read nor write either table for a client that isn't theirs. Personal corrections are read only for the same `client_id` (tested with two members of one gym and members of different gyms).
- **One user cannot change shared values.** A shared AI value changes only through an admin-approved proposal backed by distinct people. A shared phrase→food mapping needs 3+ distinct people *and* an operator's approval, and can be revoked. The candidate list shows counts only, never who.
- **Integrity.** The server re-prices catalogue items on both logging paths, including at the classic picker's oil level. A client cannot claim a "verified" provenance (schema-rejected; tested). The plate's proposal snapshot is strictly validated and never used for pricing.
- **Duplicates.** Retries and concurrent duplicates write once on both paths (SQLite and PostgreSQL).
- **Profile fields.** Activity level and diet are validated against enums, exclusions are length-limited, and unknown values are refused with a message.
- **Not done:** penetration test, load test.

## 6. What it takes to reach 9/10

1. **Resolve licensing** (L1–L5 in `NUTRITION_DATA_LICENSING.md`): NIN permission, INDB confirmation, approved attribution.
2. **Run the weighed-plate validation** (`NUTRITION_REAL_WORLD_VALIDATION.md` §2) and fix what it finds, especially katori/bowl sizes and restaurant oil.
3. **Calibrate meal-level confidence** on real data, so that "low" stops meaning 95% right.
4. **Nullable stored macros**, so an unmeasured carbohydrate is never stored as 0.
5. **Convert the remaining inline values and the most-logged INDB dishes** to computed recipes, which gives a known oil baseline.
6. **AI meal decomposition** for sentences the engine cannot resolve, through the grounded pipeline. **Photo estimation** only if a paid provider is approved, priced by the database.
7. **Browser end-to-end tests** for the plate and classic flows, and a load test on PostgreSQL.

## 7. Test status at hand-off

| Suite | Result |
|---|---|
| Backend `node --test` (SQLite) | 2,161 tests: **2,155 pass, 0 fail**, 6 skipped (Postgres-only without a URL) |
| PostgreSQL 16 integration (temporary local cluster, removed after) | mealLogPg 8/8 (incl. corrections RLS), communityPg 11/11, financialRls 11/11, groupByParamsPg 4/4 |
| Frontend `vitest` | 218 tests, **0 fail** |
| Frontend production build | OK |
| Benchmark gates | v1 PASS, v2 PASS, v3 PASS; 0 silent drops and 0 fabrication enforced on v2 and v3 |
| Trial merge with current `main` (`3fb3907`) | **Not performed on any branch.** In a throwaway detached worktree: one trivial conflict in `.github/workflows/test.yml` (both sides added a CI step; keep both); with it resolved, backend 2,226 pass / 0 fail |
