# skos-cal-v1 — handoff note (draft, not sent)

Drafted for review before sending — not yet delivered to Kaushal.

**2026-08-16 update:** a full pre-integration audit was run before this went out (`docs/V1_PRE_INTEGRATION_AUDIT.md` — 20 checks, 10 CRITICAL/6 WARNING/4 PASS originally). Everything fixable without retraining has been fixed — see that doc's Fix Log. Two things are still genuinely open and need Kaushal/product input, not more ML work:
1. ~~Confirm `estimated_active_kcal`'s exact intended meaning~~ — **RESOLVED 2026-08-16.** The backend defines it as net-of-resting (`calorie-model-contract.md` §3) and implements the conversion in `calorieModel.js`'s `toNetOfResting()`. Verified correct in `SKOS_CALORIE_MODEL_VALIDATION_CALIBRATION_REPORT.md` §1. **Consequence:** the headline accuracy figure changed — see Headline numbers below.
2. **Watch the new `note` field in staging.** It now fires whenever an estimate is low-confidence (rate capped, extrapolated beyond the measured bout length, out-of-range body weight, unrecognized intensity, or an empty session) — worth a product decision on how it surfaces in the UI before real users see it.

## What's ready

- `ml/models/skos-cal-v1/model_v1.json` — the trained model artifact (MET baseline constants + per-exercise/per-intensity correction terms + validated 80%/90% uncertainty offsets). Plain JSON, no ML framework needed to consume it.
- `ml/models/skos-cal-v1/mlEstimate.reference.js` — dependency-free reference implementation of `mlEstimate(input)` matching the `calorieModel.js` provider contract already in the backend. Throws on missing `body_weight_kg`/`duration_minutes` so the existing baseline fallback in `calorieModel.js` keeps working unchanged.
- `ml/models/skos-cal-v1/README.md` — integration steps, worked example (bench press/hard/78.67kg/10min → 114 kcal, hand-verified and covered by a regression test).
- `ml/docs/ML_DATA_REQUIREMENTS.md` — what the backend already provides that's sufficient (body weight, measured duration, intensity tier, exercise identity/attributes), and explicitly what NOT to add on our account (`relative_load`, RPE, wearable data) — so nothing gets over-built for a requirement that doesn't exist.
- `ml/docs/VALIDATION_REPORT.md` / `MODEL_CARD.md` — full accuracy numbers, honest limitations, and how the intervals were validated (not guessed).

## Headline numbers

- 19.1% MAPE out-of-sample (LOPO-validated) on **GROSS** kcal, vs. 36.5% for the currently-deployed flat MET formula.
- **The shipped output is NET of resting**, and the gross figure does not transfer: effective accuracy on net output is **~22-35% MAPE** depending on session profile (worst for light/long/low-body-weight). Quote this range externally, never 19.1%. See `MODEL_CARD.md` -> "Accuracy of the shipped (net) output".
- Competitive with published consumer-wearable accuracy for resistance training (15-57% MAPE per Mitchell et al. 2024) — using only workout-log fields, no HR/wearable input.
- Covers 8 exercises with real trained corrections; anything outside that list falls back to baseline-only with a widened interval (not wrong, just less precise) — see `ML_DATA_REQUIREMENTS.md` item 1 for the "flag new exercises before they're used at scale" ask.

## What I'm asking of Kaushal

1. Wire `mlEstimate.reference.js`'s logic into the existing `mlEstimate` stub in `calorieModel.js` (or port the JSON-driven logic directly — either is fine, the JSON is the source of truth either way).
2. Deploy to **dev/staging and internal testing only** — not real users yet. This is a hard line, not a formality: the model is validated against 25 research participants (young, mostly male, isolated-exercise protocols), not SK OS's actual user population. It needs a calibration cohort (in progress, see `PHASE9_CALIBRATION_COHORT_PLAN.md`) before it's trusted for real users' numbers.
3. Confirm `is_synthesized` keeps being set correctly on `exercise_set_logs` — not used by v1, but critical for the calibration phase so synthetic/legacy rows never quietly become training data.
4. No contract changes needed on his end for v1 — `ML_DATA_REQUIREMENTS.md` confirms the existing schema-0.2 fields are sufficient.

## Open items, not blockers

- Still watching for Phillips 2004 (older adults) / Robergs 2007 raw individual-level data — would trigger a v2 retrain if it materializes, not required for v1 to ship to internal testing.
- Per-exercise (rather than global) uncertainty intervals — flagged as a known limitation, needs more calibration data than currently exists.

---
*Draft only — confirm before this goes to Kaushal as an actual message.*
