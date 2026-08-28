// ============================================================
// POST /auth/google/enterprise -- the gym-owner "Continue with Google"
// flow. Mocks OAuth2Client.prototype.verifyIdToken (zero real network
// calls, same zero-cost-testing philosophy as the mock payment
// provider elsewhere in this suite) so the route's own branching logic
// -- new signup vs. existing owner login vs. wrong-role rejection --
// is what's actually under test, not Google's live API.
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
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

function mockGoogleIdentity(payload) {
  return mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => ({ getPayload: () => payload }));
}

test.beforeEach(() => { resetRateLimits(); });
test.afterEach(() => { mock.restoreAll(); });

test('POST /auth/google/enterprise: a brand-new signup creates the org, owner, billing state, and a matching gym_memberships row', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'newowner@test.com', name: 'New Owner', picture: 'https://example.com/pic.jpg' });

  const res = await api.call('POST', '/api/auth/google/enterprise', { credential: 'fake-credential-token-000000', orgName: 'Google Signup Gym' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.user.role, 'GYM_OWNER');
  assert.equal(res.json.user.orgName, 'Google Signup Gym');
  assert.ok(res.json.token);

  const billing = await db.q1('SELECT status FROM org_billing_state WHERE org_id = ?', [res.json.user.orgId]);
  assert.equal(billing.status, 'SETUP', 'a fresh gym-owner signup starts in SETUP, exactly like /setup-org');

  const membership = await db.q1('SELECT role, status FROM gym_memberships WHERE user_id = ? AND org_id = ?', [res.json.user.id, res.json.user.orgId]);
  assert.equal(membership.role, 'GYM_OWNER');
  assert.equal(membership.status, 'ACTIVE');

  const userRow = await db.q1('SELECT password_hash FROM users WHERE id = ?', [res.json.user.id]);
  assert.ok(userRow.password_hash, 'a Google-only account still gets an unusable random hash, never a NULL/empty password column');
});

test('POST /auth/google/enterprise: missing orgName on a first-time signup is rejected, never defaults to something silent', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  mockGoogleIdentity({ email: 'noorgname@test.com', name: 'No Org Name' });

  const res = await api.call('POST', '/api/auth/google/enterprise', { credential: 'fake-credential-token-000000' });
  assert.equal(res.status, 422);
  const users = await db.q('SELECT * FROM users WHERE email = ?', ['noorgname@test.com']);
  assert.equal(users.length, 0, 'nothing must be created when orgName is missing');
});

test('POST /auth/google/enterprise: an existing GYM_OWNER logs straight in via Google, ignoring any orgName sent', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName: 'Existing Gym', ownerName: 'Existing Owner', email: 'existingowner@test.com', password: 'ownerpass1' });
  assert.equal(signup.status, 201);

  mockGoogleIdentity({ email: 'existingowner@test.com', name: 'Existing Owner' });
  const res = await api.call('POST', '/api/auth/google/enterprise', { credential: 'fake-credential-token-000000', orgName: 'A Totally Different Name' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.user.orgId, signup.json.user.orgId);
  assert.equal(res.json.user.orgName, 'Existing Gym', 'the REAL org name is returned, never the ignored orgName from the request body');

  const orgs = await db.q('SELECT * FROM organizations');
  assert.equal(orgs.length, 1, 'logging in via Google must never create a second organization for an existing owner');
});

test('POST /auth/google/enterprise: an email already registered as a CLIENT is rejected, never silently promoted to GYM_OWNER', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  // A direct insert is all this test actually needs -- "some non-
  // GYM_OWNER user already owns this email" -- independent of any
  // particular signup route's own request shape.
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('usr_client1', NULL, 'iamaclient@test.com', 'x', 'CLIENT', 'A Client', 1, '2026-01-01T00:00:00Z')`);

  mockGoogleIdentity({ email: 'iamaclient@test.com', name: 'A Client' });
  const res = await api.call('POST', '/api/auth/google/enterprise', { credential: 'fake-credential-token-000000', orgName: 'Should Not Matter' });
  assert.equal(res.status, 409);
  const row = await db.q1('SELECT role FROM users WHERE email = ?', ['iamaclient@test.com']);
  assert.equal(row.role, 'CLIENT', 'the existing account\'s role must never change');
});

test('POST /auth/google/enterprise: server without GOOGLE_CLIENT_ID configured returns 503, never silently proceeds', async (t) => {
  const original = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const db = await memDb();
    const api = await startApp(db); t.after(() => api.close());
    const res = await api.call('POST', '/api/auth/google/enterprise', { credential: 'fake-credential-token-000000', orgName: 'Gym' });
    assert.equal(res.status, 503);
  } finally {
    if (original !== undefined) process.env.GOOGLE_CLIENT_ID = original;
  }
});
