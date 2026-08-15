# API Contract — SK OS

Base path `/api` · JSON bodies · Bearer JWT (`Authorization: Bearer <token>`).
Frontend calls go through `frontend/src/api.js` (`api(path, opts)`; auto-logout on 401;
Vite proxy `/api → http://127.0.0.1:4000`). 120 endpoints across 13 route modules.

## 1. Conventions

- Errors: `{ error: string, issues?: string[] }` — 400/401/403/404/409/413/422/500.
  422 carries zod `issues`.
- Timestamps are ISO-8601 UTC; day keys `YYYY-MM-DD` in org timezone (server-side).
- Write routes are zod-validated; nutrition macros are server-computed (client totals
  ignored).
- Auth: `POST /api/auth/login` → `{ token, user }`. Roles: SUPER_ADMIN, GYM_OWNER,
  TRAINER, CLIENT. Tenant scoping is token-derived (`orgScope`); clients resolve their
  own record via `resolveClient`.

## 2. Endpoint map

| Mount | Module | Count | Auth |
|---|---|---|---|
| `/api/auth` | auth.js | 3 | public |
| `/api/dashboard` | dashboard.js | 3 | owner/trainer |
| `/api/clients` | clients.js | 16 | owner/trainer |
| `/api/workouts` | workouts.js | 11 | any authed (role gates per route) |
| `/api/nutrition` | nutrition.js | 9 | mixed |
| `/api/tracking` | tracking.js | 9 | mixed |
| `/api/insights` | insights.js | 3 | trainer |
| `/api/alerts` | alerts.js | 2 | trainer |
| `/api/reports` | reports.js | 2 | trainer |
| `/api/messages` | messages.js | 2 | mixed |
| `/api/business` + `/api/admin` | admin.js | 11 | owner/super |
| `/api/me` | me.js | 32 | client |
| `/api/intel` | intelligence.js | 18 | any authed (client-resolved) |

## 3. Workout session timing — NEW

### `POST /api/workouts/:id/start` (new)

Records the session start. **Idempotent** — safe to call repeatedly.

```
200 → { ok, workout_id, started_at }                  // started (or already started)
200 → { ok, workout_id, started_at, duration_min, already_completed: true }  // already done
403 cross-org/unauthorized · 404 unknown workout
```

### `POST /api/workouts/:id/complete` (changed — now atomic)

Body (zod-validated):

```jsonc
{
  "started_at": "2026-08-15T09:00:00.000Z",   // OPTIONAL — fallback when /start wasn't called
  "logs": [
    {
      "exercise_id": "wxeA",
      "sets": [                                  // preferred per-set shape
        { "set_number": 1, "actual_reps": 10, "actual_weight": 60, "rir": 2, "completed": true }
      ]
      // OR legacy aggregate: { "sets_done": 3, "reps": 10, "weight": 60 } → rows tagged is_synthesized=1
    }
  ]
}
```

Response additions:

```jsonc
{
  "ok": true,
  "prs": [ /* existing PR records */ ],
  "workoutId": "wko_1",
  "duration_min": 45,                  // NEW — backend-computed actual duration
  "calorie": {                          // NEW — persisted estimate (actual sets only)
    "schema_version": "0.1",
    "estimated_active_kcal": 285,
    "lower_kcal": 250,
    "upper_kcal": 320,
    "model_version": "skos-cal-baseline-v1",
    "provider": "baseline",
    "source": "persisted",
    "estimated_at": "2026-08-15T09:45:00.000Z"
  }
}
```

- Entire completion is one transaction: logs + set rows + PRs + status + duration +
  calorie commit together; any failure rolls back everything.
- Re-completing returns `{ ok, alreadyCompleted: true, ... }` without double-logging.
- `exercise_set_logs.is_synthesized`: `1` for legacy aggregate payloads, `0` for the
  per-set shape.

## 4. Today session — `GET /api/tracking/me/today` (extended, not changed)

`meta` additions (existing keys `totalSets`, `estMinutes`, `estKcal`, `exerciseCount`,
`doneCount` remain):

```jsonc
"meta": {
  "totalSets": 6,
  "estMinutes": 19,
  "estKcal": 117,
  "calorie": {                          // NEW
    "schema_version": "0.1",
    "estimated_active_kcal": 117,
    "lower_kcal": 99,
    "upper_kcal": 135,
    "model_version": "skos-cal-baseline-v1",
    "provider": "baseline",
    "source": "preview",                // preview (planned, not persisted) | persisted
    "completedSets": 6,                 // preview only
    "estimated_at": "…"                 // persisted only
  }
}
```

`estKcal` mirrors `calorie.estimated_active_kcal` so existing UI keeps working.

## 5. `POST /api/intel/confirm-workout` (extended)

Response now includes `calorie` (persisted, actual sets) and the workout row gets
`started_at`/`completed_at` (equal — NL sessions have no measured duration). `duration_min`
stays null for these. Set rows are `is_synthesized = 0` (user-confirmed input).

## 6. Notes for Manavi

- Nothing was removed — all changes are additive. Update the workout UI to call
  `POST /workouts/:id/start` when the user begins; `duration_min` and `calorie` now come
  back from the server (drop the client-side `Date.now() - startedAt` math as the
  authoritative value).
- `meta.calorie.source === 'preview'` → show as an estimate before the session;
  `'persisted'` → the authoritative number.
- ML provider is invisible to the UI by design.
