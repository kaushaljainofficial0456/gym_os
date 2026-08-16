# ML Data Requirements — what the SK OS backend must provide

Consolidates everything learned across this project into one spec for Kaushal. Where a requirement is already met by the existing calorie-model-contract.md (schema 0.2), that's noted as confirmed, not re-litigated.

## Required, already provided (confirmed working against skos-cal-v1)

| Field | Contract path | Status |
|---|---|---|
| Body weight | `user.body_weight_kg` | Required — `mlEstimate` throws without it (caller falls back to baseline, correct behavior) |
| Duration | `session.duration_minutes` | Required, **measured only** — never send an estimated duration here; `mlEstimate` has no way to tell the difference and would silently treat it as real |
| Intensity tier | `session.intensity_rating` (light/moderate/hard) | Sufficient — tested against the richer %1RM signal our research data has, cost <0.2 points of MAPE. No need to add a finer intensity field on our account. |
| Exercise identity + attributes | `exercises[].exercise_id`, `.muscle_group`, `.compound_or_isolation` | Sufficient for the 8 trained exercises; anything else falls back to baseline-only (see below) |

## Not required for v1, explicitly do not add on our account

- **`relative_load`** — cannot even be validated against our current training data (the source studies report %1RM, not absolute load-to-bodyweight ratio, and don't report individual 1RM in kg). Not a blocker for skos-cal-v1. Revisit only if a future dataset actually uses this quantity.
- **RPE** — not in the training data (only RIR). Don't wire this into the calorie model without a specific reason.
- **Wearable/HR data** — out of scope per the original plan; the model has no code path for it.

## Needed for the model to stay honest as exercises/features evolve

1. **New `exercise_library` entries should be flagged to us before they're used at scale.** `skos-cal-v1` only has corrections for 8 exercises (`model_v1.json`'s `exercise_attributes` keys). Any other `exercise_id` silently falls back to baseline-only with a widened interval — not wrong, but a real gym mostly doing untrained exercises would get systematically weaker estimates without anyone noticing unless someone's watching for it. Worth a periodic check: "what fraction of completed sets reference an exercise_id outside the trained 8?"

### Expanding to a large exercise library (~100 exercises) — tested, 2026-08-16

**Nothing breaks.** Adding any number of exercises is safe: unknown `exercise_id`s fall back to the MET baseline with a proportionally widened interval and an explicit `note`. No crash, no silent wrong answer.

**The accuracy cost, measured:**

| Exercise type | Expected MAPE |
|---|---|
| One of the trained 8 | **19.1%** (LOPO-validated, GROSS) |
| Any other exercise | **~36.5%** (baseline-only, GROSS) |

**Both figures are GROSS.** The shipped output is net of resting, which inflates percentage error to **~22-35%** for the trained 8 (see `MODEL_CARD.md`). The untrained figure degrades correspondingly.

For context, ~36% still sits inside the published range for consumer wearables on resistance training (30–53%, see `VALIDATION_REPORT.md`) — so an untrained exercise is not catastrophic, just unremarkable.

**We tested whether category attributes could close that gap. They can't — do not attempt it.** `scripts/exercise_coverage_experiment.py` runs nested leave-one-exercise-out × leave-one-participant-out (model has seen neither the exercise nor the person), predicting the correction from coarse attributes instead of exercise identity:

| Approach | MAPE |
|---|---|
| Baseline-only (current behaviour) | 36.46% |
| Coarse category (upper/lower + compound/isolation + tier) | **34.71%** |
| Coarse + movement_pattern | 36.09% |

A 1.8-point average gain — but **unstable in a way that disqualifies it**: BARBELL_SQUAT improves dramatically (55.2% → 28.2%) while LEG_PRESS gets *twice as bad* (30.0% → 63.8%). Trading a reliable 36% for an unpredictable 28–64% is a bad deal, so v1's honest "zero correction + widen the interval" fallback stays.

**Two things the experiment revealed that are worth knowing:**
- **`muscle_group` cannot generalise to new exercises at this sample size.** It has 6 distinct values across 8 exercises, 5 appearing in exactly one exercise — so it functions as a proxy for exercise identity, not a transferable attribute. (The first version of this experiment produced 1e14% MAPE from exactly this: holding out an exercise made its muscle_group unseen, the design matrix went singular, and unregularised OLS exploded. Regularisation fixed the arithmetic; it did not fix the underlying information problem.)
- Only attributes with **several exercises per level** can transfer. Today that's just upper/lower body and compound/isolation.

**So: add the 100 exercises. Just do these two things.**
1. **Populate `muscle_group` and `compound_or_isolation` on every new entry.** Not used for correction today (see above), but required by the contract, and it's the field that makes future expansion possible once more measured exercises exist.
2. **Track which `exercise_id`s users actually pick.** This is the genuinely valuable output: if a handful of untrained exercises dominate real usage, those are exactly the ones to prioritise measuring in a future calibration study. Usage data turns "which exercises should we measure?" from a guess into a ranked list.

3. **`is_synthesized` on `exercise_set_logs` must keep being set correctly.** Not used by v1 (which trains on external data only), but this is the single most important field for the *next* phase — the calibration cohort (Section 26/Phase 9) — since synthetic legacy rows must never quietly become training data.
4. **`started_at`/`duration_min` must keep being backend-authoritative**, never client-supplied. Already true per `TEAM-CONTRACT.md` §2.1 — flagging because the whole MET-baseline-rate math (`kcal/min`) is meaningless if duration isn't real.

## For the future calibration cohort specifically (not needed now)

If/when SK OS runs a real measured-energy-expenditure study on actual users (Section 26), the backend should be able to export, per session: `user_id` (for cross-referencing to the measurement, not for training), all fields already in the schema-0.2 contract, plus whatever body-composition fields the calibration study collects (fat mass / lean mass — optional profile fields already exist, per the calorie contract's §6 "optional" list, and per the Lytle 2019 formula this data has independent value if ever populated).

## What we will tell you before it changes

Per `TEAM-CONTRACT.md`'s OLD/NEW/WHY/IMPACT rule: if a future model version needs a new input field, that request comes as a proper contract-change proposal, not a silent assumption. Nothing in this document should be read as "coming soon" — it's the boundary of what v1 needs and doesn't need, stated plainly so nobody over-builds for a requirement that doesn't exist yet.
