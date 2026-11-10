// ============================================================
// GROUP BY + BOUND PARAMETERS ON POSTGRESQL
//
// A query that repeats a parameterised expression in SELECT and GROUP BY --
//   SELECT CASE WHEN end_date < ? ... END AS bucket ... GROUP BY CASE WHEN end_date < ? ... END
// -- runs on SQLite, but PostgreSQL sees two DIFFERENT parameters ($1, $3),
// cannot prove the expressions equal, and rejects it:
//   column "subscriptions.status" must appear in the GROUP BY clause ...
// That took down GET /api/dashboard/pulse (the owner Home) and the founder's
// coupon detail (getCouponAnalytics) on production's Postgres while every
// SQLite test stayed green. The fix groups over a derived table, so the
// expression is written once.
//
// The same assertions run on in-memory SQLite and, with TEST_DATABASE_URL, on
// a fresh schema of a real PostgreSQL server (CI's postgres:16 service).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gymPulse } from '../src/services/gymPulse.js';
import { getCouponAnalytics } from '../src/services/coupons/couponAdmin.js';
import { translateSql } from '../src/db.js';
import { dayKey } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const PG_URL = process.env.TEST_DATABASE_URL || '';
const ts = '2026-01-01T00:00:00Z';
const TZ = 'Asia/Kolkata';

async function sqliteDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const db = {
    driver: 'sqlite',
    async q(sql, p = []) { return raw.prepare(sql).all(...p); },
    async q1(sql, p = []) { return raw.prepare(sql).all(...p)[0] || null; },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    async tx(fn) { raw.exec('BEGIN'); try { const o = await fn(db); raw.exec('COMMIT'); return o; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    close: async () => {},
  };
  return db;
}

let n = 0;
async function pgDb() {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  const name = `gbp_t${process.pid}_${++n}`;
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE; CREATE SCHEMA ${name}; SET search_path TO ${name}`);
    await c.query(schema);
  } catch (e) { await c.end().catch(() => {}); throw e; }
  const db = {
    driver: 'postgres',
    async q(sql, p = []) { return (await c.query(translateSql(sql), p)).rows; },
    async q1(sql, p = []) { return (await c.query(translateSql(sql), p)).rows[0] || null; },
    async run(sql, p = []) { const r = await c.query(translateSql(sql), p); return { changes: r.rowCount ?? 0 }; },
    async tx(fn) { await c.query('BEGIN'); try { const o = await fn(db); await c.query('COMMIT'); return o; } catch (e) { await c.query('ROLLBACK'); throw e; } },
    close: async () => { await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await c.end(); },
  };
  return db;
}

const engines = [['sqlite', sqliteDb, false], ['postgres', pgDb, PG_URL ? false : 'set TEST_DATABASE_URL to run against PostgreSQL']];

for (const [label, make, skip] of engines) {
  test(`${label}: the owner pulse buckets memberships (active / lapsed / cancelled) without a GROUP BY error`, { skip }, async () => {
    const db = await make();
    try {
      await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'o1', ts]);
      const today = dayKey(new Date(), TZ);
      const plus = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
      const rows = [['active', plus(60)], ['active', plus(-120)], ['cancelled', plus(-5)], ['active', plus(10)]];
      for (const [i, [status, end]] of rows.entries()) {
        await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,'x','CLIENT','C',1,?)`, [`u${i}`, 'o1', `u${i}@x.in`, ts]);
        await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [`c${i}`, `u${i}`, 'o1', ts]);
        await db.run(`INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status) VALUES (?,?,?,'Monthly',1000,'2026-01-01',?,?,'paid')`, [`s${i}`, 'o1', `c${i}`, end, status]);
      }
      const p = await gymPulse(db, 'o1', { tz: TZ });
      const by = Object.fromEntries(p.members.byStatus.map((x) => [x.status, Number(x.value)]));
      assert.equal(by.active, 2, 'the two that have not run out');
      assert.equal(by.lapsed, 1, '"active" but ended: lapsed');
      assert.equal(by.cancelled, 1);
    } finally { await db.close(); }
  });

  test(`${label}: a coupon's hold breakdown (held for review / released / in flight) without a GROUP BY error`, { skip }, async () => {
    const db = await make();
    try {
      await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'o1', ts]);
      await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('admin1', NULL, 'a@x.in', 'x', 'SUPER_ADMIN', 'A', 1, ?)`, [ts]);
      await db.run(`INSERT INTO coupons (id, code, internal_name, discount_type, discount_value, customer_type, starts_at, expires_at, created_by, created_at, updated_at)
                    VALUES ('cp1', 'TEN', 'Ten off', 'PERCENTAGE', 10, 'BOTH', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'admin1', ?, ?)`, [ts, ts]);
      const future = '2099-01-01T00:00:00Z';
      const red = (rid, status, reason = null) => db.run(
        `INSERT INTO coupon_redemptions (id, coupon_id, org_id, subject_type, original_amount, discount_amount, final_amount, status, reserved_at, reservation_expires_at, release_reason, created_at, updated_at)
         VALUES (?, 'cp1', 'o1', 'ORG_PACKAGE', 100, 10, 90, ?, ?, ?, ?, ?, ?)`, [rid, status, ts, future, reason, ts, ts]);
      await red('r1', 'RELEASED', 'held_for_review');
      await red('r2', 'RELEASED', 'checkout_abandoned');
      await red('r3', 'RESERVED');
      const a = await getCouponAnalytics(db, 'cp1');
      assert.equal(a.analytics.heldForReview, 1);
      assert.equal(a.analytics.abandonedOrFailed, 1);
      assert.equal(a.analytics.inFlight, 1);
    } finally { await db.close(); }
  });
}
