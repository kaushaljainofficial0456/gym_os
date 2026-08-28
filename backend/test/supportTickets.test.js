// ============================================================
// Support tickets (Phase 3b) -- owner-facing (own org only, never sees
// internal admin notes) vs. console-facing (platform-wide, sees
// everything). The one thing worth over-testing here: an internal note
// must never leak to the owner-facing read, at the query level, not
// just hidden by a frontend that happens to not render it.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';

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
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/admin', adminRoutes(db));
  app.use('/api/console', consoleRoutes(db));
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

async function createSuperAdmin(db, api, email = 'admin@sk-os.test') {
  const userId = id('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Platform Admin', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

test.beforeEach(() => { resetRateLimits(); });

test('owner: can create a ticket and see it in their own list', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerT1@test.com', 'Ticket Gym');

  const create = await api.call('POST', '/api/admin/support', { category: 'PAYMENT', subject: 'Refund not showing', body: 'A client says their refund never arrived.' }, owner.token);
  assert.equal(create.status, 201, JSON.stringify(create.json));
  assert.equal(create.json.ticket.status, 'OPEN');

  const list = await api.call('GET', '/api/admin/support', undefined, owner.token);
  assert.equal(list.json.tickets.length, 1);
});

test('owner: tenant-isolated -- cannot see or fetch another org\'s ticket', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerTA@test.com', 'Ticket Gym A');
  const ownerB = await setupOwner(api, 'ownerTB@test.com', 'Ticket Gym B');
  const created = await api.call('POST', '/api/admin/support', { category: 'OTHER', subject: 'A only', body: 'body' }, ownerA.token);

  const listB = await api.call('GET', '/api/admin/support', undefined, ownerB.token);
  assert.equal(listB.json.tickets.length, 0);
  const detailB = await api.call('GET', `/api/admin/support/${created.json.ticket.id}`, undefined, ownerB.token);
  assert.equal(detailB.status, 404);
});

test('owner-facing ticket detail NEVER includes an internal admin note, even when one exists', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerT2@test.com', 'Ticket Gym 2');
  const admin = await createSuperAdmin(db, api);
  const created = await api.call('POST', '/api/admin/support', { category: 'TECHNICAL', subject: 'Bug report', body: 'Something is broken.' }, owner.token);

  await api.call('POST', `/api/console/support/${created.json.ticket.id}/messages`, { body: 'Internal: this is a known Postgres bigint bug, do not tell the customer yet.', internal: true }, admin.token);
  await api.call('POST', `/api/console/support/${created.json.ticket.id}/messages`, { body: 'Thanks for reporting -- we are looking into it.', internal: false }, admin.token);

  const ownerView = await api.call('GET', `/api/admin/support/${created.json.ticket.id}`, undefined, owner.token);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.json.messages.length, 2, 'the client\'s own opening message + the one public reply, NOT the internal note');
  assert.ok(!ownerView.json.messages.some((m) => m.body.includes('do not tell the customer')), 'internal note must never leak to the owner-facing read');

  const adminView = await api.call('GET', `/api/console/support/${created.json.ticket.id}`, undefined, admin.token);
  assert.equal(adminView.json.messages.length, 3, 'the admin view sees everything, including the internal note');
});

test('console: platform-wide list spans multiple gyms, and status changes are audited', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerT3@test.com', 'Ticket Gym 3');
  const ownerB = await setupOwner(api, 'ownerT4@test.com', 'Ticket Gym 4');
  await api.call('POST', '/api/admin/support', { category: 'BILLING', subject: 'From gym 3', body: 'body' }, ownerA.token);
  await api.call('POST', '/api/admin/support', { category: 'BILLING', subject: 'From gym 4', body: 'body' }, ownerB.token);
  const admin = await createSuperAdmin(db, api);

  const list = await api.call('GET', '/api/console/support', undefined, admin.token);
  assert.equal(list.status, 200);
  assert.equal(list.json.tickets.length, 2);
  const orgNames = list.json.tickets.map((t2) => t2.org_name).sort();
  assert.deepEqual(orgNames, ['Ticket Gym 3', 'Ticket Gym 4']);

  const ticketId = list.json.tickets[0].id;
  const statusChange = await api.call('POST', `/api/console/support/${ticketId}/status`, { status: 'RESOLVED' }, admin.token);
  assert.equal(statusChange.status, 200);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'support_ticket_status_changed' && l.entity_id === ticketId));
});

test('a non-internal reply re-opens a RESOLVED ticket to IN_PROGRESS; an internal note never does', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerT5@test.com', 'Ticket Gym 5');
  const admin = await createSuperAdmin(db, api);
  const created = await api.call('POST', '/api/admin/support', { category: 'OTHER', subject: 'Reopen test', body: 'body' }, owner.token);
  await api.call('POST', `/api/console/support/${created.json.ticket.id}/status`, { status: 'RESOLVED' }, admin.token);

  await api.call('POST', `/api/console/support/${created.json.ticket.id}/messages`, { body: 'internal thought', internal: true }, admin.token);
  let ticket = await api.call('GET', `/api/console/support/${created.json.ticket.id}`, undefined, admin.token);
  assert.equal(ticket.json.ticket.status, 'RESOLVED', 'an internal note alone must not reopen a resolved ticket');

  await api.call('POST', `/api/admin/support/${created.json.ticket.id}/messages`, { body: 'Actually still broken' }, owner.token);
  ticket = await api.call('GET', `/api/console/support/${created.json.ticket.id}`, undefined, admin.token);
  assert.equal(ticket.json.ticket.status, 'IN_PROGRESS');
});
