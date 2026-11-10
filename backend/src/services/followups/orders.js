// ============================================================
// BUYING CAPACITY -- pack orders through the existing payment provider.
//
// Same shape as the Barbell plan (services/plans/barbellPlan.js): an order
// row of its own, a provider order, then activation from EITHER the
// checkout's signed result OR the provider's webhook -- whichever arrives
// first. Activation is idempotent (a conditional UPDATE on status), so a
// duplicate webhook or a retried verify can never credit twice. Nothing
// is ever activated from a client-side "success" screen alone.
//
// Each order snapshots the pack and the price-book version it was sold at,
// so later price changes never alter what a gym already bought.
// ============================================================
import { id, now } from '../../ids.js';
import { createProviderOrder, verifyCheckoutSignature, providerName } from '../payments/paymentProvider.js';
import { getPriceBook, catalogue, taxed, unitCosts, creditUnits, grantLines } from './wallet.js';
import { tierAvailable } from './providers/index.js';
import { track } from '../events.js';

const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(v * 100) / 100;

/** Spread a pack's pre-tax price across its units by what each costs us. */
function unitValues(pack, net, book) {
  const u = unitCosts(book);
  const weights = {};
  let total = 0;
  for (const unit of Object.keys(pack.units || {})) {
    const n = Number(pack.units?.[unit] || 0);
    if (!n) continue;
    weights[unit] = n * (u[unit] || 1);
    total += weights[unit];
  }
  const out = {};
  for (const [unit, w] of Object.entries(weights)) out[unit] = r2(net * (w / (total || 1)));
  return out;
}

export async function createOrder(db, { orgId, userId, packId, quantity = 1 }) {
  const book = await getPriceBook(db);
  const pack = catalogue(book, tierAvailable).find((p) => p.id === packId);
  if (!pack) throw err('That pack is not available', 404);
  if (!pack.available) throw err('That quality is not available yet', 409);
  const q = pack.plan === 'lines' ? Math.min(pack.max_quantity || 1, Math.max(1, Math.round(Number(quantity) || 1))) : 1;
  const t = taxed(pack.price * q, book);
  const orderId = id('fco');
  const ts = now();
  const snapshot = { ...book.packs.find((p) => p.id === packId), quantity: q, net: t.net, tax: t.tax, total: t.total, tax_label: book.tax?.label };
  await db.run(
    `INSERT INTO followup_orders (id, org_id, user_id, pack_id, quantity, pack_json, pricing_version, amount, tax_amount, currency, provider, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, 'CREATED', ?, ?)`,
    [orderId, orgId, userId, packId, q, JSON.stringify(snapshot), book.version, t.total, t.tax, providerName(), ts, ts]);
  try {
    const provider = await createProviderOrder({ amount: t.total, currency: 'INR', receipt: orderId, notes: { subjectType: 'AI_COMMUNICATION', pack: packId, orgId } });
    await db.run('UPDATE followup_orders SET provider = ?, provider_order_id = ?, updated_at = ? WHERE id = ?', [provider.provider, provider.providerOrderId, now(), orderId]);
  } catch (e) {
    await db.run(`UPDATE followup_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now(), orderId]);
    throw e;
  }
  return db.q1('SELECT * FROM followup_orders WHERE id = ?', [orderId]);
}

/** Turn a paid order into capacity. Exactly once, whichever path gets here first. */
export async function activateOrder(db, order, { providerPaymentId }) {
  const pack = JSON.parse(order.pack_json);
  const book = await getPriceBook(db);
  const number = `AIC-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  let activated = false;
  await db.tx(async (tx) => {
    const upd = await tx.run(
      `UPDATE followup_orders SET status = 'SUCCESS', provider_payment_id = ?, invoice_number = ?, updated_at = ? WHERE id = ? AND status = 'CREATED'`,
      [providerPaymentId, number, now(), order.id]);
    if (upd.changes !== 1) return;
    activated = true;
    if (pack.plan === 'lines') {
      await grantLines(tx, order.org_id, { lines: (pack.lines || 1) * (pack.quantity || 1), days: pack.days || 30, orderId: order.id });
    } else {
      // Value at the price it was SOLD at (the snapshot), not today's book.
      const net = Number(pack.net) || r2(Number(order.amount) - Number(order.tax_amount || 0));
      await creditUnits(db, order.org_id, pack.units, { values: unitValues(pack, net, book), reason: 'purchase', orderId: order.id, pricingVersion: order.pricing_version, note: `${pack.plan} · ${pack.name}`, tx });
    }
  }, { orgId: order.org_id });
  if (activated) await track(db, { type: 'ai_communication_purchase', orgId: order.org_id, userId: order.user_id, data: { orderId: order.id, pack: order.pack_id, amount: order.amount } }).catch(() => {});
  return db.q1('SELECT * FROM followup_orders WHERE id = ?', [order.id]);
}

/** The checkout's signed result. */
export async function verifyOrder(db, { orgId, orderId, providerPaymentId, signature }) {
  const order = await db.q1('SELECT * FROM followup_orders WHERE id = ? AND org_id = ?', [orderId, orgId]);
  if (!order) throw err('Order not found', 404);
  if (order.status === 'SUCCESS') return order;
  if (order.status !== 'CREATED') throw err('This order can no longer be paid', 409);
  if (order.provider !== providerName() || !verifyCheckoutSignature({ providerOrderId: order.provider_order_id, providerPaymentId, signature })) {
    throw err('This payment could not be verified. You have not been charged twice; contact support if money left your account.');
  }
  return activateOrder(db, order, { providerPaymentId });
}

/** The payment provider's webhook, for an order whose checkout never came back. */
export async function confirmFromWebhook(db, order, { status, providerPaymentId, amount, currency }) {
  if (status !== 'SUCCESS') {
    if (status === 'FAILED' && order.status === 'CREATED') await db.run(`UPDATE followup_orders SET status = 'FAILED', updated_at = ? WHERE id = ? AND status = 'CREATED'`, [now(), order.id]);
    return { ok: true, status };
  }
  if (amount !== undefined && amount !== null && (Math.abs(Number(amount) - Number(order.amount)) > 0.01 || (currency && currency !== order.currency))) {
    console.error(`[ai-communication] webhook amount/currency mismatch on ${order.id}: got ${amount} ${currency}, expected ${order.amount} ${order.currency}`);
    return { ok: false, reason: 'amount_mismatch' };
  }
  await activateOrder(db, order, { providerPaymentId });
  return { ok: true, activated: true };
}

export async function cancelOrder(db, orgId, orderId) {
  await db.run(`UPDATE followup_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'CREATED'`, [now(), orderId, orgId]);
}

export async function listOrders(db, orgId) {
  return db.q(`SELECT id, pack_id, quantity, pack_json, pricing_version, amount, tax_amount, currency, status, invoice_number, created_at FROM followup_orders WHERE org_id = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 100`, [orgId]);
}
