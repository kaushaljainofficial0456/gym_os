// ============================================================
// Phase 2 -- multi-gym identity, centralized permissions, branches.
// Covers: hasPermission's role matrix, gymMemberships.js's service
// primitives, the /setup-org -> gym_memberships sync, /switch-gym
// (including cross-gym access being blocked for a user with no
// membership there), and the branches CRUD routes.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hasPermission, PERMISSIONS } from '../src/permissions.js';
import { syncPrimaryMembership, listUserMemberships, getActiveMembership, revokeMembership } from '../src/services/enterprise/gymMemberships.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec(`ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`);
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
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function setupOwner(api, email, orgName) {
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  return { token: signup.json.token, orgId: signup.json.user.orgId, userId: signup.json.user.id };
}

test.beforeEach(() => { resetRateLimits(); });

// ---------------------------------------------------------------
// PERMISSIONS
// ---------------------------------------------------------------

test('hasPermission: SUPER_ADMIN\'s wildcard grants everything', () => {
  assert.equal(hasPermission('SUPER_ADMIN', 'billing.refund'), true);
  assert.equal(hasPermission('SUPER_ADMIN', 'anything.at.all.made.up'), true);
});

test('hasPermission: GYM_OWNER has billing.refund, CLIENT does not', () => {
  assert.equal(hasPermission('GYM_OWNER', 'billing.refund'), true);
  assert.equal(hasPermission('CLIENT', 'billing.refund'), false);
});

test('hasPermission: MANAGER can manage members/trainers but cannot refund billing', () => {
  assert.equal(hasPermission('MANAGER', 'members.manage'), true);
  assert.equal(hasPermission('MANAGER', 'trainers.manage'), true);
  assert.equal(hasPermission('MANAGER', 'billing.refund'), false, 'refunds are deliberately GYM_OWNER/SUPER_ADMIN only in the matrix');
});

test('hasPermission: STAFF is limited to attendance + viewing members only', () => {
  assert.equal(hasPermission('STAFF', 'attendance.manage'), true);
  assert.equal(hasPermission('STAFF', 'members.view'), true);
  assert.equal(hasPermission('STAFF', 'members.manage'), false);
});

test('hasPermission: an unrecognized role is denied by default, never implicitly allowed', () => {
  assert.equal(hasPermission('SOME_MADE_UP_ROLE', 'members.view'), false);
  assert.equal(hasPermission(undefined, 'members.view'), false);
});

test('PERMISSIONS matrix: every listed role except SUPER_ADMIN uses explicit permission strings, never a wildcard', () => {
  for (const [role, perms] of Object.entries(PERMISSIONS)) {
    if (role === 'SUPER_ADMIN') continue;
    assert.ok(!perms.includes('*'), `${role} must not carry an unrestricted wildcard`);
  }
});

// ---------------------------------------------------------------
// gymMemberships.js service
// ---------------------------------------------------------------

test('syncPrimaryMembership: idempotent -- calling it twice for the same (user, org) never creates a duplicate row', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES ('u1', 'o1', 'a@test.com', 'x', 'GYM_OWNER', 'A', '2026-01-01T00:00:00Z')`);
  await syncPrimaryMembership(db, { userId: 'u1', orgId: 'o1', role: 'GYM_OWNER' });
  await syncPrimaryMembership(db, { userId: 'u1', orgId: 'o1', role: 'GYM_OWNER' });
  const rows = await db.q('SELECT * FROM gym_memberships WHERE user_id = ? AND org_id = ?', ['u1', 'o1']);
  assert.equal(rows.length, 1);
});

test('getActiveMembership / revokeMembership: a revoked membership is no longer active', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Gym', 'gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES ('u1', 'o1', 'a@test.com', 'x', 'TRAINER', 'A', '2026-01-01T00:00:00Z')`);
  await syncPrimaryMembership(db, { userId: 'u1', orgId: 'o1', role: 'TRAINER' });
  assert.ok(await getActiveMembership(db, { userId: 'u1', orgId: 'o1' }));
  const revoked = await revokeMembership(db, { userId: 'u1', orgId: 'o1' });
  assert.equal(revoked, true);
  assert.equal(await getActiveMembership(db, { userId: 'u1', orgId: 'o1' }), null);
});

// ---------------------------------------------------------------
// Integration: signup syncs gym_memberships, switch-gym, cross-gym block
// ---------------------------------------------------------------

test('/auth/setup-org: creates a matching ACTIVE gym_memberships row for the new owner', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner1@test.com', 'Gym One');

  const row = await db.q1('SELECT * FROM gym_memberships WHERE user_id = ? AND org_id = ?', [owner.userId, owner.orgId]);
  assert.ok(row);
  assert.equal(row.role, 'GYM_OWNER');
  assert.equal(row.status, 'ACTIVE');

  const list = await api.call('GET', '/api/auth/my-gyms', undefined, owner.token);
  assert.equal(list.status, 200);
  assert.equal(list.json.memberships.length, 1);
  assert.equal(list.json.memberships[0].org_id, owner.orgId);
});

test('/auth/switch-gym: a user with NO membership at the target org is rejected -- cross-gym access blocked', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerA@test.com', 'Gym A');
  const ownerB = await setupOwner(api, 'ownerB@test.com', 'Gym B');

  const attempt = await api.call('POST', '/api/auth/switch-gym', { orgId: ownerB.orgId }, ownerA.token);
  assert.equal(attempt.status, 403);
});

test('/auth/switch-gym: a user with a genuine second membership switches successfully and gets a correctly-scoped token', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerA2@test.com', 'Gym A2');
  const ownerB = await setupOwner(api, 'ownerB2@test.com', 'Gym B2');

  // Grant ownerA's user a MANAGER membership at Gym B2 (the building
  // block for a future "invite a manager to a second gym" flow --
  // simulated directly here since no invite route exists yet).
  await syncPrimaryMembership(db, { userId: ownerA.userId, orgId: ownerB.orgId, role: 'MANAGER' });

  const switched = await api.call('POST', '/api/auth/switch-gym', { orgId: ownerB.orgId }, ownerA.token);
  assert.equal(switched.status, 200, JSON.stringify(switched.json));
  assert.equal(switched.json.user.orgId, ownerB.orgId);
  assert.equal(switched.json.user.role, 'MANAGER', 'the token now carries the ROLE FOR THAT GYM, not the primary GYM_OWNER role from Gym A');

  // ownerA's own primary identity (users.org_id/role) is untouched --
  // switching gyms is a per-session context change, never a mutation.
  const stillOwnerAtHome = await db.q1('SELECT org_id, role FROM users WHERE id = ?', [ownerA.userId]);
  assert.equal(stillOwnerAtHome.org_id, ownerA.orgId);
  assert.equal(stillOwnerAtHome.role, 'GYM_OWNER');
});

// ---------------------------------------------------------------
// Branches
// ---------------------------------------------------------------

test('branches: an owner can create and list branches for their own org, architecture-ready for multi-branch', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerbr@test.com', 'Branch Gym');

  const create = await api.call('POST', '/api/admin/branches', { name: 'Downtown', address: '1 Main St' }, owner.token);
  assert.equal(create.status, 201, JSON.stringify(create.json));

  const list = await api.call('GET', '/api/admin/branches', undefined, owner.token);
  assert.equal(list.status, 200);
  assert.equal(list.json.branches.length, 1);
  assert.equal(list.json.branches[0].name, 'Downtown');
  assert.equal(list.json.branches[0].status, 'ACTIVE');
});

test('branches: are tenant-isolated -- one org never sees another org\'s branches', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerbrA@test.com', 'Branch Gym A');
  const ownerB = await setupOwner(api, 'ownerbrB@test.com', 'Branch Gym B');
  await api.call('POST', '/api/admin/branches', { name: 'A Branch' }, ownerA.token);

  const listB = await api.call('GET', '/api/admin/branches', undefined, ownerB.token);
  assert.equal(listB.json.branches.length, 0, 'org B must never see org A\'s branch');
});
