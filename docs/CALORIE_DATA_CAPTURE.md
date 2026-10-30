# Workout data capture (phase 0)

Approved 2026-10-30. Makes the workout log record **what actually happened and when**, so rest,
density and effort can be studied and, once validated, used. **The production calorie formula and
every displayed figure are unchanged:** none of the new fields is read by `calorieModel.js`.

## What is captured

| Data | How | Where stored |
|---|---|---|
| Set completion time | stamped when the member ticks a set (phone clock); cleared if unticked | `exercise_set_logs.set_completed_at` |
| Set start time | **optional**: tap the set number before lifting | `exercise_set_logs.set_started_at` |
| Actual rest | **derived on the server**: previous set's completion → this set's start, minus paused time. Only when both are measured. | `exercise_set_logs.actual_rest_seconds` |
| Tick interval | previous completion → this completion, minus paused time (rest + set). Available without start taps. | `exercise_set_logs.tick_interval_seconds` |
| Planned rest | the plan's `rest_sec`, labelled as planned | `exercise_set_logs.prescribed_rest_seconds` |
| Pause intervals | each pause's start/end (was only a running total) | `workouts.session_timing_json` |
| Per-set RIR | **optional** chips after a tick ("Reps left? 0 1 2 3 4 5+"); blank is a normal answer | `exercise_set_logs.reported_rir` |
| Timing quality | per-set and session flags (below) | `exercise_set_logs.timing_flags`, `workouts.session_timing_json` |
| Profile gaps | which of height, age, sex and a recent weight log are missing or stale | completion response `profile_gaps` |
| Hidden-mode engine inputs | features + engine status (`not_fitted`, no estimate) | `workouts.calorie_features_json` (never returned by the API) |

## Planned rest vs actual rest

- **Old behaviour:** `exercise_set_logs.rest_seconds` held the **plan's** rest copied onto every
  set, never rest actually taken.
- **New rows:** that column is no longer written (NULL). Planned rest goes to
  `prescribed_rest_seconds`; measured rest goes to `actual_rest_seconds`.
- **Existing rows:** the migration **copies** their value into `prescribed_rest_seconds` and leaves
  `rest_seconds` as it was. Nothing is ever promoted to `actual_rest_seconds`.

## Validation (`backend/src/services/workoutTiming.js`)

Timestamps come from the phone. They are checked against the phone's own session window
(`client_started_at`..`client_finished_at`), so a phone clock that is off from the server's stays
self-consistent. A timestamp that fails a check is stored as NULL **with a flag**; it is never
repaired.

| Flag | Meaning | Action |
|---|---|---|
| `no_completion_time` | set not timed (older app, retroactive log) | none |
| `completed_outside_session` / `started_outside_session` | outside the session window (±60 s) | timestamp dropped |
| `started_after_completed`, `set_too_long` (> 10 min), `start_without_completion` | impossible set timing | start dropped |
| `overlaps_previous_set` | starts before the previous set ended | start dropped |
| `rest_exceeds_limit` (> 30 min) | an interruption, not rest | rest NULL |
| `interval_excludes_pause` | a pause fell inside the interval | pause time removed |
| session `no_set_timestamps` / `partial_set_timestamps` | completeness | — |
| session `interrupted`, `long_pause` (> 30 min) | pauses | — |
| session `idle_tail` (> 15 min after the last set), `idle_head` (> 20 min before the first) | timer left running / started early | **flag only**: duration and estimate unchanged |
| session `duration_shorter_than_sets`, `duration_missing_or_zero`, `duration_exceeds_limit` (> 4 h) | timer anomalies | flag only |
| session `client_window_missing` | no phone window: checked against the server's, ±5 min | — |

These limits decide whether a timestamp is believable. They are not physiology, and never
enter a calorie calculation.

## Per-set RIR is kept away from the estimate

- **Existing `rir` field:** the API's per-set `rir` already feeds the estimator's effort inference
  (RIR ≤ 1 → "hard"). Sending the new chips there would change displayed figures without
  validation.
- **New field:** the chips are therefore sent as `reported_rir` and stored in their own column,
  which the estimator never reads.
- **Test:** `backend/test/workoutCapture.test.js` asserts that RIR 0 on every set leaves the
  estimate unchanged.

## Hidden-mode engine

`backend/src/services/intelligence/calorieEngineShadow.js` logs, per completed session:
- **completeness:** timed sets, started sets, sets with actual rest, sets with RIR, mapped
  exercises, profile gaps and timing flags;
- **person:** mass, height, age, sex;
- **time:** active minutes, paused seconds, measured set durations, actual rest and tick-interval
  statistics, sets per minute;
- **composition:** shares by movement pattern, primary muscle and exercise type;
- **load:** reps, external volume, volume per kg body mass, unloaded reps;
- **effort:** reported RIR statistics.

**Engine status:** each component lists the inputs it is missing. Every component is
`fitted: false`, and the engine returns `estimate_kcal: null`. It contains **no coefficients,
multipliers or default rates**. Those come only from criterion data that passes
`docs/CALORIE_MODEL_RESEARCH_PLAN.md`.

## Migration impact

- **New columns, all nullable:**
  - `exercise_set_logs`: `prescribed_rest_seconds`, `set_started_at`, `set_completed_at`,
    `actual_rest_seconds`, `tick_interval_seconds`, `timing_flags`, `reported_rir`;
  - `workouts`: `session_timing_json`, `calorie_features_json`.
- **How they arrive:** `database/schema.sql` for new databases; `init-db.js` `MIGRATIONS` for
  existing ones (SQLite `PRAGMA` check / PostgreSQL `ADD COLUMN IF NOT EXISTS`).
- **One data step:** copy legacy `rest_seconds` into `prescribed_rest_seconds` where it is empty.
  Idempotent; `rest_seconds` itself is untouched.
- **Historical calorie values** (`estimated_active_kcal`, range, model version, provider) are not
  touched. Old sessions get no timing or features: NULL, not invented. Covered by
  `backend/test/workoutCaptureMigration.test.js`.
- **RLS:** columns on existing tables; no `rls.sql` change.
- **API:** additive only.
  - Request: optional per-set `started_at`, `completed_at`, `reported_rir`; optional `pauses`,
    `client_started_at`, `client_finished_at`. Older clients keep working.
  - Response: `profile_gaps`.
