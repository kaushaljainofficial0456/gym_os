# SK OS — Team Contract

Shared contract for **backend (Kaushal)**, **frontend (Manavi)**, and **ML (Sambhav)**.
This repository is NOT greenfield — preserve working functionality. **Never silently
change a cross-team field, API, or schema.** Before changing anything another team
consumes, document:

```
OLD   — what existed before
NEW   — what replaces it
WHY   — the reason for the change
IMPACT — who/what is affected and what they must do
```

Every change below that touches a contract already carries this block. Add one for
any future change.

---

## 1. Roles & ownership

| Area | Owner |
|---|---|
| Backend API, PostgreSQL, auth, multi-tenancy, security, perf | Kaushal |
| Frontend / UI / UX / animations | Manavi |
| ML / calorie estimation model | Sambhav |

**Rule:** backend is the source of truth for data. The frontend never computes
authoritative business values (duration, calories, macros). The ML model never writes
to PostgreSQL — the backend persists.

## 2. API conventions (frontend ↔ backend)

- Base path `/api`, JSON bodies, Bearer JWT (`Authorization: Bearer <token>`).
- Errors: `{ error: string, issues?: string[] }` with status 400/401/403/404/409/413/422/500.
- 401 → frontend clears session and redirects to `/login`.
- Dates/timestamps are **ISO-8601 UTC strings**; day keys are `YYYY-MM-DD` in the
  **org timezone** (converted server-side via `utils/time.js` — never hardcode in the UI).
- All write endpoints are zod-validated server-side; client-sent totals are ignored
  for nutrition.

### 2.1 Workout session timing — NEW contract

```
OLD — workouts had `completed_at` only. No start time, no actual duration.
      The frontend computed duration locally (client-side only, not persisted).
NEW — workouts now have:
        started_at   TEXT   UTC ISO-8601 — session start (backend source of truth)
        duration_min REAL   backend-computed = completed_at − started_at
      Client flow:
        1. POST /api/workouts/:id/start        → backend records started_at (idempotent)
        2. user logs sets                      → POST /api/workouts/:id/complete
        3. complete persists duration_min + calorie estimate; backend computes it
WHY — reliable actual session duration is required for calorie estimation and
      analytics. client_profiles.workout_duration is a user PREFERENCE, never used.
IMPACT — Manavi: call /workouts/:id/start when the user begins a session. The backend
      is the ONLY source of started_at — a client-supplied started_at is NEVER
      accepted on /complete (it could inflate duration). Missing /start => duration_min
      stays null; an estimated duration is never substituted for a measured session.
      `meta.calorie.source` in /tracking/me/today tells the UI preview vs persisted.
```

### 2.2 Duration provenance — measured vs estimated (NEW)

```
NEW — two duration classes, never conflated:
      measured  = POST /workouts/:id/start → /complete (server computed_at − started_at)
      estimated = baseline provider's estimateDurationMinutes() (from completed sets),
                  used ONLY when no measured duration exists (e.g. NL-logged sessions)
WHY — presenting an estimated duration as measured would poison calorie features and
      analytics. The calorie input's duration_* fields carry MEASURED values only;
      estimation stays internal to the baseline provider and is never persisted as
      measured.
IMPACT — Sambhav: input.session.duration_* is null for sessions without a real timer
      (e.g. /intel/confirm-workout). Treat null as "no measured duration", never 0.
```

## 3. Workout data model (planned vs actual)

Preserved and authoritative:

| Concept | Table | Notes |
|---|---|---|
| Planned | `workout_exercises` | prescribed `sets`, `reps` (TEXT), `weight` (TEXT) |
| Actual | `exercise_set_logs` | per-set `actual_reps`, `actual_weight`, `rir`, `rest_seconds`, `completed` |
| Session summary | `workout_logs` | backward-compatible aggregate (best reps/weight) |

**Calorie estimation MUST use actual completed sets only** — skipped exercises
contribute `0 completed sets / 0 reps / 0 workload`. Planned values are only used for
a clearly-labeled `preview` estimate on the "today" view, which is never persisted.

### 3.1 Legacy synthesized sets — NEW field

```
OLD — legacy aggregate payloads ({sets_done, reps, weight}) synthesized
      exercise_set_logs rows with no way to tell them apart from real per-set input.
NEW — exercise_set_logs.is_synthesized INTEGER NOT NULL DEFAULT 0
      0 = user-entered per-set data   1 = derived from a legacy aggregate payload
WHY — synthetic rows must never silently become high-quality ML training data.
IMPACT — Sambhav: filter `is_synthesized = 0` when training. Manavi: no change
      (the frontend always sends the per-set shape). Backend backfill in init-db.js
      tags all pre-existing rows as synthesized.
```

## 4. Calorie estimation contract (backend ↔ ML)

The **only** calorie service is `backend/src/services/intelligence/calorieModel.js`.
Providers: `baseline` (default, deterministic MET heuristic — clearly NOT ML),
`mock` (fixed demo values), `ml` (Sambhav's model — falls back to baseline until
implemented). Selected by env `CALORIE_MODEL_PROVIDER`.

- The frontend never learns the provider (`workouts.calorie_provider` is backend-only).
- ML credentials never reach the frontend.
- The ML model never writes to the DB — it returns an estimate; the backend persists.
- Full contract: `docs/calorie-model-contract.md`.

### 4.1 Calorie persistence — NEW fields on `workouts`

```
OLD — no persisted calorie result; today's view used estKcal = totalSets × 6.5 (temporary).
NEW — workouts columns:
        estimated_active_kcal REAL   active kcal (range midpoint)
        lower_kcal            REAL
        upper_kcal            REAL
        model_version         TEXT   e.g. skos-cal-baseline-v1
        schema_version        TEXT   e.g. 0.2 (calorie contract version)
        calorie_provider      TEXT   baseline | mock | ml (never exposed to the UI)
        calorie_estimated_at  TEXT
WHY — the heuristic is replaced by the calorieModel service; results must persist so
      history and analytics show consistent numbers and model changes are traceable.
IMPACT — Manavi: /tracking/me/today `meta.calorie` replaces the old `meta.estKcal`
      (estKcal is kept in sync for compatibility). New fields are additive; no removal.
```

### 4.2 Body weight at workout time — resolved by backend

```
OLD — none (weight not used in any workout flow).
NEW — resolveBodyWeight(db, clientId, workoutDate) in calorieModel.js:
      1. nearest weight_logs row at/before the session day
      2. clients.current_weight
      3. clients.start_weight
      4. clients.target_weight
      → null if none available (estimator falls back to 70 kg, documented)
WHY — workout calorie estimates need body weight; we reuse the existing weight_logs
      system instead of inventing a new one.
IMPACT — Sambhav: the resolved value arrives as input.user.body_weight_kg. Manavi: no
      change (weight entry UI already writes weight_logs).
```

## 5. Tenant isolation (all teams)

- JWT claims carry `org`; `orgScope` derives `req.orgId` from the token.
- Every org/client-sensitive query carries an explicit app-level filter — RLS is a
  **defense-in-depth layer that is only engaged inside `db.tx()`** (via
  `SET LOCAL app.org_id`). Never assume RLS protects non-transactional queries.
- Canonical exercise IDs (`exercise_library.id`) are shared across backend, frontend,
  and ML. Do not create a second exercise database; request metadata changes via the
  OLD/NEW/WHY/IMPACT format instead.

## 6. Change log

| Date | Change | Owner |
|---|---|---|
| 2026-08-15 | Workout session timing: `started_at`, `duration_min` on workouts (§2.1) | Kaushal |
| 2026-08-15 | Calorie persistence fields on workouts (§4.1) | Kaushal |
| 2026-08-15 | `exercise_set_logs.is_synthesized` (§3.1) | Kaushal |
| 2026-08-15 | `calorieModel` service + provider architecture (§4) | Kaushal |
| 2026-08-15 | Workout completion made transactional; `POST /api/workouts/:id/start` added | Kaushal |
| 2026-08-15 | Calorie contract bumped to schema 0.2 (session/exercise/derived aggregates in `buildWorkoutCalorieInput`) | Kaushal |
| 2026-08-15 | Timing hardened: client-supplied `started_at` rejected; `duration_min` measured-only | Kaushal |
| 2026-08-15 | `/complete` returns 422 for `exercise_id` not belonging to the workout (no silent ignore) | Kaushal |
| 2026-08-15 | Training-data export layer: `services/intelligence/trainingData.js` + `scripts/export-training-data.js` — contract-0.2 features from actual completed sets, `is_synthesized` excluded, reserved label slot (no ground truth yet). Contract: `docs/training-data-contract.md` | Kaushal |
| 2026-08-16 | Phase 3B Step 1: `estimateWorkoutCalories()` made async; `ml` provider calls bounded by a hard timeout (`ML_TIMEOUT_MS`, `AbortController`/`Promise.race`) — a slow/hanging provider can never stall workout completion, falls back to `baseline` (new `ml_timeout` observability category). No change to validation, persisted contract, or API shape | Kaushal |
| 2026-08-16 | Phase 3B Step 2: training-data export gained an optional `--org <org_id>` scope (parameterized filter, unknown-org fails fast, bare `--org` fails fast); default cross-org behavior unchanged. Contract: `docs/training-data-contract.md` §1.2 | Kaushal |
| 2026-08-16 | Phase 3B Step 3: `ml` provider implemented — Sambhav's `skos-cal-v1` artifact ported (ESM, `mlModels/skosCalV1.js` + `skosCalV1.model.json`, coefficients unchanged) and wired via `calorieModel.js`; exercise-ID canonicalization (6 confirmed global `animation_key` mappings only, custom exercises never trusted) and gross→net-of-resting conversion added at the integration boundary. `ml` remains opt-in and dev/staging-only; `baseline` stays the production default. Contract: `docs/calorie-model-contract.md` §7/§8 | Kaushal |
