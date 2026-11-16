# RLS Fail-Closed — Deployment Runbook

Change: branch `security/rls-tenant-isolation-hardening`. Read `RLS_SECURITY_AUDIT.md` first.
**Staging first. Nothing here has been run against staging or production yet.**

## Order matters

| | Code (app) | Policies (DB) | Works? |
|---|---|---|---|
| Today | old | old (fail-open) | yes |
| **Step 3** | **new** | old | **yes**: the new code sets a context on every statement; the old policies ignore `app.platform` and allow "unset" |
| **Step 5** | new | **new (fail-closed)** | yes: target state |
| ✗ never | old | new | **NO**: the old code sends no context, so the app sees no tenant rows |

**Code before policies when rolling out; policies before code when rolling back.**

## 0. Before you start

- A Neon **backup branch** of the target database (staging, then production).
- `PG_ADMIN_URL`: the admin/owner role (migrations only). `DATABASE_URL`: the runtime role (`skos_app`).
- `psql` available (or use `npm run db:init` with the admin URL, which applies the same `database/rls.sql`).
- If `feat/ai-communication` merged first: its follow-up tables must be in `rls.sql`'s `org` list and `up.sql` regenerated. CI fails otherwise (`every table with an org_id … is protected`).

## 1. Verify the runtime role (read-only, today's state)

```bash
DATABASE_URL="<runtime skos_app url>" node backend/scripts/rls-verify.js
```

Expect the policy checks to FAIL now (old policies). That is the bug this change fixes. The **role** lines must already pass: not superuser, not BYPASSRLS, owns no table, not a member of an owner/superuser/BYPASSRLS role, no CREATE on `public`, **no TRUNCATE**. If any role line fails, fix grants as admin. Never fix it by granting the runtime role more:

```sql
-- as the admin role; adjust names
ALTER ROLE skos_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM skos_app, PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM skos_app;
GRANT USAGE ON SCHEMA public TO skos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO skos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE <admin role> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO skos_app;
-- if the role owns tables: ALTER TABLE ... OWNER TO <admin role>;
```

## 2. CI green on the branch

GitHub Actions `tests`: unit, PostgreSQL (incl. **tenant isolation**), build.

## 3. Deploy the CODE to staging (policies unchanged)

Deploy the branch to the staging Vercel project. Smoke-test that login, the owner dashboard and the member home load. Watch logs for `[rls] statement ran with no tenant or platform context`. Each such line is a code path that will see nothing once step 5 lands, so note it.

## 4. Apply the policies to STAGING, then validate

```bash
psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f database/migrations/2026-11-16_rls_fail_closed/up.sql
DATABASE_URL="<staging skos_app url>" node backend/scripts/rls-verify.js      # expect 12/12
DATABASE_URL="<staging skos_app url>" PG_ADMIN_URL="$PG_ADMIN_URL" npm run pg:validate   # disposable DB only: it seeds rows
```

`up.sql` is atomic and ends with a self-check: if any fail-open policy survives, nothing is committed.

**Functional checks.** Two gyms (A, B) plus one independent member. Each item touches a flow that crosses gyms:

- [ ] Owner A: dashboard, members, payments, invoices, attendance, AI Communication. Only A's data.
- [ ] Member logs a workout, meal, weight; sees history and PRs.
- [ ] **Independent member joins gym A via QR** (free plan *and* paid plan: checkout-return and webhook). Their old workouts and history are still visible; owner A sees them as a member.
- [ ] Owner A **removes** that member. They keep their history; A keeps their payments.
- [ ] Friend community with members from A and B: feed, leaderboard, invites.
- [ ] Tournament with entrants from A and B: join, scoring, results, notifications.
- [ ] In-app share A → member in B; public share link opened and imported by a member of B.
- [ ] Barcode scan of a new product (global cache write).
- [ ] Wearable sync (WHOOP webhook + manual sync) for a member who changed gym.
- [ ] SUPER_ADMIN console: gyms, cross-gym payments, reconciliation, suspend/reactivate.
- [ ] Demo session start → expiry.
- [ ] Follow-ups scheduler tick runs; Razorpay webhook replay activates.
- [ ] Logs: no new `[rls]` lines, no `row-level security` errors, no 5xx spike.

**Load test (required):** `npm run loadtest --prefix backend` against staging, before and after. Each statement now makes 3 round trips instead of 1. Accept only if p95 stays within budget; `PG_POOL_METRICS=1` on staging separates pool wait from query time.

## 5. Production

Same order: (a) Neon backup branch, (b) step 1 on production, (c) **deploy code**, watch 15–30 min, (d) apply `up.sql` with the admin role, (e) `rls-verify.js` as runtime role → 12/12, (f) repeat the read-only parts of the checklist. Never run `pg:validate` on production.

## Rollback

| Symptom | Action |
|---|---|
| One cross-gym feature broken after step 5 | Hotfix: wrap that path in `runAsPlatform('<reason>', …)` after confirming its app-level authorisation. |
| Broad breakage after step 5 | `psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f database/migrations/2026-11-16_rls_fail_closed/down.sql` (restores the previous policies exactly; the new code keeps working on them). |
| Latency regression or a per-statement scoping problem | Set `RLS_TENANT_SCOPE=off` and redeploy: tenants' plain statements run as platform again (the pre-change behaviour); `db.tx` stays scoped and the policies stay fail-closed. **Emergency only.** It logs a SECURITY error at every boot; remove it as soon as fixed. |
| Code must be reverted | Run `down.sql` **first**, then redeploy the previous build. |

## After go-live

- Add `rls-verify.js` (runtime role) to the post-deploy checklist for any change to `rls.sql` or role grants.
- Any new table with `org_id`/`client_id` must be added to `rls.sql` (CI enforces this), with `up.sql` regenerated for the next versioned migration.
