// ============================================================
// COUPONS ON THE BARBELL PLAN -- an Independent client's own ₹59/₹590
// plan takes founder coupons through the same engine as a gym's checkout,
// at the HTTP route level (plan + Enterprise + Admin Console + mock
// gateway), plus the schema upgrade for databases that already have
// coupon_redemptions.
//
// What this proves:
//   pricing     an INDEPENDENT coupon works on the plan; ENTERPRISE-only is
//               refused; kind/tier/duration limits apply; never below ₹1;
//               the request can't set the amount
//   holds       held at /plan/order, redeemed only by a verified payment in
//               the transaction that confirms the plan; failed, closed and
//               abandoned checkouts never count; duplicates count once
//   limits      the global limit and the per-PERSON limit hold under
//               concurrency (every Independent client shares one org)
//   analytics   Enterprise vs Independent split, customers counted by person
//   receipts    BBL-... receipts carry the coupon lines
//   schema      an existing coupon_redemptions is upgraded, keeping its rows
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword, signToken } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import {
  mockSimulateCheckout, mockBuildWebhookEvent, _resetMockProviderStateForTests,
} from '../src/services/payments/paymentProvider.js';
import { recordWebhookEvent } from '../src/services/payments/paymentActivation.js';
import { utcToZoned } from '../src/services/coupons/couponTime.js';
import { confirmPlanFromWebhook } from '../src/services/plans/barbellPlan.js';
import { sweepExpiredReservations } from '../src/services/coupons/couponEngine.js';
import { upgradeCouponRedemptionsSqlite, upgradeCouponRedemptionsPg } from '../scripts/lib/couponRedemptionsUpgrade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const DAY = 86_400_000;
const istDate = (offsetDays) => utcToZoned(new Date(Date.now() + offsetDays * DAY).toISOString(), 'Asia/Kolkata').date;

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // Guarded-migration columns the routes under test touch (init-db.js's
  // MIGRATIONS array, which this in-memory DB does not run).
  for (const ddl of ['contact_email TEXT', 'contact_phone TEXT', 'address TEXT', 'city TEXT', 'country TEXT', 'logo_url TEXT', 'website TEXT', 'instagram_url TEXT', 'description TEXT']) {
    db.exec(`ALTER TABLE gym_settings ADD COLUMN ${ddl}`);
  }
  const tryExec = (sql) => { try { db.exec(sql); } catch { /* already present */ } };
  tryExec(`ALTER TABLE trainers ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'`);
  tryExec(`ALTER TABLE packages ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  tryExec(`ALTER TABLE notifications ADD COLUMN data_json TEXT`);
  tryExec(`ALTER TABLE notifications ADD COLUMN channel TEXT NOT NULL DEFAULT 'in_app'`);
  tryExec(`ALTER TABLE users ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL`);
  tryExec(`ALTER TABLE users ADD COLUMN plan_trial_from TEXT`);
  tryExec(`ALTER TABLE organizations ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`);
  tryExec(`ALTER TABLE subscriptions ADD COLUMN lifecycle_status TEXT`);
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
  const ts = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?),
    ('p100', '100 Clients', 100, 13999, 'INR', 365, 1, 'active', ?, ?)`, [ts, ts, ts, ts]);
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', 155, 100, 1, 'active', ?, ?)`, [ts, ts]);
}

async function world() {
  const db = await memDb();
  await seedPricing(db);
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const planRoutes = (await import('../src/routes/plan.js')).default;
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  app.use('/api/plan', planRoutes(db));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString()); } catch {}
    return { status: res.status, json, text: buf.toString(), buf, headers: res.headers };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });

  // The founder.
  const adminId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [adminId, 'founder@barbell.test', await hashPassword('adminpass1'), 'Founder One', now()]);
  const login = await call('POST', '/api/auth/login', { email: 'founder@barbell.test', password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const admin = { token: login.json.token, userId: adminId };

  // THE shared org every Independent client belongs to.
  await db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('org_ind', 'Independent', 'independent', 'independent', ?)`, [now()]);
  const client = async (name) => {
    const userId = id('usr');
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, 'org_ind', ?, 'x', 'CLIENT', ?, 1, ?)`,
      [userId, `${userId}@solo.in`, name, now()]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?, ?, ?, ?)', [id('cli'), userId, 'org_ind', now()]);
    return { userId, name, token: signToken({ id: userId, role: 'CLIENT', org_id: 'org_ind', name, email: `${userId}@solo.in` }) };
  };
  const owner = async (email, orgName) => {
    const signup = await call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    return { token: signup.json.token, orgId: signup.json.user.orgId };
  };
  const mkCoupon = async (over = {}) => {
    const res = await call('POST', '/api/console/coupons', {
      code: 'SOLO25', internalName: 'Solo launch', description: '25% off the Barbell plan',
      discountType: 'PERCENTAGE', discountValue: 25, customerType: 'INDEPENDENT',
      startsDate: istDate(-1), startsTime: '00:00', expiresDate: istDate(30), expiresTime: '23:59', timezone: 'Asia/Kolkata',
      founderNotes: 'SECRET-FOUNDER-NOTE', ...over,
    }, admin.token);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.coupon;
  };
  return { db, call, close, admin, client, owner, mkCoupon };
}

const couponRow = (db, couponId) => db.q1('SELECT * FROM coupons WHERE id = ?', [couponId]);
const holds = (db, couponId) => db.q('SELECT * FROM coupon_redemptions WHERE coupon_id = ? ORDER BY created_at', [couponId]);
const counters = async (db, couponId) => { const c = await couponRow(db, couponId); return [c.redemption_count, c.reserved_count]; };
const webhook = (db, providerOrderId, eventType) => {
  const ev = mockBuildWebhookEvent(providerOrderId, { eventType });
  return recordWebhookEvent(db, { rawBody: ev.body, signature: ev.signature });
};

/** /plan/order -> (mock) checkout -> /plan/verify. */
async function buyPlan(w, who, { plan = 'yearly', codes } = {}) {
  const o = await w.call('POST', '/api/plan/order', { plan, ...(codes ? { couponCodes: codes } : {}) }, who.token);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const { paymentId, signature } = mockSimulateCheckout(o.json.order.provider_order_id);
  const v = await w.call('POST', '/api/plan/verify', { orderId: o.json.order.id, providerPaymentId: paymentId, signature }, who.token);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return { order: o.json.order, pricing: o.json.pricing, paid: v.json.order, paymentId, signature };
}

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

// ===============================================================
// PRICING AND THE FULL LIFECYCLE
// ===============================================================

test('plan: an INDEPENDENT coupon prices, holds and redeems on the Barbell plan', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon();
  const asha = await w.client('Asha');

  // Apply: priced, nothing held.
  const q = await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['solo25'] }, asha.token);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.equal(q.json.pricing.originalAmount, 590);
  assert.equal(q.json.pricing.discount, 147.5);
  assert.equal(q.json.pricing.total, 442.5);
  assert.equal(q.json.pricing.message, 'Congratulations! SOLO25 applied successfully. You saved ₹147.50.');
  assert.ok(!q.text.includes('SECRET-FOUNDER-NOTE') && !q.text.includes('Solo launch'), 'founder-only fields never reach a client');
  assert.ok(!q.text.includes(c.id), 'nor the internal coupon id');
  assert.equal((await holds(w.db, c.id)).length, 0);
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);

  // Proceed: re-priced on the server, stored on the order, held.
  const o = await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, asha.token);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const order = o.json.order;
  assert.equal(order.amount, 442.5, 'the order is for the discounted amount');
  assert.equal(order.original_amount, 590);
  assert.equal(order.discount_amount, 147.5);
  assert.deepEqual(JSON.parse(order.coupons_json).map((l) => [l.code, l.discountAmount]), [['SOLO25', 147.5]]);
  assert.equal(JSON.parse(mockBuildWebhookEvent(order.provider_order_id).body).payload.order.entity.amount, 44250, 'the gateway was asked for exactly that, in paise');
  let [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'RESERVED');
  assert.equal(h.plan_order_id, order.id);
  assert.equal(h.quote_id, null);
  assert.equal(h.user_id, asha.userId);
  assert.equal(h.org_id, 'org_ind');
  assert.equal(h.subject_type, 'BARBELL_PLAN');
  assert.equal(h.subject_id, order.id);
  assert.equal(h.customer_slot, null, 'never the shared org\'s slot');
  assert.deepEqual([h.original_amount, h.discount_amount, h.final_amount], [590, 147.5, 442.5]);
  assert.deepEqual(await counters(w.db, c.id), [0, 1], 'held, not redeemed');

  // Verified payment: redeemed with the plan, in one go.
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  const v = await w.call('POST', '/api/plan/verify', { orderId: order.id, providerPaymentId: paymentId, signature }, asha.token);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.status.access, 'active');
  [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'REDEEMED');
  assert.equal(h.late_confirmation, 0);
  assert.equal(h.payment_order_id, null, 'a plan has no payment_orders row');
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await couponRow(w.db, c.id)).updated_at, c.updated_at, 'usage never masquerades as a founder edit');

  // Receipt (BBL-...): the price, the coupon, what was paid.
  const s = await w.call('GET', '/api/plan/status', undefined, asha.token);
  const [r] = s.json.receipts;
  assert.match(r.number, /^BBL-/);
  assert.equal(r.amount, 442.5);
  assert.equal(r.originalAmount, 590);
  assert.equal(r.discount, 147.5);
  assert.deepEqual(r.coupons, [{ code: 'SOLO25', discountType: 'PERCENTAGE', discountValue: 25, discountAmount: 147.5 }]);
  const pdf = await w.call('GET', `/api/plan/receipts/${order.id}/pdf`, undefined, asha.token);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');
});

test('plan: an ENTERPRISE-only coupon is refused on the plan, at Apply and at payment; BOTH works', async (t) => {
  const w = await world(); t.after(() => w.close());
  const ent = await w.mkCoupon({ code: 'GYMSONLY', customerType: 'ENTERPRISE' });
  await w.mkCoupon({ code: 'EVERYONE', customerType: 'BOTH' });
  const ravi = await w.client('Ravi');

  const q = await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['GYMSONLY'] }, ravi.token);
  assert.equal(q.status, 422);
  assert.equal(q.json.error, 'coupon_invalid');
  assert.equal(q.json.reason, 'enterprise_only');
  assert.equal(q.json.message, 'This coupon is only available for Enterprise gyms.');
  // Skipping Apply and sending the code straight to /order changes nothing.
  const o = await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['GYMSONLY'] }, ravi.token);
  assert.equal(o.status, 422);
  assert.equal(o.json.reason, 'enterprise_only');
  assert.equal((await holds(w.db, ent.id)).length, 0);
  assert.equal((await w.db.q1('SELECT COUNT(*) AS n FROM barbell_plan_orders')).n, 0, 'no order is created for a refused coupon');
  // Nothing in the request can claim to be a gym.
  const spoof = await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['GYMSONLY'], customerType: 'ENTERPRISE' }, ravi.token);
  assert.equal(spoof.json.reason, 'enterprise_only');
  assert.ok(await w.db.q1(`SELECT id FROM events WHERE type = 'coupon_rejected'`), 'refusals are logged');

  const both = await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['EVERYONE'] }, ravi.token);
  assert.equal(both.status, 200, JSON.stringify(both.json));
  assert.equal(both.json.pricing.total, 44.25);
});

test('plan: purchase type, tier and duration limits apply to the plan', async (t) => {
  const w = await world(); t.after(() => w.close());
  await w.mkCoupon({ code: 'PKGONLY', customerType: 'BOTH', applicableKinds: ['ORG_PACKAGE'] });
  await w.mkCoupon({ code: 'PLANONLY', applicableKinds: ['BARBELL_PLAN'] });
  await w.mkCoupon({ code: 'TIERED', customerType: 'BOTH', applicableTiers: ['100 Clients'] });
  await w.mkCoupon({ code: 'YEARLY', applicableDurations: [365] });
  await w.mkCoupon({ code: 'BIGSPEND', minimumPurchaseAmount: 100 });
  const u = await w.client('Meera');
  const quote = (plan, code) => w.call('POST', '/api/plan/quote', { plan, couponCodes: [code] }, u.token);

  assert.equal((await quote('monthly', 'PKGONLY')).json.reason, 'kind_not_eligible');
  assert.equal((await quote('monthly', 'PLANONLY')).status, 200);
  assert.equal((await quote('monthly', 'TIERED')).json.reason, 'plan_not_eligible', 'the plan has no capacity tier');
  assert.equal((await quote('yearly', 'YEARLY')).status, 200);
  assert.equal((await quote('monthly', 'YEARLY')).json.reason, 'duration_not_eligible');
  assert.equal((await quote('monthly', 'BIGSPEND')).json.reason, 'minimum_not_met');
  assert.equal((await quote('yearly', 'BIGSPEND')).status, 200);
  // And a gym can't use a plan-only coupon.
  const gym = await w.owner('owner-a@test.in', 'Gym A');
  const g = await w.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 100, couponCodes: ['PLANONLY'] }, gym.token);
  assert.equal(g.json.reason, 'independent_only');
});

test('plan: a coupon never takes the plan below ₹1, and the request cannot set the amount', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'FLAT100', discountType: 'FIXED', discountValue: 100 });
  const u = await w.client('Kabir');
  const o = await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['FLAT100'], amount: 0.01, discount: 58.99 }, u.token);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  assert.equal(o.json.order.amount, 1);
  assert.equal(o.json.order.discount_amount, 58);
  assert.equal(JSON.parse(mockBuildWebhookEvent(o.json.order.provider_order_id).body).payload.order.entity.amount, 100);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.final_amount, 1);
  const plain = await w.call('POST', '/api/plan/order', { plan: 'yearly', amount: 1 }, u.token);
  assert.equal(plain.json.order.amount, 590, 'extra fields are ignored');
});

// ===============================================================
// FAILED, CLOSED, ABANDONED, DUPLICATE
// ===============================================================

test('plan: a failed payment releases the hold and never counts; the order stays payable', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ maxRedemptions: 1 });
  const a = await w.client('A');
  const b = await w.client('B');
  const o = (await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, a.token)).json.order;
  assert.deepEqual(await counters(w.db, c.id), [0, 1]);
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, b.token)).json.reason, 'exhausted', 'held while in flight');

  mockSimulateCheckout(o.provider_order_id, { outcome: 'failed' });
  const r = await webhook(w.db, o.provider_order_id, 'payment.failed');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.couponsReleased, 1);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'RELEASED');
  assert.equal(h.release_reason, 'payment_failed');
  assert.equal(h.user_slot, null);
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);
  assert.equal((await w.db.q1('SELECT status FROM barbell_plan_orders WHERE id = ?', [o.id])).status, 'CREATED', 'a retry on the same order can still succeed');
  // The single use is free again for someone else.
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, b.token)).status, 200);

  // A payment that does not match the order also gives the hold back.
  const o2 = (await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['SOLO25'] }, b.token)).json.order;
  await w.db.run('UPDATE barbell_plan_orders SET amount = 999 WHERE id = ?', [o2.id]);
  const bad = await webhook(w.db, o2.provider_order_id, 'payment.captured');
  assert.equal(bad.reason, 'amount_or_currency_mismatch');
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);
  assert.equal((await w.call('GET', '/api/plan/status', undefined, b.token)).json.receipts.length, 0, 'and grants nothing');
});

test('plan: closing the checkout hands the hold back at once; paying anyway is still recorded (late)', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ maxRedemptionsPerCustomer: 1 });
  const u = await w.client('Dev');
  const o = (await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, u.token)).json.order;
  // Someone else cannot release your hold.
  const stranger = await w.client('Stranger');
  assert.equal((await w.call('POST', `/api/plan/order/${o.id}/cancel`, {}, stranger.token)).status, 404);
  const cancel = await w.call('POST', `/api/plan/order/${o.id}/cancel`, {}, u.token);
  assert.deepEqual(cancel.json, { released: 1 });
  assert.equal((await holds(w.db, c.id))[0].release_reason, 'checkout_closed');
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);
  // Their once-per-customer coupon is not "already used" on the retry.
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, u.token)).status, 200);

  // A UPI approval that lands after the sheet closed still grants the
  // plan at the price paid, and the coupon use is recorded as late.
  const { paymentId, signature } = mockSimulateCheckout(o.provider_order_id);
  const v = await w.call('POST', '/api/plan/verify', { orderId: o.id, providerPaymentId: paymentId, signature }, u.token);
  assert.equal(v.status, 200);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'REDEEMED');
  assert.equal(h.late_confirmation, 1);
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, u.token)).json.reason, 'already_used');
});

test('plan: an abandoned checkout holds the coupon only until the TTL, and never counts', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ maxRedemptions: 1 });
  const a = await w.client('A');
  const b = await w.client('B');
  await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, a.token);
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, b.token)).json.reason, 'exhausted');
  await w.db.run(`UPDATE coupon_redemptions SET reservation_expires_at = ? WHERE coupon_id = ?`, ['2000-01-01T00:00:00.000Z', c.id]);
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['SOLO25'] }, b.token)).status, 200, 'the abandoned hold no longer blocks anyone');
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'EXPIRED');
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);
  const an = (await w.call('GET', `/api/console/coupons/${c.id}`, undefined, w.admin.token)).json.analytics;
  assert.equal(an.successfulRedemptions, 0);
  assert.equal(an.abandonedOrFailed, 1);
});

test('plan: verify, a duplicate webhook and a stale concurrent confirm redeem exactly once', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon();
  const u = await w.client('Isha');
  const o = (await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, u.token)).json.order;
  const { paymentId, signature } = mockSimulateCheckout(o.provider_order_id);
  const v = await w.call('POST', '/api/plan/verify', { orderId: o.id, providerPaymentId: paymentId, signature }, u.token);
  assert.equal(v.status, 200);
  const again = await w.call('POST', '/api/plan/verify', { orderId: o.id, providerPaymentId: paymentId, signature }, u.token);
  assert.equal(again.json.order.period_end, v.json.order.period_end);
  assert.equal((await webhook(w.db, o.provider_order_id, 'payment.captured')).duplicate, true);
  assert.equal((await webhook(w.db, o.provider_order_id, 'payment.captured')).duplicate, true, 'the same delivery twice');
  assert.equal((await webhook(w.db, o.provider_order_id, 'order.paid')).duplicate, true);
  // The webhook racing the app: it read the order while it was still
  // CREATED, and only reaches the confirm after the app's has committed.
  const stale = { ...o, status: 'CREATED' };
  const raced = await confirmPlanFromWebhook(w.db, stale, { status: 'SUCCESS', providerPaymentId: paymentId, amount: o.amount, currency: 'INR' });
  assert.equal(raced.ok, true);
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await holds(w.db, c.id)).filter((h) => h.status === 'REDEEMED').length, 1);
  const s = await w.call('GET', '/api/plan/status', undefined, u.token);
  assert.equal(s.json.receipts.length, 1, 'one year, one receipt');
});

test('plan: a webhook alone (app closed before it confirmed) redeems the coupon', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon();
  const u = await w.client('Nina');
  const o = (await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['SOLO25'] }, u.token)).json.order;
  mockSimulateCheckout(o.provider_order_id);
  const r = await webhook(w.db, o.provider_order_id, 'payment.captured');
  assert.equal(r.activated, true, JSON.stringify(r));
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await w.call('GET', '/api/plan/status', undefined, u.token)).json.access, 'active');
});

// ===============================================================
// LIMITS UNDER CONCURRENCY
// ===============================================================

test('plan: concurrent checkouts can never exceed the total redemption limit', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'ONLYTWO', maxRedemptions: 2 });
  const people = [];
  for (let i = 0; i < 6; i++) people.push(await w.client(`Racer ${i}`));
  const results = await Promise.all(people.map((p) => w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['ONLYTWO'] }, p.token)));
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status !== 200);
  assert.equal(won.length, 2, results.map((r) => r.status).join(','));
  for (const l of lost) {
    assert.ok([409, 422].includes(l.status), String(l.status));
    assert.equal(l.json.reason, 'exhausted');
  }
  assert.deepEqual(await counters(w.db, c.id), [0, 2]);
  assert.equal((await w.db.q1(`SELECT COUNT(*) AS n FROM barbell_plan_orders WHERE status = 'CREATED' AND provider_order_id IS NOT NULL`)).n, 2,
    'only the winners have a payable order');
  for (const r of won) {
    const who = people.find((p) => p.userId === r.json.order.user_id);
    const { paymentId, signature } = mockSimulateCheckout(r.json.order.provider_order_id);
    await w.call('POST', '/api/plan/verify', { orderId: r.json.order.id, providerPaymentId: paymentId, signature }, who.token);
  }
  assert.deepEqual(await counters(w.db, c.id), [2, 0]);
  const list = await w.call('GET', '/api/console/coupons?status=EXHAUSTED', undefined, w.admin.token);
  assert.equal(list.json.total, 1);
});

test('plan: the per-customer limit is per PERSON (not the shared org) and holds under concurrency', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'ONCEEACH', maxRedemptionsPerCustomer: 1 });
  const a = await w.client('A');
  const [x, y] = await Promise.all([
    w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['ONCEEACH'] }, a.token),
    w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['ONCEEACH'] }, a.token),
  ]);
  assert.deepEqual([x.status, y.status].filter((s) => s === 200).length, 1, `${x.status},${y.status}`);
  const loser = x.status === 200 ? y : x;
  assert.equal(loser.json.reason, 'already_used');
  const winner = x.status === 200 ? x : y;
  const { paymentId, signature } = mockSimulateCheckout(winner.json.order.provider_order_id);
  await w.call('POST', '/api/plan/verify', { orderId: winner.json.order.id, providerPaymentId: paymentId, signature }, a.token);
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['ONCEEACH'] }, a.token)).json.message, 'You have already used this coupon.');

  // Everyone else in the same 'independent' org still has their own use.
  for (const name of ['B', 'C']) {
    const p = await w.client(name);
    await buyPlan(w, p, { plan: 'monthly', codes: ['ONCEEACH'] });
  }
  const rows = (await holds(w.db, c.id)).filter((h) => h.status === 'REDEEMED');
  assert.equal(rows.length, 3);
  assert.deepEqual([...new Set(rows.map((h) => h.org_id))], ['org_ind'], 'all in one org');
  assert.equal(new Set(rows.map((h) => h.user_id)).size, 3, 'three different people');
});

test('plan: first-time-only means the person has never paid for a plan', async (t) => {
  const w = await world(); t.after(() => w.close());
  await w.mkCoupon({ code: 'WELCOME', firstTimeOnly: true });
  const fresh = await w.client('Fresh');
  const repeat = await w.client('Repeat');
  await buyPlan(w, repeat, { plan: 'monthly' });
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['WELCOME'] }, repeat.token)).json.reason, 'first_time_only');
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'yearly', couponCodes: ['WELCOME'] }, fresh.token)).status, 200,
    'another client\'s purchase in the same org does not count against them');
});

test('plan: coupon guessing on the plan is rate limited per person', async (t) => {
  const w = await world(); t.after(() => w.close());
  const u = await w.client('Guesser');
  const statuses = [];
  for (let i = 0; i < 10; i++) {
    statuses.push((await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: [`GUESS${i}X`] }, u.token)).status);
  }
  assert.ok(statuses.slice(0, 8).every((s) => s === 422), statuses.join(','));
  assert.equal(statuses[9], 429);
  // Per person, not per shared org: the next client is not locked out.
  const other = await w.client('Innocent');
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['NOPE123'] }, other.token)).status, 422);
});

// ===============================================================
// ANALYTICS AND ADMIN
// ===============================================================

test('analytics: Enterprise and Independent redemptions are split, and customers are counted by person', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'TENOFF', discountValue: 10, customerType: 'BOTH' });
  // One gym purchase...
  const gym = await w.owner('owner-a@test.in', 'Gym A');
  const q = await w.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 100, couponCodes: ['TENOFF'] }, gym.token);
  const eo = await w.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, gym.token);
  const pay = mockSimulateCheckout(eo.json.order.provider_order_id);
  await w.call('POST', '/api/enterprise/payment/verify', { orderId: eo.json.order.id, providerPaymentId: pay.paymentId, signature: pay.signature }, gym.token);
  // ...two Independent clients on the plan, and one who walked away.
  const asha = await w.client('Asha Rao');
  const ravi = await w.client('Ravi K');
  await buyPlan(w, asha, { plan: 'yearly', codes: ['TENOFF'] });   // 590 -> 531
  await buyPlan(w, ravi, { plan: 'monthly', codes: ['TENOFF'] });  // 59 -> 53.10
  const gone = await w.client('Gone');
  await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['TENOFF'] }, gone.token);

  const an = (await w.call('GET', `/api/console/coupons/${c.id}`, undefined, w.admin.token)).json.analytics;
  assert.equal(an.successfulRedemptions, 3);
  assert.equal(an.enterpriseRedemptions, 1);
  assert.equal(an.independentRedemptions, 2);
  assert.equal(an.uniqueCustomers, 3, 'two people in one shared org are two customers');
  assert.equal(an.inFlight, 1, 'the unpaid plan order is in flight, not redeemed');
  assert.equal(an.totalDiscount, 1464.8);           // 1,399.90 + 59 + 5.90
  assert.equal(an.totalOriginalValue, 14648);       // 13,999 + 590 + 59
  assert.equal(an.totalRevenueCollected, 13183.2);  // 12,599.10 + 531 + 53.10

  const dash = (await w.call('GET', '/api/console/coupons/summary', undefined, w.admin.token)).json;
  assert.equal(dash.successfulRedemptions, 3);
  assert.equal(dash.enterpriseRedemptions, 1);
  assert.equal(dash.independentRedemptions, 2);
  assert.equal(dash.discountedOrders, 3);
  assert.equal(dash.grossRevenue, 13183.2, 'gym and plan revenue, verified payments only');

  const hist = (await w.call('GET', `/api/console/coupons/${c.id}/redemptions`, undefined, w.admin.token)).json;
  assert.equal(hist.total, 3);
  const plans = hist.redemptions.filter((r) => r.subject_type === 'BARBELL_PLAN');
  assert.deepEqual(plans.map((r) => r.customer_name).sort(), ['Asha Rao', 'Ravi K']);
  for (const r of plans) {
    assert.equal(r.customer_type, 'INDEPENDENT');
    assert.match(r.invoice_number, /^BBL-/);
    assert.ok(r.provider_payment_id, 'payment reference');
    assert.equal(r.order_status, 'SUCCESS');
  }
  assert.equal(hist.redemptions.find((r) => r.subject_type === 'ORG_PACKAGE').customer_name, 'Gym A');

  const csv = await w.call('GET', `/api/console/coupons/${c.id}/redemptions/export`, undefined, w.admin.token);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^redemption_id,coupon_code,status,gym,org_id,customer_type,client,user_id,plan_order_id,/);
  assert.ok(lines.some((l) => /,REDEEMED,,org_ind,INDEPENDENT,Asha Rao,/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /,REDEEMED,Gym A,/.test(l)));
});

test('admin: the Barbell plan is a purchase type; an Enterprise-only coupon cannot name it', async (t) => {
  const w = await world(); t.after(() => w.close());
  const opts = (await w.call('GET', '/api/console/coupons/options', undefined, w.admin.token)).json;
  assert.deepEqual(opts.kinds.find((k) => k.value === 'BARBELL_PLAN'), { value: 'BARBELL_PLAN', label: 'Barbell plan (Independent clients)', personal: true });
  assert.equal(opts.kinds.find((k) => k.value === 'ORG_PACKAGE').personal, false);
  assert.deepEqual(opts.plans.map((p) => [p.value, p.price, p.durationDays]), [['monthly', 59, 30], ['yearly', 590, 365]]);
  assert.ok(opts.durations.some((d) => d.value === 30), 'the plan\'s monthly duration can be chosen');

  const bad = await w.call('POST', '/api/console/coupons', {
    code: 'NOPE', internalName: 'x', discountType: 'PERCENTAGE', discountValue: 10, customerType: 'ENTERPRISE', applicableKinds: ['BARBELL_PLAN'],
    startsDate: istDate(-1), startsTime: '00:00', expiresDate: istDate(5), expiresTime: '23:59',
  }, w.admin.token);
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'invalid_kind');
  const monthlyOnly = await w.mkCoupon({ code: 'MONTHLY', applicableKinds: ['BARBELL_PLAN'], applicableDurations: [30] });
  assert.deepEqual(monthlyOnly.applicable_kinds, ['BARBELL_PLAN']);
  assert.deepEqual(monthlyOnly.applicable_durations, [30]);
  // Picking every purchase type is stored as "no restriction".
  const all = await w.mkCoupon({ code: 'ALLKINDS', customerType: 'BOTH', applicableKinds: ['ORG_PACKAGE', 'ORG_UPGRADE', 'ORG_CAPACITY_ADDON', 'BARBELL_PLAN'] });
  assert.equal(all.applicable_kinds, null);
});

// ===============================================================
// LATE CONFIRMATIONS NEVER EXCEED A LIMIT (both checkouts)
// ===============================================================

/** Enterprise: quote -> order (holds the coupon). */
async function gymOrder(w, gym, codes) {
  const q = await w.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 100, couponCodes: codes }, gym.token);
  assert.equal(q.status, 200, JSON.stringify(q.json));
  const o = await w.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, gym.token);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  return o.json;
}
const gymVerify = (w, gym, order) => {
  const { paymentId, signature } = mockSimulateCheckout(order.provider_order_id);
  return w.call('POST', '/api/enterprise/payment/verify', { orderId: order.id, providerPaymentId: paymentId, signature }, gym.token);
};
const expireHolds = (db, couponId) => db.run(
  `UPDATE coupon_redemptions SET reservation_expires_at = ? WHERE coupon_id = ? AND status = 'RESERVED'`, ['2000-01-01T00:00:00.000Z', couponId]);

test('late (Enterprise): a payment after its hold ended, when the last use went to someone else, is held for review -- never past the limit', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'LASTONE', customerType: 'ENTERPRISE', maxRedemptions: 1 });
  const a = await w.owner('owner-a@test.in', 'Gym A');
  const b = await w.owner('owner-b@test.in', 'Gym B');
  const slow = await gymOrder(w, a, ['LASTONE']);
  await expireHolds(w.db, c.id); // Gym A's bank sits on it past the TTL...
  const fast = await gymOrder(w, b, ['LASTONE']); // ...and Gym B takes the last use and pays.
  assert.equal((await gymVerify(w, b, fast.order)).status, 200);
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);

  // Gym A's payment now verifies.
  const late = await gymVerify(w, a, slow.order);
  assert.equal(late.status, 409, JSON.stringify(late.json));
  assert.equal(late.json.error, 'payment_held_for_review');
  assert.match(late.json.message, /on hold/);
  assert.deepEqual(await counters(w.db, c.id), [1, 0], 'the limit of 1 is never exceeded');
  const order = await w.db.q1('SELECT status FROM payment_orders WHERE id = ?', [slow.order.id]);
  assert.equal(order.status, 'DISPUTED', 'money received, not activated');
  const sub = await w.db.q1('SELECT status FROM org_subscriptions WHERE id = ?', [slow.subscription.id]);
  assert.notEqual(sub.status, 'ACTIVE', 'the package is not activated at a discount the coupon could no longer give');
  const hold = (await holds(w.db, c.id)).find((h) => h.payment_order_id === slow.order.id);
  assert.equal(hold.status, 'EXPIRED');
  assert.equal(hold.release_reason, 'held_for_review');
  const issues = await w.db.q(`SELECT * FROM reconciliation_issues WHERE payment_order_id = ?`, [slow.order.id]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].note, /^COUPON_LIMIT_AFTER_PAYMENT: .*LASTONE.*NOT activated/);
  assert.equal(issues[0].org_id, a.orgId);

  // Any later callback for that payment gets the same answer -- sticky.
  for (const evt of ['payment.captured', 'order.paid']) {
    const r = await webhook(w.db, slow.order.provider_order_id, evt);
    assert.notEqual(r.ok, true, `${evt}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await w.db.q1('SELECT status FROM payment_orders WHERE id = ?', [slow.order.id])).status, 'DISPUTED');
  assert.notEqual((await w.db.q1('SELECT status FROM org_subscriptions WHERE id = ?', [slow.subscription.id])).status, 'ACTIVE');
  assert.equal((await w.db.q(`SELECT id FROM reconciliation_issues WHERE payment_order_id = ?`, [slow.order.id])).length, 1, 'one issue, not one per callback');
  const an = (await w.call('GET', `/api/console/coupons/${c.id}`, undefined, w.admin.token)).json.analytics;
  assert.equal(an.successfulRedemptions, 1);
  assert.equal(an.heldForReview, 1, 'the founders see it as held, not as an abandoned checkout');
  assert.equal(an.abandonedOrFailed, 0);
  const all = (await w.call('GET', `/api/console/coupons/${c.id}/redemptions?status=ALL`, undefined, w.admin.token)).json;
  assert.equal(all.redemptions.find((r) => r.payment_order_id === slow.order.id).release_reason, 'held_for_review');
});

test('late (Enterprise): a late payment that still fits is redeemed within the limit, holding a real per-gym slot', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'ROOMY', customerType: 'ENTERPRISE', maxRedemptions: 5, maxRedemptionsPerCustomer: 1 });
  const a = await w.owner('owner-a@test.in', 'Gym A');
  const o = await gymOrder(w, a, ['ROOMY']);
  await expireHolds(w.db, c.id);
  assert.equal(await sweepExpiredReservations(w.db, { couponId: c.id }), 1, 'the abandoned hold is swept and its unit returned');
  assert.deepEqual(await counters(w.db, c.id), [0, 0]);
  assert.equal((await gymVerify(w, a, o.order)).status, 200);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'REDEEMED');
  assert.equal(h.late_confirmation, 1);
  assert.equal(h.customer_slot, 1, 'the late redemption takes the gym\'s slot, so its once-per-gym limit still holds');
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  resetRateLimits();
  const again = await w.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 100, couponCodes: ['ROOMY'] }, a.token);
  assert.equal(again.json.reason, 'already_used');
});

test('late (Enterprise): a gym that already used its one use cannot get a second through a late payment', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'ONCEPERGYM', customerType: 'ENTERPRISE', maxRedemptionsPerCustomer: 1 });
  const a = await w.owner('owner-a@test.in', 'Gym A');
  const first = await gymOrder(w, a, ['ONCEPERGYM']);
  await expireHolds(w.db, c.id);
  const second = await gymOrder(w, a, ['ONCEPERGYM']);
  assert.equal((await gymVerify(w, a, second.order)).status, 200);
  const late = await gymVerify(w, a, first.order);
  assert.equal(late.status, 409);
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await holds(w.db, c.id)).filter((h) => h.status === 'REDEEMED').length, 1);
});

test('late (plan): paid after the checkout closed, with the last use gone, grants no time and is held for review', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'LASTSOLO', maxRedemptions: 1 });
  const a = await w.client('Asha');
  const b = await w.client('Ravi');
  const slow = (await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['LASTSOLO'] }, a.token)).json.order;
  await w.call('POST', `/api/plan/order/${slow.id}/cancel`, {}, a.token); // closed the sheet...
  await buyPlan(w, b, { plan: 'monthly', codes: ['LASTSOLO'] }); // ...Ravi takes the last use...
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);

  // ...and Asha's UPI approval lands afterwards.
  const { paymentId, signature } = mockSimulateCheckout(slow.provider_order_id);
  const late = await w.call('POST', '/api/plan/verify', { orderId: slow.id, providerPaymentId: paymentId, signature }, a.token);
  assert.equal(late.status, 409, JSON.stringify(late.json));
  assert.equal(late.json.error, 'payment_held_for_review');
  assert.deepEqual(await counters(w.db, c.id), [1, 0], 'never past the limit');
  const row = await w.db.q1('SELECT status, review_reason, invoice_number, period_end FROM barbell_plan_orders WHERE id = ?', [slow.id]);
  assert.deepEqual({ ...row }, { status: 'CREATED', review_reason: 'exhausted', invoice_number: null, period_end: null });
  const s = await w.call('GET', '/api/plan/status', undefined, a.token);
  assert.equal(s.json.access, 'trial', 'no paid time was granted');
  assert.equal(s.json.receipts.length, 0);
  const issue = await w.db.q1(`SELECT * FROM reconciliation_issues WHERE note LIKE ?`, [`%${slow.id}%`]);
  assert.ok(issue, 'the founders are told');
  assert.equal(issue.payment_order_id, null);
  assert.equal(issue.org_id, 'org_ind');

  // The webhook, and the app confirming again, change nothing.
  const r = await webhook(w.db, slow.provider_order_id, 'payment.captured');
  assert.equal(r.heldForReview, true, JSON.stringify(r));
  assert.equal((await w.call('POST', '/api/plan/verify', { orderId: slow.id, providerPaymentId: paymentId, signature }, a.token)).status, 409);
  assert.equal((await w.call('GET', '/api/plan/status', undefined, a.token)).json.receipts.length, 0);
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await w.db.q(`SELECT id FROM reconciliation_issues WHERE note LIKE ?`, [`%${slow.id}%`])).length, 1);
});

test('late (plan): one person cannot get a second use of a once-per-person coupon through a late payment', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon({ code: 'ONCEEACH', maxRedemptionsPerCustomer: 1 });
  const a = await w.client('Asha');
  const first = (await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['ONCEEACH'] }, a.token)).json.order;
  await w.call('POST', `/api/plan/order/${first.id}/cancel`, {}, a.token);
  await buyPlan(w, a, { plan: 'yearly', codes: ['ONCEEACH'] });
  const { paymentId, signature } = mockSimulateCheckout(first.provider_order_id);
  const late = await w.call('POST', '/api/plan/verify', { orderId: first.id, providerPaymentId: paymentId, signature }, a.token);
  assert.equal(late.status, 409);
  assert.equal((await w.db.q1('SELECT review_reason FROM barbell_plan_orders WHERE id = ?', [first.id])).review_reason, 'already_used');
  assert.deepEqual(await counters(w.db, c.id), [1, 0]);
  assert.equal((await w.call('GET', '/api/plan/status', undefined, a.token)).json.receipts.length, 1, 'only the purchase that got the coupon');
});

test('security: a refunded order is never re-activated by a later callback for its payment', async (t) => {
  const w = await world(); t.after(() => w.close());
  const a = await w.owner('owner-a@test.in', 'Gym A');
  const o = await gymOrder(w, a, undefined);
  assert.equal((await gymVerify(w, a, o.order)).status, 200);
  await w.db.run(`UPDATE payment_orders SET status = 'REFUNDED' WHERE id = ?`, [o.order.id]); // as the refund flow leaves it
  const subsBefore = await w.db.q1(`SELECT COUNT(*) AS n FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE'`, [a.orgId]);
  const r = await webhook(w.db, o.order.provider_order_id, 'order.paid');
  assert.equal(r.alreadyFinalized, true, JSON.stringify(r));
  assert.equal((await w.db.q1('SELECT status FROM payment_orders WHERE id = ?', [o.order.id])).status, 'REFUNDED');
  const subsAfter = await w.db.q1(`SELECT COUNT(*) AS n FROM org_subscriptions WHERE org_id = ? AND status = 'ACTIVE'`, [a.orgId]);
  assert.equal(subsAfter.n, subsBefore.n);
});

// ===============================================================
// SECURITY
// ===============================================================

test('security: every coupon admin endpoint is founder-only -- Independent clients and gyms included', async (t) => {
  const w = await world(); t.after(() => w.close());
  const c = await w.mkCoupon();
  const solo = await w.client('Solo');
  const gym = await w.owner('owner-a@test.in', 'Gym A');
  const body = { code: 'HACKED', internalName: 'x', discountType: 'PERCENTAGE', discountValue: 99, customerType: 'BOTH',
    startsDate: istDate(-1), startsTime: '00:00', expiresDate: istDate(5), expiresTime: '23:59' };
  const probes = [
    ['GET', '/api/console/coupons/summary'], ['GET', '/api/console/coupons/options'], ['GET', '/api/console/coupons'],
    ['GET', '/api/console/coupons/export'], ['POST', '/api/console/coupons', body], ['GET', `/api/console/coupons/${c.id}`],
    ['POST', `/api/console/coupons/${c.id}`, { ...body, code: c.code }], ['POST', `/api/console/coupons/${c.id}/disable`, {}],
    ['POST', `/api/console/coupons/${c.id}/enable`, {}], ['DELETE', `/api/console/coupons/${c.id}`],
    ['GET', `/api/console/coupons/${c.id}/redemptions`], ['GET', `/api/console/coupons/${c.id}/redemptions/export`],
  ];
  for (const [method, p, b] of probes) {
    assert.equal((await w.call(method, p, b)).status, 401, `anonymous ${method} ${p}`);
    for (const [who, token] of [['independent client', solo.token], ['gym owner', gym.token]]) {
      resetRateLimits();
      assert.equal((await w.call(method, p, b, token)).status, 403, `${who} ${method} ${p}`);
    }
  }
  const after = await couponRow(w.db, c.id);
  assert.deepEqual([after.discount_value, after.is_enabled, after.customer_type], [25, 1, 'INDEPENDENT'], 'nothing changed');
  assert.equal((await w.db.q1(`SELECT COUNT(*) AS n FROM coupons WHERE code = 'HACKED'`)).n, 0);
});

test('security: the plan checkout needs a signed-in Independent client, and one client cannot touch another\'s order', async (t) => {
  const w = await world(); t.after(() => w.close());
  await w.mkCoupon({ customerType: 'BOTH' });
  const a = await w.client('A');
  const b = await w.client('B');
  for (const [method, p, body] of [['GET', '/api/plan/status'], ['POST', '/api/plan/quote', { plan: 'monthly' }],
    ['POST', '/api/plan/order', { plan: 'monthly' }], ['POST', '/api/plan/order/x/cancel', {}],
    ['POST', '/api/plan/verify', { orderId: 'x', providerPaymentId: 'p', signature: 's' }]]) {
    assert.equal((await w.call(method, p, body)).status, 401, `anonymous ${method} ${p}`);
  }
  // A gym owner is not an Independent client: no plan, no plan coupons.
  const gym = await w.owner('owner-a@test.in', 'Gym A');
  assert.equal((await w.call('POST', '/api/plan/quote', { plan: 'monthly', couponCodes: ['SOLO25'] }, gym.token)).status, 409);
  assert.equal((await w.call('POST', '/api/plan/order', { plan: 'monthly', couponCodes: ['SOLO25'] }, gym.token)).status, 409);
  // B cannot confirm, cancel or download A's order.
  const o = (await w.call('POST', '/api/plan/order', { plan: 'yearly', couponCodes: ['SOLO25'] }, a.token)).json.order;
  const { paymentId, signature } = mockSimulateCheckout(o.provider_order_id);
  assert.equal((await w.call('POST', '/api/plan/verify', { orderId: o.id, providerPaymentId: paymentId, signature }, b.token)).status, 404);
  assert.equal((await w.call('POST', `/api/plan/order/${o.id}/cancel`, {}, b.token)).status, 404);
  assert.equal((await w.db.q1(`SELECT status FROM coupon_redemptions WHERE plan_order_id = ?`, [o.id])).status, 'RESERVED', 'A\'s hold is untouched');
  // A forged signature on A's own order grants nothing and redeems nothing.
  const forged = await w.call('POST', '/api/plan/verify', { orderId: o.id, providerPaymentId: paymentId, signature: 'ab'.repeat(32) }, a.token);
  assert.equal(forged.status, 422);
  assert.equal((await w.db.q1(`SELECT status FROM coupon_redemptions WHERE plan_order_id = ?`, [o.id])).status, 'RESERVED');
  // A webhook with a bad signature is refused before it can do anything.
  const ev = mockBuildWebhookEvent(o.provider_order_id, { eventType: 'payment.captured' });
  const bad = await recordWebhookEvent(w.db, { rawBody: ev.body, signature: 'ab'.repeat(32) });
  assert.equal(bad.reason, 'invalid_webhook_signature');
  assert.equal((await w.db.q1(`SELECT status FROM barbell_plan_orders WHERE id = ?`, [o.id])).status, 'CREATED');
});

// ===============================================================
// SCHEMA: an existing coupon_redemptions is upgraded in place
// ===============================================================

// The table as the first coupon release created it.
const OLD_COUPON_REDEMPTIONS = `CREATE TABLE coupon_redemptions (
  id                     TEXT PRIMARY KEY,
  coupon_id              TEXT NOT NULL REFERENCES coupons(id),
  org_id                 TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quote_id               TEXT NOT NULL REFERENCES billing_quotes(id),
  payment_order_id       TEXT REFERENCES payment_orders(id),
  subject_type           TEXT CHECK (subject_type IS NULL OR subject_type IN ('ORG_PACKAGE','ORG_CAPACITY_ADDON')),
  subject_id             TEXT,
  original_amount        REAL NOT NULL CHECK (original_amount >= 0),
  discount_amount        REAL NOT NULL CHECK (discount_amount > 0),
  final_amount           REAL NOT NULL CHECK (final_amount >= 0),
  currency               TEXT NOT NULL DEFAULT 'INR',
  status                 TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','REDEEMED','RELEASED','EXPIRED')),
  customer_slot          INTEGER,
  late_confirmation      INTEGER NOT NULL DEFAULT 0,
  reserved_at            TEXT NOT NULL,
  reservation_expires_at TEXT NOT NULL,
  redeemed_at            TEXT,
  released_at            TEXT,
  release_reason         TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (coupon_id, quote_id),
  UNIQUE (coupon_id, org_id, customer_slot),
  CHECK (discount_amount <= original_amount)
)`;

test('schema (SQLite): an existing coupon_redemptions is rebuilt in the new shape, keeping every row', async () => {
  const db = await memDb();
  const raw = db.raw;
  raw.exec('DROP TABLE coupon_redemptions');
  raw.exec(OLD_COUPON_REDEMPTIONS);
  const ts = '2026-11-01T00:00:00.000Z';
  raw.exec(`INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1', 'Gym', 'gym', '${ts}')`);
  raw.exec(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES ('org_ind', 'Independent', 'independent', 'independent', '${ts}')`);
  raw.exec(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'o@g.in', 'x', 'GYM_OWNER', 'O', 1, '${ts}')`);
  raw.exec(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u2', 'org_ind', 's@s.in', 'x', 'CLIENT', 'S', 1, '${ts}')`);
  raw.exec(`INSERT INTO billing_quotes (id, org_id, kind, total, currency, status, expires_at, created_at) VALUES ('q1', 'o1', 'ORG_PACKAGE', 100, 'INR', 'CONSUMED', '${ts}', '${ts}')`);
  raw.exec(`INSERT INTO coupons (id, code, internal_name, discount_type, discount_value, customer_type, starts_at, expires_at, created_by, created_at, updated_at, redemption_count)
            VALUES ('c1', 'OLD10', 'x', 'PERCENTAGE', 10, 'BOTH', '2026-01-01', '2027-01-01', 'u1', '${ts}', '${ts}', 1)`);
  raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, org_id, quote_id, subject_type, subject_id, original_amount, discount_amount, final_amount,
              status, customer_slot, reserved_at, reservation_expires_at, redeemed_at, created_at, updated_at)
            VALUES ('r1', 'c1', 'o1', 'q1', 'ORG_PACKAGE', 's1', 111.11, 11.11, 100, 'REDEEMED', 1, '${ts}', '${ts}', '${ts}', '${ts}', '${ts}')`);
  const before = raw.prepare('SELECT * FROM coupon_redemptions').all();

  assert.equal(upgradeCouponRedemptionsSqlite(raw, schema), true);
  assert.equal(upgradeCouponRedemptionsSqlite(raw, schema), false, 'a second run changes nothing');

  const cols = Object.fromEntries(raw.prepare('PRAGMA table_info(coupon_redemptions)').all().map((x) => [x.name, x]));
  assert.equal(cols.quote_id.notnull, 0);
  for (const added of ['plan_order_id', 'user_id', 'user_slot']) assert.ok(cols[added], added);
  const after = raw.prepare('SELECT * FROM coupon_redemptions').all();
  assert.equal(after.length, 1);
  for (const [k, v] of Object.entries(before[0])) assert.equal(after[0][k], v, k);
  assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on');
  const indexes = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'coupon_redemptions'`).all().map((x) => x.name);
  for (const ix of ['idx_coupon_redemptions_coupon', 'idx_coupon_redemptions_org', 'idx_coupon_redemptions_order', 'idx_coupon_redemptions_subject', 'idx_coupon_redemptions_hold']) {
    assert.ok(indexes.includes(ix), ix);
  }

  // The plan's rows now fit: no quote, the plan hold key, the person's slot.
  raw.exec(`INSERT INTO barbell_plan_orders (id, user_id, plan, amount, currency, provider, status, created_at, updated_at) VALUES ('bpo1', 'u2', 'monthly', 53.1, 'INR', 'mock', 'CREATED', '${ts}', '${ts}')`);
  const planRow = (rid, slot, orderId = 'bpo1') => raw.prepare(
    `INSERT INTO coupon_redemptions (id, coupon_id, org_id, plan_order_id, user_id, subject_type, subject_id, original_amount, discount_amount, final_amount,
       status, user_slot, reserved_at, reservation_expires_at, created_at, updated_at)
     VALUES (?, 'c1', 'org_ind', ?, 'u2', 'BARBELL_PLAN', ?, 59, 5.9, 53.1, 'RESERVED', ?, '${ts}', '${ts}', '${ts}', '${ts}')`).run(rid, orderId, orderId, slot);
  planRow('r2', 1);
  assert.throws(() => planRow('r3', 2), /UNIQUE/, 'one hold per coupon per plan order');
  raw.exec(`INSERT INTO barbell_plan_orders (id, user_id, plan, amount, currency, provider, status, created_at, updated_at) VALUES ('bpo2', 'u2', 'monthly', 53.1, 'INR', 'mock', 'CREATED', '${ts}', '${ts}')`);
  assert.throws(() => planRow('r4', 1, 'bpo2'), /UNIQUE/, "the person's slot is unique");
  planRow('r5', 2, 'bpo2');
  // Deleting the account keeps the redemption snapshot instead of being blocked by it.
  raw.exec(`DELETE FROM users WHERE id = 'u2'`);
  const kept = raw.prepare(`SELECT user_id, plan_order_id FROM coupon_redemptions WHERE id = 'r2'`).get();
  assert.deepEqual({ ...kept }, { user_id: null, plan_order_id: null });
});

const PG_URL = process.env.TEST_DATABASE_URL || '';
test('schema (PostgreSQL): db:init upgrades an existing coupon_redemptions in place, idempotently',
  { skip: PG_URL ? false : 'set TEST_DATABASE_URL to run the PostgreSQL integration suite' }, async () => {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
      { env: { ...process.env, DATABASE_URL: PG_URL, NODE_ENV: 'development' }, cwd: root });
    assert.match(stdout, /Schema applied to PostgreSQL/);
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: PG_URL, max: 1, connectionTimeoutMillis: 15_000 });
    const c = await pool.connect();
    try {
      // Put the table back in the first release's shape, inside a
      // transaction that is rolled back, so the database is left as it was.
      await c.query('BEGIN');
      await c.query(`
        DELETE FROM coupon_redemptions WHERE quote_id IS NULL;
        ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_plan_order_once;
        ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_user_slot_once;
        DROP INDEX IF EXISTS coupon_redemptions_plan_order_once;
        DROP INDEX IF EXISTS coupon_redemptions_user_slot_once;
        DROP INDEX IF EXISTS idx_coupon_redemptions_plan_order;
        ALTER TABLE coupon_redemptions DROP COLUMN plan_order_id, DROP COLUMN user_id, DROP COLUMN user_slot;
        ALTER TABLE coupon_redemptions ALTER COLUMN quote_id SET NOT NULL;
        ALTER TABLE coupon_redemptions DROP CONSTRAINT coupon_redemptions_subject_type_check;
        ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_subject_type_check CHECK (subject_type IS NULL OR subject_type IN ('ORG_PACKAGE','ORG_CAPACITY_ADDON'));
      `);
      const query = (sql) => c.query(sql);
      await upgradeCouponRedemptionsPg(query);
      await upgradeCouponRedemptionsPg(query);
      const cols = (await c.query(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'coupon_redemptions'`)).rows;
      const byName = Object.fromEntries(cols.map((x) => [x.column_name, x.is_nullable]));
      assert.equal(byName.quote_id, 'YES');
      for (const added of ['plan_order_id', 'user_id', 'user_slot']) assert.ok(byName[added], added);
      const check = (await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'coupon_redemptions_subject_type_check'`)).rows;
      assert.equal(check.length, 1);
      assert.match(check[0].def, /BARBELL_PLAN/);
      const ix = (await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'coupon_redemptions'`)).rows.map((x) => x.indexname);
      assert.ok(ix.includes('coupon_redemptions_plan_order_once'));
      assert.ok(ix.includes('coupon_redemptions_user_slot_once'));
    } finally {
      try { await c.query('ROLLBACK'); } catch { /* connection already unusable */ }
      c.release();
      await pool.end();
    }
  });
