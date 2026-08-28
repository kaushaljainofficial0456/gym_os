// ============================================================
// Admin Console gap-closing pass (route-level, real HTTP): the 4
// routes an audit found with NO frontend caller and NO test coverage
// at all -- refund history, support ticket priority, support ticket
// assignment, and the platform-wide refunds list/export -- plus the
// new /admins roster the assignment picker needs. Same harness as
// orgPaymentRefundsConsole.test.js (real signup -> quote -> order ->
// verify flow, never hand-inserted payment_orders rows).
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
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  db.exec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT CHECK (lifecycle_status IN ('PENDING_PAYMENT','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','REFUND_PENDING','REFUNDED','TRANSFERRED'))`);
  db.exec(`ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`);
  db.exec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
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

async function seedPricing(db) {
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?)`, [nowIso, nowIso]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/csv')) return { status: res.status, contentType, text: await res.text() };
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
  return { token: signup.json.token, orgId: signup.json.user.orgId };
}

async function createSuperAdmin(db, api, email = 'admin@sk-os.test', name = 'Platform Admin') {
  const userId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), name, now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

async function buyOrgPackage(api, ownerToken) {
  const quote = await api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 75 }, ownerToken);
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  const order = await api.call('POST', '/api/enterprise/payment/order', { quoteId: quote.json.quote.id }, ownerToken);
  assert.equal(order.status, 200, JSON.stringify(order.json));
  const { paymentId, signature } = mockSimulateCheckout(order.json.order.provider_order_id);
  const verify = await api.call('POST', '/api/enterprise/payment/verify', { orderId: order.json.order.id, providerPaymentId: paymentId, signature }, ownerToken);
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return order.json.order.id;
}

async function seedTicket(db, { orgId, createdBy, priority = 'MEDIUM', subject = 'Billing question' }) {
  const ticketId = id('tkt');
  const nowIso = now();
  await db.run(
    `INSERT INTO support_tickets (id, org_id, created_by, category, priority, status, subject, created_at, updated_at)
     VALUES (?, ?, ?, 'BILLING', ?, 'OPEN', ?, ?, ?)`,
    [ticketId, orgId, createdBy, priority, subject, nowIso, nowIso]);
  return ticketId;
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

// ---------------------------------------------------------------
// GET /admins
// ---------------------------------------------------------------

test('GET /admins: lists only SUPER_ADMIN users, and never leaks password_hash', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api, 'admin1@sk-os.test', 'Priya Admin');
  await createSuperAdmin(db, api, 'admin2@sk-os.test', 'Rahul Admin');
  const owner = await setupOwner(api, 'owner@test.in', 'Some Gym');

  const res = await api.call('GET', '/api/console/admins', undefined, admin.token);
  assert.equal(res.status, 200);
  assert.equal(res.json.admins.length, 2, 'the gym owner must not appear in the admin roster');
  assert.ok(res.json.admins.every((a) => !('password_hash' in a)), 'password_hash must never be in the response');
  assert.deepEqual(Object.keys(res.json.admins[0]).sort(), ['email', 'id', 'name']);
});

test('GET /admins: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner2@test.in', 'Gym');
  const res = await api.call('GET', '/api/console/admins', undefined, owner.token);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------
// POST /support/:id/priority
// ---------------------------------------------------------------

test('POST /support/:id/priority: a valid change persists and is audited', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner3@test.in', 'Gym3');
  const admin = await createSuperAdmin(db, api);
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner3@test.in'])).id });

  const res = await api.call('POST', `/api/console/support/${ticketId}/priority`, { priority: 'URGENT' }, admin.token);
  assert.equal(res.status, 200);

  const ticket = await api.call('GET', `/api/console/support/${ticketId}`, undefined, admin.token);
  assert.equal(ticket.json.ticket.priority, 'URGENT');

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  const entry = audit.json.logs.find((l) => l.action === 'support_ticket_priority_changed' && l.entity_id === ticketId);
  assert.ok(entry, 'priority change must be audited');
  assert.equal(entry.before_json.priority, 'MEDIUM');
  assert.equal(entry.after_json.priority, 'URGENT');
});

test('POST /support/:id/priority: an invalid value is rejected by validation', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner4@test.in', 'Gym4');
  const admin = await createSuperAdmin(db, api);
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner4@test.in'])).id });

  const res = await api.call('POST', `/api/console/support/${ticketId}/priority`, { priority: 'CRITICAL' }, admin.token);
  assert.equal(res.status, 422);
});

test('POST /support/:id/priority: a nonexistent ticket 404s', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const admin = await createSuperAdmin(db, api);
  const res = await api.call('POST', '/api/console/support/does-not-exist/priority', { priority: 'HIGH' }, admin.token);
  assert.equal(res.status, 404);
});

test('POST /support/:id/priority: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner5@test.in', 'Gym5');
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner5@test.in'])).id });
  const res = await api.call('POST', `/api/console/support/${ticketId}/priority`, { priority: 'HIGH' }, owner.token);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------
// POST /support/:id/assign
// ---------------------------------------------------------------

test('POST /support/:id/assign: assign, reassign, and unassign all persist and are audited distinctly', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner6@test.in', 'Gym6');
  const admin1 = await createSuperAdmin(db, api, 'a1@sk-os.test', 'Admin One');
  const admin2 = await createSuperAdmin(db, api, 'a2@sk-os.test', 'Admin Two');
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner6@test.in'])).id });

  const assign1 = await api.call('POST', `/api/console/support/${ticketId}/assign`, { adminId: admin1.userId }, admin1.token);
  assert.equal(assign1.status, 200);
  let ticket = await api.call('GET', `/api/console/support/${ticketId}`, undefined, admin1.token);
  assert.equal(ticket.json.ticket.assigned_admin_id, admin1.userId);

  const reassign = await api.call('POST', `/api/console/support/${ticketId}/assign`, { adminId: admin2.userId }, admin1.token);
  assert.equal(reassign.status, 200);
  ticket = await api.call('GET', `/api/console/support/${ticketId}`, undefined, admin1.token);
  assert.equal(ticket.json.ticket.assigned_admin_id, admin2.userId);

  const unassign = await api.call('POST', `/api/console/support/${ticketId}/assign`, { adminId: null }, admin1.token);
  assert.equal(unassign.status, 200);
  ticket = await api.call('GET', `/api/console/support/${ticketId}`, undefined, admin1.token);
  assert.equal(ticket.json.ticket.assigned_admin_id, null);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin1.token);
  const actions = audit.json.logs.filter((l) => l.entity_id === ticketId).map((l) => l.action);
  assert.deepEqual(actions, ['support_ticket_unassigned', 'support_ticket_assigned', 'support_ticket_assigned'], 'newest first: unassign, reassign, first assign');
});

test('POST /support/:id/assign: an adminId that is not a real SUPER_ADMIN is rejected (no IDOR)', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner7@test.in', 'Gym7');
  const admin = await createSuperAdmin(db, api);
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner7@test.in'])).id });

  // The gym owner's own user id is a real user, just not a SUPER_ADMIN.
  const ownerUser = await db.q1('SELECT id FROM users WHERE email = ?', ['owner7@test.in']);
  const res = await api.call('POST', `/api/console/support/${ticketId}/assign`, { adminId: ownerUser.id }, admin.token);
  assert.equal(res.status, 422);
});

test('POST /support/:id/assign: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'owner8@test.in', 'Gym8');
  const admin = await createSuperAdmin(db, api);
  const ticketId = await seedTicket(db, { orgId: owner.orgId, createdBy: (await db.q1('SELECT id FROM users WHERE email = ?', ['owner8@test.in'])).id });
  const res = await api.call('POST', `/api/console/support/${ticketId}/assign`, { adminId: admin.userId }, owner.token);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------
// GET /gyms/:id/payments/:orderId/refunds -- per-order refund history
// ---------------------------------------------------------------

test('refund history: no refunds yet -> empty array, not an error', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerA1@test.in', 'GymA1');
  const admin = await createSuperAdmin(db, api);
  const orderId = await buyOrgPackage(api, owner.token);

  const res = await api.call('GET', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refunds`, undefined, admin.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.refunds, []);
});

test('refund history: multiple partial refunds show cumulative amount correctly; a third exceeding the remainder is rejected', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerA2@test.in', 'GymA2');
  const admin = await createSuperAdmin(db, api);
  const orderId = await buyOrgPackage(api, owner.token); // 12000 total

  const r1 = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, { amount: 5000, reason: 'partial 1' }, admin.token);
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const r2 = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, { amount: 4000, reason: 'partial 2' }, admin.token);
  assert.equal(r2.status, 200, JSON.stringify(r2.json));

  const history = await api.call('GET', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refunds`, undefined, admin.token);
  assert.equal(history.json.refunds.length, 2);
  const cumulative = history.json.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(cumulative, 9000);
  assert.ok(history.json.refunds.every((r) => r.status === 'SUCCESS' && r.type === 'PARTIAL'));

  // Only 3000 of the original 12000 remains -- asking for 4000 more must fail.
  const overRefund = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, { amount: 4000 }, admin.token);
  assert.equal(overRefund.status, 422);
  assert.equal(overRefund.json.error, 'exceeds_remaining_refundable');

  // A subsequent full refund of the exact remainder succeeds and flips the order to REFUNDED.
  const finalRefund = await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, {}, admin.token);
  assert.equal(finalRefund.status, 200, JSON.stringify(finalRefund.json));
  assert.equal(finalRefund.json.orderStatus, 'REFUNDED');
  assert.equal(finalRefund.json.refund.type, 'FULL', 'the last sliver that brings the order to fully-refunded is itself typed FULL');

  const finalHistory = await api.call('GET', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refunds`, undefined, admin.token);
  assert.equal(finalHistory.json.refunds.length, 3);
  const finalCumulative = finalHistory.json.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(finalCumulative, 12000, 'three refunds must sum to exactly the original payment, no drift');
});

test('refund history: gym isolation -- a different gym\'s order id 404s', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerA3@test.in', 'GymA3');
  const ownerB = await setupOwner(api, 'ownerB3@test.in', 'GymB3');
  const admin = await createSuperAdmin(db, api);
  const orderIdB = await buyOrgPackage(api, ownerB.token);

  const res = await api.call('GET', `/api/console/gyms/${ownerA.orgId}/payments/${orderIdB}/refunds`, undefined, admin.token);
  assert.equal(res.status, 404);
});

test('refund history: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerA4@test.in', 'GymA4');
  const orderId = await buyOrgPackage(api, owner.token);
  const res = await api.call('GET', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refunds`, undefined, owner.token);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------
// GET /refunds -- platform-wide list
// ---------------------------------------------------------------

test('GET /refunds: platform-wide, newest first, across different gyms; status filter works; joins the initiating admin\'s name', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const ownerA = await setupOwner(api, 'ownerR1@test.in', 'GymR1');
  const ownerB = await setupOwner(api, 'ownerR2@test.in', 'GymR2');
  const admin = await createSuperAdmin(db, api, 'refundadmin@sk-os.test', 'Refund Admin');
  const orderA = await buyOrgPackage(api, ownerA.token);
  const orderB = await buyOrgPackage(api, ownerB.token);

  await api.call('POST', `/api/console/gyms/${ownerA.orgId}/payments/${orderA}/refund`, {}, admin.token);
  await api.call('POST', `/api/console/gyms/${ownerB.orgId}/payments/${orderB}/refund`, {}, admin.token);

  const all = await api.call('GET', '/api/console/refunds', undefined, admin.token);
  assert.equal(all.status, 200);
  assert.equal(all.json.refunds.length, 2);
  assert.ok(all.json.refunds.every((r) => r.status === 'SUCCESS'));
  assert.ok(all.json.refunds.every((r) => r.initiated_by_name === 'Refund Admin'));
  const orgNames = all.json.refunds.map((r) => r.org_name).sort();
  assert.deepEqual(orgNames, ['GymR1', 'GymR2']);

  const filtered = await api.call('GET', '/api/console/refunds?status=FAILED', undefined, admin.token);
  assert.equal(filtered.json.refunds.length, 0);
});

test('GET /refunds: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerR3@test.in', 'GymR3');
  const res = await api.call('GET', '/api/console/refunds', undefined, owner.token);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------
// GET /export/refunds -- CSV
// ---------------------------------------------------------------

test('GET /export/refunds: correct headers, real rows, and no secret/internal columns ever leak', async (t) => {
  const db = await memDb(); await seedPricing(db);
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerR4@test.in', 'GymR4');
  const admin = await createSuperAdmin(db, api);
  const orderId = await buyOrgPackage(api, owner.token);
  await api.call('POST', `/api/console/gyms/${owner.orgId}/payments/${orderId}/refund`, { reason: 'export test' }, admin.token);

  const res = await api.call('GET', '/api/console/export/refunds', undefined, admin.token);
  assert.equal(res.status, 200);
  assert.ok(res.contentType.includes('text/csv'));
  const [headerLine, ...rows] = res.text.trim().split('\n');
  assert.equal(headerLine, 'id,org_id,org_name,payment_order_id,type,amount,currency,status,reason,created_at');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('GymR4'));
  assert.ok(rows[0].includes('export test'));
  // Explicit allow-list -- nothing beyond the 10 named columns can ever
  // appear, regardless of what future columns land on the refunds table
  // (e.g. a provider secret or an internal-only field).
  assert.equal(headerLine.split(',').length, 10);
  const forbidden = ['password', 'secret', 'provider_refund_id', 'failure_reason', 'initiated_by'];
  for (const term of forbidden) assert.ok(!headerLine.includes(term), `CSV header must never include "${term}"`);

  const audit = await api.call('GET', '/api/console/audit', undefined, admin.token);
  assert.ok(audit.json.logs.some((l) => l.action === 'data_export' && l.after_json?.export === 'refunds'));
});

test('GET /export/refunds: blocked for a non-SUPER_ADMIN', async (t) => {
  const db = await memDb();
  const api = await startApp(db); t.after(() => api.close());
  const owner = await setupOwner(api, 'ownerR5@test.in', 'GymR5');
  const res = await api.call('GET', '/api/console/export/refunds', undefined, owner.token);
  assert.equal(res.status, 403);
});
