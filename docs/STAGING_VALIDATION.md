# Staging validation plan — Postgres connection-pool investigation

Prepared during the perf/optimization work. This is the exact sequence to
run once the one open safety question below is answered — nothing here
has been executed against Preview or Production.

## Confirmed facts (read-only Vercel CLI inspection, already logged in as
## kaushaljainofficial0456-8497 — no deploys or changes made)

- Project: `gym-os` (`prj_V9nv6wZWZv2fTBYXXAujbmbyrQkp`), team `nikhaar-fashions-connect`
- Production alias: `gym-os-psi-ebon.vercel.app` — currently **Ready**, deployed
  ~3h before this was written, `main` branch, Node.js 24.x, region `iad1`
  (Washington D.C.), serverless function bundle `api/index` = 6.88MB
- Framework preset "Other", build command `npm run build`, install command
  `npm run setup` (matches root `vercel.json`)
- `DATABASE_URL` is configured for **both** the Production and Preview
  environments in this project (`vercel env ls`) — see the blocking
  question below
- **Deployment history shows an ~11-hour window (roughly 16h to 5h before
  this was written) where every single deploy attempt — both Production
  and Preview — failed at the build step**, not from anything
  performance-related:
  ```
  [db:check] FAILED — the database is missing objects this code requires.
  missing columns (2): users.terms_accepted_at, users.terms_version
  Deploying now would repeat the community_members outage: application
  code live against a database that cannot satisfy its queries.
  Run the migration against this database first:  npm run db:init
  ```
  This is `backend/scripts/db-check.js` correctly doing its job — refusing
  to ship code against a database missing columns it needs. It appears to
  have been resolved (someone ran the migration) roughly 4-5 hours before
  this was written; deploys have been `Ready` since. **This is unrelated
  to the connection-pool-starvation investigation** but is worth knowing:
  during that window, any commits pushed (including any of this session's
  perf work, if pushed) would NOT have gone live — production would have
  stayed frozen on the last successful deploy. Confirm your migration
  process runs before every deploy that adds a required column, or this
  will recur.

## BLOCKING SAFETY QUESTION — must be answered before any staging load test

**Is the Preview environment's `DATABASE_URL` a genuinely separate Neon
database/branch from Production's, or the same value?**

I did not pull or decrypt either value (`vercel env pull` would fetch the
actual secret into a local file) specifically to avoid finding out the
hard way that they're identical and then load-testing production data by
mistake. This has to be answered by you, from the Vercel/Neon dashboards
directly, or by explicitly telling me to check.

- **If they're already separate**: the fast path is a real `vercel deploy`
  of the `perf/optimization` branch (Preview target), which gets its own
  URL, hits the separate Preview `DATABASE_URL`, and is safe to load-test
  immediately.
- **If they're the same, or you're not sure**: create an isolated Neon
  branch first (Neon's own "branching" feature makes an independent,
  writable copy of the schema+data in seconds) and point a *new* Preview
  environment variable at it before deploying, so Preview and Production
  are provably isolated. Exact steps below.

## Exact steps once the database is confirmed isolated

1. **Deploy the branch as a Preview** (never `--prod`):
   ```bash
   cd K:\dev\skos_final
   npx vercel deploy --yes
   ```
   This uses the already-authenticated CLI session, targets Preview by
   default (no `--prod` flag), and prints a unique `*.vercel.app` URL.

2. **Enable pool diagnostics on that Preview deployment only** (not
   Production): in the Vercel dashboard → gym-os → Settings →
   Environment Variables → add for **Preview only**:
   - `EXPOSE_POOL_STATS=1` — makes `GET /api/ready` return live
     `{total, idle, waiting}` pool occupancy (see `backend/src/db.js`)
   - `PG_POOL_METRICS=1` (optional, verbose) — logs per-query wait-time
     vs query-time to the function's runtime logs

   Redeploy after adding env vars (Vercel doesn't hot-reload them):
   ```bash
   npx vercel deploy --yes
   ```

3. **Run the load test against the Preview URL**:
   ```bash
   cd backend
   node scripts/loadtest.mjs --base-url https://<preview-url>.vercel.app \
     --confirm-staging --levels 1,5,10,20,30,50 --duration 15
   ```
   This is the exact script built and dry-run-validated locally last
   session — it refuses non-localhost targets without `--confirm-staging`,
   logs in as the seeded demo owner/client, and cycles a realistic mixed
   workload (dashboard, clients, workouts, nutrition, tracking,
   intelligence food-logging) at each concurrency level, polling
   `/api/ready` throughout for live pool occupancy.

4. **Watch function logs in a second terminal while the load test runs**:
   ```bash
   npx vercel logs https://<preview-url>.vercel.app --follow
   ```
   This is what actually distinguishes cold starts (a burst of "Retrieving
   deployment"/init-time log lines right as a new instance spins up) from
   steady-state request handling — something a local-only test can't show
   at all, since it has no cold starts.

5. **Read the results against these decision rules**:
   - `poolMaxWaiting` > 0 at some concurrency level = pool starvation,
     confirmed directly (not inferred).
   - p99/max latency climbing sharply while `poolMaxWaiting` stays 0 =
     the pool is NOT the bottleneck at that concurrency; look at query
     time (Phase 7, `PG_POOL_METRICS=1` logs) or Vercel cold starts
     instead.
   - Errors/timeouts appearing exactly when `poolMaxWaiting` first goes
     > 0 = strong confirmation the pool bound (`max: 5` / 8s timeout,
     `backend/src/db.js`) is the thing actually being hit under load.

6. **Afterward**: remove `EXPOSE_POOL_STATS` / `PG_POOL_METRICS` from the
   Preview environment (or leave `EXPOSE_POOL_STATS` — it's inert and
   harmless if left on, since it only adds a field to a health-check
   response), and if a scratch Neon branch was created for this, delete it
   once done.

## What I still need from you before step 1

1. Confirmation (or a "go check it") on the Preview vs Production
   `DATABASE_URL` question above.
2. Your Neon plan tier (Free / Launch / Scale) and Vercel plan tier
   (Hobby / Pro / Enterprise) — needed to do the real math in Phase 5
   (documented connection limits per tier differ significantly, and I
   don't want to publish a `max:` recommendation based on a guessed tier).
