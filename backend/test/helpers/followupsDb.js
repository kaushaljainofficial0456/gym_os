// ============================================================
// AI COMMUNICATION TEST DATABASES
//
// memDb()  a fresh database per test:
//   - default: in-memory SQLite built from database/schema.sql;
//   - TEST_DATABASE_URL set: a fresh SCHEMA on that PostgreSQL server, built
//     from the same schema.sql (and rls.sql), talked to through the same
//     ?->$n translation as backend/src/db.js -- so the whole follow-ups
//     suite runs unchanged on real Postgres (CI does this; see
//     .github/workflows/test.yml). One connection per test: a nested
//     transaction becomes a savepoint.
//
// pgPoolDb()  Postgres only: a POOLED db shaped exactly like db.js's (each
//   db.tx() checks out its own connection and sets app.org_id), for the tests
//   that need real concurrency and row-level security.
//
// Never point TEST_DATABASE_URL at a database you care about: every schema
// this creates is named fu_t<pid>_<n> and dropped when the run ends.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
export const schemaSql = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
export const rlsSql = fs.readFileSync(path.join(root, 'database', 'rls.sql'), 'utf8');
export const PG_URL = process.env.TEST_DATABASE_URL || '';
export const driverName = PG_URL ? 'postgres' : 'sqlite';

// Registered once, at import (the root of the importing test file): a hook
// added from inside a running test would belong to that test only, and every
// later connection would stay open and keep the process alive.
const cleanups = [];
if (PG_URL) test.after(async () => { for (const f of cleanups.reverse()) { try { await f(); } catch { /* best effort */ } } });
const registerCleanup = (fn) => cleanups.push(fn);

let seq = 0;
const schemaName = () => `fu_t${process.pid}_${++seq}`;

async function sqliteDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schemaSql);
  const db = {
    driver: 'sqlite',
    async q(sql, p = []) { return raw.prepare(sql).all(...p); },
    async q1(sql, p = []) { return raw.prepare(sql).all(...p)[0] || null; },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    exec(sql) { raw.exec(sql); },
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(db); raw.exec('COMMIT'); return out; } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* */ } throw e; }
    },
    raw,
  };
  return db;
}

async function createSchema(client, name, { rls = false } = {}) {
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  await client.query(`SET search_path TO ${name}`);
  await client.query(schemaSql);
  if (rls) await client.query(rlsSql);
}

async function pgSingleDb() {
  const { default: pg } = await import('pg');
  const { translateSql } = await import('../../src/db.js');
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  const name = schemaName();
  // A failed setup must close its connection, or the open socket keeps the
  // test process alive forever instead of failing (e.g. a non-UTF8 database:
  // schema.sql is UTF-8, as Neon and CI's postgres:16 are).
  try { await createSchema(c, name); } catch (e) { await c.end().catch(() => {}); throw e; }
  registerCleanup(async () => { await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await c.end(); });
  const q = async (sql, p = []) => (await c.query(translateSql(sql), p)).rows;
  let depth = 0;
  const db = {
    driver: 'postgres',
    schema: name,
    q,
    async q1(sql, p = []) { return (await q(sql, p))[0] || null; },
    async run(sql, p = []) { const r = await c.query(translateSql(sql), p); return { changes: r.rowCount ?? 0 }; },
    exec(sql) { return c.query(sql); },
    async tx(fn) {
      const sp = depth ? `sp${depth}` : null;
      await c.query(sp ? `SAVEPOINT ${sp}` : 'BEGIN');
      depth += 1;
      try { const out = await fn(db); depth -= 1; await c.query(sp ? `RELEASE SAVEPOINT ${sp}` : 'COMMIT'); return out; } catch (e) { depth -= 1; try { await c.query(sp ? `ROLLBACK TO SAVEPOINT ${sp}` : 'ROLLBACK'); } catch { /* */ } throw e; }
    },
  };
  return db;
}

/** A fresh database for one test: SQLite in memory, or a fresh Postgres schema. */
export const memDb = () => (PG_URL ? pgSingleDb() : sqliteDb());

/**
 * Postgres only: a pooled db with db.js's semantics (separate connection per
 * transaction, app.org_id set inside it), on its own schema with RLS applied.
 * Returns { db, pool, schema, admin }.
 */
export async function pgPoolDb({ max = 12, t = null } = {}) {
  const { default: pg } = await import('pg');
  const { translateSql } = await import('../../src/db.js');
  const name = schemaName();
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  try { await createSchema(admin, name, { rls: true }); } catch (e) { await admin.end().catch(() => {}); throw e; }
  const pool = new pg.Pool({ connectionString: PG_URL, max, options: `-c search_path=${name}` });
  // Closed when ITS test ends (pass `t`): warm pools hold every connection
  // open, and a file's worth of them would exceed max_connections.
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await admin.end(); };
  if (t) t.after(close); else registerCleanup(close);
  // WARM THE POOL, like a production pool that has been serving traffic. A
  // cold pool spends milliseconds authenticating each new connection, which
  // quietly serialises "concurrent" work and hides real races (verified: the
  // original settleJob double-charged 25x on a warm pool and never on a cold one).
  await Promise.all(Array.from({ length: max }, () => pool.query('SELECT pg_sleep(0.03)')));
  const db = {
    driver: 'postgres',
    schema: name,
    async q(sql, p = []) { return (await pool.query(translateSql(sql), p)).rows; },
    async q1(sql, p = []) { return (await pool.query(translateSql(sql), p)).rows[0] || null; },
    async run(sql, p = []) { const r = await pool.query(translateSql(sql), p); return { changes: r.rowCount ?? 0 }; },
    async tx(fn, opts = {}) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (opts.orgId) await c.query(`SELECT set_config('app.org_id', $1, true)`, [String(opts.orgId)]);
        const t = {
          driver: 'postgres',
          async q(sql, p = []) { return (await c.query(translateSql(sql), p)).rows; },
          async q1(sql, p = []) { return (await c.query(translateSql(sql), p)).rows[0] || null; },
          async run(sql, p = []) { const r = await c.query(translateSql(sql), p); return { changes: r.rowCount ?? 0 }; },
        };
        const out = await fn(t);
        await c.query('COMMIT');
        return out;
      } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; } finally { c.release(); }
    },
  };
  return { db, pool, schema: name, admin, close };
}
