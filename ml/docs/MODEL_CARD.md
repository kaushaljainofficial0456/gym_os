# Model Card — skos-cal-v1

## Purpose
Estimate **active calories burned** during a resistance-training workout on SK OS, as a MET-baseline-plus-correction with a validated uncertainty range — not a claimed exact measurement. Feeds the `ml` provider behind `backend/src/services/intelligence/calorieModel.js` (see `docs/calorie-model-contract.md`).

## Training data
14 participants (reis2017 + reis2019, PLOS ONE, CC BY 4.0 — proven to be the same cohort, see `DATA_PROVENANCE.md`), 1,001 observations, 8 exercises × 3 intensity tiers (12/16/20/24%1RM mapped to light; nothing mapped moderate in this specific pair — see actual mapping in `deployed_baseline_benchmark.py`), plus an 80%1RM condition mapped to "hard." Measured via breath-by-breath indirect calorimetry (COSMED K4b2).

## Population
**100% male, ~20-35 years old (cohort mean 27.5±4.9y), body weight 78.67±10.7kg, trained or newly-sedentary.** No women, no other age brackets, no body-fat/lean-mass variation captured. This is the single most important limitation of this model — repeated here deliberately, not just in one place.

## Features used
`exercise_id` (8 known exercises, categorical), `intensity_rating` (light/moderate/hard, categorical — NOT %1RM, which production doesn't have; tested and found to cost almost no accuracy vs. the richer %1RM signal, see `VALIDATION_REPORT.md` Step 3), `body_weight_kg`, `duration_minutes`. Muscle group and compound/isolation are derived attributes of the known exercise set, not independently learned.

## Target
`measured_kcal_min` (rate) from indirect calorimetry, for the exercise duration actually measured (steady-state bouts, not multi-exercise sessions). The deployed model extrapolates this to a session total via volume-weighted averaging across exercises in a session — an extrapolation beyond what was directly measured, flagged in `models/skos-cal-v1/README.md`.

## Validation methodology
Leave-One-Participant-Out (14 folds) for accuracy; group-split conformal prediction (7/7 disjoint calibration/test participants) for interval coverage, confirmed on two independent random splits. See `VALIDATION_REPORT.md` for full numbers and the model-comparison table (baseline vs. three correction approaches).

## Performance

> **READ THIS BEFORE QUOTING ANY NUMBER BELOW.** All figures in this section are measured on **GROSS** energy expenditure (kcal/min, VO2-derived, no resting subtraction). The backend contract (`calorie-model-contract.md` §3) defines `estimated_active_kcal` as **NET of resting**, and `calorieModel.js`'s `toNetOfResting()` performs that conversion before any value reaches a user. **The gross figures do not transfer to the net output.** See "Accuracy of the shipped (net) output" below.

**Gross metrics (what the model was validated on):**
- MAE 1.35 kcal/min, MAPE 19.1% (out-of-sample, LOPO) — vs. 36.5% for the deployed generic baseline alone.
- 90% interval: empirical coverage 91.0% / 88.2% on two independent test splits — genuinely validated, not asserted, **for isolated single-exercise bouts only**.
- Context: published wearable-vs-calorimetry accuracy for resistance exercise runs 15-57% MAPE (Mitchell et al. 2024 systematic review) — this model is competitive with that range using workout-log features alone.

### Accuracy of the shipped (net) output

A constant resting subtraction leaves absolute error unchanged but shrinks the denominator, so percentage error grows. Measured across representative sessions (`SKOS_CALORIE_MODEL_VALIDATION_CALIBRATION_REPORT.md` §7.1):

| Session | net/gross | Effective MAPE on net |
|---|---|---|
| 75kg, 60min, hard | 0.88 | 21.7% |
| 100kg, 45min, moderate | 0.87 | 22.0% |
| 75kg, 60min, moderate | 0.69 | 27.7% |
| 65kg, 115min, moderate | 0.64 | 29.6% |
| 50kg, 90min, light | 0.54 | 35.3% |

**The defensible external claim is ~22–35% MAPE on shipped output, not 19.1%.** Degradation is worst for light-intensity, long-duration and low-body-weight sessions — i.e. beginners and lighter users, who are also the least represented in training.

**Additionally**, all of the above was measured on isolated single-exercise lab bouts. Accuracy on real multi-exercise sessions is **unvalidated** and could be worse again. No number in this card has been validated against a real SK OS workout.

## Participant accounting (authoritative — see `V1_PRE_INTEGRATION_AUDIT.md` §10 for full derivation)

| | reis2017 | reis2019 | brunelli2019 | Total |
|---|---|---|---|---|
| Unique participants | 14 | 14 | 11 | **25** |
| Used to train/evaluate `model_v1.json`? | Yes | Yes | No (confirmatory check only) | 14 |

"25 participants" (cited elsewhere, e.g. `DATA_AUDIT.md`) = the full literature corpus. "14 participants" (`model_v1.json`'s own `trained_on.participants`) = the actual training/evaluation population for the shipped model. Both are correct; they answer different questions — see the audit doc if this looks inconsistent at a glance.

## Known failure modes
- **Any exercise outside the trained 8** falls back to baseline-only with a widened interval — will be systematically less accurate for compound barbell lifts like deadlift or overhead press, which aren't in the training set at all.
- **Multi-exercise sessions** were never directly measured — every source study tested one exercise continuously. The volume-weighted session aggregation is reasonable but unvalidated.
- **Women, non-20s/30s ages, and non-isolated training styles** — no basis in the training data to claim accuracy here at all.
- **BARBELL_SQUAT is the least-well-corrected exercise** even within the trained set — largest baseline error (55%) and highest residual variance; treat squat-heavy sessions' estimates with the most caution.
- **Hard-tier (80%1RM) corrections were fit on 26-56 second bouts, not sustained work** — applying them across a realistic session duration is an extrapolation the pre-integration audit found could produce physiologically-impossible totals (e.g. BARBELL_SQUAT hard, uncapped, at 90min ≈ 3,261 kcal). `mlEstimate.reference.js` now caps the applied rate at 20 kcal/min and flags when this engages — a safety net, not a validated fix. See `V1_PRE_INTEGRATION_AUDIT.md`.
- **The correction terms do not scale with body weight at all** — the source studies never recorded individual participant weights, only a cohort mean (78.67±10.7kg), so there was never a body-weight signal for the correction to learn from. Runtime now flags users outside roughly 57–100kg; this is a flag, not a fix — a real fix needs new data with individual weights (Phase 9).

## Intended use
Internal dev/staging testing now. Real-user exposure only after either (a) a calibration-cohort validation on actual SK OS users, or (b) explicit "beta / limited validation" framing in the UI. Never as a substitute for actual medical/clinical calorie measurement.

## Non-intended use
Not for clinical nutrition prescription, not for populations outside the stated training population without additional validation, not as a claimed-precise single number — always pair `estimated_active_kcal` with the `lower_kcal`/`upper_kcal` range in any UI surface.

## Versioning
`model_version: skos-cal-v1`, `schema_version: 0.2` (contract version, not model version — these are independent per `calorie-model-contract.md` §1). Retraining on new data (e.g. if outreach data arrives) produces `skos-cal-v2`, never a silent overwrite of v1's behavior for historical results already persisted.
