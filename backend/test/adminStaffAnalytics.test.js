// ============================================================
// GET /api/admin/trainers  and  GET /api/admin/analytics
//
// Both endpoints are new, and both exist because an owner had no view of
// them at all: no staff list (so "who can take another client" meant
// opening clients one at a time) and no analytics beyond a single
// revenue line (so the number that moved came with no explanation).
//
// What is worth testing here is not that they return 200. It is the two
// places these are easy to get quietly wrong:
//
//   COUNTS      Postgres returns COUNT() as a bigint STRING. Left
//               uncoerced, "9" > "40" is true and every capacity
//               comparison on the staff page inverts.
//
//   ABSENCE     an unset capacity is not an empty one, and churn
//               measured against nobody is not 0%. Both render as
//               reassuring green numbers if they collapse to zero.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
    raw: db,
  });
  return mk();
}

let seq = 0;
const uid = (p) => `${p}_${++seq}`;

/** An ISO date N whole months before today, on the 1st. */
function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

async function seed(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
    ['o1', 'Gym', 'gym', ts]);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
    ['o2', 'Other', 'other', ts]);
  await db.run('INSERT INTO gym_settings (org_id, updated_at) VALUES (?,?)', ['o1', ts]);

  const owner = uid('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,?,'GYM_OWNER',?,1,?)`, [owner, 'o1', `${owner}@a.in`, 'x', 'Owner', ts]);

  // Two trainers: one with a capacity, one with none set.
  const busy = uid('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,?,'TRAINER',?,1,?)`, [busy, 'o1', `${busy}@a.in`, 'x', 'Busy Coach', ts]);
  await db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,?)', [busy, 'o1', 10]);

  const uncapped = uid('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,?,'TRAINER',?,1,?)`, [uncapped, 'o1', `${uncapped}@a.in`, 'x', 'No Limit', ts]);
  await db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,0)', [uncapped, 'o1']);

  // A trainer at ANOTHER gym, who must never appear in o1's list.
  const foreign = uid('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,?,'TRAINER',?,1,?)`, [foreign, 'o2', `${foreign}@a.in`, 'x', 'Foreign', ts]);
  await db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,50)', [foreign, 'o2']);

  // 9 clients on the busy trainer: 8 active, 1 inactive.
  for (let i = 0; i < 9; i++) {
    const u = uid('usr'); const c = uid('cli');
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,?,?,?,'CLIENT',?,1,?)`, [u, 'o1', `${u}@a.in`, 'x', `C${i}`, ts]);
    await db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, status, created_at)
                  VALUES (?,?,?,?,?,?)`,
      [c, u, 'o1', busy, i === 8 ? 'INACTIVE' : 'ON_TRACK', `${monthsAgo(2)}T00:00:00Z`]);
  }

  // One client with no trainer at all.
  const lu = uid('usr'); const lc = uid('cli');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES (?,?,?,?,'CLIENT',?,1,?)`, [lu, 'o1', `${lu}@a.in`, 'x', 'Orphan', ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, status, created_at)
                VALUES (?,?,?,NULL,'ON_TRACK',?)`, [lc, lu, 'o1', `${monthsAgo(1)}T00:00:00Z`]);

  return { owner, busy, uncapped, orphanClient: lc };
}

async function startApp() {
  const db = await memDb();
  const ids = await seed(db);
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: ids.owner, role: 'GYM_OWNER', org: 'o1', name: 'Owner' },
    config.jwtSecret, { expiresIn: '1h' });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    let json = null;
    try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, get, ids, close };
}

test('the staff list counts each trainer\'s clients, and separates active from inactive', async (t) => {
  const { get, ids, close } = await startApp(); t.after(() => close());

  const res = await get('/api/admin/trainers');
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const busy = res.json.trainers.find((x) => x.id === ids.busy);
  assert.equal(busy.clientCount, 9, 'everyone on their books');
  assert.equal(busy.activeClientCount, 8, 'an inactive client is on the books but not being coached');
  assert.equal(typeof busy.clientCount, 'number',
    'counts must be numbers, not the bigint strings Postgres returns');
});

test('load is a real percentage, and an unset capacity is null rather than 0%', async (t) => {
  const { get, ids, close } = await startApp(); t.after(() => close());
  const { json } = await get('/api/admin/trainers');

  const busy = json.trainers.find((x) => x.id === ids.busy);
  assert.equal(busy.loadPct, 80, '8 active against a ceiling of 10');

  const uncapped = json.trainers.find((x) => x.id === ids.uncapped);
  assert.equal(uncapped.loadPct, null,
    'no ceiling set means unknown load — 0% would read as "wide open" and get them overloaded');
});

test('unassigned clients are reported, because nobody is looking after them', async (t) => {
  const { get, close } = await startApp(); t.after(() => close());
  const { json } = await get('/api/admin/trainers');
  assert.equal(json.unassigned, 1);
});

test('another gym\'s trainers never appear', async (t) => {
  const { get, close } = await startApp(); t.after(() => close());
  const { json } = await get('/api/admin/trainers');
  assert.ok(json.trainers.every((x) => x.name !== 'Foreign'), 'org scoping holds');
  assert.equal(json.trainers.length, 2);
});

test('analytics buckets every month in the window, including empty ones', async (t) => {
  const { get, close } = await startApp(); t.after(() => close());

  const res = await get('/api/admin/analytics?months=6');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.series.length, 6,
    'a month with no activity is a zero on the chart, not a missing point');

  const months = res.json.series.map((m) => m.month);
  assert.deepEqual([...months].sort(), months, 'oldest first');
  assert.equal(new Set(months).size, 6, 'no duplicated months');
});

test('joins land in the month they happened, and net is joined minus left', async (t) => {
  const { get, close } = await startApp(); t.after(() => close());
  const { json } = await get('/api/admin/analytics?months=6');

  const twoAgo = monthsAgo(2).slice(0, 7);
  const oneAgo = monthsAgo(1).slice(0, 7);
  assert.equal(json.series.find((m) => m.month === twoAgo).joined, 9);
  assert.equal(json.series.find((m) => m.month === oneAgo).joined, 1);
  assert.equal(json.totals.joined, 10);

  for (const m of json.series) {
    assert.equal(m.net, m.joined - m.left, 'net is derived, never independently stored');
  }
});

test('churn is null when there is nobody to churn, not a reassuring 0%', async (t) => {
  const { db, get, close } = await startApp(); t.after(() => close());

  // An empty gym: no clients at all.
  await db.run('DELETE FROM clients WHERE org_id = ?', ['o1']);
  const { json } = await get('/api/admin/analytics?months=6');

  assert.equal(json.churnPct, null,
    '0% churn on a gym with no members reads as an achievement rather than as no data');
  assert.equal(json.hasRevenue, false);
  assert.equal(json.hasAttendance, false);
});

test('the window is clamped, so a hostile months value cannot scan everything', async (t) => {
  const { get, close } = await startApp(); t.after(() => close());

  assert.equal((await get('/api/admin/analytics?months=9999')).json.months, 24);
  assert.equal((await get('/api/admin/analytics?months=1')).json.months, 3);
  assert.equal((await get('/api/admin/analytics?months=abc')).json.months, 6, 'falls back to the default');
});
