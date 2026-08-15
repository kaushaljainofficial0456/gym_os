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
2. **`is_synthesized` on `exercise_set_logs` must keep being set correctly.** Not used by v1 (which trains on external data only), but this is the single most important field for the *next* phase — the calibration cohort (Section 26/Phase 9) — since synthetic legacy rows must never quietly become training data.
3. **`started_at`/`duration_min` must keep being backend-authoritative**, never client-supplied. Already true per `TEAM-CONTRACT.md` §2.1 — flagging because the whole MET-baseline-rate math (`kcal/min`) is meaningless if duration isn't real.

## For the future calibration cohort specifically (not needed now)

If/when SK OS runs a real measured-energy-expenditure study on actual users (Section 26), the backend should be able to export, per session: `user_id` (for cross-referencing to the measurement, not for training), all fields already in the schema-0.2 contract, plus whatever body-composition fields the calibration study collects (fat mass / lean mass — optional profile fields already exist, per the calorie contract's §6 "optional" list, and per the Lytle 2019 formula this data has independent value if ever populated).

## What we will tell you before it changes

Per `TEAM-CONTRACT.md`'s OLD/NEW/WHY/IMPACT rule: if a future model version needs a new input field, that request comes as a proper contract-change proposal, not a silent assumption. Nothing in this document should be read as "coming soon" — it's the boundary of what v1 needs and doesn't need, stated plainly so nobody over-builds for a requirement that doesn't exist yet.
