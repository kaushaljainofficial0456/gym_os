// ============================================================
// Invoice PDF rendering -- built strictly from the stored invoices row
// snapshot, never live-recalculated pricing. See invoicePdf.js's own
// header comment.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaymentOrder } from '../src/services/payments/paymentOrders.js';
import { recordCheckoutVerification } from '../src/services/payments/paymentActivation.js';
import { issueInvoice } from '../src/services/payments/invoices.js';
import { renderInvoicePdf } from '../src/services/payments/invoicePdf.js';
import { mockSimulateCheckout, _resetMockProviderStateForTests } from '../src/services/payments/paymentProvider.js';

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
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [id, 'Ironforge Fitness', 'ironforge', '2026-01-01T00:00:00Z']);
}

test.beforeEach(() => { _resetMockProviderStateForTests(); });

test('renderInvoicePdf: returns a genuine PDF buffer for a real invoice', async () => {
  const db = await memDb();
  await seedOrg(db);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  const invoice = await issueInvoice(db, await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]));

  const pdf = await renderInvoicePdf(db, { invoiceId: invoice.id, orgId: 'o1' });
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 500, 'a real rendered PDF should be more than a trivial number of bytes');
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-', 'must be a genuine PDF, not placeholder text');
});

test('renderInvoicePdf: returns null for an invoice belonging to a DIFFERENT org (never leaks another gym\'s invoice)', async () => {
  const db = await memDb();
  await seedOrg(db, 'o1');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o2', 'Other Gym', 'other-gym', '2026-01-01T00:00:00Z']);
  const order = await createPaymentOrder(db, { subjectType: 'ORG_PACKAGE', subjectId: 'sub1', orgId: 'o1', amount: 12000 });
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  await recordCheckoutVerification(db, { orderId: order.id, providerPaymentId: paymentId, signature });
  const invoice = await issueInvoice(db, await db.q1('SELECT * FROM payment_orders WHERE id = ?', [order.id]));

  const pdf = await renderInvoicePdf(db, { invoiceId: invoice.id, orgId: 'o2' });
  assert.equal(pdf, null);
});

test('renderInvoicePdf: a nonexistent invoice id returns null, never throws', async () => {
  const db = await memDb();
  await seedOrg(db);
  const pdf = await renderInvoicePdf(db, { invoiceId: 'inv_does_not_exist', orgId: 'o1' });
  assert.equal(pdf, null);
});
