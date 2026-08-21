# V2 Validation Report

**Status: PHASES A-F COMPLETE AND VERIFIED. PHASE G (V2 residual-model training) NOT STARTED — insufficient independent data, per the explicit stop condition in the V2 authorization.** This is not a partial result being presented as complete; it's the honest state of the project. No V2 model exists. `model_v1.json` is untouched.

## 1. Dataset composition

`ml/data/processed/v2_training_dataset.csv` — 1,034 rows, built by `ml/src/v2/build_v2_dataset.py` from currently-available legitimate data only. Two roles:
- **1,001 rows, `data_role=primary_training_target`** — reis2017 + reis2019, rate-form (kcal/min), the exact same rows V1 itself was trained/evaluated on.
- **33 rows, `data_role=confirmatory_only_incompatible_unit`** — brunelli2019, absolute kcal, carried forward with V1's own established treatment (never a training target, incompatible unit).

## 2. Participant count

**25 unique participants total; 14 in the primary training-target population** (identical to V1 — no new participant has been added, because none is currently in hand). This number is enforced by an automated regression test (`test_v2_pipeline.py::test_reis_lab_participant_count_unchanged`) so it can't silently drift.

## 3. Study count

3 studies ingested (reis2017, reis2019, brunelli2019) — same 3 as V1. 3 additional studies identified and assessed but **not yet acquired**: Rustaden 2020, João 2021 (participant-level data not confirmed available), Benito 2016 (permanently unavailable at individual level, Spanish law).

## 4. Leakage analysis

See `V2_LEAKAGE_REPORT.md` in full. Summary: reis2017/reis2019 confirmed same cohort (numeric identity, unified namespace); brunelli2019 confirmed disjoint; no confirmed overlap with any not-yet-acquired candidate. One soft flag (João 2021 shares co-author surnames with a previously-logged review) — noted, not disqualifying.

## 5. Baseline performance

Computed fresh through the new v2 pipeline (`baseline_and_v1_lopo_benchmark.py`), zero-correction MET formula: **MAE 2.96 kcal/min, MAPE 36.46%, R² 0.109.** Matches V1's own already-published 36.5% almost exactly — confirms the new infrastructure's baseline calculation is correct.

## 6. V1 performance

Frozen V1 (model_v1.json's existing coefficients, applied as-is, never refit) run through the new pipeline: **MAE 1.43 kcal/min, MAPE 18.36% (in-sample), R² 0.739.** This is *in-sample* — V1's coefficients already saw these 14 participants during its own original fitting — so it's expectedly a bit lower than V1's genuinely out-of-sample LOPO figure of 19.1% documented in `VALIDATION_REPORT.md`. The two numbers being close (18.4% vs 19.1%) is itself a good sign: it means V1 isn't wildly overfit to its own training set.

## 7. V2 candidate performance

**None. No V2 candidate model was trained.** Per the explicit instruction: "If there is insufficient independent data to train a meaningful V2, STOP TRAINING rather than pretending otherwise." Training any model — simple or complex — on the identical 14 participants V1 already used would not constitute genuine V2 development:
- It would either reproduce V1's own already-completed exploratory work (`exploratory_correction_v0.py` already tested Models A/C/C2/D/E/F on this exact population and selected Model E), or
- It would risk exactly the failure mode Section 29 warns against: optimizing training-set fit on the same small n without any new held-out population to prove generalization actually improved.

There is no honest way to report a "V2 vs V1" comparison without a genuinely independent test population, which doesn't exist yet.

## 8. Final V2 performance

N/A — no V2 model exists.

## 9. Subgroup performance

N/A — cannot evaluate subgroups (women, older adults, beginners, etc.) that don't exist anywhere in the current 14-participant population (100% male, ~20-35y, per `MODEL_CARD.md`). Reporting **INSUFFICIENT DATA** for every stated subgroup (women, older adults, beginners, advanced lifters, body-weight groups) rather than fabricating a number, per the explicit instruction.

## 10. Uncertainty coverage

N/A for a V2 interval — none exists. V1's own interval coverage (validated on single-exercise bouts, re-scoped for multi-exercise sessions per `V1_PRE_INTEGRATION_AUDIT.md` #9) remains the only validated uncertainty figure in this project.

## 11. Failure cases

Not applicable to a V2 model that doesn't exist. The relevant failure-mode documentation for V1 remains `V1_PRE_INTEGRATION_AUDIT.md` in full, unchanged by this work.

## 12. Limitations

- Zero new independent participants currently in hand — this is the single limiting fact of this entire phase.
- Individual body weight remains unavailable in every currently-held dataset (confirmed by `test_v2_pipeline.py::test_no_individual_body_weight_fabricated`) — Section 13's explicit ask ("if V2 datasets provide individual body weight, USE IT... measure it, don't assume") cannot be executed until a dataset that actually has this field is acquired.
- The pipeline itself (schema, ingestion, provenance validation, leakage detection, frozen-V1 benchmark, baseline benchmark) is built, tested (18/18 tests passing, including 9 new V2-specific tests), and verified against real data — but exists to receive future data, not to have produced a result yet.

## 13. Recommended production status

**Not applicable — nothing new to deploy.** V1's own recommended status (`V1_PRE_INTEGRATION_AUDIT.md`'s A-E verdicts) is unchanged by this work. `model_v1.json` was read-only throughout this phase; confirmed via `git status` showing no changes to `ml/models/` or `ml/src` outside the new `ml/src/v2/` directory, and via the regression test that re-checks V1's own hand-verified coefficient value.

---

## What's actually needed to proceed to Phase G

Exactly 3 things, in priority order, per the acquisition report:

1. **Rustaden et al. 2020's participant-level raw data**, obtained by request to the corresponding author (not yet sent). 18 women, real multi-exercise session (~58min), named indirect-calorimetry device. Highest-value single acquisition available — closes 3 stated priority gaps (women, multi-exercise, realistic duration) at once if granted.
2. **João et al. 2021's data availability confirmed** (and obtained if available) — 15 trained men, realistic 44-116 minute sessions, directly relevant to validating the V1 audit's duration-extrapolation concern.
3. **A decision on the MDPI untrained-vs-trained study** — currently unverifiable (site blocked automated access); needs either institutional access or another retrieval path before it can be scored at all.

Until at least one of these lands as real, participant-level, provenance-complete data, Phase G cannot honestly proceed — the pipeline is ready the moment it does.
