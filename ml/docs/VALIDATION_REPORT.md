# Validation Report — v0 (living document, updated as phases complete)

## Dataset

25 participants, 3 studies (reis2017, reis2019, brunelli2019), CC BY 4.0. Full detail: `DATA_AUDIT.md`, `DATA_PROVENANCE.md`. This report's model comparison uses the **14-participant reis-lab subset only** (reis2017 + reis2019 share one cohort — proven, see provenance doc) — the only subset with a unit-consistent kcal/min rate target. brunelli2019 (11 participants, absolute kcal over a to-failure protocol) is excluded from rate-based comparisons for the reasons documented in `src/baseline/deployed_baseline_benchmark.py`.

## Splitting methodology

**Leave-One-Participant-Out (LOPO)**, 14 folds. Chosen over a single train/test split because at n=14 a single split would waste too much of an already-small dataset; LOPO still guarantees no participant's rows ever appear in both train and test within a fold. Every number below is out-of-sample.

## Step 1 — Baseline error (MET formula already deployed in `calorieModel.js`)

Formula: `MET × 3.5 × body_weight_kg ÷ 200` (rate form), MET = {light: 3.0, moderate: 4.5, hard: 6.0}. %1RM mapped to tiers as {12,16→light, 20,24→moderate, 80→hard} — a documented approximation, not a validated equivalence (research data has no RIR to derive intensity_rating the way production does).

| | MAE (kcal/min) | MAPE | Bias |
|---|---|---|---|
| Overall | 2.96 | 36.5% | -1.62 |

**Finding: the error is not random — it's systematic and exercise-dependent.** BARBELL_SQUAT is underestimated by 55% (bias -8.28); LEG_PRESS and LEG_EXTENSION are also underestimated. Upper-body isolation exercises (BICEP_CURL, TRICEPS_EXTENSION, LAT_PULLDOWN) are overestimated by 25-42%. The flat 3-tier formula treats all exercises at a given intensity label as metabolically equivalent — measured data says lower-body/compound work costs systematically more than that. Full breakdown: `_deployed_baseline_eval_report_v0.txt`.

## Step 2 — Does any correction beat the baseline? (Section 8/35: test, don't assume)

Correction target = `measured_kcal_min − baseline_predicted_kcal_min` (Section 8's definition). Four models compared, all evaluated under the same LOPO splits:

| Model | MAE | MAPE | Bias |
|---|---|---|---|
| A — baseline alone | 2.96 | 36.5% | -1.62 |
| C — baseline + per-exercise mean-residual correction | 2.17 | 28.2% | ~0.00 |
| C2 — baseline + linear regression correction | 1.73 | 23.3% | ~0.00 |
| D — RandomForest, direct prediction (200 trees, depth 4) | 1.35 | 19.3% | ~0.01 |

**Yes — even the simplest correction (a per-exercise average offset, model C) cuts MAPE from 36.5% to 28.2%, out-of-sample.** The linear model (C2) does better still (23.3%). RandomForest (D) is numerically best (19.3%) but per the Model Selection Rule (Section 35 — never pick a model for sophistication alone), **the linear correction (C2) is the recommended candidate**, not RF: the improvement from C2→D is modest, RF's fit is far less interpretable/explainable (Section 28 requirement), and 14 participants is a thin basis for trusting a nonlinear model's extra flexibility over a linear one, even under honest LOPO validation.

## Step 2b — Pushing further: richer features, still interpretable

Tested whether an exercise×intensity **interaction** term (instead of treating exercise and intensity as independent additive effects) recovers more of RandomForest's advantage while staying a transparent linear model — legitimate to try since each of the 24 exercise×tier combinations still has ~40 rows on average, not a sparse blow-up.

| Model | MAE | MAPE | Bias (kcal/min) |
|---|---|---|---|
| C2 — additive linear correction | 1.74 | 23.4% | +0.01 |
| **E — exercise×intensity interaction, linear** | **1.35** | **19.1%** | **+0.00** |
| F — same features, Huber-robust regression | 1.34 | 18.2% | -0.19 |

**E matches RandomForest's accuracy (19.1% vs 19.3% MAPE) while remaining a fully interpretable linear model** — each exercise×intensity cell gets its own learned correction term, explainable in one sentence per cell, no black-box splits. This is now the recommended candidate, superseding C2. F (Huber) shaves off a further 0.9 points of MAPE at the cost of a small systematic bias (-0.19 kcal/min) — a real trade-off, not a free win, so E stays the primary recommendation; F is noted as an option if outlier-robustness is prioritized over the zero-bias property.

### Out-of-sample error distribution (Model E, all 1,001 LOPO predictions pooled)

| Percentile of \|% error\| | Value |
|---|---|
| 10th | 3.1% |
| 25th | 8.2% |
| 50th (median) | 14.7% |
| 75th | 26.5% |
| 90th | 39.7% |
| 95th | 47.3% |
| Mean (MAPE) | 19.1% |

Note the mean %-error (19.1%) and the mean *signed* %-error (+5.2%) differ from the near-zero kcal/min bias above — %-error is dominated by rows with small measured values (dividing by a small number inflates the percentage), so the kcal/min bias is the more physically meaningful number for "is this systematically over/under," while the %-distribution above is the honest way to answer "how far off should a user expect this to be."

**Worked example, at three magnitudes (using the model's own out-of-sample error distribution, not a guess):**

| If true active burn is... | Typical estimate (±mean error) | Wider realistic band (±75th percentile) |
|---|---|---|
| 50 kcal | 40–60 kcal | 37–63 kcal |
| 100 kcal | 81–119 kcal | 73–127 kcal |
| 200 kcal | 162–238 kcal | 147–253 kcal |

**Context for whether this is "good":** the systematic review found in the data audit (Mitchell et al. 2024) reports that consumer wearables validated against indirect calorimetry run **15–57% MAPE** for resistance exercise specifically. This model's 19.1% sits at the good end of that published range — competitive with, not worse than, commercial wearable calorie estimates, using only workout-log features and no heart-rate/wearable input at all.

### Device-level comparison (compiled 2026-08-16) — read the caveats before quoting this

| Source | Device / model | Activity | Reported MAPE |
|---|---|---|---|
| skos-cal-v1 | **This model** | Resistance (isolated bouts) | **19.1%** |
| Deployed baseline | Flat MET formula | Resistance (isolated bouts) | 36.5% |
| Published validation | Polar A360 | Resistance training | **52.95%** (82% of participants overestimated) |
| Umbrella review of systematic reviews | All major brands | Energy expenditure generally | **>30% for every brand** |
| Multi-device validation | Apple Watch 6 | Across activities | 14.9–47.8% (best case 14.9%, running) |
| Multi-device validation | Polar (across studies) | Various | 29–80% |
| Multi-device validation | Apple Watch / Garmin | Walking | 19.8% / 32% |
| Multi-device validation | Apple Watch / Garmin | Running | 24.4% / 21.8% |
| 2026 study, 62 men, 4 smartwatches | Apple, Galaxy, Fitbit, Garmin | **Resistance protocol** | Correlation with calorimetry **collapsed to r = 0.10–0.34**, reliability ICC < 0.45 |

**The pattern that matters more than any single number:** wearables perform acceptably on steady-state cardio and degrade sharply on resistance training. The 2026 four-device study is the clearest statement of it — during lifting, correlation with true energy expenditure fell to r = 0.10–0.34, i.e. barely related to reality, *despite* those devices measuring heart rate accurately. Resistance training is genuinely the hard case, which is why this project exists.

**Caveats — mandatory when citing the comparison above:**
1. **This is not a head-to-head test.** Different studies, populations, protocols and equipment. Nobody has run skos-cal-v1 and an Apple Watch on the same person in the same session.
2. **The comparison currently flatters us.** V1's 19.1% comes from *isolated single-exercise bouts*; several wearable figures come from full or circuit sessions, which are harder. V1's accuracy on real multi-exercise sessions is **unvalidated** (`V1_PRE_INTEGRATION_AUDIT.md` #3/#9) and could be worse.
3. **Different populations.** V1: 14 young men. Wearable studies often span wider demographics.
4. **V1 uses no heart-rate or wearable input at all** — only workout-log fields. That is a genuine architectural advantage (nothing to strap on, no sensor drift), and worth stating plainly, but it is not the same as being independently proven more accurate.

**Defensible claim:** "competitive with, and plausibly better than, consumer wearables for resistance training specifically — using only workout-log data." **Not defensible:** "more accurate than Apple Watch/Fitbit/Garmin." The first is supported; the second requires a head-to-head study nobody has run.

**Why this isn't going to reach single-digit error, and shouldn't be pushed there artificially:** three real constraints, not a lack of effort — (1) n=14 participants is a hard ceiling on how finely the model can be tuned before any further "improvement" would just be memorizing this specific cohort rather than learning generalizable physiology; (2) inter-individual metabolic variability is a real, physiological source of noise no feature set fully removes — the same exercise at the same relative intensity genuinely costs different people different amounts of energy; (3) indirect calorimetry itself, the "ground truth" this is validated against, has its own measurement error (not perfect either). Chasing the reported number toward 0% would mean overfitting to this specific 14-person sample, which is exactly the failure mode the whole project was designed to avoid.

## Step 3 — The feature-availability question (does production's missing %1RM matter?)

Production's calorie contract has no %1RM — only a coarse `intensity_rating` (light/moderate/hard) and `relative_load` (which this dataset cannot even compute, since it has %1RM but not absolute load-in-kg or 1RM-in-kg). Two feature variants were compared:

- **A_research_best**: exercise attributes + raw %1RM (not deployable — production never sends this)
- **B_deployment_realistic**: exercise attributes + only the coarse intensity tier (what production actually sends today)

| Variant | C2 MAPE | D MAPE |
|---|---|---|
| A (with %1RM) | 23.26% | 19.28% |
| B (without %1RM, tier only) | 23.37% | 19.41% |

**Finding: the gap is negligible (~0.1-0.2 points).** Exercise identity (which exercise, which muscle group, compound vs. isolation) is doing almost all the predictive work — the specific %1RM value within a light/moderate/hard bucket adds very little once exercise identity is known. **This means the deployment-realistic feature set already available in the production contract is nearly as good as the richer research-only one** — a concrete, evidence-based answer to the sync question, not a guess. Recommendation to Kaushal: adding a finer intensity/relative_load signal is not urgently justified by this evidence; exercise-level attributes matter far more.

## Honest limitations of everything above

- n=14 for this comparison, 100% male, 20s-30s, isolated-exercise protocols only — not multi-exercise sessions, not validated for women, other ages, or beginners.
- The %1RM→intensity_rating tier mapping is an assumption, not validated against real RIR data.
- RandomForest's result, while numerically best, is not being recommended as the production candidate — flagged for the exact overfitting-risk reason this whole project was designed to guard against.
- No uncertainty/interval quantification yet (Phase 6, not started) — everything above is a point-estimate error metric.
- No external validation yet (Phase 7) — same data used for all model comparison here, just properly out-of-sample within it via LOPO.

## Step 4 — Uncertainty quantification (Phase 6), validated not invented

Per Section 20's rule ("do not invent ranges such as ±50 kcal without validation"), intervals are built via **group-split conformal prediction**: the 14 reis-lab participants are split into two *disjoint* halves — 7 used to calibrate the interval width (empirical quantiles of the signed out-of-sample error), 7 held back purely to check whether the resulting interval actually contains the true value at the claimed rate. This avoids the circular mistake of calibrating and validating on the same residuals, which would trivially hit the target by construction.

| Target coverage | Empirical coverage achieved | Mean interval width |
|---|---|---|
| 80% | 81.2% (alt split: 80.8%) | 4.01 kcal/min |
| 90% | 91.0% (alt split: 88.2%) | 5.72 kcal/min |

**The intervals are honestly calibrated** — achieved coverage lands within ~1-2 points of target on both random splits tested, which is a legitimate result at this sample size, not a coincidence dressed up as one.

**Limitation, stated plainly:** this is a single global interval width, not adjusted per exercise — but the error analysis in Step 1/2 shows BARBELL_SQUAT has substantially larger absolute error than BICEP_CURL. A single global width is very likely too wide for light isolation work and too narrow for heavy compound work. Per-exercise conformal calibration is the correct next refinement, not attempted yet because splitting 7 calibration participants further by exercise leaves too few rows per cell to trust. Flagged as a concrete limitation, not silently smoothed over.

**Scope correction (added 2026-08-16, per `V1_PRE_INTEGRATION_AUDIT.md` #9):** the 80%/90% coverage above was validated *only* against single-exercise, continuous-bout predictions — the same regime the LOPO folds were built from. It has never been tested against a multi-exercise, volume-weighted, session-duration-extrapolated prediction (no such data exists in this project). `mlEstimate.reference.js` now widens the interval proportionally whenever a prediction relies on unmapped exercises, exceeds the source-measured bout duration, hits the plausibility cap, or uses an out-of-range body weight — but that widening is a heuristic mitigation, not a re-validated coverage guarantee. Do not present 80%/90% as a proven number for real multi-exercise SK OS sessions.

**Participant accounting note:** this report's "14 participants" refers to the reis-lab training/evaluation subset only — see `MODEL_CARD.md`'s participant table for how this reconciles with the "25 participants" figure cited in `DATA_AUDIT.md` (full literature corpus vs. actual model training population).

**Worked example using the validated 90% interval** (additive ±kcal/min around the point prediction, not yet exercise-adjusted per the limitation above): a point prediction of 15 kcal/min carries a 90%-validated range of roughly 12.4–17.5 kcal/min. This is the honest, tested version of the "range" the production API should eventually surface — a real validated width, not a guessed ±X%.

## Step 5 — Brunelli (absolute-kcal target): why this can't become a second trained model, resolved not deferred

Brunelli's data uses a genuinely different target definition (absolute kcal over a 3-sets-to-failure protocol, not a kcal/min rate) — per Section 6's rule, this was always going to be kept separate, never blended into the rate-based model. The open question was whether it could become its *own* LOPO-validated correction model. **Answer: no, and this is now resolved, not left open.**

The blocker isn't the target — it's the predictors. A correction model needs something that varies per observation to correct against (duration, reps, exercise identity). Brunelli's source data has none of these at the individual level: no per-set duration (to-failure sets have no fixed length), no rep count, and only one exercise (leg extension). The only things that vary are participant and load condition (30%/80%1RM) — too little to fit anything beyond reporting the study's own group means, which isn't a "model," it's a lookup table with n=11.

**What this data is still good for — used it as an independent check, not a training run:**

Recomputed the paper's central finding directly from our own harmonized data (not just cited from the abstract):

| Component | 30%1RM (mean±SD) | 80%1RM (mean±SD) | Paired difference |
|---|---|---|---|
| Active exercise kcal | 33.1±5.6 | 28.1±7.8 | -5.0±7.3 |
| EPOC kcal | 91.4±10.6 | 95.1±18.4 | +3.7±20.0 |
| **Total kcal** | **124.5±15.0** | **123.2±25.4** | **-1.3±26.1** |

Confirms the paper's own reported result independently: total energy cost is essentially identical whether the same muscle group is trained to failure at low load/high reps or high load/low reps. This is a genuinely useful, citable physiological finding for product messaging (volume-to-failure matters more than absolute load, within the range tested) — but it's confirmatory literature validation, not a new trained artifact. Logged here so this line of work has a definitive answer instead of sitting as a permanent "todo."

## Next
Phase 6's core deliverable (a validated interval, not an invented one) is done for the reis-lab/rate-based data, and the Brunelli question is now closed (see Step 5) rather than open. Remaining: (a) per-exercise interval calibration once more data exists — still blocked on sample size, unchanged since Step 4, (b) Phase 7 external validation on data untouched by any of the above, gated on new data arriving (Phillips 2004 / Robergs 2007, pending institutional access).
