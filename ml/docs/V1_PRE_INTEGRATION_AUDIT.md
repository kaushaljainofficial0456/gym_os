# skos-cal-v1 — Pre-Integration Audit

> **UPDATE (2026-08-16): fixes applied.** Every CRITICAL/WARNING finding below that could be addressed without retraining has been fixed in `mlEstimate.reference.js` + additive metadata in `model_v1.json`. See **[Fix Log](#fix-log-2026-08-16)** at the end of this document for exactly what changed, what's still open, and proof that no fitted coefficient was touched. The findings below are left as originally written (the audit record), with the Fix Log giving the current status of each.

**Scope:** scientific + engineering review of `model_v1.json` and `mlEstimate.reference.js` before backend integration. **No retraining performed. No files under `ml/models/` or `ml/src/` were modified.** Every number below was recomputed directly from the shipped artifact and the existing processed data (`data/processed/*.csv`), not estimated or recalled from memory — scripts used are inline in this doc's evidence sections and their outputs are reproducible from files already in this repo (`docs/_v1_audit_sensitivity_analysis.csv` is a new, additive output of this audit, containing the full 144-row sensitivity table condensed below).

**Important caveat on scope:** `calorie-model-contract.md` is not present in this repository — it exists only on Kaushal's side (reviewed once, in an earlier session, from a delivered zip, not committed here). Several findings below (particularly #1, #2, #9) depend on the contract's exact intended semantics and are marked accordingly as unverifiable from this repo alone. This is itself flagged as a finding, not silently assumed either way.

---

## 1. What does the baseline formula represent?

**Classification: WARNING**

`MET[tier] × 3.5 × body_weight_kg ÷ 200` is the ACSM standard MET-to-kcal/min conversion. The `3.5 mL·kg⁻¹·min⁻¹` constant embedded in "1 MET" already represents **resting** oxygen consumption — so this formula outputs **gross energy expenditure** (total metabolic rate during the activity), not net-of-resting. It does not subtract a resting baseline anywhere in the pipeline (confirmed: no resting-rate subtraction term exists in `deployed_baseline_benchmark.py` or `mlEstimate.reference.js`).

The ML correction target (`residual = measured_kcal_min − predicted_kcal_min`, `models/exploratory_correction_v0.py:63`) is built on `measured_kcal_min` sourced from reis2017's relative-VO2 and reis2019's directly-reported EC — both of which are **gross, VO2-derived, during-exercise measurements**, with no resting subtraction in the source studies' own methodology either (confirmed via `ml/src/ingestion/reis2017.py`/`reis2019.py` docstrings — no resting/basal term is referenced anywhere in either file). Brunelli2019's data explicitly separates a `rest` component from `exercise`/`epoc`/`total` (see `brunelli2019.py:36`), confirming the field convention in this literature: "exercise" EE is gross, not resting-subtracted.

**So baseline and target are internally consistent — both gross.** That's the good news. What's unverified: whether SK OS's product/contract *means* "gross" when it says "active calories." See #2.

---

## 2. Does `estimated_active_kcal` match its actual target definition?

**Classification: CRITICAL — cannot be fully resolved from this repo, and the two plausible readings materially disagree**

`estimated_active_kcal` is computed as `(baseline_rate + correction_rate) × duration_minutes` — i.e. **gross energy expenditure during the logged exercise duration.** Two industry conventions exist for "active calories" and they produce different numbers:

- **Convention A (what this model computes):** gross EE during the active period. No resting subtraction.
- **Convention B (Apple Health / Fitbit "active calories," arguably the more common consumer expectation):** EE *above* what would have been burned at rest for that same duration — i.e. `gross − resting_rate × duration`.

At `bw=78.67kg`, resting rate ≈ `1 MET × 3.5 × 78.67 / 200 = 1.38 kcal/min`. Over a 60-minute session that's **83 kcal** of difference between the two conventions — not a rounding issue.

**I am not proposing a silent change.** Per the instructions, this is flagged, not altered. Recommendation: confirm directly against `calorie-model-contract.md` §8's field definition (not available in this repo) before shipping. If the contract intends Convention B, either (a) rename the field to something unambiguous (`estimated_gross_exercise_kcal`), or (b) subtract a resting term before output — a real calculation change, not a naming change, and one that should go through the same OLD/NEW/WHY/IMPACT contract-change process already established in `ML_DATA_REQUIREMENTS.md`.

---

## 3. Is the multi-exercise aggregation scientifically justified?

**Classification: CRITICAL**

Two distinct extrapolations are stacked here, and only one is currently documented:

**(a) Blending per-exercise corrections by volume-share across exercises in one session** — already flagged in `MODEL_CARD.md`/`README.md` as "reasonable but unvalidated." No new finding here, correctly disclosed.

**(b) Applying the resulting blended RATE across the full session `duration_minutes` — not documented anywhere, and more serious.** Per `DATA_AUDIT.md` row 7, the training data's bouts were **continuous, single-intensity, 26 seconds to 5 minutes long** ("4–5 min / 26–56s" for reis2017; "4×4min" for reis2019). The 80%1RM ("hard") condition specifically corresponds to the **shortest** bouts in that range — near-maximal continuous effort sustainable for well under a minute. `mlEstimate` has no concept of "time under tension" vs. "total session time"; it multiplies the fitted rate directly by whatever `duration_minutes` the session logged, which is very likely (contract not available to confirm) the full start-to-end session time **including rest between sets and exercises**.

**Quantified consequence (see #4):** a "hard"-tier `BARBELL_SQUAT` active rate of 36.2 kcal/min, sustained conceptually for a 90-minute session, is not a modest extrapolation — it assumes a human can continuously exert near-80%1RM squat effort for 90 straight minutes, which is not physiologically achievable by any population, let alone the model's own training population. This is the single largest scientific gap found in this audit, and it compounds with #8 (intensity-tier mapping) and #13 (body-weight non-scaling) below.

---

## 4. Sensitivity analysis — 30/45/60/75/90/120 min × light/moderate/hard × all 8 exercises

**Classification: CRITICAL** (full 144-row table: `docs/_v1_audit_sensitivity_analysis.csv`, `bw=78.67kg` — the cohort mean, i.e. this is the *most favorable* body weight for the model, not an edge case)

Representative rows (full table has all 8 exercises × 3 tiers × 6 durations):

| Exercise | Tier | Active rate (kcal/min) | 60 min | 90 min | 120 min |
|---|---|---|---|---|---|
| BARBELL_SQUAT | hard | **36.23** | 2,174 | 3,261 | 4,348 |
| LEG_EXTENSION | hard | **25.57** | 1,534 | 2,302 | 3,069 |
| LEG_PRESS | hard | 19.82 | 1,189 | 1,784 | 2,379 |
| INCLINE_BENCH_PRESS | hard | 16.68 | 1,001 | 1,501 | 2,002 |
| BENCH_PRESS | hard | 11.43 | 686 | 1,029 | 1,372 |
| BICEP_CURL | hard | 8.56 | 513 | 770 | 1,027 |

For reference: a 78.67kg elite endurance athlete sustaining near-maximal aerobic power (e.g. a competitive cyclist in a time trial) tops out around 20-24 kcal/min, and only for a limited duration — not 60-120 minutes. A recreational lifter's realistic session-average burn (across working sets *and* rest) is typically single digits to low teens kcal/min. The table above puts several cells 2-3x above even elite-athlete sustained output.

## 5. Implausibly high/low predictions flagged

**Classification: CRITICAL**

24 of 144 sensitivity cells (16.7%) are flagged:
- **8 cells exceed 20 kcal/min sustained rate** (BARBELL_SQUAT hard, LEG_EXTENSION hard) — physiologically implausible as a sustained rate for any duration tested.
- **16 cells exceed 12 kcal/min** (adds INCLINE_BENCH_PRESS hard, LEG_PRESS hard) — very high but not impossible for brief periods; implausible as a 60+ minute sustained rate.
- **16 cells produce a session total above 1,500 kcal** for a single exercise — for comparison, 1,500 kcal is in the range of a full marathon's energy cost.
- No cells were implausibly *low* (all active rates stay ≥1 kcal/min; the `Math.max(0, ...)` floor in `mlEstimate.reference.js:75` prevents negative rates, confirmed working — light-tier `LAT_PULLDOWN`/`BICEP_CURL`/`TRICEPS_EXTENSION` all have negative correction terms but never drive the active rate below zero).

**Every flagged cell is at the "hard" tier.** Light and moderate tiers never exceed 11.55 kcal/min even at the longest duration tested, and none flagged. This localizes the problem precisely: it is the 80%1RM/"hard" tier's short-bout-rate being extrapolated to long durations (#3), not a general model defect.

---

## 6. Correction term audit — BARBELL_SQUAT hard, LEG_EXTENSION hard, INCLINE_BENCH_PRESS hard

**Classification: CRITICAL for BARBELL_SQUAT hard and LEG_EXTENSION hard; WARNING for INCLINE_BENCH_PRESS hard**

Traced every correction back to its underlying rows (`data/processed/exploratory_features_v0.csv`):

| Exercise | Tier | n rows | n participants | mean measured (kcal/min) | std | min–max | Source |
|---|---|---|---|---|---|---|---|
| BARBELL_SQUAT | hard | 14 | 14 | 35.94 | 4.98 | 26.98–42.97 | **reis2017 only** |
| LEG_EXTENSION | hard | 14 | 14 | 25.70 | 9.23 | 15.83–43.41 | **reis2017 only** |
| INCLINE_BENCH_PRESS | hard | 14 | 14 | 16.78 | 6.06 | 9.68–31.72 | **reis2017 only** |

**Critical structural fact, not previously documented anywhere:** every single "hard"/80%1RM row across all 8 exercises comes exclusively from reis2017 (112 rows, confirmed by direct query) — **reis2019 has no 80%1RM condition at all** (it only measured 12/16/20/24%). This means the "hard" tier has **zero cross-validation from a second, independently-measured source** — unlike light/moderate, which benefit from reis2019's directly-reported EC values taking precedence over reis2017's derived ones in the dedup logic. Every hard-tier correction rests entirely on one measurement method, one file, one lab's 80%1RM protocol.

These are not fabricated or corrupted numbers — they trace consistently to real, individually-measured relative-VO2 values (reis2017's yellow block), converted via the documented cohort-mean-weight method. The values themselves are plausible **as short-bout, near-maximal-effort rates** (a brief 26-56 second near-failure squat set genuinely can elicit a very high VO2, partly reflecting rapid non-steady-state oxygen kinetics and an anaerobic-energy-system contribution that the standard 5kcal/L O2 conversion doesn't cleanly separate from aerobic cost). The problem is not the data — it's applying a short-burst rate as if it were a sustainable steady-state rate (see #3/#4).

LEG_EXTENSION hard's std (9.23, CV≈36%) is also notably higher than its own light/moderate tiers (CV≈22%/38%) and higher than BARBELL_SQUAT hard's CV (≈14%) — meaning the single global 80%/90% interval (already flagged as a known limitation in `VALIDATION_REPORT.md` Step 4) is likely **too narrow** for this specific cell, compounding the point-estimate concern.

---

## 7. Exercise variant labeling — half-squat vs. BARBELL_SQUAT

**Classification: WARNING (correctly documented in code/docs, but missing from the shipped artifact itself)**

Confirmed: `ml/src/ontology/exercise_map.py`'s `EXERCISE_VARIANT_NOTES` explicitly documents that the source studies used a "half squat" protocol on a guided/Smith-type rig, not a free-weight full-depth barbell back squat — and states this may not transfer 1:1 to SK OS's `BARBELL_SQUAT` if that's logged as a free barbell lift. This is real, honest documentation — not a silent mislabel at the source-code level.

**The gap:** this caveat lives in a Python docstring and in `MODEL_CARD.md`/`README.md`, but **not in `model_v1.json` itself.** Whoever integrates or later maintains this model, reading only the shipped JSON artifact (the thing that actually ships to production), would see `"BARBELL_SQUAT": {"muscle_group": "quads", ...}` with no hint that the underlying data is a half-squat, not a full free-weight squat. Recommend adding a `"data_source_variant_note"` field per exercise directly into `exercise_attributes` in the exported JSON, not just in prose docs that ship separately.

---

## 8. Intensity normalization

**Classification: CRITICAL — two distinct issues**

**(a) Unmapped runtime values silently default to "moderate":**
```js
function normalizeTier(rating) {
  const r = String(rating || '').toLowerCase();
  if (r === 'light' || r === 'hard') return r;
  return 'moderate'; // matches calorieModel.js's own normalizeIntensity default
}
```
Confirmed in `mlEstimate.reference.js:96-100`: any value other than the literal strings `"light"` or `"hard"` — including `"very_hard"`, `"extreme"`, `null`, `""`, a typo, or a future contract's new tier — silently becomes `"moderate"`. This is exactly the failure mode the audit brief named explicitly. No explicit supported-intensity contract exists; recommend defining one (e.g. a fixed enum `{light, moderate, hard}`) and either throwing (consistent with the existing missing-body-weight/duration behavior, forcing a baseline fallback) or at minimum setting the `note` field to flag that an unrecognized value was coerced, rather than silently absorbing it.

**(b) The %1RM→tier mapping itself may not represent what real users' `intensity_rating` values mean — already partially disclosed, but the severity wasn't previously quantified.** `deployed_baseline_benchmark.py`'s own docstring calls this "a reasonable but NOT validated mapping." Concretely: `light`=12-16%1RM and `moderate`=20-24%1RM are both **very light loads** in real training terms — a typical hypertrophy-range "moderate" set in practice is usually 60-80%1RM, not 20-24%. Only `hard` (80%1RM) corresponds to a real heavy-training load. If production's RIR-derived `intensity_rating` labels typical 60-80%1RM work as "moderate" (plausible), then production "moderate" sessions would be scored against research data calibrated on much lighter loads than what's actually happening — a mismatch in the opposite direction from the "hard" tier's over-extrapolation problem in #3/#4. This was disclosed as an approximation; this audit's finding is that the approximation's *consequences* (implausible hard-tier outputs, likely-mismatched moderate-tier calibration) were not previously quantified anywhere.

---

## 9. 80%/90% prediction interval calibration validity

**Classification: CRITICAL**

Confirmed via `ml/src/uncertainty/conformal_intervals_v0.py`: the conformal calibration (`run_model_e_lopo()`) reuses the **exact same per-row, single-exercise, continuous-bout evaluation** as the point-estimate model — same 1,001 rows, same LOPO structure. **The interval is validated only for single-exercise research bouts. It has never been validated against a multi-exercise, volume-weighted, session-duration-extrapolated prediction** — because no such data exists in the training set at all (every source study measured one exercise at a time; see `MODEL_CARD.md`'s own "Known failure modes").

**Compounding engineering gap found in this audit, not previously documented:** `mlEstimate.reference.js` only widens the interval when **every** exercise in the session is unknown (`anyUnknownExercise && !anyKnownExercise`, line 78). A session that is, say, 80% unmapped-exercise volume and 20% `BARBELL_SQUAT` volume gets **zero interval widening** — full-confidence 90% bounds reported on a prediction that is mostly extrapolation. See #18.

**Bottom line: do not claim 90% coverage for real multi-exercise SK OS sessions.** The number is genuine and honestly earned for the narrow case it was tested on (isolated single-exercise bouts); it has not been shown to hold, and there's good structural reason to doubt it holds, for anything resembling an actual logged gym session.

---

## 10. Participant reconciliation — one authoritative table

**Classification: WARNING (the underlying numbers are internally consistent and correctly computed; the *documentation* across files is what caused the 14-vs-25 confusion)**

Recomputed directly from `unified_observations_v0.csv` and `model_e_lopo_predictions_v0.csv`:

| | reis2017 | reis2019 | brunelli2019 | **Total** |
|---|---|---|---|---|
| Unique participants | 14 | 14 | 11 | **25** |
| Rows (harmonized, post-dedup) | 679 | 994 | 396 | 2,069 |
| Used to train/evaluate `model_v1.json`? | Yes | Yes | **No** | 14 participants, 1,001 rows |
| Participant overlap with reis-lab | — | 100% identical to reis2017 (proven numerically, see `reis2017.py` docstring) | 0 (confirmed, disjoint) | — |

**Resolution of the discrepancy:** "25 participants" (`DATA_AUDIT.md`, `HANDOFF_NOTE_FOR_KAUSHAL.md`) refers to the **full literature corpus** across all 3 studies. "14 participants" (`model_v1.json`'s `trained_on.participants`) refers to the **reis-lab subset actually used to train and evaluate the shipped model** — brunelli2019's 11 participants were deliberately excluded from training/evaluation (no clean rate-form target; used only as an independent confirmatory check in `VALIDATION_REPORT.md` Step 5, never as training or held-out eval data). Both numbers are correct; they answer different questions. **Recommend adding this exact table to `VALIDATION_REPORT.md` and `MODEL_CARD.md`** so this doesn't require re-deriving from source next time.

There is **no held-out evaluation population beyond LOPO folds within the same 14** — every number this project has produced is internal cross-validation on one 14-person cohort. This is a limitation already stated in multiple docs, restated here because it's directly relevant to the A-E integration verdict below.

---

## 11. Were 19.1% and 36.5% MAPE computed on identical held-out rows?

**Classification: PASS, with a nuance worth stating precisely**

Recomputed directly: `deployed_baseline_eval_v0.csv` (baseline), `exploratory_features_v0.csv` (Model E's training/eval base), and `model_e_lopo_predictions_v0.csv` (Model E's LOPO output) are **all exactly 1,001 rows**, built from the identical underlying row set (confirmed by direct length/participant-count comparison). Baseline MAPE recomputed independently here: **36.458%** (rounds to the documented 36.5%) — matches exactly.

**The nuance:** the baseline is a zero-parameter fixed formula — it has no "training" step, so in-sample and out-of-sample are identical for it by construction; there's no way for it to have an unfair in-sample advantage. Model E's 19.1% is genuinely out-of-sample via LOPO (a fresh model refit on 13 participants for every prediction). This is a valid, honest comparison — if anything **conservative in the baseline's favor** (Model E is held to the harder standard of the two), not an apples-to-oranges setup.

---

## 12. Participant-level out-of-sample predictions

**Classification: PASS — provided for audit, no red flags**

Per-participant LOPO error (Model E, genuinely held out each time), recomputed from `model_e_lopo_predictions_v0.csv`:

| Participant | n | MAE | MAPE | Bias |
|---|---|---|---|---|
| reis_lab_p7 | 72 | 0.85 | 12.4% | -0.27 |
| reis_lab_p13 | 71 | 0.93 | 14.9% | +0.20 |
| reis_lab_p5 | 72 | 1.35 | 15.7% | -0.37 |
| reis_lab_p8 | 71 | 1.03 | 16.5% | +0.08 |
| reis_lab_p9 | 72 | 1.31 | 16.5% | -0.78 |
| reis_lab_p6 | 72 | 1.60 | 17.7% | -0.69 |
| reis_lab_p1 | 72 | 1.43 | 19.4% | +0.04 |
| reis_lab_p3 | 71 | 1.28 | 19.6% | +0.57 |
| reis_lab_p4 | 71 | 1.68 | 20.6% | -0.46 |
| reis_lab_p14 | 72 | 1.27 | 21.9% | +0.51 |
| reis_lab_p2 | 71 | 1.83 | 21.0% | -1.01 |
| reis_lab_p10 | 72 | 1.38 | 22.4% | +0.22 |
| reis_lab_p11 | 72 | 1.46 | 24.3% | +0.61 |
| reis_lab_p12 | 70 | 1.55 | 24.6% | +1.42 |

No participant is a wild outlier (range 12.4%-24.6%, no participant driving the aggregate MAPE disproportionately). Bias is small and mixed-sign across participants (no systematic direction). This is genuinely reassuring evidence for the *point-estimate* model's stability — it does not speak to the extrapolation concerns in #3/#4/#9, which are about applying the model outside the regime these numbers were computed in.

---

## 13. Body-weight extrapolation

**Classification: CRITICAL**

The correction term (`correction_kcal_per_min_by_exercise_and_tier`) is a **fixed kcal/min value, not scaled by body weight anywhere** — confirmed in `mlEstimate.reference.js:67` (`correctionRate += weight * lookup[tier]` — `weight` here is volume-share, not body weight; body weight only enters via `baselineRate`). This is a direct consequence of the source data itself: per `DATA_AUDIT.md` row 8, **none of the 3 studies report individual participant body weight** — only a cohort mean (78.67±10.7kg for reis-lab) was available, so the correction could never have learned a body-weight relationship even in principle.

Recomputed across a realistic body-weight range (45-130kg), `BARBELL_SQUAT` hard:

| Body weight | Baseline rate | Fixed correction | Active rate | Correction's share of active rate |
|---|---|---|---|---|
| 45 kg | 4.72 | +27.97 | 32.69 | 85.5% |
| 60 kg | 6.30 | +27.97 | 34.27 | 81.6% |
| 78.67 kg (cohort mean) | 8.26 | +27.97 | 36.23 | 77.2% |
| 100 kg | 10.50 | +27.97 | 38.47 | 72.7% |
| 130 kg | 13.65 | +27.97 | 41.62 | 67.2% |

A 45kg user and a 130kg user get active rates of 32.69 vs 41.62 kcal/min — **only a 27% difference despite body weight nearly tripling.** Physiologically, moving/stabilizing more body mass through the same relative-intensity movement should scale active energy cost roughly with mass; a correction term that doesn't scale at all means the model's output is dominated by a constant that was fit on a ~79kg-average cohort and is being applied unchanged to users far outside that range. This compounds every other finding above — a light user gets an even more disproportionate correction relative to their true baseline than the cohort-mean case already shows in #4/#5.

---

## 14. Volume-weighting logic audit

**Classification: WARNING**

`mlEstimate.reference.js:62-63`:
```js
const weight = totalVolume > 0 ? (ex.total_volume_kg || 0) / totalVolume
                                : (ex.sets || 0) / (totalSets || 1);
```
Blends a **rate** (kcal/min per exercise) using **load-volume share** (kg lifted) as the weighting basis, falling back to set-count share only if the whole session has zero total volume. This is a reasonable engineering choice given the fields actually available in the contract, but it is an unvalidated proxy for what should really drive a rate-blend: **time spent on each exercise**, which isn't in the contract at all. Two exercises can have identical `total_volume_kg` while taking very different amounts of time (heavy-low-rep vs. light-high-rep), which would be blended identically here despite representing different actual time allocations. Not urgent to fix immediately, but worth flagging precisely as "a proxy for a proxy," not a validated time-allocation signal.

---

## 15. Skipped exercises contribute zero workload/correction

**Classification: PASS**

Confirmed, `mlEstimate.reference.js:49`: `input.exercises.filter((e) => (e.completed_sets || []).length > 0)` runs before any volume/weight calculation. An exercise with zero completed sets is excluded entirely — it does not enter `totalVolume`, `totalSets`, or the correction blend. Verified by direct code read, no ambiguity here.

---

## 16. Bodyweight exercises and zero-load exercises

**Classification: CRITICAL**

The zero-volume fallback (`totalVolume > 0 ? ... : ...`) is evaluated at the **whole-session level**, not per-exercise. Consequence: if a session mixes a loaded exercise (e.g. `BARBELL_SQUAT`, nonzero volume) with a **known, trained** exercise logged at `total_volume_kg: 0` (a bodyweight variation, or a data-entry gap — e.g. `BICEP_CURL` done with resistance bands and no kg logged), the zero-volume exercise's weight becomes `0 / totalVolume = 0`. **Its trained correction is silently excluded from the blend even though it's a recognized, trained exercise** — not because it's unknown, but purely because its own volume happened to be zero while the session's total wasn't. The set-count fallback only triggers when the *entire session's* volume is zero, never per-exercise. This is a real, previously-undocumented gap: a legitimately-logged bodyweight variant of a trained exercise gets treated as if it contributed nothing, rather than falling back to its own set-share within the session.

---

## 17. Empty workouts and missing-duration behavior

**Classification: PASS for missing duration; WARNING for zero-exercise sessions**

- **Missing `duration_minutes` or `body_weight_kg`:** confirmed throws (`mlEstimate.reference.js:42-44`), caller falls back to baseline provider per the existing, tested architecture. PASS, matches documented/tested behavior exactly.
- **Zero completed exercises, but valid `duration_minutes`:** the function does **not** throw or return zero — it returns `baselineRate × duration` for whatever `intensity_rating` was supplied (defaulting to "moderate" per #8 if that's also missing/invalid). A session where the user started a workout, logged no completed sets, and ended it would still produce a confident-looking nonzero calorie number, framed identically to a real workout estimate. Recommend either returning a distinct signal (zero, or an explicit `note` marking it as a non-workout duration) rather than silently treating an empty session as generic "moderate" activity for its full duration.

---

## 18. Unknown exercises

**Classification: CRITICAL**

Confirmed: unknown exercises contribute zero correction (correct, matches the documented "never guess" rule) but **their volume still counts in the `totalVolume`/`totalSets` denominators**, diluting the weight fraction assigned to known exercises without contributing anything themselves. Combined with #9's finding: interval widening only fires when **every** exercise is unknown (`anyUnknownExercise && !anyKnownExercise`) — a session where, say, 80% of volume is an untrained exercise and 20% is `BARBELL_SQUAT` produces a full-confidence, non-widened 90% interval on an estimate that is mostly extrapolation from a single minority-share known exercise. Recommend widening proportional to the unknown-exercise volume/set share, not as an all-or-nothing binary.

---

## 19. Output fields and units

**Classification: PASS** (aside from the naming concern already covered in #1/#2)

`schema_version`, `estimated_active_kcal`, `lower_kcal`, `upper_kcal`, `model_version` — all present, all integers via `Math.round`, all in kcal (no kJ ambiguity anywhere in the pipeline). `lower_kcal` is explicitly clamped `≥0`; `upper_kcal` is never negative by construction given the existing, tested invariant that `lo_offset ≤ 0 ≤ hi_offset` (`test_pipeline.py::test_interval_offsets_are_ordered_correctly`, confirmed passing). No missing or malformed fields found in any code path traced.

---

## 20. Confirmation: no model modification performed

**Classification: PASS (compliance statement)**

`model_v1.json`'s `trained_at` timestamp and every coefficient/correction value were read, never written, during this audit. No retraining script was run. The only new file this audit produced is `docs/_v1_audit_sensitivity_analysis.csv` (a read-only sensitivity table) and this document — both purely additive, nothing in `ml/models/` or `ml/src/` was touched.

---

## Summary table

| # | Check | Classification |
|---|---|---|
| 1 | Baseline formula definition | WARNING |
| 2 | `estimated_active_kcal` naming vs. target | **CRITICAL** |
| 3 | Multi-exercise aggregation justification | **CRITICAL** |
| 4 | Sensitivity analysis | **CRITICAL** |
| 5 | Implausible outputs | **CRITICAL** |
| 6 | Correction term audit (3 named exercises) | **CRITICAL** (SQUAT, LEG_EXTENSION) / WARNING (INCLINE_BENCH_PRESS) |
| 7 | Exercise variant labeling | WARNING |
| 8 | Intensity normalization | **CRITICAL** |
| 9 | Interval calibration validity | **CRITICAL** |
| 10 | Participant reconciliation | WARNING (docs only — math is correct) |
| 11 | Identical eval rows for both MAPE numbers | PASS |
| 12 | Participant-level predictions | PASS |
| 13 | Body-weight extrapolation | **CRITICAL** |
| 14 | Volume-weighting logic | WARNING |
| 15 | Skipped exercises = zero | PASS |
| 16 | Bodyweight/zero-load exercises | **CRITICAL** |
| 17 | Empty workouts / missing duration | PASS (duration) / WARNING (empty session) |
| 18 | Unknown exercises | **CRITICAL** |
| 19 | Output fields/units | PASS |
| 20 | No modification performed | PASS |

**10 CRITICAL, 6 WARNING, 4 PASS** (some checks split across sub-findings).

---

## A. Safe to integrate into staging?

**Yes, conditionally.** Wiring `mlEstimate` into `calorieModel.js` behind the existing `CALORIE_MODEL_PROVIDER=ml` flag, in a non-production environment, is a safe *engineering* step — the existing fallback architecture (throws on missing fields → baseline provider) is sound and tested. The condition: whoever runs staging needs to walk in expecting exactly the extreme outputs documented in #4/#5 (a "hard"-tier squat-heavy long session *will* return an absurd number today) — otherwise this will read as a staging bug hunt rather than a known, already-diagnosed limitation.

## B. Safe to expose to internal testers?

**No.** A tester logging a realistic squat-heavy session and seeing "3,261 kcal for 90 minutes" will (correctly) stop trusting the feature, and that first impression is hard to undo even after the underlying issue is fixed. Minimum bar before internal testing: address #3/#4/#5/#6 (the hard-tier extrapolation) in some form — even a stopgap plausibility cap — plus #8a (stop silently defaulting unknown intensity values).

## C. Safe for production?

**No, not close.** Beyond B's blockers: #9 (interval validity for real multi-exercise sessions), #13 (body-weight scaling), #16/#18 (zero-load and unknown-exercise handling), and #2 (confirm `estimated_active_kcal` semantics against the actual contract) all need resolution. Given #10's honest accounting — this is still fundamentally a 14-person, single-exercise-lab-bout model — production exposure should also wait on the Phase 9 calibration-cohort work already scoped in `PHASE9_CALIBRATION_COHORT_PLAN.md`, per the "beta framing or calibration data, whichever comes first" rule already stated in `README.md`.

## D. Required fixes before staging

- None strictly blocking (staging is internal/code-only) — but strongly recommended before anyone looks at outputs: add a plausibility guardrail (e.g., flag/cap when active rate exceeds ~15-20 kcal/min sustained) so extreme cases are visibly marked as suspect rather than presented with full confidence identical to a normal case.
- Fix #8a's silent unknown→moderate default — cheap, mechanical, removes a real silent-failure mode before anyone starts testing against it.

## E. Required fixes before production

1. Redesign or explicitly bound how `duration_minutes` interacts with the "hard" tier — the core fix for #3/#4/#5/#6. Likely needs either a rate cap grounded in physiology, a duration-decay model, or restricting "hard" tier corrections to short-duration estimates only until real multi-set session data exists.
2. Resolve #2 — confirm `estimated_active_kcal`'s intended semantics against the real contract; rename or recalculate as needed.
3. Fix #13 — either scale the correction term by body weight (would require retraining, out of scope per this audit's instructions) or explicitly bound/flag its use outside the ~68-89kg range the training data actually covers.
4. Fix #16 — per-exercise zero-volume fallback, not session-level-only.
5. Fix #18 — proportional interval widening by unknown-exercise volume share, not all-or-nothing.
6. Re-scope #9's coverage claim — either validate on real multi-exercise sessions (ties to Phase 9) or stop presenting the 80%/90% figures as applicable beyond single-exercise estimates.
7. Address #17's empty-session case — don't return a confident nonzero estimate for a session with zero completed work.

None of these require retraining on the existing data (per the explicit instruction not to optimize MAPE by retraining on the same data) — they are calculation-logic, bounds, and interval-widening fixes on top of the existing coefficients, plus one open confirmation question (#2) that needs Kaushal/product input, not more ML work.

---

## Fix Log (2026-08-16)

**Proof no coefficient was touched:** `docs/_v1_audit_fix_diff.txt` — direct before/after comparison of `correction_kcal_per_min_by_exercise_and_tier`, `interval_offsets_kcal_per_min`, and `baseline`, all confirmed byte-for-byte `UNCHANGED`. `export_model_v1.py` was edited to add new metadata keys only; the LinearRegression fit itself was not re-run with different inputs, and the added metadata was verified against the pre-fix artifact before this log was written.

| # | Finding | Status | What changed |
|---|---|---|---|
| 1 | Baseline formula definition | **Documented** | Confirmed gross EE, stated explicitly in this doc; no code change needed (baseline and target were already consistent). |
| 2 | `estimated_active_kcal` naming vs. target | **Still open** | Cannot be unilaterally resolved — needs confirmation against the real `calorie-model-contract.md`, which isn't in this repo. No calculation changed (would risk guessing wrong). Flagged prominently in the new code header comment. |
| 3/4/5 | Multi-exercise/duration extrapolation, implausible outputs | **Mitigated** | Added `plausibility_guardrails.max_active_rate_kcal_min` (20 kcal/min, documented rationale) — `mlEstimate` now caps the rate and flags via `note` when hit. BARBELL_SQUAT hard @ 90min: **3,261 → 1,800 kcal**. LEG_EXTENSION hard @ 90min: **2,302 → 1,800 kcal**. This is a safety net, not a scientific fix — real resolution needs multi-set session data (Phase 9). Also added a separate duration-vs-source-bout-length flag (fires even when the cap doesn't) so every hard-tier prediction beyond ~1 minute is explicitly marked as extrapolated. |
| 6 | Correction term audit (3 named exercises) | **Documented + mitigated** | Root cause (all 112 hard-tier rows are reis2017-only, no reis2019 cross-check) written up in this doc; addressed at runtime via the same plausibility cap as #3/4/5. |
| 7 | Exercise variant labeling | **Fixed** | `model_v1.json`'s `exercise_attributes.BARBELL_SQUAT` now carries `"data_source_variant_note"` directly in the shipped artifact — no longer only in source docstrings. |
| 8a | Silent unknown-intensity default | **Fixed** | `normalizeTier()` now returns `{tier, wasDefaulted}`; any value outside `{light, moderate, hard}` is still defaulted to moderate (safest fallback, matches existing backend behavior) but now adds an explicit `note` and widens the interval — never silently absorbed. |
| 8b | %1RM-tier-to-production-tier mapping validity | **Still open** | Genuinely can't be fixed without new data confirming what real users' RIR-derived `light`/`moderate`/`hard` values correspond to in %1RM terms — this is a Phase 9 question, not a code fix. |
| 9 | Interval calibration validity for multi-exercise sessions | **Mitigated** | Interval now widens proportionally to unknown-exercise workload share (was all-or-nothing) and widens whenever the plausibility cap, duration-extrapolation, or body-weight-out-of-range flags fire. Coverage is still only *proven* for single-exercise bouts — that claim's scope is now reflected in when the interval actually widens, not just in prose. |
| 10 | Participant reconciliation | **Fixed** | Authoritative table (this doc, §10) — recommend copying into `VALIDATION_REPORT.md`/`MODEL_CARD.md` on next doc pass. |
| 13 | Body-weight extrapolation | **Mitigated** | `model_v1.json.body_weight_validity` now ships `flag_below_kg`/`flag_above_kg` (mean ± 2SD = 57.3–100.1kg) computed from the actual cohort SD; `mlEstimate` flags and widens outside that range. Root cause (no individual weights in source data) is **not fixable without new data** — stated explicitly in the artifact itself now, not just in this doc. |
| 14 | Volume-weighting logic | **Documented, not changed** | Confirmed reasonable given available contract fields; a real fix needs a per-exercise duration field, which is a contract-change proposal for Kaushal (per `ML_DATA_REQUIREMENTS.md`'s existing process), not something to add unilaterally. |
| 15 | Skipped exercises = zero | No change needed | Already correct. |
| 16 | Bodyweight/zero-load exercises | **Fixed** | `computeWeights()` rewritten: if every exercise has usable volume, weight by volume (unchanged); if any exercise lacks it, the *whole session* falls back to set-count weighting, so a zero-volume known exercise is never silently dropped. Verified: a session with `BARBELL_SQUAT` + zero-volume `BICEP_CURL` now produces a measurably different (lower) estimate than `BARBELL_SQUAT` alone, proving the curl is actually being included. |
| 17 | Empty workouts | **Fixed** | Zero-completed-exercise sessions still return a shape-consistent estimate (unchanged API contract) but now always carry an explicit `note` — no longer indistinguishable from a real workout estimate. |
| 18 | Unknown exercises, interval widening | **Fixed** | Widening is now `1 + (widen_factor − 1) × unknown_volume_share` — proportional, not all-or-nothing. Verified: a session that's 80% unmapped-exercise volume now produces a measurably wider interval than an all-known session at the same duration; previously it would not have. |
| 19/20 | Output fields/units, no modification during audit | No change needed | Already correct; confirmed unchanged by this fix pass too (same field set, same units). |

**Verification performed:**
- `ml/tests/test_pipeline.py` — full suite re-run, **9/9 still pass** (proves the fitted artifact's core numbers are untouched).
- `ml/models/skos-cal-v1/mlEstimate.test.js` — new, **9/9 pass**, covering: the original hand-verified 114kcal example (regression check, unchanged), the plausibility cap engaging, unrecognized-intensity flagging, zero-volume known-exercise inclusion, proportional interval widening, empty-session flagging, out-of-range body-weight flagging, and both existing missing-field throw behaviors (unchanged). Run with `node mlEstimate.test.js` from `ml/models/skos-cal-v1/`.

**Updated verdicts, given the above:**
- **A — Staging: yes**, same as before, now with less need for the "expect absurd numbers" caveat — the cap keeps the worst cases bounded and self-explaining via `note`.
- **B — Internal testers: closer, but still hold.** The cap prevents the most embarrassing numbers (3,261→1,800 kcal), but 1,800 kcal for a 90-minute squat-only session is still a lot, and every hard-tier estimate now carries a visible extrapolation note — good for transparency, but worth a UI decision on how `note` gets surfaced (or suppressed) before testers see it raw.
- **C — Production: still no.** #2 (field semantics) and #13's root cause (no real body-weight scaling possible without new data) are unresolved by design — they need a product decision and new data respectively, not more code.
- **D — Staging fixes: done**, both items from the original list are in.
- **E — Production fixes: 5 of 7 addressed** (mitigated or fixed); #2 (semantics confirmation) and full #13 resolution (needs Phase 9 data) remain genuinely blocked on things outside this codebase.
