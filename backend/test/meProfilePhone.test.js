// ============================================================
// Regression test for an audit-session fix: the Settings page's Phone
// Number field was accepted and showed "saved ✓", but PUT /me/profile
// never read `phone` from the body, and GET /auth/me never returned it
// -- so the value was silently discarded on save and could never be
// shown even if it had been. users.phone already existed and was
// already read by trainer-facing views (resolveClient's join in
// auth.js); this was the client's own self-service read/write path.
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
    raw: db,
  });
  return mk();
}

test('PUT /me/profile persists phone, and GET /auth/me returns it back', async (t) => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', ['c1', 'u1', 'o1', 'FAT_LOSS', '2026-01-01T00:00:00Z']);

  const meRoutes = (await import('../src/routes/me.js')).default;
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client' }, config.jwtSecret, { expiresIn: '1h' });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const before = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers }).then((r) => r.json());
  assert.equal(before.user.phone, null, 'no phone set yet');

  const save = await fetch(`http://127.0.0.1:${port}/api/me/profile`, {
    method: 'PUT', headers, body: JSON.stringify({ name: 'Client', phone: '+91 98765 43210' }),
  });
  assert.equal(save.status, 200);

  const after = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers }).then((r) => r.json());
  assert.equal(after.user.phone, '+91 98765 43210', 'must survive the round trip through PUT /me/profile and back out via GET /auth/me');

  // Clearing it (empty string) must set it back to null, not the literal string "".
  await fetch(`http://127.0.0.1:${port}/api/me/profile`, { method: 'PUT', headers, body: JSON.stringify({ phone: '' }) });
  const cleared = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers }).then((r) => r.json());
  assert.equal(cleared.user.phone, null);
});
