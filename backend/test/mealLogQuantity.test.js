// ============================================================
// LOGGED QUANTITY — the number a later "Edit Quantity" scales from.
//
// A meal log stores both the nutrition and the amount it describes.
// The amount is not decoration: PUT /me/meal-logs/:id rescales the
// macros by newQuantity / storedQuantity, so a wrong or missing stored
// quantity does not degrade the edit, it corrupts it.
//
// The bug these tests exist to prevent was a 50x macro error reachable
// from ordinary use: the client logged "1.5 bowls" but never sent the
// quantity, the row stored NULL, and the edit path's `|| 100` fallback
// read that as 100 g. Editing 1.5 bowls -> 2 bowls scaled by 2/100 and
// turned 52.5 g of protein into 1.05 g, silently, with no error.
//
// Two separate properties are pinned below, and a fix for either one
// alone leaves the other broken:
//
//   BASELINE PRESENT   scaling is proportional to the REAL logged
//                      amount, in whatever unit it was logged in --
//                      bowls scale like grams do.
//
//   BASELINE ABSENT    there is no honest ratio to apply, so the
//                      macros are left ALONE and the stated quantity is
//                      simply recorded. Never invent a denominator.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

const ts = '2026-01-01T00:00:00Z';

async function seed(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, current_weight, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'GENERAL', 30, 'M', 175, 78, ts]);
}

/** Inserts a meal log directly, so each test controls exactly what the
 *  stored quantity is -- including NULL, which is what every row logged
 *  before the client started sending it looks like. */
async function insertLog(db, { id: logId, quantity, unit, calories, protein, carbs, fat }) {
  await db.run(
    `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit)
     VALUES (?,?,NULL,?,?,?,?,?,?,?,1,'manual',?,?)`,
    [logId, 'c1', '2026-01-02', 'Snack', 'Paneer Bowl', calories, protein, carbs, fat, quantity, unit]);
}

async function startApi(db) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client' }, config.jwtSecret, { expiresIn: '1h' });
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('editing quantity scales macros from the REAL logged amount, in its own unit', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  // 1.5 bowls of a 20P/10C/15F-per-bowl food.
  await insertLog(db, { id: 'mlg_a', quantity: 1.5, unit: 'bowl', calories: 382.5, protein: 30, carbs: 15, fat: 22.5 });

  const r = await api.call('PUT', '/me/meal-logs/mlg_a', { quantity: 2, unit: 'bowl' });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // 2 bowls is 2/1.5 of 1.5 bowls -- NOT 2/100. A countable unit scales
  // exactly the way grams do; nothing here may assume a gram basis.
  assert.equal(r.json.log.protein, 40);
  assert.equal(r.json.log.carbs, 20);
  assert.equal(r.json.log.fat, 30);
  assert.equal(r.json.log.quantity, 2);
  assert.equal(r.json.log.unit, 'bowl');

  const row = await db.q1('SELECT * FROM meal_logs WHERE id = ?', ['mlg_a']);
  assert.equal(row.protein, 40, 'persisted, not just echoed in the response');
  assert.equal(row.quantity, 2);
});

test('a quantity edit with NO known baseline records the amount and leaves macros untouched', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  // A legacy row: real macros, but the amount they describe was never
  // stored. This is every entry logged before the client began sending
  // `quantity`, so it is ordinary production data, not an edge case.
  await insertLog(db, { id: 'mlg_b', quantity: null, unit: null, calories: 382.5, protein: 30, carbs: 15, fat: 22.5 });

  const r = await api.call('PUT', '/me/meal-logs/mlg_b', { quantity: 2, unit: 'bowl' });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // The old `|| 100` fallback produced 0.6 g of protein here. There is no
  // denominator to divide by, so the only correct answer is to not divide.
  assert.equal(r.json.log.protein, 30, 'macros are preserved when the baseline is unknown');
  assert.equal(r.json.log.carbs, 15);
  assert.equal(r.json.log.fat, 22.5);
  assert.equal(r.json.log.quantity, 2, 'the stated amount is still recorded');
  assert.equal(r.json.log.unit, 'bowl');
});

test('once a baseline exists, the NEXT edit scales from it normally', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  await insertLog(db, { id: 'mlg_c', quantity: null, unit: null, calories: 382.5, protein: 30, carbs: 15, fat: 22.5 });

  // First edit establishes "this is 2 bowls" without touching nutrition.
  await api.call('PUT', '/me/meal-logs/mlg_c', { quantity: 2, unit: 'bowl' });
  // Second edit now has something real to scale from: 3/2.
  const r = await api.call('PUT', '/me/meal-logs/mlg_c', { quantity: 3, unit: 'bowl' });

  assert.equal(r.json.log.protein, 45);
  assert.equal(r.json.log.carbs, 22.5);
  assert.equal(r.json.log.fat, 33.8);
});
