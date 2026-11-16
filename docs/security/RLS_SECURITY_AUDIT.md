# PostgreSQL RLS Tenant Isolation — Security Audit

**Branch:** `security/rls-tenant-isolation-hardening` (from `origin/main` 3fab43a) · **Date:** 2026-11-16 · **Not merged, not deployed.**

**Final status: CONDITIONAL PASS — SPECIFIC RISKS REMAIN** (see [Unresolved risks](#unresolved-risks)). The database-level isolation is fixed and proven by adversarial tests on PostgreSQL. What remains is staging validation of cross-gym product flows that could not be exercised end to end offline, a load test of the added round trips, and verification of the *production* role, which this audit could not reach.

---

## 1. Summary of findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **High** | RLS was effectively off for most of the app. `db.q()/q1()/run()` used `pool.query()` with no tenant context, and every policy had an `app.org_id unset ⇒ every row` branch. Only `db.tx()` was scoped. | **Fixed** |
| F2 | **High** | Policies failed **open**: any statement without context (a script, a raw connection, a new code path) saw every gym's rows and could write into any gym. | **Fixed:** fail closed |
| F3 | Medium | No reference check on writes: a gym could insert a row stamped with its own org that points at **another gym's client** (payments, workouts, …). | **Fixed:** WITH CHECK requires the client to be the writer's own |
| F4 | Medium | Global library rows (`foods`, `exercise_library`, …; `org_id NULL`) were **insertable, editable and deletable by any gym**, affecting every gym. | **Fixed:** only platform writes shared rows |
| F5 | Medium (bug, pre-existing) | An independent member joining a gym ran activation inside a `db.tx()` scoped to their **old** (independent) org: the gym's enrollment token was invisible (free join silently did nothing), and a paid checkout-return failed WITH CHECK on a non-bypass role. | **Fixed:** join routes run as explicit platform |
| F6 | Medium (robustness) | A connection dying while checked out emitted an unhandled `error` event, an **uncaught exception that exits the process**. Found by test 9. | **Fixed** |
| F7 | Info | Stale tenant context on pooled connections: **not exploitable before or after.** `db.tx()` already used `set_config(…, true)`; the new path keeps it transaction-local and also overwrites any session-level value planted on a connection. | Proven by tests 7 and 9 |

The documented issue in `docs/RLS-BOUNDARY.md` was real, though not in the "stale context" form one might suspect. It was a **missing backstop**: application `WHERE org_id = ?` clauses were the only control on most queries, so one forgotten filter (an IDOR) would leak across gyms. The pre-change test suites pinned the fail-open behaviour on purpose (`'unset app.org_id keeps the application working'`).

## 2. How tenant context reaches PostgreSQL now

1. `index.js` installs `platformScope('http-request')` **after** the body parsers. They resume on socket stream callbacks, which do not carry an AsyncLocalStorage context set before them; this ordering is covered by a test.
2. `requireAuth` verifies the JWT (HS256 pinned). Its own gate lookups (suspension, deactivation, demo session) run as an explicit platform context, then `runWithOrg(req.user.org)` **narrows** the rest of the request to that tenant. The org comes only from the signed token; body fields and headers are ignored (tested).
3. `db.js` `scoped()` is the single path to PostgreSQL. It checks out **one** connection, sends `BEGIN; SELECT set_config('app.org_id', <org>, true), set_config('app.platform', <flag>, true)` in one round trip, runs the statement (or the whole `db.tx` callback) on that connection, then `COMMIT`, or `ROLLBACK` on error, and releases. If ROLLBACK fails, the client is **destroyed** (`release(err)`) instead of being reused.
4. Both settings are always written. The org id is validated against `[A-Za-z0-9_.:-]{1,128}` and passed through `escapeLiteral` (the simple-query protocol cannot bind parameters); invalid ids throw before any SQL runs.
5. `db.tx(fn, { orgId })` may narrow a platform context to one gym (the AI Communication wallet does this). It **cannot** point a tenant request at another gym (`tenant context mismatch`).
6. Policies (`database/rls.sql`) grant rows only for `app.org_id = <org>` or `app.platform = 'on'`. **Neither ⇒ nothing.**

**Platform context** is used only where application code is the authorisation:

| Where | Why |
|---|---|
| Every request until `requireAuth` narrows it | Login, sign-up, public share previews, signed webhooks (Razorpay, WHOOP, access hook, ADMS `/iclock`, follow-ups hooks), the follow-ups scheduler tick |
| Users with no org (SUPER_ADMIN console) | Platform operator, cross-gym by role |
| `routes/communities.js`, `routes/tournaments.js` | Cross-gym by design; membership/tournament checks in services |
| `routes/enrollment.js`: `/preview`, `/client/join`, `/client/payment/verify`, `/trainer/join` | Joining moves rows between orgs; the signed single-use token is the control (fixes F5) |
| `routes/auth.js`: `/me`, `/my-gyms`, `/switch-gym` | The caller's own identity spans gyms |
| `sharing.js` snapshot loads, people search; `appShares.js` delivery | Sender/recipient in different gyms; unguessable share id and `allowedRecipients()` |
| `gymExit.js` `endGymMembership` | Moves the member out of the gym (after the owner's org-scoped check) |
| `barcodeLookup.js` global cache insert | The only writer of shared (`org_id NULL`) food rows |
| `create-super-admin.js`, `export-training-data.js`, `pg-validate.js` | Operator tools |

Every site is greppable: `runAsPlatform` / `platformScope`.

## 3. Policy model (summary — full table list in the matrix)

| Category | Tables | Read | Write |
|---|---|---|---|
| **org** | 75 gym-owned and financial tables | own org | own org, and any `client_id` must be own client |
| **personal** | 11 member-history tables (workouts, client workouts, cardio, AI memory, …) | own org **or** member currently in own org | insert: own org + own client; update/delete: rows readable |
| **personal_user** | 5 wearable tables + `notification_preferences` | own org or user currently in own org | as above, by user |
| **client** | 15 tables with only `client_id` | client in own org | same |
| **parent** | 10 child tables | parent visible (subquery runs under the parent's policy) | same |
| **global** | foods, exercise libraries, share snapshots | shared rows + own (+ own member's) | **never** a shared row outside platform |
| **demo** | `demo_sessions` | `demo_org_id` = own | same |

"Personal" exists because members move: independent → gym on join, gym → independent on leave. The code promises their history moves with them ("BRING YOUR ACCOUNT WITH YOU", `enrollment.js`), and rows keep the org they were created in. Strict org scoping would have hidden a joining member's entire pre-gym history from them. Financial and operational rows (payments, subscriptions, attendance, messages, AI Communication) stay strictly with the gym where they happened. This broadens what the **policy text** allows for those 16 tables compared with the old file. The old policies were never applied to `db.q()` reads, so the effective exposure is far smaller than before. The trade-off is deliberate and tested ("history follows a member").

## 4. Database role (runtime vs admin)

`backend/scripts/rls-verify.js` (read-only; run as the runtime role) checks: not superuser; not BYPASSRLS; no CREATEROLE/CREATEDB/REPLICATION; owns no table; is not a member of an owner, superuser or BYPASSRLS role; no CREATE on the schema; **no TRUNCATE** on any table (TRUNCATE ignores RLS); every `org_id`/`client_id` table has RLS enabled, forced and a policy (or is on the reviewed exemption list); no fail-open policy remains; and a live probe that a statement with no context sees no tenant row in any of the 123 protected tables.

- **Local, verified:** a fresh database with an admin role for init and a separate `NOBYPASSRLS` DML-only runtime role: **12/12**. A deliberately bad role (BYPASSRLS + TRUNCATE) fails the BYPASSRLS, TRUNCATE and probe checks (tested).
- **Production, NOT verified:** this audit had no access to Neon. `config.js` refuses only the role name `neondb_owner`. Whether production's `skos_app` is `NOBYPASSRLS`, owns no table and lacks TRUNCATE is **unknown** until `rls-verify.js` runs there (runbook step 1).

Migrations stay on the admin role (`init-db.js`, `up.sql`); nothing in this change grants the runtime role anything.

## 5. Tests and results (all executed on 2026-11-16)

Environment: embedded PostgreSQL **17.10** (Windows), Node 22.23.4. CI runs PostgreSQL 16 and now includes the new suite.

| Suite | Result |
|---|---|
| `rlsTenantIsolation.test.js` (new; 6 static/context + 14 PostgreSQL) | **20 / 20 pass** |
| `communityPg.test.js` (updated: fail-closed assertion) | 11 / 11 pass |
| `financialRls.test.js` (updated: fail-closed assertion) | 11 / 11 pass |
| `groupByParamsPg.test.js` | 4 / 4 pass |
| AI Communication on PostgreSQL (`followups`, `followupsHardening`, `followupsPg`) | 58 / 58 pass |
| `pg-validate.js` (updated) with separate admin / NOBYPASSRLS runtime roles | **8 / 8** |
| `rls-verify.js` as the runtime role | **12 / 12** |
| Full backend suite (SQLite), `node --test` | **2,122 pass, 0 fail, 14 skipped** (the PG-gated tests above) |
| Migration round trip (down → self-check rejects old policies → up → up) | pass (in the new suite) |
| Frontend / admin tests | **Not run**: no frontend or admin file changed |

The adversarial suite covers all ten requested attacks, using the **real `db.js` adapter** on a login role without BYPASSRLS and **pools of size one**: SELECT/UPDATE/DELETE of Gym B rows by id and by unfiltered query; INSERT into B, with B's client, on B's parent rows, re-pointing own rows at B; financial, attendance, AI Communication, wearable and training tables; **no context ⇒ zero rows on all 123 protected tables** and no writes, including through a raw connection that bypasses `db.js`; reuse of a single connection across 40 alternating A/B requests, with a session-level value planted on it; 120 concurrent A/B requests on pools of 4 and 1, with `pg_sleep` interleaving and transactions; rollback, a failed statement and a **backend killed mid-transaction**; webhook-style platform transactions scoped to one gym, tenant→other-gym transactions, injection-shaped org ids; and an Express + `requireAuth` route whose SQL **forgot its org filter**, called with `org_id`/`x-org-id` claiming Gym B (it still only returned Gym A's clients).

## 6. Affected files

- `backend/src/db.js`: context model, `scoped()` execution path, kill switch, unscoped-statement log, checked-out-connection error handling
- `backend/src/auth.js`: gate lookups as platform; tenant narrowing
- `backend/src/index.js`: request-wide platform scope after the body parsers
- `backend/src/routes/{communities,tournaments,enrollment,auth,appShares}.js`, `backend/src/services/{sharing,barcodeLookup}.js`, `backend/src/services/enterprise/gymExit.js`: named platform scopes
- `database/rls.sql`: rewritten fail-closed policies
- `database/migrations/2026-11-16_rls_fail_closed/{up,down}.sql`: versioned migration and exact rollback
- `backend/scripts/rls-verify.js` (new), `pg-validate.js`, `create-super-admin.js`, `export-training-data.js`
- `backend/test/rlsTenantIsolation.test.js` (new); `communityPg.test.js`, `financialRls.test.js` (assertions flipped to fail-closed)
- `.github/workflows/test.yml`: new CI step; `docs/RLS-BOUNDARY.md` marked superseded

## 7. Unresolved risks

1. **Cross-gym flows not exercised end to end.** I found the cross-gym features by code review (friend communities, tournaments, sharing, join/exit, multi-gym switching). Any cross-gym read I missed inside a tenant request now returns **no rows** or fails WITH CHECK. That is fail-closed, so it surfaces as a functional bug rather than a leak, but it must be checked in staging (runbook step 4). Most backend tests use in-memory SQLite and cannot catch it.
2. **Performance.** Each statement now costs 3 round trips instead of 1 (measured locally: +0.10 ms; real cost ≈ 2 × the app↔DB round-trip time per statement). Policies with client subqueries also add planner work. **Load test required** before production (`scripts/loadtest.mjs`).
3. **Production role posture unknown** (section 4).
4. **Platform context is broad.** Unauthenticated routes, webhooks, SUPER_ADMIN and the named features above see all gyms at the database level; application checks and signatures are their control, exactly as before. Narrowing each route is follow-up work.
5. **RLS is tenant-level, not user-level.** Members of the same gym, and **all independent members (one shared `independent` org)**, are separated only by application checks.
6. **GUC-based RLS and SQL injection.** Any SQL the runtime role executes can call `set_config('app.platform','on',true)`. Every query found is parameterised; RLS is not a defence against SQL injection.
7. **Behaviour changes to note:** a member's receipts, notifications and messages from a *previous* gym are no longer reachable from their new gym (financial/operational data stays with the gym). `followup_member_prefs` is keyed by `client_id` alone, so a member who moves between two gyms that both use AI Communication cannot have prefs saved by the second gym (conflict on a row it cannot see). That needs a schema change to `(org_id, client_id)`. A "switched" multi-gym session whose token org differs from `users.org_id` sees only its own identity via `/auth/*`.
8. **Personal tables:** a gym can UPDATE its *current* member's older rows; WITH CHECK cannot compare old and new `org_id`, so a malicious update could re-stamp such a row to another org (a push, not a read). No code path writes `org_id` on these tables.
9. **Merge conflicts:** `feat/ai-communication` adds follow-up tables and `rls.sql` entries; they must be added to the `org` list (and `up.sql` regenerated) when that branch merges.
