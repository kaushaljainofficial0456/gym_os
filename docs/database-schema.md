# Database Schema — SK OS

Source of truth: `database/schema.sql` (portable SQLite/PostgreSQL) + `database/rls.sql`
(PG Row-Level Security). Initialization/migrations: `backend/scripts/init-db.js`
(idempotent `CREATE TABLE IF NOT EXISTS` + guarded `ADD COLUMN` migrations on both
engines; `ADD COLUMN IF NOT EXISTS` on PG). 52 tables.

## 1. Conventions

- TEXT primary keys generated in application code (`backend/src/ids.js`, nanoid-style).
- TEXT ISO-8601 **UTC** timestamps (msec precision). Day keys are `YYYY-MM-DD` in the
  org timezone (converted via `utils/time.js`).
- INTEGER booleans (`0`/`1`), REAL numerics. No PG-only or SQLite-only column types.

## 2. Tenancy & identity

`organizations` · `users` (role: SUPER_ADMIN/GYM_OWNER/TRAINER/CLIENT) · `trainers` ·
`clients` (org_id, trainer_id, goal, start_weight, current_weight, target_weight,
height_cm, age, sex) · `client_profiles` · `goals` · `gym_settings`.
41 tables carry `org_id`; RLS policies cover all 50 RLS-enabled tables.

## 3. Workout domain

| Table | Purpose |
|---|---|
| `exercise_library` | canonical exercises (`id` shared across backend/frontend/ML); `movement`, `ex_type`, `equipment`, `primary_muscle` |
| `exercise_aliases` | search aliases → canonical id |
| `muscles` / `exercise_muscles` | normalized muscle model + PRIMARY/SECONDARY roles |
| `workout_templates` | trainer reusable sessions (org-scoped) |
| `training_programs` / `training_days` | client plan → day_of_week → template |
| `workouts` | materialized session (see §3.1 for new timing/calorie columns) |
| `workout_exercises` | planned exercises (prescribed sets/reps/weight TEXT, `done`) |
| `workout_logs` | session-level per-exercise summary (aggregate, backward compat) |
| `exercise_set_logs` | **actual** per-set rows (see §3.2) |
| `personal_records` | heaviest weight / best reps / est 1RM / best volume |

### 3.1 `workouts` — new session timing + calorie columns

```sql
started_at            TEXT   -- UTC ISO-8601 session start (backend source of truth)
duration_min          REAL   -- backend-computed actual duration (completed_at − started_at)
estimated_active_kcal REAL   -- active kcal (range midpoint) from calorieModel
lower_kcal            REAL   -- low end of estimate range
upper_kcal            REAL   -- high end of estimate range
model_version         TEXT   -- calorie model version (e.g. skos-cal-baseline-v1)
schema_version        TEXT   -- calorie input contract version (e.g. 0.1)
calorie_provider      TEXT   -- baseline | mock | ml (backend-only, never exposed to UI)
calorie_estimated_at  TEXT   -- UTC ISO-8601 when the estimate was computed
```

`client_profiles.workout_duration` remains a user PREFERENCE (string like `"40 min"`)
and is NOT used as actual session duration.

### 3.2 `exercise_set_logs` — provenance flag

```sql
is_synthesized INTEGER NOT NULL DEFAULT 0
-- 1 = derived from a legacy aggregate payload ({sets_done, reps, weight});
-- 0 = user-entered per-set data. ML training MUST filter is_synthesized = 0.
```

## 4. Nutrition domain

`nutrition_plans` + `meals` (trainer plans) · `foods` (+ `food_aliases`, org-scoped +
global) · `client_meal_templates` + `meal_items` (client-owned) · `meal_logs`
(`estimate` flag for AI-estimated entries; `quantity`/`unit`/`unit_type` provenance) ·
`water_logs` · `supplements`. Nutrition is server-authoritative: the server recomputes
macros from the foods table; client-sent totals are ignored.

## 5. Tracking & wellness

`weight_logs` (date, weight, source) — used by `calorieModel.resolveBodyWeight` ·
`measurements` · `progress_photos` (storage abstraction: data_url/local/s3) ·
`sleep_logs` · `custom_metrics` + `metric_entries` · `attendance` + `attendance_events`
(entry/exit — no biometrics; no ingestion route yet) · `adherence_records`.

## 6. Intelligence & ops

`intelligence_events` (audit log) · `coach_insights` · `alerts` · `ai_memory` ·
`ai_feedback` · `events` (analytics) · `messages` · `notifications` (write-only so far) ·
`packages` / `subscriptions` / `payments`.

## 7. Migrations

`init-db.js` runs a shared `MIGRATIONS` list on both engines:
- SQLite: `PRAGMA table_info` existence check → `ALTER TABLE … ADD COLUMN`.
- PostgreSQL: `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (idempotent).
Then backfills `workout_logs.created_at` and synthesizes `exercise_set_logs` for legacy
aggregate logs **with `is_synthesized = 1`** (never silently real data).
No data is ever dropped by migrations.
