# Production readiness

An honest assessment of BARBELL for paying gyms, as of branch
`eng/production-overhaul` (2026-11-09). "Verified" means checked by running
something; "unverified" means it depends on production configuration this
audit could not see.

## Verdict

**Not yet launch-ready for paying customers at scale — close, with three
things to confirm and two to fix.** The code base is unusually careful
(fail-open/closed choices are documented, tenant scoping is consistent, the
deploy has a schema gate, payment webhooks are signature-checked and there is a reconciliation sweep). The
remaining risks are mostly configuration that cannot be seen from the
repository, plus a few engineering gaps listed below.

| Area | State |
|---|---|
| Builds, tests | Verified: backend suite, frontend suite, build and bundle budgets pass on this branch |
| Tenant isolation | Verified by existing isolation tests and this audit's IDOR scan; RLS is defence-in-depth for writes only (documented) |
| Authentication | Improved: password change/reset now end other sessions |
| Rate limiting | **Unverified** — real only if Upstash is configured in production |
| File storage | **Unverified** — must be `s3` in production (local disk does not persist on Vercel) |
| Payments | Code verified by tests; live Razorpay configuration unverified here |
| Performance | Improved and measured (model); no real-device field data |
| Observability | Partial: request ids, access log, `server_error` events; no alerting |
| Backups / recovery | Neon point-in-time restore available; no documented restore drill |

## Production blockers (do before launch)

1. **Confirm the shared rate-limit store.** Production function logs must show
   `Rate limiting: using Upstash Redis`. Otherwise every limit — login attempts,
   password reset, coupon guessing — is per instance and resets on cold start.
   (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`; now documented in
   `.env.example`.)
2. **Confirm `STORAGE_DRIVER=s3`** with all four `STORAGE_S3_*` values. The
   server warns at boot if it is `local` in production.
3. **Run `npm run db:init` against production before deploying this branch**
   (adds `users.sessions_valid_after` and six indexes; `db:check` will refuse
   the deploy otherwise). See `DEPLOYMENT_RUNBOOK.md` § 2 for lock behaviour.
4. **Run the Postgres CI job on this branch** (open a PR; the `postgres` job
   runs the RLS suites this machine could not).
5. **Add alerting on `server_error`.** Errors are recorded in the `events` table
   but nobody is notified. A daily (or hourly) query or a log drain to an
   alerting service is the minimum.

## Environment

- Configuration is validated at boot (`backend/src/config.js`): production
  refuses a missing or weak `JWT_SECRET`, a missing `DATABASE_URL`, the
  `neondb_owner` role, an invalid calorie provider, and a half-configured
  Razorpay. Missing `CORS_ORIGINS` is a warning, not a refusal.
- Vercel's `VERCEL_ENV=preview` maps to `staging`, so previews get production's
  strictness. `db:check` prints the Neon timeline it checked, because a preview
  once validated against the production database.
- Secrets: none in the repository (`.env*` gitignored; `.env.example` holds
  names and safe defaults only). The SPA bundle contains only `VITE_*` values
  (`VITE_GOOGLE_CLIENT_ID` is public by design).
- Tests never touch production: the profiler and verification scripts refuse to
  run with `DATABASE_URL` set; CI's Postgres is a throwaway service container.

## Database

- Schema changes are additive and idempotent; `db:check` is the gate. Rolling
  back code is safe against a migrated schema for this branch.
- Backups: Neon point-in-time restore. **Not done:** a written restore drill
  (restore to a branch, point a preview at it, verify) — do one before launch.
- Permissions: runtime role `skos_app` (NOBYPASSRLS); admin role used only for
  `db:init`.
- No `statement_timeout`. A runaway query holds a pooled connection until the
  function is killed. Setting it via the `pg` pool's startup parameters was
  considered and **not done**: Neon's pooled endpoint may reject unknown startup
  parameters, and that could not be tested here. Recommended:
  `ALTER ROLE skos_app SET statement_timeout = '25s'` (server side, no client
  change), applied by hand after checking it on a Neon branch.

## Observability

| Have | Missing |
|---|---|
| Request id on every request, access log line with status and duration | Alerting of any kind |
| `server_error` rows in `events` with path, status, request id | Latency percentiles per route (the access log has the raw data) |
| `client_error` rows from the frontend ErrorBoundary | Uptime check on `/api/ready` |
| `/api/ready` (DB reachable), opt-in pool stats (`EXPOSE_POOL_STATS=1`) | Failed-job monitoring for cron endpoints |

## Operations

- Timeouts: the frontend gives reads 20 s and writes 60 s, retrying a read once
  on 502/503/504. AI food estimation calls have a 12 s timeout; the coach ping
  now 2 s. `callAI()` (coach chat, NL parsing) still has none on paid providers
  — bounded only by the function's max duration (see SECURITY_AUDIT S-8).
- Request size limits: 1 MB JSON, 8 MB on three upload mounts, raw-body limits
  on signed webhooks.
- Rate limits exist on every public and abuse-prone route (see S-3 for where
  they are counted).

## Readiness score

| | Before this branch | After |
|---|---|---|
| Security | 7/10 — sessions survived password resets; an upload traversal | 8/10 — both fixed; store config still unverified |
| Performance | 6/10 — sequential round trips on the hottest screens; every revisit reloaded | 8/10 — measured cuts; no field data |
| Reliability | 7/10 | 7/10 — unchanged except the ping timeout; no alerting |
| Deployability | 8/10 — schema gate, additive migrations | 8/10 — runbook written |
| Test coverage | 8/10 | 8/10 — new suites for the new behaviour; browser suite still outside CI |

These are judgements, not measurements; the reasons are in the row.
