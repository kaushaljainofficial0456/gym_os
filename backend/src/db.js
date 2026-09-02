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

// Per-request org context (set by requireAuth). Lets db.tx() automatically
// engage PostgreSQL RLS for the authenticated org without threading an
// orgId through every call site. AsyncLocalStorage propagates through the
// request's async chain and is inherently race-safe across concurrent requests.
export const als = new AsyncLocalStorage();
export const runWithOrg = (orgId, fn) => als.run(orgId || null, fn);
export const currentOrg = () => als.getStore() || null;

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

async function createPg() {
  const pg = await import('pg');
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
    connectionString: config.databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
  // Without this handler, an error on an IDLE pooled connection (e.g. Neon
  // dropping it server-side) is an uncaught 'error' event -- which crashes
  // the whole Node process. pg's own docs call this out explicitly. The
  // pool recovers the connection on its own; this just keeps the process up.
  pool.on('error', (err) => {
    console.error('[sk-os] Postgres pool error on idle client:', err.message);
  });
  const client = { driver: 'postgres' };
  client.q = async (sql, params = []) => {
    const res = await pool.query(translateSql(sql), params);
    return res.rows;
  };
  client.q1 = async (sql, params = []) => {
    const rows = await client.q(sql, params);
    return rows[0] || null;
  };
  client.run = async (sql, params = []) => {
    const res = await pool.query(translateSql(sql), params);
    return { changes: res.rowCount ?? 0 };
  };
  client.exec = (sql) => pool.query(sql);
  // Multi-statement transaction (rolls back on any failure). When an orgId is
  // provided, RLS (database/rls.sql) is engaged for the whole transaction via
  // SET LOCAL — it is scoped to this connection+tx and reset automatically at
  // COMMIT/ROLLBACK, so it can never leak across pooled connections.
  client.tx = async (fn, opts = {}) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const orgId = opts.orgId || currentOrg();
      // PG does not accept parameter placeholders ($1) in SET — inline the
      // literal (org ids are app-generated tokens; escaped defensively).
      if (orgId) await c.query(`SET LOCAL app.org_id = '${String(orgId).replace(/'/g, "''")}'`);
      const txDb = {
        driver: 'postgres',
        async q(sql, params = []) { const r = await c.query(translateSql(sql), params); return r.rows; },
        async q1(sql, params = []) { const r = await c.query(translateSql(sql), params); return r.rows[0] || null; },
        async run(sql, params = []) { const r = await c.query(translateSql(sql), params); return { changes: r.rowCount ?? 0 }; },
        exec: (sql) => c.query(sql),
        raw: c
      };
      const out = await fn(txDb);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally {
      c.release();
    }
  };
  client.raw = pool;
  return client;
}

let instance = null;
export async function getDb() {
  if (!instance) instance = config.databaseUrl ? await createPg() : await createSqlite();
  return instance;
}
