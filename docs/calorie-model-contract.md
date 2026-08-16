# Calorie Model Contract (backend ↔ ML)

**Owner (backend):** Kaushal — this contract is stable. **Consumer (ML):** Sambhav.
The frontend (Manavi) consumes only the API-level output (§6) and never learns which
provider produced it.

The single integration point is:

```
backend/src/services/intelligence/calorieModel.js
    estimateWorkoutCalories(input) -> result
```

Feature extraction (actual `exercise_set_logs` → input) is done by the backend via
`buildWorkoutCalorieInput()` — the **single feature-engineering choke point**. Routes
and services never compute calorie features themselves. **The model never touches
PostgreSQL.** The backend persists the result.

---

## 1. Versioning

- `schema_version`: version of THIS input/output contract. Current: **`0.2`**.
  (`0.1` added session/exercise/derived aggregates — see §2.1/§2.2; output shape unchanged.)
- `model_version`: version of the model implementation (Sambhav's choice), e.g.
  `skos-cal-v1`. Persisted per-workout for traceability.
- Changing the contract shape requires bumping `schema_version` (coordinate with
  Kaushal; see `docs/TEAM-CONTRACT.md` OLD/NEW/WHY/IMPACT).

## 2. INPUT (schema_version 0.2)

```jsonc
{
  "schema_version": "0.2",
  "user": {
    "age_years": 30,          // number | null
    "sex": "male",            // "male" | "female" | "other" | null
    "height_cm": 175,         // number | null
    "body_weight_kg": 78      // number | null (backend-resolved; see §5)
  },
  "session": {
    "workout_id": "wko_abc",          // string | null
    "duration_seconds": 1800,         // number | null (MEASURED only — see §2.3)
    "duration_minutes": 30,           // number | null (rounds to 1 decimal)
    "intensity_rating": "moderate",   // "light" | "moderate" | "hard" | null
    // --- v0.2 session aggregates (actual completed sets only) ---
    "exercise_count": 4,              // exercises with ≥1 completed set (skipped = 0)
    "total_sets": 12,                 // completed sets
    "total_reps": 96,                 // completed reps
    "total_volume_kg": 3240,          // completed volume (Σ reps × weight_kg)
    // --- v0.2 derived features (null when denominator unknown — never fabricated) ---
    "volume_per_minute": 108.0,       // total_volume_kg / duration_min
    "sets_per_minute": 0.4,           // total_sets / duration_min
    "reps_per_minute": 3.2,           // total_reps / duration_min
    "relative_load": 0.77,            // average_load_kg / body_weight_kg
    "compound_set_ratio": 0.75,       // compound sets / total sets
    "isolation_set_ratio": 0.25       // isolation sets / total sets
  },
  "exercises": [
    {
      "exercise_id": "libA",          // canonical exercise_library.id | name | null
      "exercise_type": "compound",    // string | null (exercise_library.ex_type)
      "muscle_group": "chest",        // canonical muscle id | null
      "equipment": "BARBELL",         // string | null
      "movement_pattern": "horizontal_push", // string | null
      "compound_or_isolation": "compound",   // "compound" | "isolation"
      "completed_sets": [
        {
          "set_number": 1,
          "reps": 10,                 // number (0 when bodyweight/unknown)
          "weight_kg": 60,            // number (0 when bodyweight/unknown)
          "rir": 2,                   // number 0-5 | null
          "rest_seconds": 90,         // number | null
          "completed": 1              // always 1 (incomplete sets are excluded)
        }
      ],
      // --- v0.2 per-exercise aggregates (actual completed sets only) ---
      "sets": 3,                      // completed sets for this exercise
      "total_reps": 30,
      "total_volume_kg": 1800.0,      // Σ reps × weight_kg (1 decimal)
      "average_load_kg": 60.0         // total_volume_kg / total_reps (1 decimal; 0 when no reps)
    }
  ]
}
```

### 2.1 Session & per-exercise aggregates

- Computed **only from actual completed `exercise_set_logs`** (see §2.2). Planned
  workload from `workout_exercises` is never used as actual calorie workload.
- `exercise_count` counts exercises with ≥ 1 completed set — **skipped exercises
  (0 completed sets) contribute 0 sets / 0 reps / 0 volume and are NOT counted**.
- Exercises with zero completed sets still appear in the `exercises` array (with
  `completed_sets: []` and aggregate values 0) so the model can see the full session.

### 2.2 Actual-workout semantics (read carefully)

- **Only completed sets appear.** Skipped exercises contribute `0 sets / 0 reps /
  0 workload` and are not counted as completed work.
- `weight_kg: 0` means bodyweight or unknown — do not treat as a zero load signal.
- `exercise_id` is the shared canonical library id; it is `null` for name-only
  exercises (rare). Never invent a second exercise database.
- **Synthesized/legacy sets** (`exercise_set_logs.is_synthesized = 1`) are included
  in the input but remain identifiable via the DB flag — **filter `is_synthesized = 0`
  for training data**. A dedicated `is_synthesized` field is deliberately NOT added to
  the contract input; provenance filtering happens in the training pipeline.
- Missing values are never fabricated: optional fields are `null`, aggregates that
  require a missing denominator are `null`, unknown weights become `0` (documented
  bodyweight convention), and an empty workout yields `total_sets: 0`.

### 2.3 Duration provenance (measured vs estimated)

- `duration_seconds` / `duration_minutes` carry **measured duration only** — the
  server-authoritative `completed_at − started_at` from `POST /workouts/:id/start` →
  `/complete`. Client-supplied start times are **never accepted**.
- When no measured duration exists (e.g. NL-logged sessions via
  `/intel/confirm-workout`), `duration_*` are `null` — the input never substitutes an
  estimated duration for a measured one.
- `estimateDurationMinutes()` (baseline provider only) derives a **clearly-labeled
  estimate** from completed sets when duration is absent; it is never presented as
  measured and never feeds the contract's `duration_*` fields.

## 3. OUTPUT (schema_version 0.2)

```jsonc
{
  "schema_version": "0.2",
  "estimated_active_kcal": 285,   // number, integer — ACTIVE calories only
  "lower_kcal": 250,              // number, integer — low end of the range
  "upper_kcal": 320,              // number, integer — high end of the range
  "model_version": "skos-cal-v1", // string
  "provider": "baseline",         // string — "baseline" | "mock" | "ml"
  "note": "optional explanation"  // string (optional)
}
```

- `estimated_active_kcal` must equal the range midpoint: `lower ≤ est ≤ upper`.
- Active calories = energy expended during the session beyond resting; do not include
  BMR/total daily expenditure unless agreed otherwise. The `ml` provider's underlying
  model computes **gross** workout-period expenditure — the backend converts gross to
  net at the integration boundary (`calorieModel.js: toNetOfResting()`, reusing the
  same MET-based formula as §7's baseline, with `MET=1` as the ACSM definition of
  resting rate) before any result reaches this contract or `validateCalorieResult()`.
  `estimated_active_kcal` is therefore always net-of-resting, regardless of provider.
- Values are never negative; lower bound ≥ 0. A gross value that is already invalid
  (e.g. negative) is never "fixed" by the conversion — it still fails validation and
  falls back to `baseline`, per §7.

## 4. Enums

| Field | Values |
|---|---|
| `sex` | `male` \| `female` \| `other` \| `null` |
| `intensity_rating` | `light` \| `moderate` \| `hard` \| `null` (backend derives from avg RIR when absent: ≤1 hard, ≤3 moderate, else light) |
| `compound_or_isolation` | `compound` \| `isolation` |
| `provider` | `baseline` \| `mock` \| `ml` |
| `muscle_group` | canonical ids from `services/muscles.js` (`chest`, `lats`, `quads`, …) or `null` |

## 5. Body weight resolution (backend, Phase 11)

Order of preference (documented in `docs/TEAM-CONTRACT.md` §4.2):
1. nearest `weight_logs` row at/before the session day
2. `clients.current_weight`
3. `clients.start_weight`
4. `clients.target_weight`
5. `null` → the baseline provider falls back to **70 kg** (documented; never claimed
   as measured).

## 6. API-level output (what the frontend sees)

`GET /api/tracking/me/today` → `session.meta.calorie`:

```jsonc
{
  "schema_version": "0.2",
  "estimated_active_kcal": 285,
  "lower_kcal": 250,
  "upper_kcal": 320,
  "model_version": "skos-cal-baseline-v1",
  "provider": "baseline",
  "source": "preview" | "persisted",   // preview = planned estimate (never persisted);
                                       // persisted = actual-set estimate from completion
  "estimated_at": "2026-08-15T10:00:00Z" // persisted only
}
```

`POST /api/workouts/:id/complete` returns the same object with `source: "persisted"`
(and `duration_min`). `POST /api/intel/confirm-workout` returns the persisted calorie
for NL-logged sessions. `meta.estKcal` is kept in sync with
`meta.calorie.estimated_active_kcal` for existing UI compatibility.

## 7. Providers & fallback behavior

- `CALORIE_MODEL_PROVIDER=baseline` (default) — deterministic MET heuristic:
  `MET × 3.5 × body_weight_kg ÷ 200 × duration_min`, `MET ∈ {light 3.0, moderate 4.5,
  hard 6.0}`, range ±15%. Explicitly **not ML**. This is the only provider running in
  production today, and remains the default in every environment unless
  `CALORIE_MODEL_PROVIDER=ml` is explicitly set — `ml` is opt-in, never automatic.
- `CALORIE_MODEL_PROVIDER=mock` — fixed demo values (300/250/350), clearly labeled.
- `CALORIE_MODEL_PROVIDER=ml` — **implemented (Phase 3B Step 3).** Sambhav's
  `skos-cal-v1` artifact, ported into
  `backend/src/services/intelligence/mlModels/skosCalV1.js` (+ `skosCalV1.model.json`)
  from `origin/ml-sambhav`; see §8. **Dev/staging only** — per Sambhav's own
  `V1_PRE_INTEGRATION_AUDIT.md`, the model's known production limitations are still
  unresolved (the correction terms do not scale with body weight; multi-exercise
  session interval coverage is unvalidated beyond single-exercise research bouts).
  `ml` must not be enabled in production until those are separately resolved. Any ML
  failure (exception, timeout, or invalid output) still falls back to `baseline` and
  marks a `note` explaining why — that fallback behavior is unchanged from before this
  provider was implemented.
- **Provider honesty:** the persisted result always records the provider actually used
  (`workouts.calorie_provider`) — a baseline result never appears to be an ML
  prediction, and the provider is never exposed to the frontend.
- **Error behavior:** the backend wraps estimation in try/catch at every call site.
  Estimation failure never fails workout completion/logging — the workout commits and
  the calorie result stays `null`. The model is expected to be robust to missing
  optional fields (all are nullable per §2).

## 8. Where Sambhav plugs in

**Implemented (Phase 3B Step 3).** `mlEstimate(input, { signal })` in
`backend/src/services/intelligence/calorieModel.js` delegates to the ported
`skos-cal-v1` logic in `mlModels/skosCalV1.js` — a mechanical CommonJS→ESM port of
`origin/ml-sambhav`'s `mlEstimate.reference.js`; `mlModels/skosCalV1.model.json` is
`model_v1.json` copied byte-for-byte from the same branch, no fitted coefficient
changed. Two backend-owned adapter steps sit between the ported model and this
contract's gate, both internal to `calorieModel.js`:
- **Exercise-ID canonicalization** — a known **global** exercise's `animation_key`
  maps to one of Sambhav's 6 confirmed canonical tokens (`bench_press → BENCH_PRESS`,
  `squat → BARBELL_SQUAT`, `leg_press → LEG_PRESS`, `leg_extension → LEG_EXTENSION`,
  `lat_pulldown → LAT_PULLDOWN`, `bicep_curl → BICEP_CURL`); a custom (non-global)
  exercise's `animation_key` is never trusted. `INCLINE_BENCH_PRESS` and
  `TRICEPS_EXTENSION` are intentionally left unmapped (multiple plausible backend
  candidates, no source resolves which) — never guessed.
- **Gross → net-of-resting conversion** (§3) — applied to whatever the `ml` branch
  produces before validation, so `mlModels/skosCalV1.js` stays a clean, minimally-
  diffed port of Sambhav's original (gross-computing) logic.

Routes, persistence, `validateCalorieResult()`, and the frontend did **not** change.
A future model version (`skos-cal-v2` or later) follows the same drop-in path: replace
or extend `mlModels/skosCalV1.js`'s logic, keep the §3 output shape, coordinate
`model_version` naming and any `schema_version` bump with Kaushal.

## 9. Constraints (from TEAM-CONTRACT)

- No direct DB access from the model.
- No credentials exposed to the frontend.
- Deterministic-first rule preserved: model unavailable ⇒ baseline fallback, never a
  crash, never a fabricated "measured" claim.
