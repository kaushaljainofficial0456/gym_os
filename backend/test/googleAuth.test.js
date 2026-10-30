// ============================================================
// POST /auth/google (Independent client) and POST /auth/google/signin
// (the Sign in screen's "Continue with Google"). Same zero-network
// approach as googleEnterpriseAuth.test.js: OAuth2Client's verifyIdToken
// is mocked, so the routes' own branching is what is under test.
//
// /auth/google's new-user path had no test at all, and an account made
// with Google had no way back in from the Sign in screen -- the gap
// /auth/google/signin closes.
// ============================================================
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { resetRateLimits } from '../src/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// See googleEnterpriseAuth.test.js: the routes 503 without a client id.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client-id-for-ci';

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
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, cookie: res.headers.get('set-cookie') };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

function mockGoogleIdentity(payload) {
  const full = { email_verified: true, ...payload };
  return mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => ({ getPayload: () => full }));
}

const CRED = { credential: 'fake-credential-token-000000' };

test.beforeEach(() => { resetRateLimits(); });
test.afterEach(() => { mock.restoreAll(); });

// ── /auth/google: the Independent client path ─────────────────────────

test('POST /auth/google: a brand-new person gets a working client account in the Independent org', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'New.Person@Gmail.com', name: 'New Person', picture: 'https://lh3.googleusercontent.com/a/x' });

  const res = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.user.role, 'CLIENT');
  assert.equal(res.json.user.email, 'new.person@gmail.com', 'stored lower-cased, as every other login looks it up');
  assert.equal(res.json.user.orgSlug, 'independent');
  assert.ok(res.json.token);
  assert.match(res.cookie || '', /sk_token=/, 'the session cookie is set, not just the token');

  const user = await db.q1('SELECT * FROM users WHERE id = ?', [res.json.user.id]);
  assert.equal(user.email_verified, 1);
  assert.equal(user.avatar, 'https://lh3.googleusercontent.com/a/x');
  const client = await db.q1('SELECT * FROM clients WHERE user_id = ?', [user.id]);
  assert.ok(client, 'a clients row exists, so the client app has someone to load');
  assert.ok(await db.q1('SELECT 1 AS ok FROM client_profiles WHERE client_id = ?', [client.id]));
  const settings = await db.q1('SELECT crowd_enabled, community_enabled FROM gym_settings WHERE org_id = ?', [user.org_id]);
  assert.deepEqual({ ...settings }, { crowd_enabled: 0, community_enabled: 0 }, 'gym-only features are off for the Independent org');
});

test('POST /auth/google: the same person signing in again gets the same account, not a second one', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'again@gmail.com', name: 'Again' });

  const first = await api.call('POST', '/api/auth/google', CRED);
  const second = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.user.id, first.json.user.id);
  const users = await db.q('SELECT id FROM users WHERE email = ?', ['again@gmail.com']);
  assert.equal(users.length, 1);
  const orgs = await db.q("SELECT id FROM organizations WHERE slug = 'independent'");
  assert.equal(orgs.length, 1, 'the shared Independent org is created once');
});

test('POST /auth/google: an unverified address can still create a new account, recorded as unverified', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'unverified@example.com', name: 'Unverified', email_verified: false });

  const res = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const user = await db.q1('SELECT email_verified FROM users WHERE id = ?', [res.json.user.id]);
  assert.equal(user.email_verified, 0, 'never claims a verification Google did not make');
});

test('POST /auth/google: an unverified address cannot sign in to an existing account', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'owner-of-this@example.com', name: 'Real' });
  const made = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(made.status, 201);

  mock.restoreAll();
  mockGoogleIdentity({ email: 'owner-of-this@example.com', name: 'Impostor', email_verified: false });
  const res = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(res.status, 403);
  assert.equal(res.json.token, undefined);
  assert.equal(res.cookie, null, 'no session cookie either');
});

test('POST /auth/google: a staff email is refused, never turned into a client', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_t1', NULL, 'coach@test.com', 'x', 'TRAINER', 'Coach', 1, '2026-01-01T00:00:00Z')`);
  mockGoogleIdentity({ email: 'coach@test.com', name: 'Coach' });

  const res = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(res.status, 409);
  const row = await db.q1('SELECT role FROM users WHERE email = ?', ['coach@test.com']);
  assert.equal(row.role, 'TRAINER');
});

// ── /auth/google/signin: the Sign in screen ───────────────────────────

test('POST /auth/google/signin: an account made with Google gets back in from Sign in', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'came.back@gmail.com', name: 'Came Back' });
  const made = await api.call('POST', '/api/auth/google', CRED);
  assert.equal(made.status, 201);

  const res = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.user.id, made.json.user.id);
  assert.equal(res.json.user.role, 'CLIENT');
  assert.equal(res.json.user.orgSlug, 'independent');
  assert.match(res.cookie || '', /sk_token=/);
});

test('POST /auth/google/signin: owners and trainers sign in too, with their own role and gym', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await api.call('POST', '/api/auth/setup-org', { orgName: 'Iron Gym', ownerName: 'Owner', email: 'owner@iron.test', password: 'ownerpass1' });
  assert.equal(owner.status, 201);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_t2', ?, 'trainer@iron.test', 'x', 'TRAINER', 'Trainer', 1, '2026-01-01T00:00:00Z')`, [owner.json.user.orgId]);

  mockGoogleIdentity({ email: 'owner@iron.test', name: 'Owner' });
  const o = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  assert.equal(o.json.user.role, 'GYM_OWNER');
  assert.equal(o.json.user.orgName, 'Iron Gym');

  mock.restoreAll();
  mockGoogleIdentity({ email: 'trainer@iron.test', name: 'Trainer' });
  const tr = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(tr.status, 200, JSON.stringify(tr.json));
  assert.equal(tr.json.user.role, 'TRAINER');
  assert.equal(tr.json.user.orgId, owner.json.user.orgId);

  const orgs = await db.q('SELECT id FROM organizations');
  assert.equal(orgs.length, 1, 'signing in never creates anything');
});

test('POST /auth/google/signin: no account yet is a clear 404 and creates nothing', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'stranger@gmail.com', name: 'Stranger' });

  const res = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'NO_ACCOUNT');
  assert.match(res.json.error, /stranger@gmail\.com/);
  assert.match(res.json.error, /Independent client/, 'says how to make one');
  assert.equal((await db.q('SELECT id FROM users')).length, 0);
  assert.equal((await db.q('SELECT id FROM organizations')).length, 0);
});

test('POST /auth/google/signin: unverified address, disabled account and platform admins are refused', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_c1', NULL, 'member@test.com', 'x', 'CLIENT', 'Member', 1, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_c2', NULL, 'gone@test.com', 'x', 'CLIENT', 'Gone', 0, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_a1', NULL, 'admin@test.com', 'x', 'SUPER_ADMIN', 'Admin', 1, '2026-01-01T00:00:00Z')`);

  mockGoogleIdentity({ email: 'member@test.com', name: 'Impostor', email_verified: false });
  const unverified = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(unverified.status, 403);
  assert.equal(unverified.cookie, null);

  mock.restoreAll();
  mockGoogleIdentity({ email: 'gone@test.com', name: 'Gone' });
  assert.equal((await api.call('POST', '/api/auth/google/signin', CRED)).status, 403);

  mock.restoreAll();
  mockGoogleIdentity({ email: 'admin@test.com', name: 'Admin' });
  const admin = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(admin.status, 404, 'the admin console has its own sign-in; Google never opens it');
  assert.equal(admin.cookie, null);
});

test('POST /auth/google/signin: a token Google rejects is a 401, never a session', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => { throw new Error('Wrong recipient, payload audience != requiredAudience'); });

  const res = await api.call('POST', '/api/auth/google/signin', CRED);
  assert.equal(res.status, 401);
  assert.equal(res.cookie, null);
});
