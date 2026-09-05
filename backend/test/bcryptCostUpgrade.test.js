// ============================================================
// F-12h REGRESSION: bcrypt cost bumped from 10 -> 12 (benchmarked:
// ~75ms -> ~263ms per hash, well under any reasonable login-latency
// budget at this app's documented ~2,500-client scale -- this runs once
// per login/signup/password-change, never per request).
//
// Backward compatibility is the point of this test file: an existing
// account hashed at the OLD cost (10) must keep authenticating with NO
// migration step, AND get transparently upgraded to the new cost on its
// next successful login -- both verified directly against real bcrypt
// hashes (not mocked), including a real end-to-end login through
// routes/auth.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import express from 'express';
import { hashPassword, verifyPassword, needsRehash } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  };
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('hashPassword() produces a cost-12 hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  const cost = Number(hash.split('$')[2]);
  assert.equal(cost, 12);
});

test('needsRehash: a cost-10 hash needs upgrading, a cost-12 hash does not', async () => {
  const oldHash = await bcrypt.hash('somepassword', 10);
  const newHash = await bcrypt.hash('somepassword', 12);
  assert.equal(needsRehash(oldHash), true);
  assert.equal(needsRehash(newHash), false);
  assert.equal(needsRehash(''), true, 'a garbage/empty hash is treated as needing rehash, never crashes');
  assert.equal(needsRehash(null), true);
});

test('an existing cost-10 password hash still authenticates correctly (no migration needed)', async () => {
  const oldHash = await bcrypt.hash('legacy-password-123', 10);
  const ok = await verifyPassword('legacy-password-123', oldHash);
  const wrong = await verifyPassword('wrong-password', oldHash);
  assert.equal(ok, true);
  assert.equal(wrong, false);
});

test('end-to-end login: a cost-10 account is transparently upgraded to cost-12 in the DB on successful login', async (t) => {
  const db = await memDb();
  const oldHash = await bcrypt.hash('legacy-password-123', 10);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'legacy@x.in', ?, 'CLIENT', 'Legacy User', 1, '2026-01-01T00:00:00Z')`,
    [oldHash]);

  const before = await db.q1('SELECT password_hash FROM users WHERE id = ?', ['u1']);
  assert.equal(Number(before.password_hash.split('$')[2]), 10, 'sanity: really starts at cost 10');

  const api = await startApp(db);
  t.after(() => api.close());
  const login = await api.call('POST', '/api/auth/login', { email: 'legacy@x.in', password: 'legacy-password-123' });
  assert.equal(login.status, 200, 'the OLD-cost hash still authenticates successfully through the real login route');

  // Rehash is fire-and-forget inside the route (never blocks the login
  // response) -- give it a tick to land before asserting on the DB.
  await new Promise((r) => setImmediate(r));
  const after = await db.q1('SELECT password_hash FROM users WHERE id = ?', ['u1']);
  assert.equal(Number(after.password_hash.split('$')[2]), 12, 'password_hash was transparently rehashed to the new cost after a successful login');
  assert.notEqual(after.password_hash, before.password_hash);

  // And the NEW hash still authenticates correctly on a second login.
  const login2 = await api.call('POST', '/api/auth/login', { email: 'legacy@x.in', password: 'legacy-password-123' });
  assert.equal(login2.status, 200, 'the freshly-upgraded cost-12 hash authenticates correctly too');
});

test('wrong password against a cost-10 hash is still rejected (rehash never fires on a failed login)', async (t) => {
  const db = await memDb();
  const oldHash = await bcrypt.hash('legacy-password-123', 10);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym-o1', '2026-01-01T00:00:00Z']);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'legacy2@x.in', ?, 'CLIENT', 'Legacy User', 1, '2026-01-01T00:00:00Z')`,
    [oldHash]);
  const api = await startApp(db);
  t.after(() => api.close());
  const login = await api.call('POST', '/api/auth/login', { email: 'legacy2@x.in', password: 'totally-wrong' });
  assert.equal(login.status, 401);
  await new Promise((r) => setImmediate(r));
  const after = await db.q1('SELECT password_hash FROM users WHERE id = ?', ['u1']);
  assert.equal(Number(after.password_hash.split('$')[2]), 10, 'a failed login never touches the stored hash');
});
