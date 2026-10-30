# Calorie model research plan (pre-registered)

Written **before any criterion data exists**, so the comparison cannot be tuned to the
result. The harness that runs it is `ml/src/research/models.py`. It refuses to run a
comparison whose evidence gate is not met.

## 1. Quantity

The target is **net kcal for the session**: gross gas-exchange energy minus the
participant's measured resting rate × session minutes. That is the quantity the app stores as
`estimated_active_kcal`.
- Models predict a **net rate** (kcal/min) and multiply by session minutes, so duration
  enters once.
- Gross and net are never mixed. A wearable figure is only compared after its stated kind
  (gross / net-active) is matched.

## 2. Architecture: separate terms, not one effort multiplier

Stage 2 showed effort, load, rest and density are different things that published data
cannot separate. The model keeps them apart:

| # | Component | Features (from `features.build_session_table`) | Expected direction |
|---|---|---|---|
| 1 | Physiology | body mass, age, sex, height; later fat-free mass where measured | rate scales with size |
| 2 | Exercise-specific cost | shares of session sets by category (compound lower, upper push/pull, isolation…) | large-muscle compound work costs more per minute |
| 3 | Work duration | work minutes (sum of set durations) | |
| 4 | Rest duration | rest minutes; mean rest between sets | longer rests lower the session **rate** |
| 5 | Density | sets per minute; work fraction | denser sessions have higher rates |
| 6 | Composition and load | volume per kg body mass; mean load per kg; session kind | load extends sessions more than it raises rate (Joao 2021, unverified) |
| 7 | Physiological measurements | mean HR where a validated chest strap was worn; never wrist calories | candidate only after component 1–6 models are calibrated |

Effort (session RPE) is kept as a **separate** candidate feature, so its added value can be
tested and not assumed.

## 3. Candidates, in the order they may be considered

1. **Production baseline (unfitted).** The deployed formula: Compendium MET by effort, net
   of Mifflin-St Jeor. The reference every other candidate must beat.
2. **Calibrated baseline.** The same structure, with a single multiplicative calibration
   per effort tier, fitted under person-grouped CV. This is the smallest change that could
   reach production.
3. **Hierarchical (mixed-effects) regression.**
   - Model: net rate ~ components 1–6 + random intercept per person.
   - New people are predicted from fixed effects only.
   - Features with no variance, or that add no rank (e.g. composition shares summing to 1),
     are dropped automatically.
   - When between-person variance is estimated at zero, the fit is equivalent to OLS, and
     the harness records which one was used.
4. **Gradient-boosted trees (LightGBM)** on the same features. Only at the `tree_models`
   gate. With fewer people a flexible model mostly learns the participants.

Neural networks and wearable-calorie features are out of scope until the above are settled.

## 4. Gates (`models.GATES`)

Counted on real, criterion-target sessions only; synthetic fixtures never count.

| Level | Unlocks | People | Sessions | Studies | Min people per sex |
|---|---|---|---|---|---|
| `baseline_calibration` | 1, 2 | 30 | 60 | 1 | 10 |
| `model_comparison` | 3 | 60 | 200 | 2 | 25 |
| `tree_models` | 4 | 150 | 600 | 3 | 60 |

The thresholds follow the usual 10–20 observations per estimated parameter at the
**person** level (about 10 fixed effects), and two or more studies so leave-one-study-out is
possible.

## 5. Validation and metrics

- **Person-grouped 5-fold CV** (a person's sessions never straddle folds) and
  **leave-one-study-out**, which also removes held-out people seen in another study. Both
  are asserted in code.
- **Reported for every candidate:** n people, n studies, n sessions; MAE (kcal); mean bias
  (kcal and %); MAPE.
- **Breakdowns:** per sex, age band, session template and study.
- **Uncertainty:** prediction intervals calibrated on person-grouped out-of-fold residuals
  (split-conformal). The displayed range must reach its stated coverage per template before
  it can replace the uncalibrated ±25% band.

## 6. Decision rule for production (fixed now)

A candidate replaces the baseline only if **all** hold under leave-one-study-out:
1. MAE ≤ 0.85 × the baseline's, with the paired bootstrap CI (over people) of the
   difference excluding 0;
2. |mean bias| ≤ 10% overall and in each session template;
3. no subgroup (sex, age band, template) worse than the baseline by more than 10%;
4. interval coverage within 5 points of nominal.

Passing changes the `reliability` the API reports, from `low` to a level justified by the
measured error. Until then it stays `low`.

## 7. What would change this plan

Only a protocol amendment written before new data is analysed.
