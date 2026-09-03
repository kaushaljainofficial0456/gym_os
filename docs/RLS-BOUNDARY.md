# Row-Level Security boundary — what it covers, what it doesn't, and how to close the gap

**Status:** documented, not fixed. Written during a security review on
2026-09-03 after confirming there is no safe, localized code change for
this — see "Why this isn't a quick fix" below before attempting one.

## The boundary, precisely

`database/rls.sql`'s policies all gate on the PostgreSQL session variable
`app.org_id`. That variable is set in exactly one place:
[`backend/src/db.js`](../backend/src/db.js)'s `client.tx()`, via
`SET LOCAL app.org_id = '...'` immediately after `BEGIN`.

`SET LOCAL` only has an effect inside an explicit transaction on a
connection you're holding onto — which is precisely what `db.tx()`
does (`pool.connect()` → `BEGIN` → `SET LOCAL` → your callback →
`COMMIT`/`ROLLBACK` → `release()`) and precisely what `db.q()`,
`db.q1()` and `db.run()` do **not** do: they call `pool.query(sql,
params)` directly, which is a single pooled round-trip with no
explicit `BEGIN` and no connection held long enough to scope a
session variable to it.

`db.q()`/`db.q1()`/`db.run()` are what the large majority of this
codebase's reads and single-row writes use — every route file, more or
less. `db.tx()` is reserved for genuinely multi-statement atomic writes
(a handful of call sites: registration, payment finalization, workout
completion, a few others). So today:

| Code path | `app.org_id` | RLS effect |
|---|---|---|
| `db.tx(fn, { orgId })` | set for the transaction | scopes rows to that org (+ global rows where the policy allows) |
| `db.q()` / `db.q1()` / `db.run()` | **never set** | policy's `IS NULL` branch passes — all rows visible |

This is confirmed empirically, not just read from the policy SQL: see
`backend/test/financialRls.test.js`'s `'unset app.org_id keeps
admin/reconciliation cross-org reads working (the path they use
today)'` and the equivalent test in `communityPg.test.js`. Both assert
this explicitly and are gated behind `TEST_DATABASE_URL` (self-skip
without it, same as every other real-Postgres test in this suite).

## What this means today

**Application-level authorization is the actual, primary boundary** —
`orgScope`, `resolveClient`, `getClient`, and every route's own `WHERE
org_id = ?` / `WHERE client_id = ?` clause. That code is what has been
reviewed and is what protects tenant isolation for the ordinary
request path. RLS adds a second, independent check only for the
minority of writes that go through `db.tx()` with an org context —
useful (it's real defense-in-depth for that subset, including against
a future miswritten query *inside* one of those transactions), but not
a backstop for the rest of the app.

This is a **known, load-bearing design choice**, not an oversight
freshly discovered — `community.js`, the admin console, and the
reconciliation sweep all depend on the "unset → all rows visible"
branch to do legitimate cross-org reads on a shared DB role, and the
test suite pins that behavior on purpose so a future policy change
can't silently break it. The gap is that `rls.sql`'s header comment
previously described RLS in terms that read as broader protection than
this — that comment has been corrected in the same change that added
this doc.

## Why this isn't a quick fix

The tempting "safe, localized" fix is: have `db.q()`/`db.q1()`/`db.run()`
set `app.org_id` too, e.g. `SELECT set_config('app.org_id', $1, false)`
before the real query. Two things make this not localized and not
obviously safe:

1. **Two separate `pool.query()` calls are not guaranteed the same
   connection.** `pool.query()` checks out *any* idle connection from
   the pool per call. Issuing a `SET`/`set_config()` call and then the
   real query as two separate `pool.query()` calls doesn't reliably
   apply the setting to the query at all — you'd need to explicitly
   check out one connection (`pool.connect()`) and run both statements
   on it, exactly like `db.tx()` already does.

2. **A plain (non-`LOCAL`) `SET` persists on the connection past that
   one query.** If the connection is released back to the pool with
   `app.org_id` still set, the *next* unrelated request that happens to
   reuse that same pooled connection inherits a stale org scope — a
   cross-tenant leak in the opposite direction from today's gap, and
   arguably worse (today's gap is "no extra check"; that failure mode
   is "the wrong check, silently"). Avoiding it means either wrapping
   every single query in its own implicit transaction (`BEGIN; SET
   LOCAL; <query>; COMMIT;`) or explicitly resetting the setting before
   every `release()`, including on every error path.

Either approach changes `db.q()`/`db.q1()`/`db.run()` from "one pooled
round-trip" to "checkout a connection, 2+ round-trips, reset, release"
— for every single query in the application. That's a change to this
adapter's entire connection-handling model and hot path, with a real
performance cost (this codebase already tracks connection-pool
starvation as its own concern — see `db.js`'s comments on `PG_POOL_METRICS`
and `scripts/loadtest.mjs`) and a real correctness risk if the
reset-on-release step is ever missed. That is not a change to make
speculatively inside an unrelated fix pass.

## Concrete remediation plan (for a dedicated change)

1. **Prototype behind `PG_POOL_METRICS`-style opt-in first.** Add an
   explicit-checkout path to `runQuery()` that mirrors the existing
   metrics branch (which already does `pool.connect()` → `query()` →
   `release()`) but wraps in `BEGIN; SELECT set_config('app.org_id',
   $1, true); <query>; COMMIT;` when `currentOrg()` (the existing ALS
   value `requireAuth` already populates on every request) is non-null.
   `SET LOCAL`'s automatic reset at `COMMIT`/`ROLLBACK` — already relied
   on by `db.tx()` — removes the "forgot to reset" failure mode instead
   of requiring a manual reset before release.
2. **Load-test it.** Compare `scripts/loadtest.mjs` results with and
   without the extra round-trip; this is the numbers-first way to
   decide whether the perf cost is acceptable given the connection-pool
   starvation work already tracked elsewhere in this codebase's recent
   history.
3. **Tighten the policies' `IS NULL` escape once the app-side change is
   live and load-tested**, so an unset `app.org_id` on a request that
   should have had one is a hard failure (no rows) rather than "all
   rows." Do this only after step 2, and only for tables where the
   "unset → visible" branch isn't independently required (community.js,
   the admin console and reconciliation's cross-org reads need a
   different mechanism first — e.g. an explicit `app.role = 'platform'`
   session flag set deliberately by those call sites, rather than
   relying on org_id simply being absent).
4. **Extend `financialRls.test.js` / `communityPg.test.js`-style
   integration tests** to cover the new checkout-and-reset path
   directly: assert a connection's `app.org_id` really is cleared after
   release (e.g. by re-acquiring it and checking `current_setting`
   before the next test's transaction sets it again), not just that
   the policy behaves correctly within one transaction.

Until this is done, treat RLS as PostgreSQL-native defense-in-depth for
the `db.tx()` write path only, and keep application-level org/client
scoping as the control that actually matters for review and for new
routes.
