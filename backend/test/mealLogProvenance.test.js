// ============================================================
// MEAL LOG PROVENANCE, SERVER PRICING AND IDEMPOTENCY
// (services/nutrition/mealLogWriter.js + provenance.js)
//
//   - a database-matched item is re-priced by the SERVER from source_id +
//     grams; a client cannot make it say something else
//   - "verified" can never be asserted by a client
//   - a retried request (same client_request_id) never logs twice
//   - what the person chose to leave out is recorded
//   - one person's request id cannot replay another person's log
// Rows are read back from the database, never trusted from the response.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';
import { modelAvailable } from '../src/services/foodEstimator.js';
import { nutritionSourceForRow, resolveLoggedNutrition } from '../src/services/nutrition/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  for (const ddl of ['ai_provider TEXT', 'ai_model TEXT', 'ai_confidence TEXT']) {
    sdb.exec(`ALTER TABLE meal_logs ADD COLUMN ${ddl}`);
  }
  const api = (handle) => ({
    driver: 'sqlite',
    async q(sql, params = []) { const s = handle.prepare(sql); return params.length ? s.all(...params) : s.all(); },
    async q1(sql, params = []) { const s = handle.prepare(sql); return (params.length ? s.all(...params) : s.all())[0] || null; },
    async run(sql, params = []) { const s = handle.prepare(sql); const r = params.length ? s.run(...params) : s.run(); return { changes: Number(r.changes) }; },
    exec(sql) { handle.exec(sql); },
    raw: handle,
  });
  const db = api(sdb);
  db.tx = async (fn) => {
    sdb.exec('BEGIN');
    try { const out = await fn(api(sdb)); sdb.exec('COMMIT'); return out; }
    catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  };
  for (const [o, u, c] of [['o1', 'u1', 'c1'], ['o2', 'u2', 'c2']]) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)', [o, `Gym ${o}`, `gym-${o}`, TZ, '2026-01-01T00:00:00Z']);
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?, 'CLIENT', ?, 1, ?)`,
      [u, o, `${u}@test.com`, 'x', `Client ${u}`, '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)', [c, u, o, 'GENERAL', '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO client_profiles (client_id, day_start_hour) VALUES (?, 0)', [c]);
  }
  return db;
}

async function startApp() {
  const db = await memDb();
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tz = TZ; next(); });
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tok = (u, o) => jwt.sign({ sub: u, role: 'CLIENT', org: o, name: u }, config.jwtSecret, { expiresIn: '1h' });
  const t1 = tok('u1', 'o1');
  const t2 = tok('u2', 'o2');
  const call = async (method, p, body, token = t1) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, t2, close };
}

test.beforeEach(() => { resetRateLimits(); });

/* ---------------- pure provenance rules ---------------- */

test('source classes follow the row, not the client', () => {
  assert.equal(nutritionSourceForRow({ source: 'IFCT2017', source_id: 'ifct:A001' }), 'verified_database');
  assert.equal(nutritionSourceForRow({ source: 'INDB', source_id: 'indb:ASC096' }), 'verified_database');
  assert.equal(nutritionSourceForRow({ source: 'OPEN_FOOD_FACTS', source_id: 'off:890' }), 'brand_label');
  assert.equal(nutritionSourceForRow({ source: 'SKOS_STAPLE', source_id: 'staple:chai', basis: 'recipe' }), 'recipe_calculation');
  assert.equal(nutritionSourceForRow({ source: 'SKOS_RECIPE', source_id: 'recipe:misal' }), 'recipe_calculation');
  assert.equal(nutritionSourceForRow(null), 'user_provided');
});

test('a client cannot claim a trusted class; an unknown source_id falls back to user_provided', () => {
  const n = resolveLoggedNutrition({ name: 'x', calories: 100, protein: 1, carbs: 1, fat: 1, source: 'manual', source_id: 'nope:1', grams: 50 });
  assert.equal(n.nutrition_source, 'user_provided');
  assert.equal(n.source_id, null);
  const ai = resolveLoggedNutrition({ name: 'x', calories: 100, protein: 1, carbs: 1, fat: 1, source: 'ai_estimated', source_id: 'indb:ASC096', grams: 80 });
  assert.equal(ai.nutrition_source, 'ai_estimate', 'an AI item is never upgraded by naming a row');
});

/* ---------------- the route ---------------- */

const live = modelAvailable();

test('log-batch re-prices a database item on the server and stores provenance', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const d = await call('POST', '/api/me/nutrition/describe', { text: '2 roti' });
  const roti = d.json.items[0];
  // A client that sends a wrong number (stale, or tampered).
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch',
    items: [{ name: roti.name, calories: 9999, protein: 1, carbs: 1, fat: 1, quantity: 2, unit: 'roti',
              source: 'manual', source_id: roti.source_id, staple_key: roti.staple_key, grams: roti.grams }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', [r.json.ids[0]]);
  assert.equal(row.calories, roti.calories, 'the server price, not the 9999 the client sent');
  assert.equal(row.nutrition_source, 'verified_database');
  assert.equal(row.source_id, roti.source_id);
  assert.equal(row.grams, roti.grams);
  assert.equal(r.json.items[0].repriced, true, 'the disagreement is reported back');
});

test('a retried request (same client_request_id) logs exactly once', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const body = {
    slot: 'dinner', client_request_id: 'plate_retry_test_0001',
    items: [{ name: 'Dal', calories: 200, protein: 10, carbs: 25, fat: 6, quantity: 1, unit: 'katori', source: 'manual' }],
  };
  const a = await call('POST', '/api/me/nutrition/log-batch', body);
  const b = await call('POST', '/api/me/nutrition/log-batch', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.replayed, true);
  assert.deepEqual(b.json.ids, a.json.ids, 'the retry gets the first request\'s ids back');
  const n = await db.q1('SELECT COUNT(*) AS n FROM meal_logs WHERE client_id = ?', ['c1']);
  assert.equal(Number(n.n), 1, 'one meal, not two');
});

test('concurrent duplicates of one request still log once', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const body = {
    slot: 'snack', client_request_id: 'plate_concurrent_0001',
    items: [{ name: 'Banana', calories: 105, protein: 1.3, carbs: 27, fat: 0.4, quantity: 1, unit: 'banana', source: 'manual' }],
  };
  const results = await Promise.all([1, 2, 3].map(() => call('POST', '/api/me/nutrition/log-batch', body)));
  assert.ok(results.every((r) => r.status === 201 || r.status === 200), results.map((r) => r.status).join(','));
  const n = await db.q1('SELECT COUNT(*) AS n FROM meal_logs WHERE client_id = ?', ['c1']);
  assert.equal(Number(n.n), 1);
});

test('a request id is scoped to its owner: another member\'s id never replays a stranger\'s log', { skip: !live }, async (t) => {
  const { db, call, t2, close } = await startApp(); t.after(close);
  const body = {
    slot: 'lunch', client_request_id: 'shared_looking_id_0001',
    items: [{ name: 'Rice', calories: 194, protein: 4, carbs: 42, fat: 0.4, quantity: 1, unit: 'katori', source: 'manual' }],
  };
  const a = await call('POST', '/api/me/nutrition/log-batch', body);
  const b = await call('POST', '/api/me/nutrition/log-batch', body, t2);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, 'a different member logs their own meal');
  assert.notDeepEqual(b.json.ids, a.json.ids);
  const c2 = await db.q('SELECT * FROM meal_logs WHERE client_id = ?', ['c2']);
  assert.equal(c2.length, 1);
});

test('what the person chose to leave out is recorded with the request', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch', client_request_id: 'plate_excluded_0001', acknowledged_unresolved: ['xyzzy blorf'],
    items: [{ name: 'Roti', calories: 162, protein: 4.7, carbs: 28.5, fat: 2.9, quantity: 2, unit: 'roti', source: 'manual' }],
  });
  assert.equal(r.status, 201);
  const req = await db.q1('SELECT * FROM meal_log_requests WHERE client_id = ? AND request_id = ?', ['c1', 'plate_excluded_0001']);
  assert.deepEqual(JSON.parse(req.excluded_json), ['xyzzy blorf']);
  const row = await db.q1('SELECT request_id FROM meal_logs WHERE id = ?', [r.json.ids[0]]);
  assert.equal(row.request_id, 'plate_excluded_0001');
});

test('an AI estimate stays an AI estimate; a typed-in entry is user_provided', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'dinner',
    items: [
      { name: 'Mystery curry', calories: 420, protein: 18, carbs: 30, fat: 24, quantity: 1, unit: 'serving', source: 'ai_estimated', confidence: 'low', ai_provider: 'groq' },
      { name: 'My shake', calories: 250, protein: 30, carbs: 20, fat: 5, quantity: 1, unit: 'serving', source: 'manual' },
    ],
  });
  assert.equal(r.status, 201);
  const rows = await db.q('SELECT name, nutrition_source, estimate, ai_provider FROM meal_logs WHERE client_id = ? ORDER BY name', ['c1']);
  const byName = Object.fromEntries(rows.map((x) => [x.name, x]));
  assert.equal(byName['Mystery curry'].nutrition_source, 'ai_estimate');
  assert.equal(byName['Mystery curry'].estimate, 1);
  assert.equal(byName['Mystery curry'].ai_provider, 'groq');
  assert.equal(byName['My shake'].nutrition_source, 'user_provided');
});

test('repeating a meal carries its provenance with it', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const d = await call('POST', '/api/me/nutrition/describe', { text: '1 katori dal' });
  const dal = d.json.items[0];
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch', date: yesterday,
    items: [{ name: dal.name, calories: dal.calories, protein: dal.protein, carbs: dal.carbs, fat: dal.fat, quantity: 1, unit: 'katori',
              source: 'manual', source_id: dal.source_id, staple_key: dal.staple_key, grams: dal.grams }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const rep = await call('POST', '/api/me/nutrition/repeat', { date: yesterday, slot: 'lunch' });
  assert.equal(rep.status, 201, JSON.stringify(rep.json));
  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', [rep.json.ids[0]]);
  assert.equal(row.source_id, dal.source_id);
  assert.ok(['verified_database', 'recipe_calculation'].includes(row.nutrition_source), row.nutrition_source);
});

test('log-batch rejects a malformed request id and a fake "verified" claim', { skip: !live }, async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const bad = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch', client_request_id: 'has spaces and ; semicolons',
    items: [{ name: 'x', calories: 1, protein: 0, carbs: 0, fat: 0, quantity: 1, unit: 'g' }],
  });
  assert.equal(bad.status, 422);
  const claim = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch',
    items: [{ name: 'x', calories: 1, protein: 0, carbs: 0, fat: 0, quantity: 1, unit: 'g', nutrition_source: 'verified_database' }],
  });
  assert.equal(claim.status, 422);
});
