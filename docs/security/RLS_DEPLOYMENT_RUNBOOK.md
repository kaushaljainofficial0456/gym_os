# RLS Fail-Closed — Deployment Runbook

Change: branch `security/rls-tenant-isolation-hardening`. Read `RLS_SECURITY_AUDIT.md` first.
**Nothing here has been run against staging or production.** Every production step below needs the owner's explicit go-ahead.

## Order matters

| | Code (app) | Policies (DB) | Works? |
|---|---|---|---|
| Today | old | old (fail-open) | yes |
| **After step 4** | **new** | old | **yes**: the new code sets a context on every statement; the old policies ignore `app.platform` and let "unset" through |
| **After step 6** | new | **new (fail-closed)** | yes: target state |
| ✗ never | old | new | **NO**: the old code sends no context, so the app sees no tenant rows |

**Code before policies when rolling out; policies before code when rolling back.**

Two things now enforce this order:
- **`npm run db:init` will not swap the policies** on a database that still has the old fail-open ones. It applies schema changes as usual (including two new indexes), prints `RLS policies NOT changed`, and leaves the policies alone, unless `RLS_FAIL_CLOSED=apply` is set. The habitual "db:init, then push" is therefore safe. Tested in `rlsTenantIsolation.test.js` ("deploy-order guard").
- `up.sql` is atomic and **refuses to commit** if any fail-open policy survives, any table with a policy is not forced, or any table carrying an `*org_id`/`*client_id` column is unprotected (for example a table added by a later feature and missing from `rls.sql`).

## 0. Before you start

- A **Neon backup branch** of the target database (staging, then production). This is the recovery point; note its name and timestamp.
- `PG_ADMIN_URL`: the admin/owner role (migrations only; production uses `neondb_owner`). `DATABASE_URL`: the runtime role (`skos_app`).
- If your network's DNS refuses `*.neon.tech` (the office Wi-Fi does), use a network or DNS resolver that resolves it (1.1.1.1 / 8.8.8.8).
- **If `feat/ai-communication` (AI Communication 2.0) merges first:** add its new `followup_*` tables to `rls.sql`'s `org` list and regenerate `up.sql`. CI and `up.sql`'s self-check both fail otherwise.

## 1. Verify the runtime role (read-only, today's state)

```bash
DATABASE_URL="<runtime skos_app url>" node backend/scripts/rls-verify.js
```

It only reads the catalog and runs read-only, rolled-back probes. Expect the **policy** checks to FAIL today (old policies; that is the bug this change fixes). The **role** lines must already pass: not superuser, not BYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION, owns no table, not a member of an owner/superuser/BYPASSRLS role, no CREATE on `public`, **no TRUNCATE**. If any role line fails, fix the grants as admin. Never fix it by granting the runtime role more:

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

GitHub Actions `tests`: unit (SQLite); PostgreSQL, including **tenant isolation** and **cross-gym product flows**; frontend tests, build and bundle budget.

## 3. Schema (safe before the code)

```bash
DATABASE_URL="$PG_ADMIN_URL" npm run db:init
```

This adds `idx_payments_client` and `idx_att_client`. On production-sized tables that is a short write lock; run it at a quiet hour. Expect `RLS policies NOT changed`; that is the guard working.

## 4. Deploy the CODE (policies unchanged)

Staging first: deploy the branch to the staging/preview Vercel project. Production: merge to `main` (Vercel deploys production from `main`).

**Health check.** Log in as an owner, a member and a trainer; the owner dashboard, member home and `/api/ready` should load. Watch the logs for `[rls] statement ran with no tenant or platform context`. Each such line is a code path that will see nothing after step 6, so note it.

Leave it running for 15–30 minutes. The latency added by this change is visible now, before the policies change (see the audit's performance section).

## 5. Apply the policies to STAGING, then validate

```bash
psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f database/migrations/2026-11-16_rls_fail_closed/up.sql
# equivalent: RLS_FAIL_CLOSED=apply DATABASE_URL="$PG_ADMIN_URL" npm run db:init
DATABASE_URL="<staging skos_app url>" node backend/scripts/rls-verify.js                 # expect 12/12
DATABASE_URL="<staging skos_app url>" PG_ADMIN_URL="$PG_ADMIN_URL" npm run pg:validate   # disposable DB only: it seeds rows
```

**Functional checks.** Two gyms (A, B) and one independent member. Everything marked ✓ is already covered end to end on PostgreSQL by `crossGymFlowsPg.test.js`; staging confirms it on real infrastructure and real data.

- [ ] Owner A: dashboard, members, payments, invoices, attendance, AI Communication. Only A's data.
- [ ] Member logs a workout, meal and weight; sees history and PRs.
- [ ] ✓ Sign up with no gym → accept terms → go independent.
- [ ] ✓ Independent member joins gym A by QR (free plan); old history visible to A. **Paid plan:** checkout return and webhook (sandbox mode). Not covered by tests.
- [ ] ✓ Owner A removes that member: they keep their history, A keeps its subscriptions.
- [ ] Multi-gym member: `/auth/switch-gym` between two gyms.
- [ ] ✓ Friend community with members from A and B: create, invite code, join, overview, leaderboards. Also feed posts and reactions (not covered).
- [ ] ✓ Tournament hosted by A, entered from B. Also scoring, results and the public QR join (not covered).
- [ ] ✓ In-app share A → friend in B; the public share link opened by a member of B (not covered).
- [ ] Barcode scan of a new product (global cache write).
- [ ] Wearable sync (WHOOP webhook and manual sync) for a member who changed gym.
- [ ] SUPER_ADMIN console: gyms, cross-gym payments, reconciliation, suspend/reactivate.
- [ ] Demo session: start → expiry.
- [ ] AI Communication: scheduler tick runs; Razorpay webhook replay activates; call logs per gym.
- [ ] eSSL/ADMS attendance push (`/iclock`) still records.
- [ ] ✓ Member export and account deletion (cross-gym rows erased).
- [ ] ✓ Gym branding: logo and colours load (`/api/branding/logo/:slug`).
- [ ] Logs: no `[rls]` lines, no `row-level security` errors, no 5xx spike.

**Load test (required):** `node backend/scripts/loadtest.mjs --base-url <staging> --confirm-staging` before and after step 4, with `PG_POOL_METRICS=1` and `EXPOSE_POOL_STATS=1` on staging. Acceptance: p95 of the owner dashboard and member home within your budget (suggested: ≤ +100 ms over today) and no `pool waiting` growth at the expected peak. If the pool saturates, raise `PG_POOL_MAX` (default 5); Neon's pooled endpoint handles the short per-statement transactions.

## 6. Production

Same order, with the owner's explicit approval at each arrow:
(a) Neon backup branch → (b) step 1 against production → (c) step 3 → (d) step 4 (merge), watch 15–30 min → (e) `up.sql` as `neondb_owner` → (f) `rls-verify.js` as `skos_app`, expect **12/12** → (g) repeat the read-only parts of the checklist with real accounts.

**Never** run `pg:validate` or any test against production.

## Rollback

| Symptom | Action |
|---|---|
| One cross-gym feature broken after step 6 | Hotfix: wrap that path in `runAsPlatform('<reason>', …)`, keyed by the caller's own ids, after confirming its application-level authorisation. |
| Broad breakage after step 6 | `psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f database/migrations/2026-11-16_rls_fail_closed/down.sql`. It restores the previous policies **exactly**, switches RLS off on the 16 tables the old model never covered (so nothing is left locked; tested), and the new code keeps working on them. |
| Latency regression or a per-statement scoping problem | Set `RLS_TENANT_SCOPE=off` and redeploy. Tenants' plain statements then run as platform again (the pre-change behaviour); `db.tx` stays scoped and the policies stay fail-closed. **Emergency only:** it logs a SECURITY error at every boot; remove it as soon as fixed. |
| Code must be reverted | Run `down.sql` **first**, then redeploy the previous build. The previous code on the restored policies is exactly today's production state. |

**Compatibility checked:** new code + old policies (tested: every suite runs the new adapter and the migration test runs down → up); new code + new policies (all suites); old code + restored policies = today's state, byte-identical policy text from `3fab43a`. **Old code + new policies is the one unsafe pair**, and the init guard plus this order prevent it.

## After go-live

- Add `rls-verify.js` (runtime role) to the post-deploy checklist for any change to `rls.sql` or role grants.
- Any new table carrying `org_id`/`client_id` (or `*_org_id`/`*_client_id`) must go into `rls.sql`, with `up.sql` regenerated for the next versioned migration. CI, `rls-verify.js` and the migration self-check all enforce this.
