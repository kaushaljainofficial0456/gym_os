// ============================================================
// Independent clients without Google.
//
// POST /auth/register-independent: email + password sign-up into the
// shared Independent org. Google used to be the only way to become an
// Independent client, and Google refuses to sign in inside an embedded
// WebView -- the Barbell Android app -- so nobody could sign up there.
//
// POST /auth/independent: "Train on my own" from the Join your gym
// screen, for a client who signed up without a gym code and has no gym.
//
// Same in-memory SQLite approach as googleAuth.test.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
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
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db,
  });
  return mk();
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, cookie: res.headers.get('set-cookie') };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test.beforeEach(() => { resetRateLimits(); });

// ── /auth/register-independent ────────────────────────────────────────

test('POST /auth/register-independent: email sign-up makes a working client in the Independent org', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());

  const res = await api.call('POST', '/api/auth/register-independent', { name: 'Solo Lifter', email: 'Solo@Example.com', password: 'secret12' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.user.role, 'CLIENT');
  assert.equal(res.json.user.email, 'solo@example.com');
  assert.equal(res.json.user.orgSlug, 'independent');
  assert.ok(res.json.token);
  assert.match(res.cookie || '', /sk_token=/, 'signed in straight away');

  const user = await db.q1('SELECT * FROM users WHERE id = ?', [res.json.user.id]);
  assert.equal(user.email_verified, 0, 'an address nobody has confirmed yet is not marked verified');
  const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [user.id]);
  assert.ok(client, 'a clients row exists, so the client app has someone to load');
  assert.equal(client.org_id, user.org_id);
  assert.ok(await db.q1('SELECT 1 AS ok FROM client_profiles WHERE client_id = ?', [client.id]));
  const org = await db.q1('SELECT type FROM organizations WHERE id = ?', [user.org_id]);
  assert.equal(org.type, 'independent');
  const settings = await db.q1('SELECT crowd_enabled, community_enabled FROM gym_settings WHERE org_id = ?', [user.org_id]);
  assert.deepEqual({ ...settings }, { crowd_enabled: 0, community_enabled: 0 });
});

test('POST /auth/register-independent: the new account signs back in with /auth/login', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const made = await api.call('POST', '/api/auth/register-independent', { name: 'Back Again', email: 'back@example.com', password: 'secret12' });
  assert.equal(made.status, 201);

  const login = await api.call('POST', '/api/auth/login', { email: 'BACK@example.com', password: 'secret12' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.user.id, made.json.user.id);
  assert.equal(login.json.user.orgSlug, 'independent');
});

test('POST /auth/register-independent: shares the one Independent org with Google sign-ups', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const a = await api.call('POST', '/api/auth/register-independent', { name: 'A', email: 'a@example.com', password: 'secret12' });
  const b = await api.call('POST', '/api/auth/register-independent', { name: 'B', email: 'b@example.com', password: 'secret12' });
  assert.equal(a.json.user.orgId, b.json.user.orgId);
  assert.equal((await db.q("SELECT id FROM organizations WHERE slug = 'independent'")).length, 1);
});

test('POST /auth/register-independent: an email that already has an account is a clear 409, nothing created', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_x', NULL, 'taken@example.com', 'x', 'TRAINER', 'Coach', 1, '2026-01-01T00:00:00Z')`);

  const res = await api.call('POST', '/api/auth/register-independent', { name: 'Someone', email: 'Taken@Example.com', password: 'secret12' });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'EMAIL_TAKEN');
  assert.match(res.json.error, /Sign in/);
  assert.equal(res.cookie, null);
  assert.equal((await db.q1('SELECT role FROM users WHERE email = ?', ['taken@example.com'])).role, 'TRAINER', 'the existing account is untouched');
  assert.equal((await db.q('SELECT id FROM clients')).length, 0);
});

test('POST /auth/register-independent: bad input is a 4xx, never an account', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  for (const body of [
    { name: 'Short', email: 'short@example.com', password: '123' },
    { name: '', email: 'noname@example.com', password: 'secret12' },
    { name: '   ', email: 'blank@example.com', password: 'secret12' },
    { name: 'Bad Email', email: 'not-an-email', password: 'secret12' },
  ]) {
    const res = await api.call('POST', '/api/auth/register-independent', body);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} -> ${res.status}`);
  }
  assert.equal((await db.q('SELECT id FROM users')).length, 0);
});

// ── /auth/independent: "Train on my own" ──────────────────────────────

test('POST /auth/independent: a client waiting on Join your gym becomes an Independent client', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const pending = await api.call('POST', '/api/auth/register', { name: 'No Gym', email: 'nogym@example.com', password: 'secret12' });
  assert.equal(pending.status, 201);
  assert.equal(pending.json.user.pendingGymEnrollment, true);

  const res = await api.call('POST', '/api/auth/independent', undefined, pending.json.token);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.user.orgSlug, 'independent');
  assert.match(res.cookie || '', /sk_token=/, 'a fresh session carries the new org');

  const user = await db.q1('SELECT org_id FROM users WHERE id = ?', [pending.json.user.id]);
  assert.equal(user.org_id, res.json.user.orgId);
  const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [pending.json.user.id]);
  assert.ok(client);
  assert.equal(client.org_id, user.org_id);
  assert.ok(await db.q1('SELECT 1 AS ok FROM client_profiles WHERE client_id = ?', [client.id]));

  const again = await api.call('POST', '/api/auth/independent', undefined, res.json.token);
  assert.equal(again.status, 200, 'a second tap is harmless');
  assert.equal((await db.q('SELECT id FROM clients WHERE user_id = ?', [pending.json.user.id])).length, 1, 'never a second client row');
});

test('POST /auth/independent: a member of a real gym, a trainer, or no session is refused', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await api.call('POST', '/api/auth/setup-org', { orgName: 'Iron Gym', ownerName: 'Owner', email: 'owner@iron.test', password: 'ownerpass1' });
  assert.equal(owner.status, 201);
  const member = await api.call('POST', '/api/auth/register', { name: 'Member', email: 'member@iron.test', password: 'secret12', gymCode: owner.json.user.orgSlug });
  assert.equal(member.status, 201, JSON.stringify(member.json));
  const trainer = await api.call('POST', '/api/auth/register-trainer', { name: 'Coach', email: 'coach@iron.test', password: 'secret12' });

  const m = await api.call('POST', '/api/auth/independent', undefined, member.json.token);
  assert.equal(m.status, 409);
  assert.equal((await db.q1('SELECT org_id FROM users WHERE email = ?', ['member@iron.test'])).org_id, owner.json.user.orgId, 'still in their gym');

  assert.equal((await api.call('POST', '/api/auth/independent', undefined, trainer.json.token)).status, 403);
  assert.equal((await api.call('POST', '/api/auth/independent', undefined, owner.json.token)).status, 403);
  assert.equal((await api.call('POST', '/api/auth/independent')).status, 401);
  assert.equal((await db.q("SELECT id FROM organizations WHERE slug = 'independent'")).length, 0, 'nothing created for a refused request');
});

// ── Duplicate email on Postgres ───────────────────────────────────────

test('POST /auth/register: a duplicate email reported the Postgres way is a 409, not a 500', async (t) => {
  const db = await memDb();
  // What node-postgres throws for a unique violation in production.
  const pgDuplicate = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
  const run = db.run.bind(db);
  db.run = async (sql, params) => {
    if (/^\s*INSERT INTO users/i.test(sql)) throw pgDuplicate;
    return run(sql, params);
  };
  const api = await startApp(db); t.after(() => api.close());

  const res = await api.call('POST', '/api/auth/register', { name: 'Twice', email: 'twice@example.com', password: 'secret12' });
  assert.equal(res.status, 409, JSON.stringify(res.json));
});
