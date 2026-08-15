# Calorie Model Contract (backend ↔ ML)

**Owner (backend):** Kaushal — this contract is stable. **Consumer (ML):** Sambhav.
The frontend (Manavi) consumes only the API-level output (§6) and never learns which
provider produced it.

The single integration point is:

```
backend/src/services/intelligence/calorieModel.js
    estimateWorkoutCalories(input) -> result
```

Feature extraction (actual `exercise_set_logs` → input) is done by the backend;
**the model never touches PostgreSQL**. The backend persists the result.

---

## 1. Versioning

- `schema_version`: version of THIS input/output contract. Current: **`0.1`**.
- `model_version`: version of the model implementation (Sambhav's choice), e.g.
  `skos-cal-v1`. Persisted per-workout for traceability.
- Changing the contract shape requires bumping `schema_version` (coordinate with
  Kaushal; see `docs/TEAM-CONTRACT.md` OLD/NEW/WHY/IMPACT).

## 2. INPUT (schema_version 0.1)

```jsonc
{
  "schema_version": "0.1",
  "user": {
    "age_years": 30,          // number | null
    "sex": "male",            // "male" | "female" | "other" | null
    "height_cm": 175,         // number | null
    "body_weight_kg": 78      // number | null (backend-resolved; see §5)
  },
  "session": {
    "workout_id": "wko_abc",          // string | null
    "duration_seconds": 1800,         // number | null (measured; null when unknown)
    "duration_minutes": 30,           // number | null (rounds to 1 decimal)
    "intensity_rating": "moderate"    // "light" | "moderate" | "hard" | null
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
      ]
    }
  ]
}
```

### Semantics (read carefully)

- **Only completed sets appear.** Skipped exercises appear with
  `completed_sets: []` — they contribute 0 sets / 0 reps / 0 workload. The session
  record keeps them so the model can see the full session if useful.
- `weight_kg: 0` means bodyweight or unknown — do not treat as a zero load signal.
- `exercise_id` is the shared canonical library id; it is `null` for name-only
  exercises (rare). Never invent a second exercise database.
- `duration_*` are `null` when no measured duration exists (e.g. NL-logged sessions).

## 3. OUTPUT (schema_version 0.1)

```jsonc
{
  "schema_version": "0.1",
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
  BMR/total daily expenditure unless agreed otherwise.
- Values are never negative; lower bound ≥ 0.

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
  "schema_version": "0.1",
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
  hard 6.0}`, range ±15%. Explicitly **not ML**.
- `CALORIE_MODEL_PROVIDER=mock` — fixed demo values (300/250/350), clearly labeled.
- `CALORIE_MODEL_PROVIDER=ml` — Sambhav's model. **Until implemented, `estimateWorkoutCalories`
  falls back to baseline and marks `note: "ml provider unavailable — baseline fallback"`.**
- **Error behavior:** the backend wraps estimation in try/catch at every call site.
  Estimation failure never fails workout completion/logging — the workout commits and
  the calorie result stays `null`. The model is expected to be robust to missing
  optional fields (all are nullable per §2).

## 8. Where Sambhav plugs in

Replace the body of `mlEstimate(input)` (or the provider wiring) in
`backend/src/services/intelligence/calorieModel.js`, keeping the §3 output shape.
Routes, persistence, and the frontend do NOT change. Coordinate `model_version`
naming and any `schema_version` bumps with Kaushal.

## 9. Constraints (from TEAM-CONTRACT)

- No direct DB access from the model.
- No credentials exposed to the frontend.
- Deterministic-first rule preserved: model unavailable ⇒ baseline fallback, never a
  crash, never a fabricated "measured" claim.
