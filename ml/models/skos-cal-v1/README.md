# skos-cal-v1 — integration package

**What this is:** the exercise×intensity linear-correction model (Model E from `docs/VALIDATION_REPORT.md`), retrained on all 14 reis-lab participants and exported as a plain lookup table. No ML framework needed to run it — `mlEstimate.reference.js` is dependency-free JavaScript.

## Files

- `model_v1.json` — the trained artifact: MET baseline constants, per-exercise attributes, per-exercise×intensity correction values (kcal/min), and validated 80%/90% interval offsets (jackknife+/CV+ calibrated from genuine leave-one-participant-out residuals).
- `mlEstimate.reference.js` — reference implementation of the `ml` provider, matching `docs/calorie-model-contract.md` (schema 0.2) exactly. Tested against hand-verified examples (see below).

## Integration steps (for whoever merges this into `calorieModel.js`)

1. Copy `model_v1.json` and `mlEstimate.reference.js` into `backend/src/services/intelligence/` (or wherever the backend keeps model artifacts).
2. In `calorieModel.js`, replace the body of `mlEstimate(input)` with a call into this module's `mlEstimate(input)` — same function name and signature already exist as the designated integration point (see `docs/calorie-model-contract.md` §8).
3. Set `CALORIE_MODEL_PROVIDER=ml` in a **dev/staging environment only** — not production yet (see rollout sequence below).
4. Nothing else changes — `validateCalorieResult()` already gates the output, routes/persistence/frontend are untouched, exactly per the contract's design.

## Correctness check performed

Ran 4 hand-verified test cases through the JS implementation and cross-checked the arithmetic by hand:
- Single exercise (bench press, hard, 78.67kg, 10min) → 114 kcal, matches manual calculation (baseline 8.26 kcal/min + 3.17 kcal/min correction × 10min = 114.3).
- Multi-exercise session (squat + bicep curl, volume-weighted).
- Unknown/unmapped exercise → falls back to zero correction + widened interval, never guesses.
- Missing body weight or duration → throws, which the existing `estimateWorkoutCalories()` caller already catches and falls back to baseline — no new error-handling needed on the backend side.

**2026-08-16 — post-audit fixes:** `V1_PRE_INTEGRATION_AUDIT.md` found several extrapolation/flagging gaps (details there); `mlEstimate.reference.js` was revised to add a plausibility rate cap, proportional interval widening, per-exercise zero-volume handling, and explicit flagging for unrecognized intensity values, out-of-range body weight, and empty sessions — all via the `note` field, all additive to `model_v1.json` as metadata, **zero change to any fitted coefficient** (proof: `docs/_v1_audit_fix_diff.txt`). Run `node mlEstimate.test.js` in this folder for the full regression/fix test suite (9/9 passing).

**Whoever integrates this: check the `note` field.** It's now a real signal, not just an FYI — it fires whenever an estimate is low-confidence (capped, extrapolated beyond the measured bout length, out-of-range body weight, defaulted intensity, or an empty session). Decide during staging how this should surface in the UI (suppress, show as a caveat, downgrade the interval styling, etc.) — that's a product decision, not something this reference implementation can decide for you.

## Recommended rollout sequence — do not skip steps

1. **Dev/staging only, `ml` provider, internal team testing** — run real (anonymized) workout logs through it, sanity-check outputs look physiologically reasonable, confirm no crashes on edge cases (bodyweight exercises with `weight_kg: 0`, single-set sessions, all-unknown-exercise sessions).
2. **Do not expose to real end users yet.** This model is validated on 14 male, ~20-35yo participants doing isolated single-exercise lab bouts — not on real multi-exercise SK OS sessions, not on women, not on other ages. See `docs/MODEL_CARD.md` for the full scope statement.
3. Before any real user sees `ml`-provider output: either (a) collect calibration-cohort data on real SK OS users to validate this population actually behaves similarly, or (b) ship with clear "estimate based on limited research data, individual results may vary" framing and treat it as a beta feature.
4. Multi-exercise session aggregation (volume-weighted average of per-exercise corrections) is a reasonable extrapolation beyond what was directly validated (each source study measured ONE exercise at a time) — worth specifically watching for sessions with many different exercise types during staging testing.

## Known limitations (repeated from MODEL_CARD.md, worth having here too)
- Population: 100% male, ~20-35yo, isolated single-exercise protocols.
- 8 exercises only (BENCH_PRESS, INCLINE_BENCH_PRESS, BARBELL_SQUAT [half-squat variant], LEG_PRESS, LEG_EXTENSION, LAT_PULLDOWN, BICEP_CURL, TRICEPS_EXTENSION) — anything else falls back to baseline-only with a widened interval.
- Interval width is not yet exercise-specific (a known, documented gap — see VALIDATION_REPORT.md Step 4).
- n=14 — treat every number here as "best available given current data," not "final."
- Hard-tier (80%1RM) rates are capped at 20 kcal/min and flagged beyond ~1 minute of duration — a safety net against short-bout rates being extrapolated over a full session, not a validated model of long-duration cost. See `V1_PRE_INTEGRATION_AUDIT.md`.
- Correction terms don't scale with body weight (source data has no individual weights) — flagged outside ~57-100kg, not fixed.
