// ============================================================
// THE PLATE LOGGER — describe a meal, adjust it, log it as one meal.
//
//   POST /api/me/nutrition/describe     "2 roti, dal and a cup of chai" -> plate
//   POST /api/me/nutrition/item         one food as a plate item (a swap)
//   POST /api/me/nutrition/log-batch    the plate, logged atomically in its slot
//   GET  /api/me/nutrition/usuals       what this person eats at this meal
//   GET  /api/me/nutrition/recent-meals past meals worth repeating
//   POST /api/me/nutrition/repeat       log a past meal again, today
//
// The rows are read back from the database, not trusted from the response:
// "how much was eaten" has been lost between the UI and the row before
// (see the quantity-provenance notes in me.js), always silently.
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
import { dayKey, shiftDayKey } from '../src/utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  // Added by scripts/init-db.js's guarded migrations, not schema.sql.
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
  // Mirrors src/db.js's sqlite .tx().
  db.tx = async (fn) => {
    sdb.exec('BEGIN');
    try { const out = await fn(api(sdb)); sdb.exec('COMMIT'); return out; }
    catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  };
  return db;
}

const TZ = 'Asia/Kolkata';

async function seed(db) {
  for (const [o, u, c] of [['o1', 'u1', 'c1'], ['o2', 'u2', 'c2']]) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)', [o, `Gym ${o}`, `gym-${o}`, TZ, '2026-01-01T00:00:00Z']);
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?, 'CLIENT', ?, 1, ?)`,
      [u, o, `${u}@test.com`, 'x', `Client ${u}`, '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)', [c, u, o, 'GENERAL', '2026-01-01T00:00:00Z']);
    // Calendar days, so "today" here is the same day the routes compute.
    await db.run('INSERT INTO client_profiles (client_id, day_start_hour) VALUES (?, 0)', [c]);
  }
}

async function startApp() {
  const db = await memDb();
  await seed(db);
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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, t2, close };
}

const today = () => dayKey(new Date(), TZ);

test.beforeEach(() => { resetRateLimits(); });

test('describe: a sentence becomes priced plate items in natural units', async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/describe', { text: '2 roti, 1 katori dal and a cup of chai' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [roti, dal, chai] = r.json.items;
  assert.equal(r.json.items.length, 3);
  assert.equal(roti.qty, 2);
  assert.equal(roti.grams, 80);
  assert.equal(roti.units.find((u) => u.key === roti.unit_key).label, 'roti');
  assert.equal(dal.unit_key, 'staple_katori');
  assert.equal(chai.grams, 150, 'an Indian tea cup');
  // per100 x grams reproduces the item, so the UI can re-price a stepper
  // change without a round trip and land on the same number.
  for (const it of r.json.items) {
    assert.equal(Math.round((it.per100.calories * it.grams) / 100), it.calories, it.name);
    assert.equal(it.units.at(-1).key, 'g', 'grams are always available');
  }
});

test('describe: what was not understood is returned, never dropped', async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/describe', { text: '2 roti and xyzzqq plover' });
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.unresolved.length, 1);
});

test('describe: an amount the person typed keeps their own words', async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/describe', { text: '200ml milk' });
  const milk = r.json.items[0];
  const unit = milk.units.find((u) => u.key === milk.unit_key);
  assert.equal(unit.label, 'ml');
  assert.equal(milk.qty, 200);
  assert.ok(Math.abs(unit.grams * milk.qty - milk.grams) < 0.5, 'ml x density = grams');
  assert.ok(milk.alternatives.some((a) => /buffalo/i.test(a.name)), 'cow vs buffalo is offered');
});

test('item: a swap arrives at its natural unit, not 100 g', async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/item', { source_id: 'ifct:L001', staple_key: 'milk_buffalo' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.name, 'Buffalo milk');
  assert.equal(r.json.item.unit_key, 'staple_glass');
  assert.equal(r.json.item.grams, 250);
  const miss = await call('POST', '/api/me/nutrition/item', { source_id: 'nope:1' });
  assert.equal(miss.status, 404);
});

test('log-batch: one meal, every item with its amount, all in the chosen slot', async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'breakfast',
    items: [
      { name: 'Roti / Chapati', calories: 162, protein: 5.6, carbs: 27.9, fat: 3.8, quantity: 2, unit: 'roti', confidence: 'high' },
      { name: 'Chai', calories: 90, protein: 3.15, carbs: 12.75, fat: 3, quantity: 1, unit: 'cup', confidence: 'medium' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.ids.length, 2);
  const rows = await db.q('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY name', ['c1']);
  assert.equal(rows.length, 2);
  const roti = rows.find((x) => x.name === 'Roti / Chapati');
  assert.equal(roti.slot, 'breakfast');
  assert.equal(roti.quantity, 2);
  assert.equal(roti.unit, 'roti');
  assert.equal(roti.eaten, 1);
  assert.equal(roti.date, today());
  assert.equal(roti.estimate, 0);
  assert.equal(rows.find((x) => x.name === 'Chai').protein, 3.2, 'rounded once, at the boundary');
});

test('log-batch: all or nothing', async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  // The second item is invalid: nothing may be written.
  const r = await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch',
    items: [
      { name: 'Rice', calories: 194, protein: 4, carbs: 42, fat: 0.4, quantity: 1, unit: 'katori' },
      { name: 'Dal', calories: -5, protein: 1, carbs: 1, fat: 1, quantity: 1, unit: 'katori' },
    ],
  });
  assert.equal(r.status, 422);
  assert.equal((await db.q('SELECT id FROM meal_logs')).length, 0);
});

test('log-batch: a past day can be filled in, a future one cannot', async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const item = { name: 'Poha', calories: 250, protein: 5, carbs: 45, fat: 6, quantity: 1, unit: 'bowl' };
  const past = await call('POST', '/api/me/nutrition/log-batch', { slot: 'breakfast', date: shiftDayKey(today(), -2), items: [item] });
  assert.equal(past.status, 201);
  const future = await call('POST', '/api/me/nutrition/log-batch', { slot: 'breakfast', date: shiftDayKey(today(), 1), items: [item] });
  assert.equal(future.status, 400);
  assert.equal((await db.q('SELECT id FROM meal_logs')).length, 1);
});

test('usuals: ranked by THIS meal, with the last amount eaten', async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const ins = (d, slot, name, qty, unit, kcal) => db.run(
    `INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit)
     VALUES (?,?,?,?,?,?,1,1,1,1,'manual',?,?)`,
    [`m_${Math.random().toString(36).slice(2)}`, 'c1', d, slot, name, kcal, qty, unit]);
  for (let i = 1; i <= 3; i += 1) await ins(shiftDayKey(today(), -i), 'breakfast', 'Poha', 1, 'bowl', 250);
  await ins(shiftDayKey(today(), -1), 'breakfast', 'Chai', 2, 'cup', 180);
  for (let i = 1; i <= 5; i += 1) await ins(shiftDayKey(today(), -i), 'dinner', 'Dal', 1, 'katori', 150);
  // Plan rows are not "a food this person picked".
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES ('p1','c1',?, 'breakfast','Plan oats',300,1,1,1,1,'plan')`, [today()]);

  const b = await call('GET', '/api/me/nutrition/usuals?slot=breakfast');
  assert.equal(b.status, 200);
  assert.deepEqual(b.json.usuals.slice(0, 2).map((u) => u.name), ['Poha', 'Chai']);
  assert.equal(b.json.usuals[1].quantity, 2);
  assert.equal(b.json.usuals[1].unit, 'cup');
  assert.ok(!b.json.usuals.some((u) => u.name === 'Plan oats'));

  const d = await call('GET', '/api/me/nutrition/usuals?slot=dinner');
  assert.equal(d.json.usuals[0].name, 'Dal');
});

test('recent-meals + repeat: yesterday\'s breakfast, again, in one call', async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const y = shiftDayKey(today(), -1);
  await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'breakfast', date: y,
    items: [
      { name: 'Poha', calories: 250, protein: 5, carbs: 45, fat: 6, quantity: 1, unit: 'bowl' },
      { name: 'Chai', calories: 90, protein: 3, carbs: 13, fat: 3, quantity: 1, unit: 'cup' },
    ],
  });
  const recent = await call('GET', '/api/me/nutrition/recent-meals');
  assert.equal(recent.status, 200);
  const meal = recent.json.meals.find((m) => m.date === y && m.slot === 'breakfast');
  assert.ok(meal, 'yesterday\'s breakfast is offered');
  assert.equal(meal.items.length, 2);
  assert.equal(meal.total.calories, 340);

  const rep = await call('POST', '/api/me/nutrition/repeat', { date: y, slot: 'breakfast' });
  assert.equal(rep.status, 201, JSON.stringify(rep.json));
  const rows = await db.q('SELECT * FROM meal_logs WHERE date = ? ORDER BY name', [today()]);
  assert.deepEqual(rows.map((x) => [x.name, x.quantity, x.unit, x.slot]), [['Chai', 1, 'cup', 'breakfast'], ['Poha', 1, 'bowl', 'breakfast']]);

  const none = await call('POST', '/api/me/nutrition/repeat', { date: y, slot: 'dinner' });
  assert.equal(none.status, 404);
});

test('another member\'s meals are invisible and cannot be repeated', async (t) => {
  const { db, call, t2, close } = await startApp(); t.after(close);
  const y = shiftDayKey(today(), -1);
  await call('POST', '/api/me/nutrition/log-batch', {
    slot: 'lunch', date: y,
    items: [{ name: 'Rajma', calories: 300, protein: 12, carbs: 40, fat: 8, quantity: 1, unit: 'katori' }],
  });
  const theirs = await call('GET', '/api/me/nutrition/recent-meals', undefined, t2);
  assert.deepEqual(theirs.json.meals, []);
  const rep = await call('POST', '/api/me/nutrition/repeat', { date: y, slot: 'lunch' }, t2);
  assert.equal(rep.status, 404);
  assert.equal((await db.q('SELECT id FROM meal_logs WHERE client_id = ?', ['c2'])).length, 0);
});

test('unauthenticated -> 401', async (t) => {
  const { call, close } = await startApp(); t.after(close);
  const r = await call('POST', '/api/me/nutrition/describe', { text: 'roti' }, '');
  assert.equal(r.status, 401);
});
