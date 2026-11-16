// Dual-mode database adapter.
//   * Dev (no DATABASE_URL): Node 22 built-in `node:sqlite` — zero native deps.
//   * Production (DATABASE_URL set): PostgreSQL via `pg`.
// Both expose the same async surface: q(sql, params) => rows, q1(...) => row|null, run(...).
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// TENANT CONTEXT (PostgreSQL row-level security)
//
// Every PostgreSQL statement this adapter runs carries an explicit,
// TRANSACTION-LOCAL context, and database/rls.sql fails CLOSED when a
// statement carries none:
//
//   tenant    app.org_id = <org>      requireAuth, for a user who has an org.
//                                     The org comes from the server-signed
//                                     JWT, never from a request body.
//   platform  app.platform = 'on'     work that legitimately spans gyms and
//                                     is authorised in application code:
//                                     unauthenticated routes (login, signed
//                                     webhooks, the scheduler tick), the
//                                     SUPER_ADMIN console, and the named
//                                     cross-gym features (runAsPlatform).
//   none      neither is set          anything outside a request that did
//                                     not ask for a context. RLS returns no
//                                     tenant rows and refuses tenant writes.
//
// How a statement gets its context (see scoped() below): check out ONE
// pooled connection, BEGIN, set_config(..., true) for both settings, run
// the statement(s) on that same connection, COMMIT (ROLLBACK on error),
// release. set_config's third argument makes the values LOCAL to the
// transaction, so PostgreSQL itself discards them at COMMIT/ROLLBACK -- a
// connection goes back to the pool with no tenant on it, on every path,
// without a "reset before release" step that could be forgotten. A
// connection whose COMMIT/ROLLBACK failed is destroyed, never reused.
//
// The context lives in AsyncLocalStorage, which follows a request's own
// async chain and nothing else, so two concurrent requests for different
// gyms can never see each other's value. docs/security/RLS_SECURITY_AUDIT.md
// has the full model and the evidence.
// ============================================================
export const als = new AsyncLocalStorage();

/** Run fn as `orgId`'s tenant. A falsy orgId (SUPER_ADMIN, or a user who has
 *  no org yet) is an explicit platform context -- application code is the
 *  control there, exactly as it always has been for those users. */
export const runWithOrg = (orgId, fn) => als.run(
  orgId ? { kind: 'tenant', orgId: String(orgId) } : { kind: 'platform', reason: 'authenticated-without-org', orgId: null },
  fn);

/** Run fn with cross-tenant (platform) visibility. `reason` names the
 *  feature for logs and review; every call site is one deliberate, grep-able
 *  decision that application code -- not RLS -- authorises what it touches. */
export const runAsPlatform = (reason, fn) => als.run({ kind: 'platform', reason: String(reason || 'unspecified'), orgId: null }, fn);

/** Express middleware form of runAsPlatform. Placed AFTER requireAuth it
 *  widens one route; placed before it, requireAuth narrows back to tenant. */
export const platformScope = (reason) => (_req, _res, next) => runAsPlatform(reason, () => next());

/** The tenant org of the current context, or null (platform / none). */
export const currentOrg = () => {
  const s = als.getStore();
  return s && s.kind === 'tenant' ? s.orgId : null;
};
/** 'tenant' | 'platform' | 'none' -- for tests and diagnostics. */
export const currentScope = () => als.getStore()?.kind || 'none';

// Org ids are app-generated tokens (ids.js: prefix_ + 10 alphanumerics).
// Anything else reaching the database layer as a tenant is refused rather
// than passed on: fail closed, loudly.
const ORG_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export function assertOrgId(orgId) {
  if (typeof orgId !== 'string' || !ORG_ID_RE.test(orgId)) {
    const err = new Error('invalid tenant context');
    err.code = 'invalid_tenant_context';
    throw err;
  }
  return orgId;
}

/**
 * The context a statement should run under, as the two settings to apply.
 *   txOrgId  db.tx()'s explicit { orgId } -- narrows a platform context to
 *            one tenant (the AI Communication wallet does this per gym). It
 *            may never point a TENANT context at a different gym.
 *   mode     'enforce' (default) or 'off' -- see RLS_TENANT_SCOPE in
 *            createPgDb. 'off' runs a tenant's plain statements as platform
 *            (the pre-hardening behaviour) while db.tx() stays tenant-scoped.
 */
export function resolveContext({ txOrgId = null, inTx = false, mode = 'enforce' } = {}) {
  const s = als.getStore();
  if (txOrgId) {
    const want = assertOrgId(String(txOrgId));
    if (s?.kind === 'tenant' && s.orgId !== want) {
      const err = new Error('tenant context mismatch: a request for one gym asked for a transaction in another');
      err.code = 'tenant_context_mismatch';
      throw err;
    }
    return { org: want, platform: false };
  }
  if (!s) return { org: null, platform: false };
  if (s.kind === 'tenant') {
    if (mode === 'off' && !inTx) return { org: null, platform: true };
    return { org: assertOrgId(s.orgId), platform: false };
  }
  return { org: null, platform: true };
}

async function createSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = path.resolve(__dirname, '..', '..', config.sqlitePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return {
    driver: 'sqlite',
    async q(sql, params = []) {
      const stmt = db.prepare(sql);
      const rows = params.length ? stmt.all(...params) : stmt.all();
      return rows;
    },
    async q1(sql, params = []) {
      const rows = await this.q(sql, params);
      return rows[0] || null;
    },
    async    run(sql, params = []) {
      const stmt = db.prepare(sql);
      const res = params.length ? stmt.run(...params) : stmt.run();
      return { changes: Number(res.changes), lastId: res.lastInsertRowid };
    },
    exec(sql) { db.exec(sql); },
    // SQLite has no connection pool -- always "not waiting". Present so
    // callers (a debug endpoint, the load-test harness) can call
    // db.poolStats() unconditionally regardless of driver.
    poolStats() { return { total: 1, idle: 1, waiting: 0 }; },
    // Atomic transaction: BEGIN → fn(txDb) → COMMIT, ROLLBACK on error.
    async tx(fn, opts = {}) {
      db.exec('BEGIN');
      try {
        const txDb = {
          driver: 'sqlite',
          async q(sql, params = []) {
            const stmt = db.prepare(sql);
            const rows = params.length ? stmt.all(...params) : stmt.all();
            return rows;
          },
          async q1(sql, params = []) { const rows = await txDb.q(sql, params); return rows[0] || null; },
          async run(sql, params = []) {
            const stmt = db.prepare(sql);
            const res = params.length ? stmt.run(...params) : stmt.run();
            return { changes: Number(res.changes), lastId: res.lastInsertRowid };
          },
          exec(sql) { db.exec(sql); },
          raw: db
        };
        const out = await fn(txDb);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    },
    raw: db
  };
}

// PostgreSQL uses $1..$n positional parameters, SQLite uses ?.
// Application code always writes `?` placeholders; translate them here so the
// same business logic runs on both engines.
export function translateSql(sql) {
  if (!sql.includes('?')) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * BEGIN plus both transaction-local settings, in ONE round trip.
 *
 * The simple-query protocol is the only way to send BEGIN and the settings
 * together, and it cannot bind parameters, so the org id is inlined -- but
 * only after assertOrgId() has limited it to [A-Za-z0-9_.:-] (no quote,
 * backslash or whitespace can get through that) and through escapeLiteral
 * regardless. The platform flag is a constant. Both settings are ALWAYS
 * written, so a statement can never inherit a value from anything that ran
 * on this connection before it.
 */
export function scopePreamble(conn, ctx) {
  const org = ctx.org ? conn.escapeLiteral(assertOrgId(ctx.org)) : "''";
  const platform = ctx.platform ? "'on'" : "''";
  return `BEGIN; SELECT set_config('app.org_id', ${org}, true), set_config('app.platform', ${platform}, true)`;
}

/** A PostgreSQL adapter around one pool. Exported for the RLS integration
 *  tests, which need a pool of size one on a role without BYPASSRLS. */
export async function createPgDb({ connectionString, max, options, mode } = {}) {
  const pg = await import('pg');
  const scopeMode = String(mode ?? process.env.RLS_TENANT_SCOPE ?? 'enforce').toLowerCase() === 'off' ? 'off' : 'enforce';
  if (scopeMode === 'off') {
    // Emergency rollback switch only (docs/security/RLS_DEPLOYMENT_RUNBOOK.md):
    // a tenant's plain statements run as platform again, as before the
    // hardening. db.tx() stays tenant-scoped and missing context still fails
    // closed. Said at every boot so it is never left on by accident.
    console.error('[sk-os] SECURITY: RLS_TENANT_SCOPE=off -- per-statement tenant isolation is DISABLED; application checks are the only cross-gym control. Remove the variable to restore it.');
  }
  // node-postgres's Pool defaults are tuned for a long-lived server process,
  // not a serverless function:
  //   - connectionTimeoutMillis defaults to 0 = NO TIMEOUT. If every pooled
  //     connection is busy (or Neon has hit its own connection cap because
  //     many concurrent Vercel function instances each opened their own
  //     Pool), a query silently queues forever instead of failing fast --
  //     from the user's side that's exactly "the page never stops loading."
  //     This cannot be reproduced by local/manual testing (SQLite has no
  //     connection limit, and a solo session never saturates 10 connections)
  //     which is why it wouldn't show up outside real concurrent production
  //     traffic. Bounding it means a saturated pool fails in ~8s with a
  //     clear 5xx instead of hanging indefinitely.
  //   - max defaults to 10 *per Pool instance*. Each concurrent warm
  //     serverless instance creates its own Pool (see getDb()'s
  //     module-level `instance` -- fresh per cold start), so under load
  //     many instances x 10 connections each can exhaust Neon's connection
  //     limit. A lower per-instance max leaves headroom across instances
  //     while still allowing real concurrency within one.
  //   - idleTimeoutMillis closes unused connections instead of holding them
  //     open indefinitely, so a warm instance that goes quiet releases its
  //     connections back to Neon's shared limit for other instances to use.
  const pool = new pg.Pool({
    connectionString,
    max: Number(max ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    ...(options ? { options } : {}),
  });
  // Without this handler, an error on an IDLE pooled connection (e.g. Neon
  // dropping it server-side) is an uncaught 'error' event -- which crashes
  // the whole Node process. pg's own docs call this out explicitly. The
  // pool recovers the connection on its own; this just keeps the process up.
  pool.on('error', (err) => {
    console.error('[sk-os] Postgres pool error on idle client:', err.message);
  });

  // Opt-in diagnostic mode (PG_POOL_METRICS=1, staging/local only). Answers
  // one question empirically instead of by inference: is request latency
  // spent WAITING FOR A POOLED CONNECTION (pool starvation) or RUNNING THE
  // STATEMENT (slow SQL / network)? Logs one line per statement over
  // POOL_METRICS_LOG_MS (default 20ms combined) with both numbers broken
  // out, plus live pool.totalCount/idleCount/waitingCount so a saturated
  // pool (waitingCount > 0) is directly observable.
  const metricsOn = process.env.PG_POOL_METRICS === '1';
  const logThresholdMs = Number(process.env.PG_POOL_METRICS_LOG_MS || 20);

  // A statement that reaches the database with no context at all is either
  // non-request code that forgot runAsPlatform, or a bug. RLS already
  // answers it with no tenant rows; this says so in the log, once per
  // statement shape, so staging validation can find every one of them.
  const unscopedSeen = new Set();
  function noteUnscoped(sql) {
    if (unscopedSeen.size >= 100) return;
    const key = String(sql).replace(/\s+/g, ' ').trim().slice(0, 90);
    if (unscopedSeen.has(key)) return;
    unscopedSeen.add(key);
    console.warn(`[rls] statement ran with no tenant or platform context (row-level security gives it no tenant rows): ${key}`);
  }

  /**
   * The ONE way this adapter talks to PostgreSQL with a context: one
   * checked-out connection, BEGIN + transaction-local settings, fn, COMMIT
   * (ROLLBACK on any error), release. A connection whose ROLLBACK itself
   * failed is in an unknown state and is destroyed (release(err)) instead
   * of going back into the pool.
   */
  async function scoped(ctx, fn, label) {
    const tWait = metricsOn ? performance.now() : 0;
    const conn = await pool.connect();
    const tStart = metricsOn ? performance.now() : 0;
    let broken;
    try {
      await conn.query(scopePreamble(conn, ctx));
      const out = await fn(conn);
      await conn.query('COMMIT');
      return out;
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
      throw e;
    } finally {
      conn.release(broken);
      if (metricsOn) {
        const waitMs = tStart - tWait;
        const runMs = performance.now() - tStart;
        if (waitMs + runMs >= logThresholdMs) {
          console.log(`[pg-metrics] wait=${waitMs.toFixed(1)}ms run=${runMs.toFixed(1)}ms pool={total:${pool.totalCount},idle:${pool.idleCount},waiting:${pool.waitingCount}} ${label || ''}`);
        }
      }
    }
  }

  async function runQuery(sql, params) {
    const ctx = resolveContext({ mode: scopeMode });
    if (!ctx.org && !ctx.platform) noteUnscoped(sql);
    return scoped(ctx, (conn) => conn.query(translateSql(sql), params), metricsOn ? `sql=${sql.trim().slice(0, 80)}` : '');
  }
  const client = { driver: 'postgres', rlsMode: scopeMode };
  client.q = async (sql, params = []) => {
    const res = await runQuery(sql, params);
    return res.rows;
  };
  client.q1 = async (sql, params = []) => {
    const rows = await client.q(sql, params);
    return rows[0] || null;
  };
  client.run = async (sql, params = []) => {
    const res = await runQuery(sql, params);
    return { changes: res.rowCount ?? 0 };
  };
  // Maintenance only (nothing in src/ calls it): a raw pooled statement with
  // NO context, so row-level security gives it no tenant rows.
  client.exec = (sql) => pool.query(sql);
  // Live pool occupancy -- waitingCount > 0 means requests are queued
  // behind a full pool RIGHT NOW (pool starvation, directly observed, not
  // inferred). Cheap (reads pg's own in-memory counters); safe to call from
  // a debug endpoint or the load-test harness at any time, in any mode.
  client.poolStats = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  // Multi-statement transaction (rolls back on any failure), on the same
  // scoped() path as every single statement: one connection, one context
  // for the whole transaction, discarded by PostgreSQL at COMMIT/ROLLBACK.
  // { orgId } narrows a platform context to one gym (never re-points a
  // tenant at another -- resolveContext refuses that).
  client.tx = async (fn, opts = {}) => {
    const ctx = resolveContext({ txOrgId: opts.orgId || null, inTx: true, mode: scopeMode });
    return scoped(ctx, async (c) => {
      const txDb = {
        driver: 'postgres',
        async q(sql, params = []) { const r = await c.query(translateSql(sql), params); return r.rows; },
        async q1(sql, params = []) { const r = await c.query(translateSql(sql), params); return r.rows[0] || null; },
        async run(sql, params = []) { const r = await c.query(translateSql(sql), params); return { changes: r.rowCount ?? 0 }; },
        exec: (sql) => c.query(sql),
        raw: c
      };
      return fn(txDb);
    }, metricsOn ? 'tx' : '');
  };
  client.raw = pool;
  return client;
}

async function createPg() {
  return createPgDb({ connectionString: config.databaseUrl, max: process.env.PG_POOL_MAX || 5 });
}

let instance = null;
export async function getDb() {
  if (!instance) instance = config.databaseUrl ? await createPg() : await createSqlite();
  return instance;
}
