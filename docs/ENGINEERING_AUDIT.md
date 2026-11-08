# Engineering audit and execution plan

Branch `eng/production-overhaul`, cut from `origin/main` at `45d68a7`
(2026-11-08) in its own git worktree, so the uncommitted Owner Assistant work in
the primary checkout (`feat/coupon-management`) was never touched. Nothing here
has been merged or deployed.

This file is also the **persistent execution plan**: § 10 lists what is done,
pending and blocked, so the work can be resumed from the last verified
checkpoint.

## 1. Existing architecture

See `ARCHITECTURE_OVERVIEW.md`. In one paragraph: a React 18 + Vite SPA and a
Node 22 / Express 5 API deployed together on Vercel (one serverless function
for the whole API, region `sin1`), PostgreSQL on Neon in production and SQLite
in dev/tests, cookie-carried HS256 JWT sessions, application-level tenant
scoping with PostgreSQL RLS as defence-in-depth on the transaction path,
Razorpay payments, R2 storage, optional Upstash for shared rate limits. No
TypeScript, no ESLint, no Supabase.

## 2. Major modules

| Module | Size | Notes |
|---|---|---|
| `backend/src/routes` | 34 files, 16.3k lines, 536 endpoints | `me.js` alone is 2.8k lines |
| `backend/src/services` | ~150 files | food/calorie engines, payments, access control, tournaments, communities, health integrations |
| `frontend/src/pages` | ~100 files | `client/Workout.jsx` 1.9k lines, `client/Progress.jsx` 1.75k, `components/FoodLogSheet.jsx` ~2.3k |
| `database/schema.sql` | 3.1k lines | idempotent; plus guarded migrations in `init-db.js` |
| Tests | backend 186 files / 2,051 tests; frontend 23 files / 205 tests; 11 Playwright specs | |

## 3. Critical execution flows

Sign-in → `requireAuth` on every request → client Home (`/tracking/me/home`,
`/intel/coach/brief`, `/intel/coach/weekly`, `/me/dashboard`, ... nine requests
in parallel) → workout and nutrition logging → owner Dashboard and Business →
member billing and the Barbell plan checkout → Razorpay webhooks. File-level
entry points are tabled in `ARCHITECTURE_OVERVIEW.md` § Critical flows.

## 4. Dependency analysis

- Backend runtime deps are few (express, pg, zod, jsonwebtoken, bcryptjs,
  google-auth-library, pdfkit, @aws-sdk/client-s3). `npm audit`: 4 advisories
  in Express's transitive deps and zod; 3 patched on this branch, zod needs a
  major upgrade (SECURITY_AUDIT S-4/S-5).
- Frontend: heavy libraries (three.js 185 kB gz, recharts 105 kB gz) are already
  lazy with CI budgets; first-paint JS is 90 kB gz. framer-motion (~37 kB gz)
  loads with the signed-in shell. `npm audit`: clean. recharts 2.x is
  end-of-life (v3 exists) — P3.
- `frontend/package.json` depends on `sk-os: file:..`, and `npm audit fix` in
  `backend/` adds the same link; it was stripped from this branch's lockfile.

## 5. Performance bottlenecks (found by measurement)

Method and numbers: `PERFORMANCE_OPTIMIZATION.md`. The causes, in order of
effect:

1. **Sequential database round trips on independent reads.** Production pays a
   network round trip to Neon per statement. The coach brief issued ~16 reads one
   after another; `/tracking/me/home` ~12 levels deep, computing adherence twice.
2. **Every revisit reloaded from nothing.** Pages remount on navigation and
   `useFetch` had no memory.
3. **Middleware round trips before every route**: an uncached org lookup in the
   plan gate on every client request, and four sequential lookups in
   `requireAuth` on a cold instance.
4. **Missing indexes** on filters the hot path runs (`nutrition_plans.client_id`;
   `workout_logs.workout_id` in correlated subqueries on the largest table).
5. Not a bottleneck: bundle size (already split and budgeted).

## 6. Security risks

Full detail: `SECURITY_AUDIT.md`. Fixed: sessions surviving a password
change/reset (S-1), upload path traversal (S-2), three dependency advisories
(S-5). Open: rate-limit store unverified (S-3), zod advisory (S-4), RLS covers
writes only (S-6, documented design), logout is client-side (S-7), `callAI`
timeout (S-8), per-account login ceiling (S-9).

## 7. Reliability risks

- No `statement_timeout` (PRODUCTION_READINESS § Database).
- No alerting on `server_error` events.
- `callAI()` paid-provider paths have no timeout (S-8).
- `gymCtx` (coach context) imports `./occupancy.js` from the wrong directory, so
  gym crowd is silently always `null` in coach context. Behaviour-changing to
  fix (the brief would start mentioning crowd), so recorded, not changed.
- Two latency-ceiling tests flake under CPU contention (TESTING_STRATEGY).

## 8. Technical debt

- God components: `Workout.jsx`, `FoodLogSheet.jsx`, `Progress.jsx`, `me.js`.
- Two theming systems (CSS tokens and inline `t.*` objects).
- `translateSql()` rewrites every `?` to `$n`, including inside string literals
  and Postgres JSON operators (`?|`); safe today only because no query uses them.
- No lint or type checking.
- Several stale remote branches (`remediation/*`, `perf/optimization`,
  `quality/production-audit`) whose work is partly merged, partly not.

## 9. Production deployment risks

The deploy gate (`db:check`) and additive migrations make schema drift hard to
ship. The risks are configuration the repository cannot show (rate-limit
store, storage driver, Razorpay keys) and the absence of alerting. Step-by-step
mitigation: `DEPLOYMENT_RUNBOOK.md`.

## 10. Prioritised remediation plan and status

### Done on this branch (each verified as stated)

| P | Item | Commit | Verified by |
|---|---|---|---|
| P0 | Password change/reset end other sessions; sign out everywhere | `462b134` | 9 new tests; browser check |
| P0 | Upload path traversal | `4c4ed2d` | 4 new tests; reproduction |
| P1 | Patch body-parser / proxy-addr / qs | `66ece86` | `npm audit`, `npm ci`, suites |
| P1 | Parallel reads: coach context, client home, week, today's session | `eddd584` | profile; existing suites |
| P1 | Parallel `requireAuth` lookups, cached plan-gate org lookup | `462b134`, `eddd584` | profile; gate-order test |
| P1 | Six hot-path indexes | `eddd584` | schema guard test; init-db on SQLite |
| P1 | Revisits render from a scoped cache | `1a969dc` | 6 new tests; browser check |
| P2 | Request profiler for round trips per screen | `817346a` | — |
| P2 | Document the rate-limit store variables | `a08455e` | — |
| P2 | Seven docs (this set) | the `docs:` commit after `a08455e` | — |

### Pending (not started)

| P | Item | Why not now |
|---|---|---|
| P0 | Verify Upstash and S3 configuration in production | Needs production access |
| P1 | Alerting on `server_error` | Needs a choice of alerting service |
| P1 | `ALTER ROLE skos_app SET statement_timeout` | Needs a Neon branch to verify first |
| P1 | Playwright suite in CI | CI job + Linux baselines |
| P1 | `callAI()` timeout | Conflicts with uncommitted work in `aiProvider.js`; do after that lands |
| P2 | Generated tenant-isolation test over every `:id` route | Sizeable test harness |
| P2 | zod 4 upgrade | Breaking across all schemas |
| P2 | ESLint | Large initial backlog |
| P2 | Split `Workout.jsx` / `FoodLogSheet.jsx` | Large refactor; needs E2E coverage first |
| P3 | Fix `gymCtx` import (crowd in coach context) | Product decision: changes coach output |
| P3 | recharts 3 | Breaking chart API |

### Blocked

| Item | Blocked on |
|---|---|
| Running the Postgres RLS suites | No PostgreSQL or Docker on this machine; CI has it |
| Real-device LCP / INP / CLS | Needs a device run against a deployed preview |
| Production latency numbers | Needs access to production logs |
