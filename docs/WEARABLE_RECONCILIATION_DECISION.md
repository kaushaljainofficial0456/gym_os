# Decision: BARBELL's estimate is primary for strength sessions

Status: implemented on `calorie-overhaul`. Not deployed. No production data changed.
Date: 2026-10-30. Owner: product (Kaushal). Supersedes the earlier rule recorded in
`backend/test/healthReconciliation.test.js` ("if the timestamps are the same for both,
give priority to the wearable").

## Decision

For a resistance-training session logged in BARBELL, the stored active energy is
**BARBELL's own estimate**. A wearable's figure for the same session:

- is kept **separately**, with its provenance;
- is **compared** with BARBELL's;
- is **flagged** when the two disagree by more than 40%;
- is **never** swapped in, summed, averaged or weighted with BARBELL's;
- is **never** a reason to raise confidence.

Neither figure has been validated against calorimetry for weight training, so the flag
marks the session for monitoring without treating either side as correct.
Non-strength sessions keep their existing reconciliation.

## Where it applies (all reconciliation paths inspected)

| Path | Code | Behaviour now |
|---|---|---|
| BARBELL strength session + wearable workout record | `reconcileWorkout` → `reconcileStrengthWorkout` | **BARBELL primary**, wearable kept + compared |
| BARBELL strength session + HR/energy samples only | same | **BARBELL primary**. HR recorded as evidence (`heart_rate_only`), **never named as the source** |
| BARBELL non-strength session (none are produced today; `dailyIntelligence` passes every BARBELL session as `strength_training`) | `reconcileWorkout`, original branch | unchanged: wearable primary, BARBELL estimate fills uncovered minutes |
| Same, HR samples only | original branch | **label fixed**: was `primarySource = <wearable>` with confidence raised to 0.70 while storing BARBELL's number. Now attributed to the BARBELL provider at BARBELL confidence. Number unchanged. |
| Wearable-only workout (e.g. a run with no BARBELL session) | `buildExternalWorkoutCandidate` | unchanged; now labelled `energy_basis = device_estimate` |
| Whole-day wearable active energy | `reconcileDailyEnergy` | unchanged (daily level, not session level) |
| Workout summary and history (`workouts.estimated_active_kcal`) | `calorieModel.js` | unchanged; always BARBELL's estimate |
| Post-workout summary in the app (`Workout.jsx`) | frontend | **was** replacing BARBELL's figure with the wearable's and calling it measured. Now shows BARBELL's, with the wearable's on a separate line ("its own estimate, not counted") |
| Burn breakdown (`/health/burn-breakdown`, `BurnDetail.jsx`) | backend + frontend | counted figure = BARBELL's for strength. Both shown with "(counted)" on one. Every workout figure tagged "Estimated". |

### Disagreement rules

- **Same interval only.** BARBELL's estimate for exactly the seconds the wearable covered.
- **Wearable record longer than the session.** If it runs more than 10% beyond the
  session's covered time, no ratio is computed, because the figures cover different time.
- **Ratio:** `|wearable − barbell| / max(wearable, barbell)`, which is symmetric.
- **Flag:** `disagreement_flag = 1` above 0.40. Confidence and `data_quality` are untouched.
- **Missing wearable calories:** kept as `device_workout_without_energy` and no ratio.
- **Two wearables on one session:** one median wearable figure, as before. It is never
  summed and never primary.

## Data recorded

`health_records` (new, nullable): `source_device`, `source_app`. These are filled from what
the native bridge sends:
- **HealthKit:** `device` and `sourceRevision.source.bundleIdentifier` / `sourceName`.
- **Health Connect:** `metadata.device` and `metadata.dataOrigin.packageName`.
- **Never inferred.** WHOOP, Oura and Samsung payloads carry no device field today, so they
  stay null.

`health_canonical_workouts` (new):

| Column | Meaning |
|---|---|
| `energy_basis` | `model_estimate` / `device_estimate`: what `active_kcal` is |
| `reconciliation_policy` | `barbell_primary_strength_v1` / `wearable_primary_non_strength` / `wearable_only` |
| `wearable_active_kcal` | wearable's figure as reported |
| `wearable_provider`, `wearable_source_device`, `wearable_source_app` | provenance |
| `wearable_measurement_type` | `device_estimate` / `device_workout_without_energy` / `heart_rate_only` |
| `wearable_coverage_ratio` | share of the session the wearable's records span |
| `disagreement_ratio`, `disagreement_flag` | as above |

`health_energy_intervals`:
- for a strength session, the primary row is BARBELL's (`is_estimate = 1`);
- the wearable's figure is a non-primary row (`is_primary = 0`, never summed);
- HR-only sessions get no wearable energy row.

## Migration

- **Additive only.** Two nullable columns on `health_records`; ten columns on
  `health_canonical_workouts` (nine nullable, `disagreement_flag` `NOT NULL DEFAULT 0`).
- **Where.** Added to `database/schema.sql` and `init-db.js`'s table definitions, plus
  `HEALTH_COLUMN_MIGRATIONS` in `init-db.js`. That list runs after the health tables exist,
  on SQLite (`PRAGMA` check) and PostgreSQL (`ADD COLUMN IF NOT EXISTS`). A separate list is
  needed because the general `MIGRATIONS` run before the health tables are created on a
  fresh database. Covered by `test/healthDeviceProvenance.test.js`.
- **RLS.** These are columns on tables that already have RLS; `rls.sql` needs no change.
- **Existing rows are not rewritten** by the migration.
  - A past day keeps its old wearable-primary canonical row until that day is reconciled
    again (a new sync for the day, or `GET /health/daily-intelligence?refresh=1`).
  - At that point its stored figure switches to BARBELL's, and the change is written to
    `health_reconciliation_log`.
  - **Owner decision needed before deploy:** leave history to update lazily (as built),
    or run a one-off re-reconciliation of past days. Nothing does the latter today.
- **Old rows in the app.** The app reads old rows correctly in the meantime:
  `wearableComparisonNote` treats a wearable-primary row as the wearable figure.

## Effect on daily totals

- **No whole-day wearable figure:** a strength session now contributes BARBELL's figure
  instead of the wearable's.
- **A whole-day wearable figure exists:** that remains authoritative for the day, unchanged.
  Only the per-session line differs.

## Android

There is no Android source in this repository, so its integration couldn't be inspected
(the 7 local Android commits are not on GitHub).
- **Device identity:** for it to reach `source_device`/`source_app`, the Android bridge
  must forward Health Connect's `metadata.device` and `metadata.dataOrigin`.
- **API compatibility:** the response shapes it would read only gained fields;
  `/health/workouts` rows have new columns.
- **What changes:** for strength sessions, `primary_energy_source`/`active_kcal` now carry
  BARBELL's figure instead of the wearable's.

## Tests

| File | Covers |
|---|---|
| `backend/test/healthReconciliation.test.js` | 420 vs 327 and the mirror case; >40% flag; no confidence gain from coverage or agreement; missing wearable kcal; HR-only; incomplete coverage; over-long record; device and app attribution; two wearables; non-strength behaviour retained |
| `backend/test/healthIntelligence.test.js` | late wearable data stored beside BARBELL's with full provenance, nothing counted twice; HR-only never the recorded source |
| `backend/test/healthBurnBreakdown.test.js` | counted figure and comparison |
| `backend/test/healthDeviceProvenance.test.js` | normalizers carry device/app; migration on an existing database |
| `frontend/test/wearableComparison.test.js` | display note for new and old rows |
