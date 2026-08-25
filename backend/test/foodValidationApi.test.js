// ============================================================
// Integration test: POST /me/foods (client custom food) must reject
// invalid macro data at the HTTP boundary, not just in the unit-tested
// validator -- see foodValidation.test.js for the pure-function cases.
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
    raw: db
  });
  return mk();
}

async function startApi() {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Org 1', 'gym-a', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client@test.com', 'x', 'Test Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);

  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Test' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test('POST /me/foods accepts a well-formed custom food', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('POST', '/api/me/foods', { name: 'Homemade Dal', calories: 150, protein: 9, carbs: 20, fat: 3 });
  assert.equal(r.status, 200);
  assert.ok(r.json.id);
});

test('POST /me/foods rejects negative calories rather than saving a corrupt row', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const r = await call('POST', '/api/me/foods', { name: 'Bad Food', calories: -500, protein: 10, carbs: 10, fat: 10 });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.json.details) && r.json.details.length > 0);
  const rows = await db.q('SELECT * FROM foods WHERE name = ?', ['Bad Food']);
  assert.equal(rows.length, 0, 'invalid food must never reach the database');
});

test('POST /me/foods rejects a physically impossible macro combination', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  // 60 + 30 + 30 = 120 g of protein+carb+fat claimed per 100 g of food.
  const r = await call('POST', '/api/me/foods', { name: 'Impossible Food', calories: 500, protein: 60, carbs: 30, fat: 30 });
  assert.equal(r.status, 400);
});

test('POST /me/foods still requires a name (now enforced by schema validation, 422 -- the route\'s own manual check behind it is still there too, just never reached first)', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const r = await call('POST', '/api/me/foods', { calories: 100 });
  assert.equal(r.status, 422);
});
