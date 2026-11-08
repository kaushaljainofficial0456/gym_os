# Deployment runbook

How a change reaches production for this project, written against the setup
the repository actually has: one Vercel project (root `vercel.json`) serving
the SPA and the API function, Neon PostgreSQL, and `db:check` as the build gate.
Nothing here is automated by this branch; every production step is a human
decision.

## 0. Before you start

- You need: Vercel project access, the production `DATABASE_URL` for the
  **admin** role (for migrations only — the app itself runs as `skos_app`), and
  a terminal on a network whose DNS resolves `*.neon.tech` (some Wi-Fi DNS
  refuses it; switch to a public resolver if `db:init` cannot connect).
- Confirm the branch's CI is green: `tests` workflow — unit (SQLite),
  postgres (RLS integration), build (frontend tests, build, bundle budget).

## 1. Take a restore point

Neon keeps point-in-time history, but record the moment explicitly:

1. Neon console → the production branch → note the current time (UTC) and LSN,
   or create a branch named `pre-deploy-YYYYMMDD-HHMM` from it.
2. Keep that name in the release notes. It is the database rollback target.

## 2. Migrate the database first

Migrations in this project are additive and idempotent (`CREATE ... IF NOT
EXISTS`, guarded `ALTER TABLE ... ADD COLUMN`). Run them **before** deploying
code that needs them; the build's `db:check` refuses to deploy otherwise.

```bash
DATABASE_URL="<admin connection string>" npm run db:init
```

```bash
DATABASE_URL="<runtime connection string>" npm run db:check
```

`db:check` prints which database it checked (Neon timeline id) — confirm it is
production, not a preview branch.

For `eng/production-overhaul` specifically, `db:init` adds:

| Change | Effect on a live system |
|---|---|
| `users.sessions_valid_after TEXT` (nullable) | Instant (metadata-only `ADD COLUMN`). NULL for all users, so every existing session stays valid |
| 6 indexes (`idx_nutrition_plans_client`, `idx_wlogs_workout`, `idx_subs_client`, `idx_att_client`, `idx_payments_external_ref`, `idx_users_org_role`) | Plain `CREATE INDEX` blocks writes to that table while it builds. At the documented scale (~2,500 clients) this is seconds; run at a quiet hour. `workout_logs` is the largest table — check its row count first (`SELECT count(*) FROM workout_logs`); above a few million rows, create that index by hand with `CREATE INDEX CONCURRENTLY` before running `db:init` |

## 3. Configure the environment

Required in production (the app refuses to boot without the first three):
`JWT_SECRET` (16+ chars), `DATABASE_URL` (role `skos_app`, never
`neondb_owner`), `CORS_ORIGINS`, `FRONTEND_URL`, `STORAGE_DRIVER=s3` with the
four `STORAGE_S3_*` values, and — to have real limits —
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Payments:
`PAYMENT_PROVIDER=razorpay` plus the three `RAZORPAY_*` values. See
`.env.example` for the full list and what each does.

## 4. Deploy

1. Open a pull request from the release branch into `main`; wait for CI.
2. Merge. Vercel builds `main` to production (`npm run setup`, then
   `npm run db:check && npm run build`). A failing `db:check` stops the deploy
   with the list of missing tables/columns — go back to step 2.

## 5. Verify (in this order, within 10 minutes)

1. `GET /api/health` → `{ ok: true, db: "postgres" }`.
2. `GET /api/ready` → 200 (the database answers).
3. Function logs for the new deployment show `Rate limiting: using Upstash
   Redis` and no `FATAL`/`WARN` about payments, CORS or storage you did not
   expect.
4. Sign in as a test owner and a test client; open Home, Workout, Nutrition,
   Progress, Community, the owner Dashboard and Business. No error states.
5. `events` table: no new `server_error` rows since the deploy
   (`SELECT data FROM events WHERE type = 'server_error' AND created_at > '<deploy time>'`).
6. For this branch: change the test client's password from one browser, and
   confirm a second browser signed in as the same client is sent to the sign-in
   screen on its next action.

## 6. Roll back

- **Code:** Vercel → Deployments → the previous production deployment →
  "Promote to Production". Immediate; no rebuild.
- **Database:** the migrations above are additive, so the previous code runs
  correctly against the migrated schema (it ignores the new column; indexes
  only speed reads). Rolling the database back is almost never needed for this
  branch. If data was damaged, restore from the step 1 branch/time; that loses
  every write since, so it is a last resort and an incident decision.
- **Session revocation specifically:** to undo revocations without a deploy,
  `UPDATE users SET sessions_valid_after = NULL WHERE id = ...`.

## 7. After an incident

Record: deploy id, time, symptoms, `server_error` events, what was rolled back,
and the follow-up. Server errors carry a request id (`[error] req=<id>`) that
matches the access log line for the same request.
