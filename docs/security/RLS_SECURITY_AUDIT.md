# PostgreSQL RLS Tenant Isolation — Security Audit

**Branch:** `security/rls-tenant-isolation-hardening` (latest `origin/main` ff8a7c8 merged in) · **Date:** 2026-11-16 · **Not merged to main, not deployed.**

**Final status: CONDITIONAL PASS.** The implementation is complete and every locally executable gate passes. Three external release gates remain: production runtime-role verification, staging validation, and an agreed latency budget for the measured cost. See [§9](#9-release-gates-and-remaining-risks).

---

## 1. Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **High** | RLS was effectively off for most of the app. `db.q()/q1()/run()` used `pool.query()` with no tenant context, and every policy had an `app.org_id unset ⇒ every row` branch. Only `db.tx()` was scoped. | **Fixed** |
| F2 | **High** | Policies failed **open**: any statement without context (a script, a raw connection, a new code path) saw every gym's rows and could write into any gym. | **Fixed:** fail closed |
| F8 | **High** (privilege escalation; found in this pass) | A signed-in user **without a gym** ran with **platform** (RLS-bypassing) visibility on every authenticated route. That covers anyone who self-registers as a member or trainer without a gym code, reachable by public sign-up. Any route that forgot its own filter would have served every gym's rows to that account. Separately, a `SUPER_ADMIN` role claim in a token was trusted without re-checking the user's current role. | **Fixed:** gym-less users run *restricted* (no tenant rows); platform scope only for a SUPER_ADMIN whose `users` row still says so, checked on every request. Own-account routes opt in to a narrow `own-identity` scope. |
| F9 | Medium (found in this pass) | **16 cross-gym tables had no RLS at all**: friend communities (7), tournaments (8), `app_shares`. Any gym's request could read every gym's community feed, tournament entries (names, body weight) and shares through a single forgotten filter. The coverage check only looked for columns named exactly `org_id`/`client_id`, so `app_shares.sender_org_id`/`recipient_org_id` and `tournaments.host_org_id` escaped it. | **Fixed:** communities and tournaments are **platform-only** (no gym context can touch them); `app_shares` is visible to the sending or receiving gym only, and a gym can only send as itself. Coverage checks match any `*org_id`/`*client_id` column. |
| F10 | Medium (operational) | The established deploy habit ("`npm run db:init` against production, then push") would have applied the fail-closed policies under the **old** code and blanked the app. | **Fixed:** `init-db.js` refuses to replace fail-open policies unless `RLS_FAIL_CLOSED=apply` (tested). |
| F11 | Medium (rollback) | `down.sql` restored the old policies but left newly covered tables with RLS on and **no policy** (deny-all), which would have broken communities and tournaments on rollback. | **Fixed:** `down.sql` switches RLS off before restoring; tested that no table is left locked. |
| F3 | Medium | No reference check on writes: a gym could insert a row stamped with its own org that points at **another gym's client** (payments, workouts, …). | **Fixed:** WITH CHECK requires the client to be the writer's own |
| F4 | Medium | Global library rows (`foods`, `exercise_library`, …; `org_id NULL`) were **insertable, editable and deletable by any gym**, affecting every gym. | **Fixed:** only platform writes shared rows |
| F5 | Medium (pre-existing bug) | An independent member joining a gym ran activation in a transaction scoped to their **old** org: a free join silently did nothing, and a paid checkout return failed on a non-bypass role. | **Fixed:** join routes run as explicit platform |
| F6 | Medium (robustness) | A connection dying while checked out was an **uncaught exception that exited the process**. | **Fixed** |
| F12 | Low (performance, pre-existing) | `attendance` and `payments` had no index by member. The member account view's attendance lookup was a full table scan: 28 ms at 200k rows. | **Fixed:** `idx_att_client`, `idx_payments_client`: 0.17 ms and 0.05 ms |
| F7 | Info | Stale tenant context on pooled connections: **not exploitable before or after.** | Proven by tests 7 and 9 |

Regressions found and fixed **by the new end-to-end PostgreSQL flow suite** before they shipped: sending a share to a friend in another gym (the recipient check read friend-community membership from inside the sender's gym context), and the member export and account deletion (their tournament and community rows would have been silently skipped). SQLite cannot catch this class of bug because it has no RLS. That is why the flow suite now runs in CI.

## 2. How tenant context reaches PostgreSQL

1. `index.js` installs `platformScope('http-request')` **after** the body parsers, so public routes (login, sign-up, public previews, signed webhooks) have an explicit context.
2. `requireAuth` verifies the JWT (HS256 pinned). Its own gate lookups run as platform. It then **narrows** the request:
   - a token with an org → **tenant** (`app.org_id` = that org; the org comes only from the signed token, never from the body, query or headers; tested);
   - `SUPER_ADMIN` with no org, **and** the `users` row currently says `SUPER_ADMIN`, active, with no org → **platform**;
   - anyone else without an org → **restricted**: neither setting, so no tenant rows.
3. `db.js` `scoped()` is the single path to PostgreSQL. It checks out **one** connection and sends `BEGIN; SELECT set_config('app.org_id', <org>, true), set_config('app.platform', <flag>, true)` in one round trip. It then runs the statement (or the whole `db.tx` callback) on that same connection, `COMMIT`s (or `ROLLBACK`s) and releases. A connection whose rollback fails is destroyed, not reused.
4. Org ids are validated (`[A-Za-z0-9_.:-]{1,128}`) and escaped; invalid ids throw before any SQL runs. A tenant request cannot open a transaction for another gym (`tenant_context_mismatch`).
5. Policies grant rows only for `app.org_id = <org>` or `app.platform = 'on'`. **Neither ⇒ nothing.**

### Platform scope: every grant, and what authorises it

| Where | Authorisation (application level) |
|---|---|
| Public routes until `requireAuth` | Login/sign-up rate limits; signed webhooks (Razorpay, WHOOP, access hook, ADMS `/iclock`, follow-ups hooks); unguessable share and invite codes |
| `SUPER_ADMIN` | Role re-checked against `users` on every request; `/api/console` and admin routes also check the role |
| `routes/communities.js` (`friend-communities`) | Active membership row per community (`services/friendCommunities`) |
| `routes/tournaments.js` (`tournaments`), public QR routes | Per-tournament access (`services/tournaments/access.js`) |
| `routes/enrollment.js` join routes | Signed, single-use enrollment token |
| `routes/auth.js` `own-identity`: `/me`, `/my-gyms`, `/switch-gym`, `/terms/*`, `/change-password`, `/independent`, `/resend-verification` | Every statement keyed by the verified token's `sub` |
| `sharing.js` snapshot loads, audience, recipient check; `appShares.js` delivery | Caller's own client id; recipients must share a gym or community |
| `routes/me.js` `own-account-export` / `own-account-deletion` | Statements keyed by the caller's own client/user id |
| `gymExit.js` | Owner's org-scoped check first |
| `barcodeLookup.js` | Only writer of shared food rows |
| Operator scripts | Run by an operator |

Every grant is greppable (`runAsPlatform` / `platformScope`) and named.

## 3. Policy model

**139 of 159 tables protected** (RLS enabled **and forced**), **211 policies**. The full per-table list, generated from the live catalog, is in [`RLS_TENANT_ISOLATION_MATRIX.md`](RLS_TENANT_ISOLATION_MATRIX.md).

| Class (brief) | Category | Tables | Read | Write |
|---|---|---|---|---|
| A gym-owned | **org** | 74 (financial, attendance, AI Communication incl. calling numbers and settings, staff, settings and branding, …) | own org | own org; any `client_id` must be own client |
| A | **client** | 15 | client in own org | same |
| A | **parent** | 10 | parent visible | same |
| A | **demo** | 1 | `demo_org_id` = own | same |
| B user-owned | **personal** | 11 member-history tables | own org **or** member now in own org | insert: own org and own client |
| B | **personal_user** | 6 | own org or user now in own org | by user |
| C global | **global** | 6 library/snapshot tables | shared (NULL-org) rows + own | never a shared row |
| D cross-gym | **platform** | 15 (communities, tournaments) | **nothing** from a gym context | **nothing** |
| D | **shares** | `app_shares` | sending or receiving gym | send only as itself and as its own member |

"Personal" exists because members move (independent → gym on joining, gym → independent on leaving), and their own history moves with them, as the product promises. Payments, subscriptions, attendance, messages and AI Communication stay with the gym where they happened. Tested both ways, at the database and through the real routes.

**20 tables deliberately unprotected**, each reviewed. They are: the tenant root (`organizations`), platform configuration and pricing, global reference data, the shared food-estimation cache and its feedback, and per-**user** rows with no tenant column (`account_tokens`, `health_reconciliation_log`, `barbell_plan_orders`), every read of which is keyed by the authenticated user. CI, `rls-verify.js` and the migration self-check all fail if a table with any `*org_id`/`*client_id` column falls outside the lists.

**Inventory beyond tables (live catalog):** 0 views, 0 materialized views, 0 functions, 0 triggers, 321 foreign keys. Raw `pg` usage outside `db.js` exists only in operator scripts (`init-db.js`, `db-check.js`: catalog reads; `rls-verify.js`: read-only probes). No caching layer holds tenant rows across requests. The only in-process caches are per-org timezone, billing status, deactivation and demo-org flags, keyed by org or user id.

## 4. Database role

`backend/scripts/rls-verify.js` (read-only; run as the runtime role) checks the following:
- the role is not a superuser and not BYPASSRLS;
- it has no CREATEROLE, CREATEDB or REPLICATION;
- it owns no table;
- it is not a member of an owner, superuser or BYPASSRLS role;
- it has no CREATE on the schema and no TRUNCATE on any table;
- every tenant table is protected and forced;
- no fail-open policy remains;
- a live probe of every protected table with no context finds nothing.

- **Local, verified: 12/12** on a NOBYPASSRLS DML-only role. A deliberately bad role (BYPASSRLS and TRUNCATE) fails, as tested.
- **Production: NOT verified.** No production credentials are available to this audit (none on this machine, and the office network's DNS refuses `*.neon.tech`). This is release gate 1.

Migrations stay on the admin role. Nothing in this change grants the runtime role anything.

## 5. Tests and results (all executed 2026-11-16, PostgreSQL 17.10 local; CI runs 16)

| Suite | Result |
|---|---|
| `rlsTenantIsolation.test.js`: 6 static/HTTP-context tests + PostgreSQL suite of 19 subtests | **26 / 26 pass** |
| `crossGymFlowsPg.test.js` (new): real app over HTTP, NOBYPASSRLS role, 8 flows | **9 / 9 pass** |
| `communityPg`, `financialRls`, `groupByParamsPg` | 11 / 11, 11 / 11, 4 / 4 pass |
| AI Communication on PostgreSQL (`followups`, `followupsHardening`, `followupsPg`) | 58 / 58 pass |
| `pg-validate.js` (admin / NOBYPASSRLS runtime roles) | **8 / 8** |
| `rls-verify.js` as the runtime role | **12 / 12** (211 policies; 139 tables probed) |
| Full backend suite (SQLite) | **2,131 pass, 0 fail, 15 skipped** (the PostgreSQL-gated files above; they self-skip without `TEST_DATABASE_URL`) |
| Frontend unit tests (Vitest) | 286 / 286 pass (27 files) |
| Frontend production build + bundle budget | pass; all bundle budgets met |

**Adversarial coverage** (real `db.js`, NOBYPASSRLS login role, pools of size 1 and 4):
- **Gym B's rows from gym A:** SELECT, UPDATE and DELETE, by id and by an unfiltered query, across financial, attendance, AI Communication (jobs, consent, calling numbers, settings), wearable, training and identity tables.
- **Writes aimed at gym B:** INSERT into B, with B's member, under B's parent rows; re-pointing own rows at B; moving a member between gyms.
- **Shared reference data:** writing global foods and the exercise library.
- **No context:** zero rows on every protected table and no writes, including over a raw connection.
- **Connection pool:** reuse across alternating gyms with a planted session value; 120 concurrent mixed requests; a background worker alternating gyms on one connection.
- **Failures:** rollback, a failed statement, a backend killed mid-transaction.
- **Forged ownership:** webhook-style transactions; a tenant opening another gym's transaction; injection-shaped org ids; a tenant calling `set_config('app.platform','on')`.
- **Cross-gym data:** platform-only tables from a gym context; shares forged from another gym.
- **Gym-less users:** they see nothing and cannot promote anyone.
- **HTTP:** an Express route whose SQL forgot its org filter, called with `org_id`/`x-org-id` claiming gym B; gym-less, demoted-admin and ghost-admin tokens.
- **Deployment:** the deploy-order guard, and the migration round trip (down → self-check rejects → up → up), with no table left locked after down.

**Cross-gym flows tested end to end** (`crossGymFlowsPg`):
- sign-up with no gym → terms → independent;
- QR join of gym A (free plan), with history visible to A and not to B;
- the owner removes the member, who keeps their history while A keeps its books;
- a friend community spanning gyms A and B;
- an A → B share with the content intact;
- a tournament hosted by A and entered from B;
- export and deletion of cross-gym rows;
- the public gym-branding logo route.

**Not executed:**
- paid checkout return (needs Razorpay sandbox);
- wearable sync;
- eSSL push;
- AI Communication calls through providers;
- multi-gym `switch-gym`;
- staging;
- production.

## 6. Performance (measured)

**Method.**
- **Database:** `skos_bench` was built by `init-db.js` and seeded with **50 gyms and 10,000 members**: 200k workouts, 300k weight logs, 60k payments, 200k attendance rows.
- **Workload:** each "gym" is a concurrent worker issuing requests for 8 s. 80% are **member home** requests (5 statements) and 20% are **owner dashboard** requests (4 aggregate statements).
- **OLD:** today's adapter (one pooled round trip, no context), on a role RLS does not filter. That is the same row work as production's fail-open policies.
- **NEW:** this branch's `db.js` on a NOBYPASSRLS role with the fail-closed policies.
- **Network latency:** simulated with a local TCP proxy adding a fixed delay each way (1 ms and 5 ms round trip), because the database is local. **These are local measurements, not staging**, and absolute numbers depend on the machine. The ratios are what transfer.

**Per request, member/owner mix (p50 / p95 / p99 ms; throughput in requests/s):**

| DB round trip | Pool | Concurrent gyms | OLD | NEW (per statement) | NEW, request in one `db.tx` |
|---|---|---|---|---|---|
| ~0 (local) | 5 | 2 | 0.7 / 1.3 / 1.7 · 2,663/s | 1.9 / 3.3 / 4.0 · 982/s | — |
| ~0 (local) | 5 | 50 | 14.6 / 21.0 / 23.1 · 3,411/s | 30.0 / 45.6 / 52.1 · 1,614/s | — |
| 1 ms | 5 | 2 | 7.1 / 8.3 / 9.1 · 282/s | 21.6 / 23.7 / 25.2 · 95/s | 9.9 / 11.4 / 11.9 · 202/s |
| 1 ms | 5 | 10 | 14.0 / 15.7 / 16.6 · 725/s | 41.7 / 46.4 / 48.1 · 245/s | 20.1 / 21.9 / 22.9 · 501/s |
| 1 ms | 5 | 25 | 36.1 / 41.0 / 43.1 · 699/s | 109.2 / 119.3 / 121.6 · 237/s | 50.8 / 54.8 / 59.6 · 497/s |
| 1 ms | 5 | 50 | 72.8 / 79.2 / 81.4 · 706/s | 212.0 / 228.6 / 234.3 · 244/s | 100.4 / 106.0 / 107.4 · 509/s |
| 1 ms | 10 | 10 | 6.5 / 7.7 / 8.2 · 1,526/s | 18.8 / 20.5 / 21.3 · 541/s | 10.0 / 11.1 / 11.7 · 1,009/s |
| 1 ms | 10 | 25 | 16.0 / 18.0 / 19.7 · 1,580/s | 46.3 / 49.2 / 50.8 · 556/s | 24.4 / 28.7 / 30.4 · 1,021/s |
| 1 ms | 10 | 50 | 32.2 / 34.2 / 35.8 · 1,587/s | 93.6 / 98.1 / 101.5 · 552/s | 49.0 / 52.0 / 53.4 · 1,036/s |
| 5 ms | 5 | 50 | 284.9 / 290.4 / 295.2 · 184/s | 848.1 / 852.5 / 855.1 · 63/s | — |
| 5 ms | 10 | 10 | 28.7 / 30.2 / 34.8 · 358/s | 84.3 / 88.7 / 93.0 · 123/s | 40.2 / 41.4 / 42.0 · 255/s |
| 5 ms | 10 | 50 | 141.9 / 146.8 / 153.0 · 368/s | 418.6 / 421.8 / 422.3 · 126/s | 199.8 / 203.1 / 205.4 · 261/s |

Across every run (about 1.2 million requests): **0 errors, 0 wrong-gym rows** (each request checked that it saw exactly its own gym), and no connection exhaustion. Waiting requests queue in the pool (`max pool wait` equals concurrency minus pool size, identical for old and new).

**What it means.**
- **The cost is round trips, not policy evaluation.** Every statement now takes 3 round trips (BEGIN + context; statement; COMMIT) instead of 1, so database time per request is about **3×**, and a pool sustains about **⅓ of the statements per second**. Policy evaluation itself is cheap: every benchmark query ran in **0.03–0.25 ms** under RLS once indexed.
- **Grouping a request's reads into one `db.tx`** costs N + 2 round trips instead of 3N. That brings the overhead down to about **1.4×** (1 ms round trip, pool 10, 50 gyms: p50 49 ms against 32 ms today and 94 ms per-statement). It uses the existing API and needs no security trade-off.
- **Pool size** matters more than before. `PG_POOL_MAX` defaults to 5; at 10, queueing halves.
- **Rejected optimisations**, because they weaken security: session-level `SET` with a reset on release (forbidden: a missed reset leaks a tenant); interpolating parameters client-side to put everything in one simple-protocol round trip (an injection surface); deferring COMMIT to the next checkout (holds open transactions and breaks read-your-writes). node-postgres cannot pipeline, so 3 round trips is the floor for an isolated single statement.

**Slow queries found:** `attendance` by member was a full scan (28 ms at 200k rows) and `payments` by member was too (4 ms). Both are now indexed: 0.17 ms and 0.05 ms. No N+1 pattern appeared in the benchmarked paths. The member and owner request shapes above are representative, not a trace of production traffic, so the staging load test (`scripts/loadtest.mjs`, runbook step 5) is still the acceptance measurement.

**Reproduce** (local or staging hardware; never against production). Scripts are in `backend/scripts/rls-bench/`:
1. Build a database named `skos_bench` with `init-db.js` and load `seed.sql` as admin.
2. Create a `bench_app` LOGIN NOBYPASSRLS role (password `benchpw`) with SELECT, INSERT, UPDATE and DELETE.
3. Optionally run `node latency-proxy.mjs <port> <pg-port> <one-way-ms>`.
4. Run `node bench-load.mjs <repo-root> <port> <label> <pool> <seconds> 2,10,25,50` (set `MODES=old,new,new-tx`). The `old` mode connects as `postgres:postgres` to model today's unfiltered reads; adjust for your environment.

**Recommendation before production:**
1. Set `PG_POOL_MAX=10` if Neon's pooled endpoint is in use.
2. Wrap the 3–5 hottest read endpoints (member home, owner dashboard, member list) in one `db.tx` each. This is a small follow-up, measured above at about 2× faster than per-statement.
3. Agree a latency budget and confirm it on staging.

## 7. Affected files

- `backend/src/db.js`: context model (tenant / platform / restricted), `scoped()`, kill switch, unscoped log, connection error handling
- `backend/src/auth.js`: gate lookups as platform; tenant / platform (DB-checked SUPER_ADMIN) / restricted narrowing
- `backend/src/index.js`: request-wide platform scope after the body parsers
- `backend/src/routes/{auth,communities,tournaments,enrollment,appShares,me}.js`, `backend/src/services/{sharing,barcodeLookup}.js`, `services/enterprise/gymExit.js`: named, narrow platform scopes
- `database/rls.sql`: fail-closed policies; `platform` and `shares` categories
- `database/schema.sql`: `idx_payments_client`, `idx_att_client`
- `database/migrations/2026-11-16_rls_fail_closed/{up,down}.sql`: versioned migration with self-checks; exact rollback
- `backend/scripts/init-db.js`: deploy-order guard. `rls-verify.js`: posture check. `pg-validate.js`, `create-super-admin.js`, `export-training-data.js`: updated.
- Tests: `rlsTenantIsolation.test.js`, `crossGymFlowsPg.test.js` (new), `communityPg.test.js`, `financialRls.test.js`
- `.github/workflows/test.yml`: tenant-isolation and cross-gym-flow steps

## 8. Frontend and API

Gym identity is server-side only: the org comes from the signed JWT (cookie or bearer), and `localStorage` holds display data only. Changing a URL parameter, body field or header cannot select a gym, as tested over HTTP. Owner and admin pages call org-scoped routes, so a URL with another gym's member id returns 403/404 (tested for weights and member lists). The branding logo route is still public and still works (tested). No frontend file changed in this work.

## 9. Release gates and remaining risks

**External release gates (cannot be completed from here):**
1. **Production runtime role** (`rls-verify.js` as `skos_app`): needs production credentials, run by the owner (runbook step 1).
2. **Staging**: no staging database or credentials available. Run the runbook's checklist, including paid checkout in sandbox, wearable sync, eSSL, AI Communication calls and `switch-gym`.
3. **Latency budget**: agree a budget against the numbers in §6 and confirm with the staging load test.

**Remaining risks:**
1. **Added latency** scales with the database round-trip time (§6). This is the price of per-statement isolation with node-postgres, which cannot pipeline. The kill switch `RLS_TENANT_SCOPE=off` exists for emergencies only.
2. **Platform scope is still broad where it is granted.** Public routes, webhooks, SUPER_ADMIN and the named features see all gyms at the database level; application checks and signatures are their control. The gyms' *private* tables are no longer reachable from ordinary gym requests or from gym-less accounts.
3. **RLS is tenant-level, not user-level.** Members of the same gym, and **all independent members** (one shared `independent` org), are separated only by application checks.
4. **GUC-based RLS does not stop SQL injection.** Any SQL the runtime role executes can call `set_config('app.platform','on',true)` for its own transaction. Every query found is parameterised.
5. **Behaviour changes:**
   - a member's receipts, notifications and messages from a *previous* gym stay with that gym;
   - shares received while at a previous gym stay with that gym's copy;
   - `followup_member_prefs` is keyed by `client_id` alone, so a member who moves between two gyms that both use AI Communication cannot have prefs saved by the second (needs `(org_id, client_id)`).
6. **Personal tables:** a gym can UPDATE its *current* member's older rows. WITH CHECK cannot compare old and new `org_id`; no code path writes `org_id` on those tables.
7. **AI Communication 2.0** (`feat/ai-communication`, unmerged) adds tables that must join `rls.sql`'s `org` list when it merges. CI and the migration self-check will refuse it otherwise.
