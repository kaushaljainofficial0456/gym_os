# Backend Audit — SK OS

Scope: `backend/src/`, `database/`, `backend/scripts/`, `backend/test/`, `frontend/src/api.js`.
Status: audit complete — no changes were made as part of this document. Implementation
changes that followed are tracked in `docs/TEAM-CONTRACT.md` and `docs/api-contract.md`.

## 1. Existing architecture

- **Express 5 (ESM)** API, **120 endpoints** across 13 route modules mounted in
  `backend/src/index.js`, all behind `/api`.
- **No ORM.** Raw SQL with `?` placeholders, translated to `$n` on PostgreSQL by
  `db.js: translateSql()`. One adapter surface (`q` / `q1` / `run` / `exec` / `tx`) for
  both SQLite (Node 22 `node:sqlite`, dev) and PostgreSQL (`pg`, production).
- **`db.tx()`** uses `AsyncLocalStorage` (`als` / `runWithOrg` / `currentOrg`); on
  PostgreSQL it issues `SET LOCAL app.org_id` to engage RLS for the transaction.
- Zod validation (`validate.js`), JWT auth + RBAC (`auth.js`), in-memory rate limiting
  (`rateLimit.js`), private uploads with per-owner authorization (`index.js`).
- Intelligence layer (`services/intelligence/`): deterministic parsers/search first,
  LLM only for framing/OCR/vision; no LLM writes; every action logged to
  `intelligence_events`.

## 2. Workout flow

1. Plan: `training_programs` → `training_days` → `workout_templates` →
   `workout_exercises` (prescribed sets/reps/weight/rest).
2. Materialize: `trainingProgram.js: ensureTodayWorkout()` copies a day's template into
   a `workouts` row (or returns an assigned workout / most recent fallback).
3. Log: `POST /api/workouts/:id/complete` (per-exercise per-set payload) or
   `POST /api/intel/confirm-workout` (NL parse → confirmed set logs). Both write
   `workout_logs` + `exercise_set_logs`; PRs via `personalRecords.js: evaluatePRs()`.
4. Progress: `progressiveOverload.js: suggestNextTarget()`.
5. **New:** `POST /api/workouts/:id/start` records `started_at`; completion now computes
   and persists `duration_min` and the calorie estimate atomically.

## 3. Database model

52 tables in `database/schema.sql` (portable DDL: TEXT nanoid PKs, ISO-8601 UTC TEXT
timestamps, INTEGER/REAL numerics). Highlights: identity/tenancy (`organizations`,
`users`, `trainers`, `clients`), workout domain (library + aliases, muscles +
exercise_muscles, templates/programs/days, workouts, workout_exercises, workout_logs,
exercise_set_logs, personal_records), nutrition (plans/meals, foods, client templates,
meal_items, meal_logs, water), tracking (weight/measurements/photos/sleep/custom
metrics), intelligence (events, insights, alerts, ai_memory, ai_feedback), ops
(packages/subscriptions/payments/attendance/messages/notifications/events).
41 columns named `org_id`. `rls.sql` covers all 50 RLS-enabled tables.

### Workout session timing (added)

`workouts.started_at` (TEXT UTC), `workouts.duration_min` (REAL), plus calorie result
columns — see `docs/database-schema.md`.

## 4. Calorie logic (before / after)

**Before:** `trainingProgram.js: todaySession()` used `estKcal = totalSets × 6.5`
(temporary heuristic) and `estMinutes = max(15, totalSets × (1.6 + rest/60))`.
Nutrition calories are server-authoritative (`parseFoods.js` + `foods` table; client
totals ignored).

**After:** `services/intelligence/calorieModel.js` is the single calorie service.
Baseline provider: `MET × 3.5 × body_weight_kg ÷ 200 × duration_min` with ±15% range,
labeled baseline (not ML). `todaySession()` now returns `meta.calorie` (preview vs
persisted); completion persists the result. `estKcal` remains in sync for the existing
UI. Contract: `docs/calorie-model-contract.md`.

## 5. PostgreSQL compatibility

- `translateSql` converts `?` → `$n`; schema.sql is portable; `rls.sql` is PG-only and
  applied only on PG.
- **Caveat (confirmed in code):** RLS is engaged only inside `db.tx()` via
  `SET LOCAL app.org_id`. Non-transactional queries rely on explicit app-level org
  filters. Do not assume RLS protects arbitrary queries.
- **Live validation complete:** `npm run pg:validate` passes **8/8** against a real
  Neon instance. The harness uses `DATABASE_URL` (runtime role `skos_app`, `NOBYPASSRLS`)
  for the checks and `PG_ADMIN_URL` (admin role `neondb_owner`) for schema/migrations/RLS.
  Never use a `BYPASSRLS` role (e.g. Neon's default owner) as the runtime connection —
  RLS is then a no-op.

## 6. Tenant isolation

Three layers: token-claim org scoping (`orgScope`), app-level `org_id` filters in every
query, and PostgreSQL RLS (defense-in-depth inside transactions). `resolveClient()`
enforces same-org + role/ownership. Existing hardening tests cover cross-org denial;
new tests in `workoutCalorie.test.js` cover cross-org workout start/complete denial.

## 7. Tests

`backend/test/` (node --test, in-memory SQLite from the real schema):
`business.test.js`, `hardening.test.js`, `intelligence.test.js`, `intelligence2.test.js`,
`coach.test.js`, `prodreadiness.test.js`, and new `workoutCalorie.test.js`.
84 tests total; all pass on SQLite. PG behavior is exercised only via
`npm run pg:validate` until a live instance is available.

## 8. Files that will be changed (implementation scope)

- `database/schema.sql` — new columns (already applied).
- `backend/scripts/init-db.js` — shared guarded migrations (SQLite + PG), synthesized
  backfill tagging (already applied).
- `backend/src/services/intelligence/calorieModel.js` — NEW service.
- `backend/src/services/trainingProgram.js` — calorie via service, `meta.calorie`.
- `backend/src/routes/workouts.js` — `POST /:id/start`, transactional `/:id/complete`.
- `backend/src/routes/intelligence.js` — confirm-workout timestamps + calorie.
- `backend/src/services/volumeAnalysis.js` — N+1 batch fix.
- `backend/test/workoutCalorie.test.js` — NEW tests.
- `docs/` — TEAM-CONTRACT, BACKEND-AUDIT, database-schema, api-contract,
  calorie-model-contract.

## 9. Files that must NOT be unnecessarily rewritten

- `backend/src/db.js` — dual adapter + tx/ALS semantics (keep, extend carefully).
- `backend/src/auth.js` — JWT/RBAC/orgScope/resolveClient (preserve).
- `backend/src/validate.js` — schema surface (additive only).
- `database/rls.sql` — policy structure (preserve; extend per new tables if any).
- `services/intelligence/aiProvider.js` + deterministic engines — working AI
  infrastructure (preserve; the calorie model is a separate service, not an aiProvider
  method).
- All 120 endpoints — do not rewrite; extend responses additively.
