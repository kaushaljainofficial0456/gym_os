# AI Communication — Production Readiness

Branch `feat/ai-communication` (Sambhav's commit `5548dd7` + this phase, uncommitted in worktree
`gym_os/.claude/worktrees/ai-communication`). Assessed 2026-11-10. Design and operating guide:
[`docs/FOLLOWUPS.md`](FOLLOWUPS.md).

## Final status

> **B. READY AFTER EXTERNAL VERIFICATION.**
>
> The code is safe to deploy now **in `off`/`test` mode** (no keys → nothing is sent in
> production). It is **not** cleared to go **live** until the external items in
> [Remaining blockers](#remaining-blockers) are done: live Exotel/ElevenLabs/WhatsApp payload
> checks on a real account, a legal review of the consent model under TRAI/DLT and Meta policy,
> the existing dependency patches merged, and the production migration run as planned below.
> Nothing here has been verified against a real provider account.

## Executive summary

Sambhav's implementation was sound in structure (provider-neutral adapters, a pure scheduler,
consent evaluated at plan and send, an append-only ledger) and its 21 tests passed. Inspection
against real PostgreSQL, real concurrency and the providers' published documentation found
defects that tests on SQLite could not show. The ones that would have cost money or broken
compliance in production are fixed and covered by tests:

| # | Severity | Defect (as found) | Status |
|---|---|---|---|
| 1 | **P0** | A duplicated or retried provider callback settled the same call many times: on a warm Postgres pool 25 deliveries of one result wrote **25 releases + 25 usage charges** and drained the gym's balance (reproduced, see Testing). | Fixed: row lock + unique `(job_id, reason)` index; test fails on the old code, passes now |
| 2 | **P0** | `npm run db:init` (on `main` too) **deadlocked** on any database with workout data and died partway — before `rls.sql`, so tables created in that run had **no tenant policies**. Root cause: an un-awaited backfill. | Fixed here and on `fix/dashboard-pulse-postgres`; rehearsal passes |
| 3 | **P1** | A payment that landed after the order was marked CANCELLED (UPI finishing after the checkout closed) or FAILED (retry after a failed attempt) was **taken but never credited**. | Fixed: a verified payment always activates, exactly once |
| 4 | **P1** | An answered Exotel call whose callback had no duration (Exotel does not promise one for flow calls) was billed **0 minutes**. | Fixed: hold kept, settled from Exotel's Call Details API; 1-minute minimum after an hour, labelled |
| 5 | **P1** | Queued jobs were placed after calling hours / after the gym switched off / to a member paused since planning (dispatch places 25 per tick, so queues outlive the window). | Fixed: full revalidation at send time |
| 6 | **P1** | A visit, renewal or payment after planning did not stop a queued contact. | Fixed: the step is re-evaluated at send time |
| 7 | **P1** | `undelivered` SMS/WhatsApp reports were read as **delivered** (regex order), so failed messages were never refunded. | Fixed |
| 8 | **P1** | The static WhatsApp webhook key and job/audio tokens were written to the access log in URLs. | Fixed: query credentials masked |
| 9 | **P1** | All webhooks shared one global rate-limit bucket: junk traffic could block the providers' billing callbacks. | Fixed: per sender IP |
| 10 | **P1** | Free trial could be granted twice by concurrent first visits. | Fixed: fixed-id marker row |
| 11 | P2 | Owner-side configuration changes were not audited. | Fixed: `followup_audit`, shown in the admin console |
| 12 | P2 | No operational visibility (queue, stuck calls, scheduler heartbeat, ledger consistency). | Fixed: admin Operations tab with alerts |
| 13 | P2 | Scheduler tick was unfair (first gyms could use the whole budget) and its budget exceeded typical function limits. | Fixed: longest-waiting first, per-gym share, configurable |
| 14 | P2 | Full-table scans on hot paths (WhatsApp reply lookup, per-gym history) that grow with every gym. | Fixed: two indexes (measured 5.7 ms → 0.02 ms) |
| 15 | P2 | Admin console had no AI Communication UI; price book could not be set (go-live step). | Fixed (previous turn) |

Separately, two `main` bugs that 500 on Postgres were fixed on their own branch (not merged):
`/api/dashboard/pulse` (owner Home) and the coupon detail analytics — see
[Separate branch](#separate-branch-fixdashboard-pulse-postgres).

## Architecture findings

### Lifecycle

Owner configuration (`routes/followups.js`) → scheduler tick (`/cron/tick` → `engine.runAll` →
`tickOrg`) → **sweep** (reconcile) → **plan** (`schedule.dueStep` + `consent.evaluate` + caps +
budget → `followup_jobs` queued, `dedupe_key` unique) → **dispatch** (claim → send-time revalidation
→ `wallet.holdUnits`/`chargeMessage` → provider adapter) → **webhooks** (`followupPublicRoutes` →
adapter parsers → `engine.apply*`) → **settlement** (`wallet.settleJob`/`refundJob`) → **ledger** →
**admin monitoring** (`routes/consoleFollowups.js` `/health`, `/gyms`).

### Module map

| Module | Responsibility | Depends on | Tables | External | Failure handling |
|---|---|---|---|---|---|
| `schedule.js` | Which step is due for one member (pure) | — | — | — | Pure; unit-tested |
| `consent.js` | ALLOW/DENY/DEFER per member+channel; consent log | — | member_prefs, consent_log, jobs | — | Member stop outranks owner; opt-out cancels queued |
| `engine.js` | plan, dispatch, sweep, apply outcomes | config, providers, schedule, consent, wallet, numbers, audio, studio | jobs, rules, settings, callbacks, … | via adapters | Every gate re-checked at send; failures release holds; reconciliation via provider record |
| `wallet.js` | price book, balances, ledger | — | balances, ledger, price_versions, line_terms | — | Conditional UPDATEs, job row lock, unique index, CHECK ≥ 0 |
| `orders.js` | pack purchases | wallet, providers, payments | orders | Razorpay (existing flow) | Exactly-once activation; amount/currency checked |
| `numbers.js` | member ↔ caller line | wallet | numbers, member_prefs | — | Retired/flagged lines re-matched |
| `audio.js`, `studio.js`, `render.js`, `languages.js` | scripts, agents, rendering, TTS cache | render, languages | scripts, agents, audio | speech adapters | Missing detail → never spoken blank |
| `providers/*` | Exotel, ElevenLabs, Sarvam, HTTP, mock | config | — | Exotel, ElevenLabs, Sarvam, own servers | 20–60 s timeouts; errors classified; parsers never throw on junk |
| `audit.js` (new) | owner audit trail | access/audit redactor | followup_audit | — | Same transaction as the change |
| `routes/followups.js` | owner/member/trainer API, webhooks, cron | all above | all | — | Role + org scoping; signed callbacks |
| `routes/consoleFollowups.js` | founder API (SUPER_ADMIN) | wallet, providers, audit | all | — | Audited in `admin_audit_logs` |

18 modules, **no import cycles** (checked). No duplicated business logic of concern: the admin
price-book screen re-implements the pack economics *only as a live preview*; the server recomputes
and was verified to agree on all 15 packs. The engine (≈830 lines) is the largest unit; it is
cohesive but would benefit from splitting dispatch/settlement into their own files (P3).

## Security findings

| Area | Finding | Status |
|---|---|---|
| Tenant isolation (API) | Owner A cannot read/modify B's members, prefs, consent, numbers, callbacks, campaigns, orders or usage through direct calls with B's ids | **Verified** (test `security: gym A cannot…`) |
| Tenant isolation (DB) | Forced RLS on all 20 org tables; under an org-scoped transaction a NOBYPASSRLS role sees and can write only its own gym's rows | **Verified on Postgres** (test `RLS: …`) |
| Admin boundary | Owners, trainers, members get 403 on every console endpoint; no session → 401 | **Verified** |
| Webhook auth | Exotel: signed job token (Exotel does not sign callbacks — documented); WhatsApp: signed key; ElevenLabs: documented HMAC with 30-min window, rotation-safe; own agent: HMAC | **Verified** (contract tests) |
| Replay | ElevenLabs: timestamp window; all: idempotent state machine + unique ledger index | **Verified** |
| Malformed payloads | Parsers return empty/null, never throw; signed-but-unreadable → 400 | **Verified** |
| Rate limiting | Webhooks per sender IP (1,200/min); owner API 240/min/user; provider-cost actions 20/min/gym; console 60/min | Implemented (per-IP relies on Vercel setting `X-Forwarded-For`) |
| Secrets | None in tracked files or browser bundles (only env var *names* in admin help text); API returns booleans only; signed URLs masked in logs | **Verified** |
| Error exposure | Webhook and route errors return generic messages; provider error bodies trimmed to 200 chars | Reviewed |
| Session/JWT/brute force | Existing platform mechanisms (session revocation, login rate limits) — unchanged by this feature | Not re-audited here |
| Dependencies (backend prod) | 1 critical (`proxy-addr` ≤2.0.7), 2 high (`body-parser` ≤2.3.0, `zod` <4.6.6) — pre-existing on `main` | `proxy-addr` 2.0.8 and `body-parser` 2.4.0 already on unmerged `eng/production-overhaul` → **P1: merge it**. `zod` needs a major upgrade → **P2** (mitigated by the 1 MB body limit). Frontend/admin: 0 |

## Billing findings

- **Exactly-once:** hold/release/usage/refund ≤ 1 per job, enforced by `ux_followup_ledger_job_reason`
  under a `SELECT … FOR UPDATE` on the job. A duplicate collision rolls the transaction back and
  is reported as "already done". Verified with 25 concurrent deliveries on a warm Postgres pool.
- **No negative balances:** conditional `UPDATE … WHERE balance >= n` plus `CHECK (balance >= 0)`
  and `CHECK (value >= 0)`. 40 messages racing for 10 units: exactly 10 sent.
- **Ledger = balance:** a mixed workload, 15 calls settling against a short balance, and every
  concurrency test assert `balance == SUM(delta)`; the admin `/health` reconciles every gym live.
- **Settlement never records more than it took:** the take is re-read and retried. (On Postgres the
  release step's row lock already serialises same-balance settlements; this is defence in depth,
  not a reachable bug — measured.)
- **Purchases:** verified payments always credit once; wrong amount/currency is refused; orders keep
  the price-book version and the value actually paid (test across a version change).
- **Pricing:** 400 random price books + every default pack: `net + tax = total` (±₹0.01), inclusive
  totals equal the price, `healthy ⇔ net ≥ cost × (1 + margin)`; depleting a balance in random chunks
  never takes more value than was paid. **No commercial price was changed.**
- **Revenue recognition** (unchanged): usage recognises value at the average paid per unit; free
  units (trial, goodwill) carry no value, so cash = recognised + deferred + refunded.
- **Refunded message cost:** a refund reverses the gym's charge but the platform's cost estimate is
  kept (provider may still bill). Confirm Exotel/Meta billing of failed deliveries (external, P3).

## Queue reliability findings

Durable queue = `followup_jobs` rows (no in-memory state). Locking = the `queued → dialing` claim
(`UPDATE … WHERE status = 'queued'`); lease = `dialed_at` + 30-minute sweep; dead-letter = `failed`
/`skipped` with a reason, visible in the admin Operations tab. Retries are the campaign's attempts per
day, spaced by its gap (no blind retry). Verified:

- overlapping ticks plan each contact once and place each job once (Postgres, 5 + 4 concurrent ticks);
- a job claimed but never placed is released by the sweep, nothing charged;
- a queue left by a restart is placed once by the next tick; anything older than 6 h is skipped;
- retries stop at attempts/day and respect the gap; a provider timeout releases the hold;
- calling hours 09:00–21:00 hard limits, owner window clamped, days off, and DST in another timezone
  (America/New_York spring-forward and fall-back) — India has no DST;
- a visit / renewal / payment after planning stops the contact before it is placed.

Throughput limit (by design, configurable): 25 contacts per gym per 5-minute tick (~300/hour). A
2,000-member gym's busiest day (539 due) clears in ~2 h; an 8,000-member gym (2,099 due) needs
~7 h and would lose the tail to the 6-hour cutoff → raise `FOLLOWUP_DISPATCH_PER_TICK` for such gyms
**after** confirming Exotel's concurrent-call limit per ExoPhone (P1, external).

## Provider integration findings

| Provider | Verified from official docs | Implemented | Still needs a live account |
|---|---|---|---|
| Exotel calls | Status values (`completed/failed/busy/no-answer`), `CallSid`, `ConversationDuration`/`Legs` only with `StatusCallbackEvents`, callbacks unsigned, delivery may be late/missing → use Call Details | Flow call, status + keypad parsing, Call Details fallback (`?details=true`), missing duration = unknown | Whether flow-connect callbacks include duration/CustomField; `digits` format; concurrent-call limit per ExoPhone; Call Details timing |
| Exotel SMS | — (field names not pinned by public docs) | DLT fields, segment counting, status parsing (failure-first) | Status names, DLT template matching |
| Exotel WhatsApp | — | Template send, events parsed in the adapter (`parseWhatsAppEvents`) | Delivery/inbound payload shapes, whether `to` is present |
| ElevenLabs | Post-call payload (`post_call_transcription`, `call_initiation_failure` reasons busy/no-answer/unknown, `post_call_audio`), 200 required, retries, signature header name | Signature `t=,v0=` HMAC of `"t.body"` with 30-min window (matches SDK behaviour reported by multiple sources; the official page defers to the SDK) | Signature verification against a real signed delivery; agent/voice config on the account |
| Own models (HTTP) | Our own contract (`providers/http.js`) | HMAC-signed results; unknown status → failed | Your servers |

Contract tests cover every adapter with documented/recorded payload shapes and stubbed HTTP
(request URL, form fields, auth header, timeouts, error mapping). **They do not prove compatibility
with a live account.**

## Compliance findings

| Requirement | State |
|---|---|
| Consent recorded per member and channel, with timestamp, source, evidence, policy version, actor | **Implemented** |
| Member-only undo of a stop; owner cannot re-grant over a member stop | **Implemented** (tested) |
| STOP (WhatsApp words, button, Hindi), keypad 9, app switch; suppression across all gym numbers | **Implemented** (tested) |
| Disclosure ("automated call from <gym>", "press 9") in every call | **Implemented** (rendered into every script) |
| Calling hours 09:00–21:00 and days; caps per day/week; human-only; pauses | **Implemented** (tested incl. send-time) |
| Audit trail of owner/founder changes | **Implemented** |
| Distinguish **transactional / service / promotional** per campaign | **Missing** — campaigns are not classified; "stopped coming" re-engagement is plausibly *promotional*, payment/renewal reminders plausibly *service*. **Requires legal review** |
| Number series per call type (140 promotional / 160 service-transactional) and DLT registration of voice/SMS headers and templates | **Requires external provider verification + legal review** |
| DND / preference-registry scrubbing for promotional content | **Missing in app** (operator/DLT may scrub SMS; voice unclear) — **requires legal review** |
| WhatsApp opt-in per Meta policy; template categories (utility vs marketing) | **Partially implemented** (opt-in recorded; category set at template creation) — **requires external verification** |
| Retention / deletion of contact data (`followup_jobs` numbers and message text, cached audio with names) | **Missing** — no retention window; consent log is deleted with the member (`ON DELETE CASCADE`), which may conflict with proving past consent. **Requires legal review (DPDP Act)** |
| Gym's subscription ≠ consent to promotional contact | **Respected**: nothing is sent without explicit per-channel permission |

**No claim of legal compliance is made.**

## Performance findings

Measured on PostgreSQL 17 (local), one gym at increasing sizes with 120 days of history:

| Members | History jobs | Plan (3 campaigns) | Dispatch pass (25) | Second full tick | 50 WhatsApp reply lookups |
|---|---|---|---|---|---|
| 500 | 2,400 | 96–100 ms | 155–160 ms | 155–167 ms | 46 → **20 ms** |
| 2,000 | 9,600 | 299–364 ms | 130–167 ms | 194–245 ms | 130 → **21 ms** |
| 8,000 | 36,000 | 1.5–1.8 s | 115–143 ms | 0.7–1.0 s | 542 → **29 ms** |

Bottlenecks identified (not assumed): (1) WhatsApp reply lookup and per-gym history were full-table
scans that grow with *every* gym → indexes added, now index/bitmap scans in the multi-tenant case;
(2) the tick's per-gym budget and fairness → fixed; (3) with real providers each placed call costs a
TTS render + an Exotel request (≈1–2 s), so a tick serves ~10–25 contacts per gym within 15–50 s —
size `FOLLOWUP_TICK_BUDGET_MS` to the function limit; (4) admin `/gyms` is N+1 (290 ms for 203 gyms)
and `/health` scans the ledger (63–69 ms at ~48k rows) — fine now, P3 at much larger scale.

## Database migration findings

- **Additive only:** 22 new tables, 23 new indexes, policy list extended; no existing table altered.
- **Idempotent:** a second `db:init` changes nothing (verified, snapshot-identical).
- **Data preserved:** no pre-existing table's rows changed by this feature. (`exercise_set_logs`
  gains synthesized rows from `main`'s own backfill on a database that never had it; production
  already ran it.)
- **Blocker found and fixed:** `db:init` deadlocked on data (finding #2). With the fix, one run on a
  `main`-built, seeded Postgres 17 database completes, applies forced RLS + policies to all 20 org
  tables, and the deploy gate (`db:check`) reports OK for 158 tables.
- **Runtime privileges:** the app never runs DDL at runtime; migrations use `PG_ADMIN_URL`. Whether
  the runtime role (`skos_app`) can use the new tables depends on production's default privileges —
  `db:check` (run as the runtime role in the build) fails the deploy if it cannot see them.
- Not executed against production (by instruction).

### Production migration plan

1. **Backup:** create a Neon branch (instant copy-on-write) of `production` named
   `pre-ai-communication-<date>`; note its timeline id.
2. **Inspect:**
   ```sql
   SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'followup_%';  -- expect 0 (or 22 if run before)
   SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;
   ```
   If tables already exist (e.g. from a preview), note that `CHECK`s added to `CREATE TABLE` will not
   apply to them — run the verification queries below and add the constraints by hand if missing.
3. **Execute** from the branch being deployed (it must include the backfill fix):
   `DATABASE_URL=<owner url> PG_ADMIN_URL=<owner url> npm run db:init` — expect
   "RLS policies applied" and "Schema applied". If it fails, fix and re-run (idempotent).
4. **Verify:**
   ```sql
   SELECT count(*) FROM pg_tables WHERE tablename LIKE 'followup_%';                              -- 22
   SELECT count(*) FROM pg_class WHERE relname LIKE 'followup_%' AND relkind='r'
          AND relrowsecurity AND relforcerowsecurity;                                               -- 20
   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'followup_%' AND policyname='tenant_isolation'; -- 20
   SELECT indexname FROM pg_indexes WHERE indexname = 'ux_followup_ledger_job_reason';             -- 1 row
   SELECT conname FROM pg_constraint WHERE conrelid='followup_balances'::regclass AND contype='c';  -- 2 rows
   SELECT tablename, has_table_privilege('skos_app', 'public.'||tablename, 'SELECT,INSERT,UPDATE,DELETE')
     FROM pg_tables WHERE tablename LIKE 'followup_%';                                              -- all true
   ```
   If the last query shows `false`: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO skos_app;`
5. **Application check:** `DATABASE_URL=<runtime url> npm run db:check` → OK; deploy; open the admin
   console → AI Communication → Setup shows mode `off` (no keys) and Operations shows no alerts.
6. **Rollback:** redeploy the previous build — old code never reads the new tables. Leave the tables
   in place. Drop them **only** if `followup_orders` and `followup_ledger` are empty (they are
   financial records); otherwise restore from the Neon branch only with finance sign-off.

## Testing results

All counts are from runs in this session; "Postgres" = a real PostgreSQL 17.5 server (not PGlite).

| Suite | Engine | Result |
|---|---|---|
| Full backend suite | SQLite | **2,097 tests: 2,086 pass, 0 fail**, 11 skipped (8 Postgres-only) |
| `followups.test.js` (Sambhav's, unchanged assertions) | SQLite / Postgres | 21/21 / 21/21 |
| `followupsHardening.test.js` (new, 28 tests: security, money, queue, contracts, compliance, audit, ops) | SQLite / Postgres | 28/28 / 28/28 |
| `followupsPg.test.js` (new: 7 concurrency + RLS) | Postgres | **8/8** |
| — mutation check: same suite against the original settlement code | Postgres | **fails** (double settle, double refund) — the tests catch the bug |
| `communityPg`, `financialRls` (existing RLS suites, fresh UTF-8 DB as CI) | Postgres | 11/11, 11/11 |
| Frontend unit tests | jsdom | 199/199 |
| Frontend build, admin build | — | pass |
| Migration rehearsal (main-built seeded DB → this branch, twice) | Postgres | pass; idempotent; `db:check` OK |
| Load probe (500 / 2,000 / 8,000 members) | Postgres | see Performance |
| Browser: admin AI Communication (Gyms, Operations, Price book, Setup, gym page), owner tab, platform-pause banner | Postgres | pass (previous turn + Operations this turn) |
| Live provider accounts | — | **not run** (no credentials, by instruction) |

CI now runs the three follow-up suites against its postgres:16 service.

## Verification matrix

| Verified locally (SQLite) | Verified against PostgreSQL | Verified with provider mocks | Verified against provider accounts | Not verified | Requires human approval |
|---|---|---|---|---|---|
| All suites, builds, UI | Suite, concurrency, RLS, migration, load, admin UI | Adapters (documented shapes, stubbed HTTP), engine flows | **Nothing** | Live payloads, signatures, Call Details timing, ExoPhone concurrency, DLT/templates, Neon default privileges | Production migration, legal/compliance sign-off, merging branches, setting provider keys, pushing |

## Remaining blockers

| Severity | Item | Owner |
|---|---|---|
| P1 | Live-account verification: Exotel flow-call callback fields (duration, CustomField), `digits` format, SMS/WhatsApp status and inbound shapes incl. `to`; ElevenLabs signed delivery; Call Details availability | Engineering + provider accounts |
| P1 | Concurrent-call limit per ExoPhone vs 25 calls/tick per gym | Exotel |
| P1 | Legal review: campaign classification (promotional/service/transactional), number series, DLT/DND scrubbing, WhatsApp categories, retention/deletion (DPDP) | Counsel |
| P1 | Merge `eng/production-overhaul` dependency patches (`proxy-addr`, `body-parser`) — platform-wide | Engineering |
| P1 | Production migration per the plan above, with the backfill fix included | Operator |
| P1 | Scheduler configured (`/cron/tick` every 5 min) and function `maxDuration` ≥ `FOLLOWUP_TICK_BUDGET_MS` | Operator |
| P2 | Data retention policy for `followup_jobs` / `followup_audio`; consent evidence surviving member deletion | Engineering after legal |
| P2 | `zod` major upgrade (DoS on oversized collections; mitigated by 1 MB body limit) | Engineering |
| P2 | ElevenLabs conversation reconciliation via its API for missed post-call webhooks (today: failed after 30 min, nothing charged) | Engineering |
| P3 | Split `engine.js`; batch admin `/gyms`; health ledger scan at very large scale | Engineering |
| P3 | Refunded-message provider cost (does Exotel/Meta bill failed deliveries?) | Finance |

## Deployment instructions

1. Merge `fix/dashboard-pulse-postgres` to `main` (or include its `init-db.js` change — this branch
   already carries the identical fix) and merge `eng/production-overhaul`'s dependency patches.
2. Run the production migration (plan above) **before** pushing the branch that needs it.
3. Deploy with **no provider keys** → mode `off`: owners can set up, nothing is sent.
4. Founder: admin console → AI Communication → Price book: enter real invoice costs, save a version.
5. Configure the scheduler and `FOLLOWUP_TICK_BUDGET_MS` below the function limit.
6. After the live-account checks and legal sign-off: set the keys from `.env.example`, paste the
   webhook URLs from Setup into Exotel/ElevenLabs, assign caller numbers per gym, and enable one
   pilot gym. Watch Operations for 48 h before widening.

## Rollback instructions

- **Stop sending immediately:** admin console → Setup → *Pause all automated contact* (or one channel).
  Owners are told; nothing is lost.
- **Code:** redeploy the previous build; the new tables are ignored by old code.
- **Data:** never delete `followup_ledger` / `followup_orders` rows (financial records). Unused
  balances remain deferred revenue owed to gyms; refunds go through the normal payments process.
- **Migration:** see step 6 of the migration plan.

## Production go / no-go

**No-go for live sending today; go for deploying in `off` mode once the migration plan is followed.**
Status **B — READY AFTER EXTERNAL VERIFICATION.**

## Separate branch: `fix/dashboard-pulse-postgres`

Cut from `origin/main` (45d68a7), local only, **not pushed or merged**, no upstream:

- `c08a0cd` fix(postgres): owner pulse and coupon analytics no longer 500 on GROUP BY — the
  parameterised `CASE` repeated in `GROUP BY` (`gymPulse.js`, and the same pattern found in
  `couponAdmin.js`) now groups over a derived table. `test/groupByParamsPg.test.js` fails on
  Postgres before the change with the production errors, passes after; CI step added.
- `34245c8` fix(db:init): await the set-log backfill — the migration deadlock (#2 above).

Full backend suite on that branch: 2,037 pass, 0 fail.
