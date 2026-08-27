// ============================================================
// Payment reconciliation -- sweeps stale non-terminal payment_orders
// against the (mock) provider's own view, recovers what it safely can,
// and flags the rest for human review. See services/payments/
// reconciliation.js's own header comment for the exact rules.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';
import { registerActivationHandler } from '../src/services/payments/paymentActivation.js';
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';
import { runReconciliationSweep, listReconciliationIssues, resolveReconciliationIssue } from '../src/services/payments/reconciliation.js';

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

async function seedOrg(db, id = 'o1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [id, 'Gym ' + id, 'gym-' + id, '2026-01-01T00:00:00Z']);
}

async function backdate(db, orderId, iso) {
  await db.run('UPDATE payment_orders SET created_at = ? WHERE id = ?', [iso, orderId]);
}

test.beforeEach(() => { _resetMockProviderStateForTests(); });

test('runReconciliationSweep: recovers an order the provider actually completed but SK OS never heard about', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('CLIENT_MEMBERSHIP', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'CLIENT_MEMBERSHIP', subjectId: 'enr1', orgId: 'o1', amount: 1500 });
  // The gateway's checkout completed successfully (mockSimulateCheckout
  // marks the mock order 'paid') -- but neither the checkout-return NOR
  // a webhook ever reached recordCheckoutVerification/recordWebhookEvent,
  // simulating a browser that closed before redirecting back AND a
  // webhook that never arrived.
  mockSimulateCheckout(order.provider_order_id);
  await backdate(db, order.id, '2020-01-01T00:00:00Z');

  const summary = await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 });
  assert.equal(summary.checked, 1);
  assert.equal(summary.recovered, 1);
  assert.equal(summary.flagged, 0);
  assert.equal(activated, 1, 'the stuck order must actually get activated, not just marked SUCCESS');

  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'SUCCESS');

  const issues = await listReconciliationIssues(db, { orgId: 'o1' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issue_type, 'RECOVERED');
});

test('runReconciliationSweep: converges to FAILED when the provider also gave up, and releases whatever was held', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id, { outcome: 'failure' });
  await backdate(db, order.id, '2020-01-01T00:00:00Z');

  const summary = await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 });
  assert.equal(summary.recovered, 1);
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'FAILED');
});

test('runReconciliationSweep: an abandoned checkout (still CREATED at the provider too) is flagged, never auto-failed', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  // Never simulate checkout at all -- the mock order stays 'created'.
  await backdate(db, order.id, '2020-01-01T00:00:00Z');

  const summary = await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 });
  assert.equal(summary.flagged, 1);
  assert.equal(summary.recovered, 0);
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'CREATED', 'an abandoned checkout is never force-failed by reconciliation');
  const issues = await listReconciliationIssues(db, { orgId: 'o1' });
  assert.equal(issues[0].issue_type, 'STUCK_NON_TERMINAL');
});

test('runReconciliationSweep: an amount mismatch is flagged for review, never silently recovered', async () => {
  const db = await memDb();
  await seedOrg(db);
  let activated = 0;
  registerActivationHandler('ORG_PACKAGE', async () => { activated++; });
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id);
  // Our own record silently drifted from what the provider actually has
  // -- same technique paymentEngine.test.js uses for its own mismatch test.
  await db.run(`UPDATE payment_orders SET amount = 99999 WHERE id = ?`, [order.id]);
  await backdate(db, order.id, '2020-01-01T00:00:00Z');

  const summary = await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 });
  assert.equal(summary.flagged, 1);
  assert.equal(summary.recovered, 0);
  assert.equal(activated, 0, 'a mismatched order must never be silently activated by reconciliation');
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'CREATED', 'the order itself is left untouched -- reconciliation only logs the disagreement');
  const issues = await listReconciliationIssues(db, { orgId: 'o1' });
  assert.equal(issues[0].issue_type, 'AMOUNT_MISMATCH');
});

test('runReconciliationSweep: an order created moments ago is never touched, even if non-terminal', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  mockSimulateCheckout(order.provider_order_id);
  // No backdating -- this order is fresh, well within the default
  // staleness window (a client could still be mid-checkout right now).

  const summary = await runReconciliationSweep(db, { orgId: 'o1' }); // default staleAfterMs
  assert.equal(summary.checked, 0, 'a fresh order must not even be selected for the sweep');
  const row = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'CREATED');
});

test('runReconciliationSweep is org-scoped: sweeping org A never touches org B\'s stuck orders', async () => {
  const db = await memDb();
  await seedOrg(db, 'o1');
  await seedOrg(db, 'o2');
  const orderA = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 's1', orgId: 'o1', amount: 12000 });
  const orderB = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 's2', orgId: 'o2', amount: 12000 });
  mockSimulateCheckout(orderA.provider_order_id);
  mockSimulateCheckout(orderB.provider_order_id);
  await backdate(db, orderA.id, '2020-01-01T00:00:00Z');
  await backdate(db, orderB.id, '2020-01-01T00:00:00Z');

  const summary = await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 });
  assert.equal(summary.checked, 1, 'only org o1\'s own stuck order is even selected');
  const rowB = await db.q1('SELECT * FROM payment_orders WHERE id = ?', [orderB.id]);
  assert.equal(rowB.status, 'CREATED', 'org o2\'s order must be completely untouched');
});

test('resolveReconciliationIssue: marks an OPEN issue resolved or dismissed, exactly once', async () => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['u1', 'o1', 'owner@o1.test', 'x', 'GYM_OWNER', 'Owner', '2026-01-01T00:00:00Z']);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  await backdate(db, order.id, '2020-01-01T00:00:00Z');
  await runReconciliationSweep(db, { orgId: 'o1', staleAfterMs: 0 }); // creates one STUCK_NON_TERMINAL issue
  const [issue] = await listReconciliationIssues(db, { orgId: 'o1' });

  const ok = await resolveReconciliationIssue(db, { orgId: 'o1', issueId: issue.id, resolvedBy: 'u1', note: 'contacted the client' });
  assert.equal(ok, true);
  const [resolved] = await listReconciliationIssues(db, { orgId: 'o1', status: 'RESOLVED' });
  assert.equal(resolved.note, 'contacted the client');
  assert.ok(resolved.resolved_at);

  // Cannot resolve the same issue twice.
  const second = await resolveReconciliationIssue(db, { orgId: 'o1', issueId: issue.id, resolvedBy: 'u1' });
  assert.equal(second, false);
});
