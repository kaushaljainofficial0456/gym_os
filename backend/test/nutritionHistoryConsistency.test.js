// ============================================================
// GET /api/nutrition/clients/:id/nutrition-summary vs
// GET /api/nutrition/clients/:id/history — Part 37 ("single source of
// truth for nutrition math"). These two routes (plus Nutrition.jsx's own
// `eaten` reduce on the client) used to each carry an independent copy
// of "sum calories/protein/carbs/fat over eaten=1 meal_logs rows",
// backed only by a comment promising they matched. Both backend routes
// now call one shared `sumEatenTotals()` in nutrition.js -- this test
// proves they can't silently drift apart, rather than just asserting
// each one's own math in isolation.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db,
  });
  return mk();
}

async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client1@test.com', 'x', 'Client One', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
}

async function startApp() {
  const db = await memDb();
  await seedFixtures(db);
  const nutritionRoutes = (await import('../src/routes/nutrition.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/nutrition', nutritionRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client One' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, tok = token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test.beforeEach(() => { resetRateLimits(); });

test('nutrition-summary and history report IDENTICAL totals for the same day (Part 37 consistency)', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  // A mix of eaten and un-eaten rows on the same day -- un-eaten must be
  // excluded from BOTH routes' totals, identically.
  await db.run(`INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES ('l1','c1',NULL,'2026-08-20','snack','Eaten A',200,10,20,5,1,'manual')`);
  await db.run(`INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES ('l2','c1',NULL,'2026-08-20','snack','Eaten B',150,8,15,4,1,'manual')`);
  await db.run(`INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES ('l3','c1',NULL,'2026-08-20','snack','Not Eaten',999,99,99,99,0,'manual')`);

  const summary = await call('GET', '/api/nutrition/clients/c1/nutrition-summary?date=2026-08-20');
  const history = await call('GET', '/api/nutrition/clients/c1/history?from=2026-08-20&to=2026-08-20');
  assert.equal(summary.status, 200, JSON.stringify(summary.json));
  assert.equal(history.status, 200, JSON.stringify(history.json));

  const historyDay = history.json.days.find((d) => d.date === '2026-08-20');
  assert.ok(historyDay, 'history must include the day with logs');

  // The actual Part-37 assertion: these two independently-called routes
  // must agree EXACTLY, not just each be internally self-consistent.
  assert.equal(summary.json.eaten.calories, historyDay.calories);
  assert.equal(summary.json.eaten.protein, historyDay.protein);
  assert.equal(summary.json.eaten.carbs, historyDay.carbs);
  assert.equal(summary.json.eaten.fat, historyDay.fat);

  // And the actual expected value (both eaten rows, un-eaten excluded).
  assert.equal(summary.json.eaten.calories, 350);
  assert.equal(summary.json.eaten.protein, 18);
});

test('history: a day with only un-eaten logs reports zero totals but still lists the logs', async (t) => {
  const { db, call, close } = await startApp(); t.after(() => close());
  await db.run(`INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES ('l1','c1',NULL,'2026-08-21','snack','Skipped Item',300,20,30,10,0,'manual')`);
  const res = await call('GET', '/api/nutrition/clients/c1/history?from=2026-08-21&to=2026-08-21');
  assert.equal(res.status, 200);
  const day = res.json.days.find((d) => d.date === '2026-08-21');
  assert.equal(day.calories, 0, 'un-eaten rows must not contribute to totals');
  assert.equal(day.logs.length, 1, 'but the log itself is still a real historical record');
  assert.equal(day.logs[0].eaten, false);
});
