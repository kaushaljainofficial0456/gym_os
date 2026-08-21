# Action 1 — exercise usage tracking (spec for backend)

**For:** Kaushal. **Status:** specified, not implemented — this is backend/analytics territory, outside the ML layer.

**Why this is the highest-leverage free action in the whole remediation list:** blocker 9 currently reads *"measure 199 more exercises"*, which is impossible. Usage data almost certainly rewrites it as *"measure the 12 that actually matter"*, which is a single lab afternoon. It converts an unsolvable blocker into a scoped one, using data the app already generates.

---

## What to collect

No new user interaction, no new columns on the hot path. `exercise_set_logs` already carries everything needed.

A periodic aggregate is enough — this is not per-request telemetry:

```sql
SELECT
  el.id                                  AS exercise_id,
  el.name,
  el.primary_muscle,
  COUNT(DISTINCT sl.workout_log_id)      AS sessions_containing,
  COUNT(*)                               AS total_sets,
  SUM(sl.actual_reps * sl.actual_weight) AS total_volume_kg,
  COUNT(DISTINCT sl.client_id)           AS distinct_clients
FROM exercise_set_logs sl
JOIN exercise_library el ON el.id = sl.exercise_id
WHERE sl.completed = 1
GROUP BY el.id, el.name, el.primary_muscle
ORDER BY total_sets DESC;
```

**Privacy:** aggregate only. No `client_id` values leave the query — `COUNT(DISTINCT client_id)` is a k-anonymity guard, not an identifier. Nothing here is PII.

**Frequency:** weekly is ample. This informs a measurement study, not a live decision.

---

## The one number that matters

```
ML-covered volume share
  = volume on the trained 8 / total volume across all exercises
```

The trained 8 are: `BENCH_PRESS`, `INCLINE_BENCH_PRESS`, `BARBELL_SQUAT`, `LEG_PRESS`, `LEG_EXTENSION`, `LAT_PULLDOWN`, `BICEP_CURL`, `TRICEPS_EXTENSION` (`model_v1.json` → `exercise_attributes`).

Mapping from SK OS ids to canonical tokens already exists in `calorieModel.js`'s `toMlInput()` — reuse it rather than re-deriving, so the tracked number matches what the model actually sees.

**How to read it:**

| Covered volume share | Interpretation |
|---|---|
| > 60% | ML is doing real work; blocker 9 is much smaller than the 4% library figure suggests |
| 20–60% | Mixed. The top uncovered exercises are the measurement shortlist. |
| < 20% | ML is mostly falling through to baseline. Worth asking whether it's earning its complexity yet. |

**[REPO]** Library coverage is ~4% by *exercise count* (8 of 207). Coverage by *actual usage volume* is the number that matters and is currently unknown — people don't train 207 exercises uniformly. This measurement is the only way to find out.

---

## What to do with the output

1. **Rank uncovered exercises by total volume.** That ranking *is* the measurement priority list for any future calibration study — it replaces guesswork with usage evidence.
2. **Watch for concentration.** If the top 20 exercises carry ~80% of volume (the usual shape for this kind of catalogue), then measuring ~12 more exercises would take coverage from ~4% to a large majority of real workload.
3. **Feed it back into `PHASE9_STUDY_PROTOCOL.md` §4.2**, which currently says participants train "their own normal session." Usage data lets that be stated concretely instead.

---

## What this deliberately does not do

- Does **not** change any estimate. Purely observational.
- Does **not** justify adding corrections for popular exercises without measurement — popularity is not evidence of energy cost. It tells us *what to measure*, never *what the answer is*.
- Does **not** need per-user tracking, retention, or any new consent surface.
