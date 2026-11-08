# Architecture overview

What BARBELL (repository `gym_os`, package name `sk-os`) actually is, read from
the code on `origin/main` at `45d68a7` (2026-11-08). Written for someone new to
the codebase who needs the shape of it before reading any one file.

## The stack, as built

| Layer | Technology | Where |
|---|---|---|
| Web app (members, trainers, owners) | React 18, React Router 7, Vite 5, Tailwind 3, framer-motion, recharts (lazy), three.js (lazy) | `frontend/` |
| Platform console (SUPER_ADMIN) | React 18 + Vite, separate deploy | `admin/` |
| API | Node 22, Express 5, ESM JavaScript (no TypeScript), zod validation | `backend/src/` |
| Database (production) | PostgreSQL on Neon, runtime role `skos_app` (NOBYPASSRLS), `pg` pool | `database/schema.sql`, `database/rls.sql` |
| Database (dev and tests) | SQLite via `node:sqlite` | same `schema.sql` |
| Hosting | Vercel, region `sin1`; static frontend + one serverless function (`api/index.js`) running the whole Express app | `vercel.json`, `api/index.js` |
| File storage | S3-compatible (R2) in production, local disk in dev | `backend/src/storage.js` |
| Payments | Razorpay (orders, webhooks, Route payouts) | `backend/src/services/payments/` |
| Rate-limit store | Upstash Redis when configured, else per-instance memory | `backend/src/rateLimit.js`, `upstashRateLimitStore.js` |
| AI | Pluggable provider (Ollama default; Groq/Gemini/OpenRouter/OpenAI gated by `ALLOW_PAID_AI`) | `backend/src/services/intelligence/` |
| Calorie / food models | Deterministic engines + an exported model (`skosCalV1`); Python training code | `backend/src/services/food/`, `ml/` |
| Door access | eSSL/ZKTeco ADMS push and a signed webhook provider | `backend/src/routes/adms.js`, `services/access/` |
| Android | Capacitor shell around the web app (on `feat/barbell-android`, not on `main`) | `mobile/` on that branch |

Not present, despite being assumed by the audit brief: Supabase, Supabase Edge
Functions, TypeScript, ESLint, React Query. Data fetching is the in-house
`useFetch` hook (`frontend/src/utils.js`) over `api()` (`frontend/src/api.js`).

## Request lifecycle (API)

```
Vercel edge ──rewrite /api/*──▶ api/index.js (memoised buildApp())
  └─ Express (backend/src/index.js)
       cookie parser → security headers → CORS (allow-list) → request id + access log
       → body parsers (1 MB default; 8 MB on upload routes; raw bodies for signed webhooks)
       → planGate            (independent clients past trial → 402; fails open)
       → router per area     (r.use(requireAuth, requireRole(...), orgScope))
            requireAuth: verify HS256 JWT (cookie `sk_token`, or Bearer)
                         then, concurrently: org timezone · demo-org flag ·
                         user state (active + sessions_valid_after) · gym suspension
                         evaluated in order: demo gate → deactivated → revoked → suspended
                         → AsyncLocalStorage org context (used by db.tx for RLS)
       → 404 → central error handler (stable error codes; never leaks SQL/stack in production)
```

Thirty-four route modules define 536 endpoints. Most are mounted behind a
router-level `requireAuth`; the deliberately public ones are: `/api/auth/*`,
`/api/share/:id`, `/api/workout-share/:id`, `/api/community-invite/:code`,
`/api/tournaments-public/*`, `/api/client-error`, `/api/demo/*` (partly),
`/api/access/hook` and `/iclock/*` (HMAC/serial-authenticated device
callbacks), the WHOOP webhook and OAuth callbacks.

## Tenancy model

- Every tenant is an `organizations` row (a gym, a trainer's own org, or the
  shared `independent` org for clients with no gym).
- The JWT carries `sub` (user), `role`, `org`. `orgScope` sets `req.orgId` from
  the token (SUPER_ADMIN may pass one). Roles: SUPER_ADMIN, GYM_OWNER, MANAGER,
  STAFF, TRAINER, CLIENT (`backend/src/permissions.js`).
- **The primary isolation boundary is application code**: every org-scoped
  query carries `WHERE org_id = ?` or resolves the record through
  `resolveClient` / `getClient` / `requireOrgClient`. PostgreSQL RLS
  (`database/rls.sql`) is defence-in-depth for the `db.tx()` write path only;
  `db.q()` runs without `app.org_id` and policies allow all rows there by
  design (see `docs/RLS-BOUNDARY.md`).
- Caches that hold tenant data are keyed by org or user id, server side
  (`auth.js`, `utils/time.js`, `barbellPlan.js`) and client side (`api.js`
  response cache, scoped to user and gym).

## Frontend shape

- `main.jsx` → `UnitsProvider` → `App.jsx` (routes). Signed-in shells
  (`ClientLayout`, `TrainerLayout`) are lazy chunks preloaded for returning
  users; three.js and recharts are lazy chunks with CI budgets
  (`frontend/scripts/check-bundle.mjs`).
- Layouts own the data every tab needs (`/tracking/me/home`, the coach brief and
  weekly review for clients) so tab switches do not refetch it. Pages own their
  own fetches through `useFetch`; read-only pages opt into the response cache
  with `{ key }` so a revisit renders at once.
- Auth is cookie-only (`credentials: 'include'`); the stored user in
  `localStorage` is display state, never a credential.

## Data and background work

- Schema: `database/schema.sql` (re-applied idempotently by `npm run db:init`)
  plus guarded column migrations (`MIGRATIONS` in `backend/scripts/init-db.js`).
  `npm run db:check` (run in the Vercel build) fails the deploy if any table or
  column the code expects is missing.
- No queue or worker. Periodic work runs on request or via Vercel cron
  endpoints guarded by `CRON_SECRET` (access-control ticks, reconciliation).
- Analytics and server errors are written to the `events` table (`track()`).

## Critical flows (where to start reading)

| Flow | Entry | Core logic |
|---|---|---|
| Sign-in / sessions | `routes/auth.js` | `auth.js` (`signToken`, `requireAuth`, `revokeUserSessions`) |
| Client home | `routes/tracking.js` `/me/home` | `services/adherence.js`, `trainingProgram.js`, `aiCoach.js` |
| Coach brief | `routes/intelligence.js` `/coach/brief` | `services/intelligence/aiContext.js` |
| Workout logging | `routes/workouts.js`, `routes/me.js` | `trainingProgram.js`, `progressiveOverload.js`, `calorieModel.js` |
| Nutrition logging | `routes/nutrition.js`, `routes/me.js` | `services/food/`, `logDay.js` |
| Member billing | `routes/admin.js`, `routes/enrollment.js` | `services/payments/*`, `enterprise/subscriptionLifecycle.js` |
| Barbell plan (independent clients) | `routes/plan.js` | `services/plans/barbellPlan.js`, `coupons/` |
| Gym SaaS billing | `routes/enterprise.js` | `services/enterprise/*` |
| Door access / crowd | `routes/access.js`, `routes/adms.js` | `services/access/*`, `occupancy.js` |
