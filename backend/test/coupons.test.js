// ============================================================
// COUPON & DISCOUNT MANAGEMENT -- end to end at the HTTP route level
// (Admin Console + Enterprise checkout + mock gateway), plus unit tests
// for the pure pricing/time helpers.
//
// What this proves, in the order the spec lists it:
//   creation    founder-only CRUD, validation, case-insensitive codes
//   validation  every rejection reason, applied server-side
//   payment     the discounted amount is what the gateway is asked for;
//               holds vs redemptions; failed/abandoned never count;
//               duplicate callbacks and concurrent checkouts can't
//               overshoot a limit; the frontend can't move the price
//   security    non-founders are blocked server-side; customer type
//               comes from the org row; gyms can't reach each other
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { resetRateLimits } from '../src/rateLimit.js';
import { hashPassword, signToken } from '../src/auth.js';
import { id, now } from '../src/ids.js';
import {
  mockSimulateCheckout, mockBuildWebhookEvent, _resetMockProviderStateForTests,
} from '../src/services/payments/paymentProvider.js';
import { recordWebhookEvent } from '../src/services/payments/paymentActivation.js';
import {
  priceWithCoupons, discountPaise, normalizeCouponCode, couponStatus, sweepExpiredReservations,
} from '../src/services/coupons/couponEngine.js';
import { couponWindowFromLocal, utcToZoned, zonedToUtcMs } from '../src/services/coupons/couponTime.js';
import { renderInvoicePdf } from '../src/services/payments/invoicePdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

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

// 100 Clients at Rs 13,999 so the spec's own worked example
// (25% -> Rs 3,499.75 off -> Rs 10,499.25) is checked to the paisa.
async function seedPricing(db) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?),
    ('p100', '100 Clients', 100, 13999, 'INR', 365, 1, 'active', ?, ?),
    ('p200', '200 Clients', 200, 24000, 'INR', 365, 1, 'active', ?, ?),
    ('p300h', '300 Clients', 300, 30000, 'INR', 180, 1, 'active', ?, ?)`,
  [ts, ts, ts, ts, ts, ts, ts, ts]);
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', 155, 100, 1, 'active', ?, ?)`, [ts, ts]);
  await db.run(`INSERT INTO sk_capacity_addons (id, increment, price, currency, version, status, effective_from, created_at) VALUES
    ('add10', 10, 1800, 'INR', 1, 'active', ?, ?)`, [ts, ts]);
}

async function startApp(db) {
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const enterpriseRoutes = (await import('../src/routes/enterprise.js')).default;
  const consoleRoutes = (await import('../src/routes/console.js')).default;
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/auth', authRoutes(db));
  app.use('/api/enterprise', enterpriseRoutes(db));
  app.use('/api/console', consoleRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

async function setupOwner(api, email, orgName) {
  const signup = await api.call('POST', '/api/auth/setup-org', { orgName, ownerName: 'Owner', email, password: 'ownerpass1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  return { token: signup.json.token, orgId: signup.json.user.orgId, userId: signup.json.user.id };
}

async function createSuperAdmin(db, api, email = 'founder@barbell.test') {
  const userId = id('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
    [userId, email, await hashPassword('adminpass1'), 'Founder One', now()]);
  const login = await api.call('POST', '/api/auth/login', { email, password: 'adminpass1' });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.json.token, userId };
}

const DAY = 86_400_000;
const istDate = (offsetDays) => utcToZoned(new Date(Date.now() + offsetDays * DAY).toISOString(), 'Asia/Kolkata').date;

function couponBody(over = {}) {
  return {
    code: 'BARBELL25', internalName: 'Launch 25', description: '25% off your Barbell package',
    discountType: 'PERCENTAGE', discountValue: 25, customerType: 'ENTERPRISE',
    startsDate: istDate(-1), startsTime: '00:00', expiresDate: istDate(30), expiresTime: '23:59', timezone: 'Asia/Kolkata',
    founderNotes: 'SECRET-FOUNDER-NOTE for the Diwali push',
    ...over,
  };
}

async function world() {
  const db = await memDb();
  await seedPricing(db);
  const api = await startApp(db);
  const admin = await createSuperAdmin(db, api);
  const owner = await setupOwner(api, 'owner-a@test.in', 'Gym A');
  const mkCoupon = async (over = {}) => {
    const res = await api.call('POST', '/api/console/coupons', couponBody(over), admin.token);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.coupon;
  };
  return { db, api, admin, owner, mkCoupon };
}

const quote = (api, token, body) => api.call('POST', '/api/enterprise/billing/quote', { kind: 'ORG_PACKAGE', capacity: 100, ...body }, token);

/** quote -> order -> (mock) checkout -> verify. */
async function buy(api, owner, { codes, capacity = 100, kind = 'ORG_PACKAGE', addonId } = {}) {
  const q = await quote(api, owner.token, { kind, capacity: kind === 'ORG_CAPACITY_ADDON' ? undefined : capacity, addonId, couponCodes: codes });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  const o = await api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, owner.token);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const { paymentId, signature } = mockSimulateCheckout(o.json.order.provider_order_id);
  const v = await api.call('POST', '/api/enterprise/payment/verify', { orderId: o.json.order.id, providerPaymentId: paymentId, signature }, owner.token);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return { quote: q.json, order: o.json.order, paymentId, signature };
}

const couponRow = (db, couponId) => db.q1('SELECT * FROM coupons WHERE id = ?', [couponId]);
const holds = (db, couponId) => db.q('SELECT * FROM coupon_redemptions WHERE coupon_id = ? ORDER BY created_at', [couponId]);

test.beforeEach(() => { resetRateLimits(); _resetMockProviderStateForTests(); });

// ===============================================================
// PURE HELPERS
// ===============================================================

test('discount math: spec example to the paisa, cap, fixed, and the Rs 1 floor', () => {
  assert.equal(discountPaise({ discount_type: 'PERCENTAGE', discount_value: 25 }, 1_399_900), 349_975);
  assert.equal(discountPaise({ discount_type: 'PERCENTAGE', discount_value: 30, max_discount_amount: 3000 }, 1_399_900), 300_000);
  assert.equal(discountPaise({ discount_type: 'FIXED', discount_value: 500 }, 1_399_900), 50_000);
  // A fixed discount bigger than the price leaves the Rs 1 minimum charge, never zero.
  assert.equal(discountPaise({ discount_type: 'FIXED', discount_value: 99_999 }, 1_399_900), 1_399_800);
  assert.equal(discountPaise({ discount_type: 'FIXED', discount_value: 10 }, 100), 0, 'nothing to discount at the floor');
  assert.equal(discountPaise({ discount_type: 'PERCENTAGE', discount_value: 12.5 }, 1_277_500), 159_688, 'half-paisa rounds');
});

test('codes normalize case-insensitively and reject anything that is not a code', () => {
  assert.equal(normalizeCouponCode('  barbell25 '), 'BARBELL25');
  assert.equal(normalizeCouponCode('diwali-2026_x'), 'DIWALI-2026_X');
  for (const bad of ['', 'ab', '=CMD()', 'with space', 'x'.repeat(33), "BAR'; DROP", null, 42]) {
    assert.equal(normalizeCouponCode(bad), null, String(bad));
  }
});

test('status is derived from the clock and the counters', () => {
  const base = { is_enabled: 1, starts_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-12-01T00:00:00.000Z', redemption_count: 0, max_redemptions: 5 };
  assert.equal(couponStatus(base, '2026-11-10T00:00:00.000Z'), 'ACTIVE');
  assert.equal(couponStatus(base, '2026-10-31T00:00:00.000Z'), 'SCHEDULED');
  assert.equal(couponStatus(base, '2026-12-01T00:00:00.000Z'), 'EXPIRED', 'expiry is exclusive');
  assert.equal(couponStatus({ ...base, redemption_count: 5 }, '2026-11-10T00:00:00.000Z'), 'EXHAUSTED');
  assert.equal(couponStatus({ ...base, is_enabled: 0 }, '2026-11-10T00:00:00.000Z'), 'DISABLED');
});

test('IST wall-clock window: 5 Nov 12:00 AM -> 30 Nov 11:59 PM IST, expiry minute inclusive', () => {
  const w = couponWindowFromLocal({ startsDate: '2026-11-05', startsTime: '00:00', expiresDate: '2026-11-30', expiresTime: '23:59', timezone: 'Asia/Kolkata' });
  assert.equal(w.startsAt, '2026-11-04T18:30:00.000Z');
  assert.equal(w.expiresAt, '2026-11-30T18:29:59.999Z');
  assert.deepEqual(utcToZoned(w.expiresAt, 'Asia/Kolkata'), { date: '2026-11-30', time: '23:59' });
  assert.equal(zonedToUtcMs('2026-02-30', '10:00', 'Asia/Kolkata'), null, 'impossible dates are rejected, not rolled over');
  assert.equal(couponWindowFromLocal({ startsDate: '2026-11-30', startsTime: '10:00', expiresDate: '2026-11-01', expiresTime: '10:00' }).ok, false);
});

// ===============================================================
// COUPON CREATION (founder, Admin Console)
// ===============================================================

test('create: percentage coupon -- stored uppercase, ACTIVE, attributed to the founder, audited', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ code: 'barbell25' });
  assert.equal(c.code, 'BARBELL25');
  assert.equal(c.discount_type, 'PERCENTAGE');
  assert.equal(c.discount_value, 25);
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.created_by, w.admin.userId);
  assert.equal(c.created_by_name, 'Founder One');
  assert.ok(c.created_at);
  const audit = await w.db.q1(`SELECT * FROM admin_audit_logs WHERE action = 'coupon_created' AND entity_id = ?`, [c.id]);
  assert.ok(audit, 'creation is audit-logged');
  assert.equal(audit.admin_id, w.admin.userId);
});

test('create: fixed-amount coupon, and Enterprise / Independent / Both customer types', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const fixed = await w.mkCoupon({ code: 'FLAT500', discountType: 'FIXED', discountValue: 500 });
  assert.equal(fixed.discount_type, 'FIXED');
  assert.equal(fixed.discount_value, 500);
  for (const customerType of ['ENTERPRISE', 'INDEPENDENT', 'BOTH']) {
    const c = await w.mkCoupon({ code: `TYPE-${customerType}`, customerType });
    assert.equal(c.customer_type, customerType);
  }
});

test('create: duplicate codes are rejected case-insensitively', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'BARBELL25' });
  const dup = await w.api.call('POST', '/api/console/coupons', couponBody({ code: 'barbell25' }), w.admin.token);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'duplicate_code');
});

test('create: invalid discount values are rejected', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const cases = [
    { discountType: 'PERCENTAGE', discountValue: 100 },   // would make it free
    { discountType: 'PERCENTAGE', discountValue: 150 },
    { discountType: 'PERCENTAGE', discountValue: 0 },
    { discountType: 'FIXED', discountValue: -500 },
    { discountType: 'FIXED', discountValue: 10.555 },     // sub-paisa
    { discountType: 'FIXED', discountValue: 'free' },
  ];
  for (const [i, c] of cases.entries()) {
    const res = await w.api.call('POST', '/api/console/coupons', couponBody({ code: `BAD${i}X`, ...c }), w.admin.token);
    assert.equal(res.status, 422, `${JSON.stringify(c)} -> ${res.status} ${JSON.stringify(res.json)}`);
  }
  const badCode = await w.api.call('POST', '/api/console/coupons', couponBody({ code: '=HYPERLINK()' }), w.admin.token);
  assert.equal(badCode.status, 422);
  assert.equal(await w.db.q1('SELECT COUNT(*) AS n FROM coupons').then((r) => r.n), 0);
});

test('create: invalid date ranges are rejected', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const backwards = await w.api.call('POST', '/api/console/coupons', couponBody({ startsDate: istDate(10), expiresDate: istDate(2) }), w.admin.token);
  assert.equal(backwards.status, 422);
  assert.equal(backwards.json.error, 'invalid_window');
  const impossible = await w.api.call('POST', '/api/console/coupons', couponBody({ expiresDate: '2027-02-30' }), w.admin.token);
  assert.equal(impossible.status, 422);
  const badTz = await w.api.call('POST', '/api/console/coupons', couponBody({ timezone: 'Mars/Olympus' }), w.admin.token);
  assert.equal(badTz.status, 422);
  const badTier = await w.api.call('POST', '/api/console/coupons', couponBody({ applicableTiers: ['Platinum Ultra'] }), w.admin.token);
  assert.equal(badTier.status, 422, 'a plan category that does not exist is refused');
});

// ===============================================================
// VALIDATION AT CHECKOUT (gym owner)
// ===============================================================

test('apply: valid coupon -- server computes 13,999 - 25% = 10,499.25 and the success message', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon();
  const res = await quote(w.api, w.owner.token, { couponCodes: ['barbell25'] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const p = res.json.pricing;
  assert.equal(p.originalAmount, 13999);
  assert.equal(p.discount, 3499.75);
  assert.equal(p.total, 10499.25);
  assert.equal(res.json.quote.total, 10499.25, 'the locked quote total is the discounted amount');
  assert.equal(res.json.quote.base_price, 13999, 'original price preserved');
  assert.equal(p.coupons[0].code, 'BARBELL25');
  assert.equal(p.message, 'Congratulations! BARBELL25 applied successfully. You saved ₹3,499.75.');
  // Apply never reserves or consumes anything.
  assert.equal((await w.db.q('SELECT * FROM coupon_redemptions')).length, 0);
  const row = await w.db.q1('SELECT redemption_count, reserved_count FROM coupons WHERE code = ?', ['BARBELL25']);
  assert.deepEqual([row.redemption_count, row.reserved_count], [0, 0]);
  // Founder-only fields never reach the gym owner.
  assert.ok(!res.text.includes('SECRET-FOUNDER-NOTE'), 'founder notes leaked');
  assert.ok(!res.text.includes('Launch 25'), 'internal name leaked');
});

test('apply: every rejection reason, each with a clear customer-facing message', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'OLDONE', startsDate: '2026-01-01', expiresDate: '2026-01-31' });
  await w.mkCoupon({ code: 'SOONER', startsDate: istDate(5), expiresDate: istDate(10) });
  const off = await w.mkCoupon({ code: 'SWITCHEDOFF' });
  await w.api.call('POST', `/api/console/coupons/${off.id}/disable`, {}, w.admin.token);
  await w.mkCoupon({ code: 'INDIEONLY', customerType: 'INDEPENDENT' });
  await w.mkCoupon({ code: 'BIGGYMS', applicableTiers: ['200 Clients'] });
  await w.mkCoupon({ code: 'ADDONSONLY', applicableKinds: ['ORG_CAPACITY_ADDON'] });
  await w.mkCoupon({ code: 'HALFYEAR', applicableDurations: [180] });
  await w.mkCoupon({ code: 'SPEND15K', minimumPurchaseAmount: 15000 });

  const expect = {
    NOSUCHCODE: ['invalid_code', 'Invalid coupon code.'],
    OLDONE: ['expired', 'This coupon has expired.'],
    SOONER: ['not_started', /not active yet/],
    SWITCHEDOFF: ['disabled', /no longer available/],
    INDIEONLY: ['independent_only', 'This coupon is only available for Independent clients.'],
    BIGGYMS: ['plan_not_eligible', 'This coupon is not applicable to this subscription plan.'],
    ADDONSONLY: ['kind_not_eligible', /not applicable/],
    HALFYEAR: ['duration_not_eligible', /billing duration/],
    SPEND15K: ['minimum_not_met', 'Minimum purchase amount of ₹15,000 not met.'],
  };
  for (const [code, [reason, message]] of Object.entries(expect)) {
    resetRateLimits();
    const res = await quote(w.api, w.owner.token, { couponCodes: [code] });
    assert.equal(res.status, 422, code);
    assert.equal(res.json.error, 'coupon_invalid', code);
    assert.equal(res.json.reason, reason, code);
    if (message instanceof RegExp) assert.match(res.json.message, message, code); else assert.equal(res.json.message, message, code);
  }
  // A rejected coupon creates no quote.
  assert.equal((await w.db.q1('SELECT COUNT(*) AS n FROM billing_quotes')).n, 0);
});

test('apply: tier/kind/duration restrictions accept the purchases they name', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'TIER100', applicableTiers: ['100 Clients'], applicableKinds: ['ORG_PACKAGE'], applicableDurations: [365] });
  const ok = await quote(w.api, w.owner.token, { couponCodes: ['TIER100'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // An 80-client custom capacity is priced off the 75 tier -> not the 100 tier.
  const custom = await quote(w.api, w.owner.token, { capacity: 80, couponCodes: ['TIER100'] });
  assert.equal(custom.json.reason, 'plan_not_eligible');
});

test('apply: maximum discount cap is enforced', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'THIRTYCAP', discountValue: 30, maxDiscountAmount: 3000 });
  const res = await quote(w.api, w.owner.token, { couponCodes: ['THIRTYCAP'] });
  assert.equal(res.json.pricing.discount, 3000);
  assert.equal(res.json.pricing.total, 10999);
});

test('apply: stacking only when every coupon allows it, applied on what remains', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'STACKTEN', discountValue: 10, allowStacking: true });
  await w.mkCoupon({ code: 'STACK500', discountType: 'FIXED', discountValue: 500, allowStacking: true });
  await w.mkCoupon({ code: 'LONER', discountValue: 5 });
  const both = await quote(w.api, w.owner.token, { couponCodes: ['STACKTEN', 'STACK500'] });
  assert.equal(both.status, 200, JSON.stringify(both.json));
  // 13,999 - 10% (1,399.90) = 12,599.10 - 500 = 12,099.10
  assert.equal(both.json.pricing.discount, 1899.9);
  assert.equal(both.json.pricing.total, 12099.1);
  const mixed = await quote(w.api, w.owner.token, { couponCodes: ['STACKTEN', 'LONER'] });
  assert.equal(mixed.json.reason, 'stacking_not_allowed');
  assert.equal(mixed.json.code, 'LONER');
});

test('apply: an Enterprise-only coupon is refused for an Independent customer (type from the org row)', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'ENTONLY', customerType: 'ENTERPRISE' });
  await w.mkCoupon({ code: 'FORALL', customerType: 'BOTH' });
  const orgId = id('org');
  await w.db.run(`INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?, 'Independent', 'independent', 'independent', ?)`, [orgId, now()]);
  const asIndie = await priceWithCoupons(w.db, { orgId, kind: 'ORG_PACKAGE', packageId: 'p100', amount: 13999, codes: ['ENTONLY'] });
  assert.equal(asIndie.ok, false);
  assert.equal(asIndie.reason, 'enterprise_only');
  assert.equal(asIndie.message, 'This coupon is only available for Enterprise gyms.');
  const both = await priceWithCoupons(w.db, { orgId, kind: 'ORG_PACKAGE', packageId: 'p100', amount: 13999, codes: ['FORALL'] });
  assert.equal(both.ok, true);
  // And the request body cannot claim a different type: an extra field is simply stripped.
  const spoof = await quote(w.api, w.owner.token, { couponCodes: ['ENTONLY'], customerType: 'INDEPENDENT' });
  assert.equal(spoof.status, 200);
});

test('apply: first-time-only coupons are refused once a gym has paid before', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon({ code: 'WELCOME', firstTimeOnly: true });
  const first = await quote(w.api, w.owner.token, { couponCodes: ['WELCOME'] });
  assert.equal(first.status, 200);
  await buy(w.api, w.owner, {});
  resetRateLimits();
  const again = await quote(w.api, w.owner.token, { couponCodes: ['WELCOME'] });
  assert.equal(again.json.reason, 'first_time_only');
});

// ===============================================================
// PAYMENT LIFECYCLE
// ===============================================================

test('payment: the gateway order is for the discounted amount; amounts are stored separately', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const { order } = await buy(w.api, w.owner, { codes: ['BARBELL25'] });
  assert.equal(order.amount, 10499.25, 'payment order amount');
  // The provider was asked for exactly that, in paise.
  const evt = mockBuildWebhookEvent(order.provider_order_id);
  assert.equal(JSON.parse(evt.body).payload.order.entity.amount, 1049925);

  const [red] = await holds(w.db, c.id);
  assert.equal(red.status, 'REDEEMED');
  assert.equal(red.original_amount, 13999);
  assert.equal(red.discount_amount, 3499.75);
  assert.equal(red.final_amount, 10499.25);
  assert.equal(red.payment_order_id, order.id);
  assert.equal(red.subject_type, 'ORG_PACKAGE');
  const sub = await w.db.q1('SELECT * FROM org_subscriptions WHERE id = ?', [red.subject_id]);
  assert.equal(sub.status, 'ACTIVE', 'activated only after verified payment');
  assert.equal(sub.price, 10499.25);
  const coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [1, 0]);
  assert.equal(coupon.updated_at, c.updated_at, 'usage never masquerades as a founder edit');

  // Receipt: invoice is the amount paid; the list carries the coupon breakdown.
  const inv = await w.api.call('GET', '/api/enterprise/invoices', undefined, w.owner.token);
  assert.equal(inv.json.invoices[0].amount, 10499.25);
  assert.equal(inv.json.invoices[0].original_amount, 13999);
  assert.equal(inv.json.invoices[0].discount_amount, 3499.75);
  assert.deepEqual(inv.json.invoices[0].coupons, [{ code: 'BARBELL25', discountAmount: 3499.75 }]);
  const pdf = await renderInvoicePdf(w.db, { invoiceId: inv.json.invoices[0].id, orgId: w.owner.orgId });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

test('payment: a failed payment releases the hold and never counts as a redemption', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ maxRedemptions: 1 });
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  const o = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, w.owner.token);
  assert.equal(o.status, 200);
  let coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [0, 1], 'held, not redeemed');

  mockSimulateCheckout(o.json.order.provider_order_id, { outcome: 'failed' });
  const evt = mockBuildWebhookEvent(o.json.order.provider_order_id, { eventType: 'payment.failed' });
  const result = await recordWebhookEvent(w.db, { rawBody: evt.body, signature: evt.signature });
  assert.equal(result.ok, true);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'RELEASED');
  assert.equal(h.customer_slot, null);
  coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [0, 0]);
  // The single use is free again for a real purchase.
  resetRateLimits();
  const retry = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  assert.equal(retry.status, 200);
});

test('payment: an abandoned checkout holds the coupon only until the TTL, then frees it', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ maxRedemptions: 1 });
  const other = await setupOwner(w.api, 'owner-b@test.in', 'Gym B');
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, w.owner.token);
  // While held, the last use is spoken for.
  const blocked = await quote(w.api, other.token, { couponCodes: ['BARBELL25'] });
  assert.equal(blocked.json.reason, 'exhausted');
  // Gym A walks away; the hold passes its TTL.
  await w.db.run(`UPDATE coupon_redemptions SET reservation_expires_at = ? WHERE coupon_id = ?`, ['2000-01-01T00:00:00.000Z', c.id]);
  const freed = await quote(w.api, other.token, { couponCodes: ['BARBELL25'] });
  assert.equal(freed.status, 200, 'the abandoned hold no longer blocks anyone');
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'EXPIRED');
  const coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [0, 0]);
});

test('payment: duplicate verification + webhook callbacks redeem exactly once', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const { order, paymentId, signature } = await buy(w.api, w.owner, { codes: ['BARBELL25'] });
  const again = await w.api.call('POST', '/api/enterprise/payment/verify', { orderId: order.id, providerPaymentId: paymentId, signature }, w.owner.token);
  assert.equal(again.status, 200);
  const evt = mockBuildWebhookEvent(order.provider_order_id, { eventType: 'payment.captured' });
  await recordWebhookEvent(w.db, { rawBody: evt.body, signature: evt.signature });
  await recordWebhookEvent(w.db, { rawBody: evt.body, signature: evt.signature });
  const coupon = await couponRow(w.db, c.id);
  assert.equal(coupon.redemption_count, 1);
  assert.equal(coupon.reserved_count, 0);
  assert.equal((await holds(w.db, c.id)).filter((h) => h.status === 'REDEEMED').length, 1);
});

test('payment: a webhook alone (browser closed before verify) still redeems the coupon', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  const o = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, w.owner.token);
  mockSimulateCheckout(o.json.order.provider_order_id);
  const evt = mockBuildWebhookEvent(o.json.order.provider_order_id, { eventType: 'payment.captured' });
  const r = await recordWebhookEvent(w.db, { rawBody: evt.body, signature: evt.signature });
  assert.equal(r.ok, true);
  assert.equal((await couponRow(w.db, c.id)).redemption_count, 1);
});

test('payment: concurrent checkouts can never exceed the total redemption limit', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ code: 'ONLYTWO', maxRedemptions: 2 });
  const gyms = [w.owner];
  for (let i = 0; i < 5; i++) gyms.push(await setupOwner(w.api, `racer${i}@test.in`, `Racer ${i}`));
  const quotes = [];
  for (const g of gyms) {
    const q = await quote(w.api, g.token, { couponCodes: ['ONLYTWO'] });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    quotes.push({ g, quoteId: q.json.quote.id });
  }
  const results = await Promise.all(quotes.map(({ g, quoteId }) => w.api.call('POST', '/api/enterprise/payment/order', { quoteId }, g.token)));
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status === 409);
  assert.equal(won.length, 2, results.map((r) => r.status).join(','));
  assert.equal(lost.length, 4);
  for (const l of lost) assert.equal(l.json.reason, 'exhausted');
  // Everyone who got an order pays -- the limit is exactly met, never passed.
  for (const r of won) {
    const owner = quotes.find((x) => x.quoteId === r.json.quote.id).g;
    const { paymentId, signature } = mockSimulateCheckout(r.json.order.provider_order_id);
    await w.api.call('POST', '/api/enterprise/payment/verify', { orderId: r.json.order.id, providerPaymentId: paymentId, signature }, owner.token);
  }
  const coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [2, 0]);
  const list = await w.api.call('GET', '/api/console/coupons?status=EXHAUSTED', undefined, w.admin.token);
  assert.equal(list.json.total, 1, 'exhausted automatically after its last use');
});

test('payment: per-customer limit holds under concurrency and across purchases', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ code: 'ONCEPERGYM', maxRedemptionsPerCustomer: 1 });
  const q1 = await quote(w.api, w.owner.token, { couponCodes: ['ONCEPERGYM'] });
  const q2 = await quote(w.api, w.owner.token, { couponCodes: ['ONCEPERGYM'] });
  const [a, b] = await Promise.all([
    w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q1.json.quote.id }, w.owner.token),
    w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q2.json.quote.id }, w.owner.token),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? a : b;
  const { paymentId, signature } = mockSimulateCheckout(winner.json.order.provider_order_id);
  await w.api.call('POST', '/api/enterprise/payment/verify', { orderId: winner.json.order.id, providerPaymentId: paymentId, signature }, w.owner.token);
  resetRateLimits();
  const again = await quote(w.api, w.owner.token, { couponCodes: ['ONCEPERGYM'] });
  assert.equal(again.json.reason, 'already_used');
  assert.equal(again.json.message, 'You have already used this coupon.');
  // The limit is per gym: another gym can still use it.
  const other = await setupOwner(w.api, 'owner-b@test.in', 'Gym B');
  const theirs = await quote(w.api, other.token, { couponCodes: ['ONCEPERGYM'] });
  assert.equal(theirs.status, 200);
  assert.equal((await couponRow(w.db, c.id)).redemption_count, 1);
});

test('payment: the frontend cannot change the price -- extra fields are ignored, a tampered amount is disputed', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const q = await w.api.call('POST', '/api/enterprise/billing/quote', {
    kind: 'ORG_PACKAGE', capacity: 100, couponCodes: ['BARBELL25'], total: 1, discount: 13998, discountAmount: 13998, price: 1,
  }, w.owner.token);
  assert.equal(q.json.quote.total, 10499.25);
  const o = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id, amount: 1, total: 1 }, w.owner.token);
  assert.equal(o.json.order.amount, 10499.25);
  // A gateway notification for a different amount than the order is
  // flagged, never activated -- and the coupon hold is handed back.
  mockSimulateCheckout(o.json.order.provider_order_id);
  const evt = mockBuildWebhookEvent(o.json.order.provider_order_id);
  const tampered = JSON.parse(evt.body);
  tampered.payload.payment.entity.amount = 100;
  const { _signRawBodyForTests } = await import('../src/services/payments/paymentProvider.js');
  const rawBody = JSON.stringify(tampered);
  const r = await recordWebhookEvent(w.db, { rawBody, signature: _signRawBodyForTests(rawBody) });
  assert.equal(r.reason, 'amount_or_currency_mismatch');
  const coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [0, 0]);
  assert.equal((await holds(w.db, c.id))[0].status, 'RELEASED');
});

test('payment: a coupon disabled between Apply and Pay fails the order cleanly (no silent full price, no stuck hold)', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  await w.api.call('POST', `/api/console/coupons/${c.id}/disable`, { reason: 'leaked on social' }, w.admin.token);
  const o = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, w.owner.token);
  assert.equal(o.status, 409);
  assert.equal(o.json.error, 'coupon_unavailable');
  assert.equal(o.json.reason, 'disabled');
  assert.equal((await w.db.q('SELECT * FROM payment_orders')).length, 0, 'no gateway order');
  assert.equal((await couponRow(w.db, c.id)).reserved_count, 0);
  const quoteRow = await w.db.q1('SELECT status FROM billing_quotes WHERE id = ?', [q.json.quote.id]);
  assert.equal(quoteRow.status, 'ACTIVE', 'quote not burned -- the owner can re-quote without the coupon');
});

test('payment: a payment verified after its hold expired is still recorded (late confirmation)', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  const o = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, w.owner.token);
  await w.db.run(`UPDATE coupon_redemptions SET reservation_expires_at = ?`, ['2000-01-01T00:00:00.000Z']);
  await sweepExpiredReservations(w.db, {});
  assert.equal((await holds(w.db, c.id))[0].status, 'EXPIRED');
  const { paymentId, signature } = mockSimulateCheckout(o.json.order.provider_order_id);
  const v = await w.api.call('POST', '/api/enterprise/payment/verify', { orderId: o.json.order.id, providerPaymentId: paymentId, signature }, w.owner.token);
  assert.equal(v.status, 200);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'REDEEMED');
  assert.equal(h.late_confirmation, 1);
  const coupon = await couponRow(w.db, c.id);
  assert.deepEqual([coupon.redemption_count, coupon.reserved_count], [1, 0]);
});

test('payment: capacity add-on purchases take coupons through the same path', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await buy(w.api, w.owner, {});
  resetRateLimits();
  const c = await w.mkCoupon({ code: 'ADDON200', discountType: 'FIXED', discountValue: 200, applicableKinds: ['ORG_CAPACITY_ADDON'] });
  const { order } = await buy(w.api, w.owner, { kind: 'ORG_CAPACITY_ADDON', addonId: 'add10', codes: ['ADDON200'] });
  assert.equal(order.amount, 1600);
  const [h] = await holds(w.db, c.id);
  assert.equal(h.status, 'REDEEMED');
  assert.equal(h.subject_type, 'ORG_CAPACITY_ADDON');
});

// ===============================================================
// SECURITY
// ===============================================================

test('security: only a founder (SUPER_ADMIN) can reach coupon administration', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  const client = await w.api.call('POST', '/api/auth/register', { name: 'A Client', email: 'client@test.in', password: 'clientpass1' });
  assert.equal(client.status, 201);
  const trainerId = id('usr');
  await w.db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, 'trainer@test.in', 'x', 'TRAINER', 'T', 1, ?)`,
    [trainerId, w.owner.orgId, now()]);
  const trainerToken = signToken({ id: trainerId, role: 'TRAINER', org_id: w.owner.orgId, name: 'T', email: 'trainer@test.in' });

  const probes = [
    ['GET', '/api/console/coupons'], ['GET', '/api/console/coupons/summary'], ['GET', `/api/console/coupons/${c.id}`],
    ['POST', '/api/console/coupons', couponBody({ code: 'HACKED' })],
    ['POST', `/api/console/coupons/${c.id}`, couponBody({ discountValue: 90 })],
    ['POST', `/api/console/coupons/${c.id}/disable`, {}], ['POST', `/api/console/coupons/${c.id}/enable`, {}],
    ['DELETE', `/api/console/coupons/${c.id}`], ['GET', `/api/console/coupons/${c.id}/redemptions/export`],
  ];
  for (const [method, p, body] of probes) {
    assert.equal((await w.api.call(method, p, body)).status, 401, `anon ${method} ${p}`);
    for (const [who, token] of [['owner', w.owner.token], ['trainer', trainerToken], ['client', client.json.token]]) {
      resetRateLimits();
      assert.equal((await w.api.call(method, p, body, token)).status, 403, `${who} ${method} ${p}`);
    }
  }
  const after = await couponRow(w.db, c.id);
  assert.equal(after.discount_value, 25, 'unchanged');
  assert.equal(after.is_enabled, 1, 'not disabled');
  assert.equal(await w.db.q1(`SELECT COUNT(*) AS n FROM coupons WHERE code = 'HACKED'`).then((r) => r.n), 0);
});

test('security: gyms cannot reach each other\'s quotes, holds or receipts', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  await w.mkCoupon();
  const other = await setupOwner(w.api, 'owner-b@test.in', 'Gym B');
  const q = await quote(w.api, w.owner.token, { couponCodes: ['BARBELL25'] });
  const steal = await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, other.token);
  assert.equal(steal.status, 422);
  assert.equal(steal.json.error, 'quote_not_found');
  await buy(w.api, w.owner, { codes: ['BARBELL25'] });
  const theirInvoices = await w.api.call('GET', '/api/enterprise/invoices', undefined, other.token);
  assert.equal(theirInvoices.json.invoices.length, 0);
});

test('security: coupon guessing is rate limited', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await quote(w.api, w.owner.token, { couponCodes: [`GUESS${i}X`] })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(422));
  assert.equal(statuses[8], 429);
  // An ordinary quote without a code is not affected by the coupon limiter.
  const plain = await quote(w.api, w.owner.token, {});
  assert.equal(plain.status, 200);
  const logged = await w.db.q1(`SELECT COUNT(*) AS n FROM events WHERE type = 'coupon_rejected'`);
  assert.equal(Number(logged.n), 8, 'rejections are logged for abuse review');
});

// ===============================================================
// ADMINISTRATION: edit rules, disable, delete, list, analytics, export
// ===============================================================

test('admin: editing after use locks the value fields but never rewrites history', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon();
  await buy(w.api, w.owner, { codes: ['BARBELL25'] });
  const locked = await w.api.call('POST', `/api/console/coupons/${c.id}`, couponBody({ discountValue: 50 }), w.admin.token);
  assert.equal(locked.status, 409);
  assert.equal(locked.json.error, 'field_locked');
  assert.deepEqual(locked.json.fields, ['discount_value']);
  const extended = await w.api.call('POST', `/api/console/coupons/${c.id}`, couponBody({ expiresDate: istDate(60), maxRedemptions: 50, founderNotes: 'extended' }), w.admin.token);
  assert.equal(extended.status, 200, JSON.stringify(extended.json));
  assert.equal(extended.json.coupon.max_redemptions, 50);
  const tooLow = await w.api.call('POST', `/api/console/coupons/${c.id}`, couponBody({ maxRedemptions: 1, expiresDate: istDate(60) }), w.admin.token);
  assert.equal(tooLow.status, 200, 'equal to used count is allowed');
  const [h] = await holds(w.db, c.id);
  assert.deepEqual([h.original_amount, h.discount_amount, h.final_amount], [13999, 3499.75, 10499.25], 'snapshot untouched');
  const audit = await w.db.q1(`SELECT * FROM admin_audit_logs WHERE action = 'coupon_updated' AND entity_id = ? ORDER BY created_at LIMIT 1`, [c.id]);
  assert.ok(audit.before_json && audit.after_json, 'edit audited with before/after');
});

test('admin: unused coupons can be fully edited; delete is only for unused coupons; disable/enable audited', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const c = await w.mkCoupon({ code: 'DRAFTCODE' });
  const edited = await w.api.call('POST', `/api/console/coupons/${c.id}`, couponBody({ code: 'FINALCODE', discountType: 'FIXED', discountValue: 750 }), w.admin.token);
  assert.equal(edited.status, 200);
  assert.equal(edited.json.coupon.code, 'FINALCODE');
  const dis = await w.api.call('POST', `/api/console/coupons/${c.id}/disable`, {}, w.admin.token);
  assert.equal(dis.json.coupon.status, 'DISABLED');
  assert.ok(dis.json.coupon.disabled_at);
  const en = await w.api.call('POST', `/api/console/coupons/${c.id}/enable`, {}, w.admin.token);
  assert.equal(en.json.coupon.status, 'ACTIVE');
  const del = await w.api.call('DELETE', `/api/console/coupons/${c.id}`, undefined, w.admin.token);
  assert.equal(del.status, 200);
  const actions = (await w.db.q(`SELECT action FROM admin_audit_logs WHERE entity_id = ? ORDER BY created_at`, [c.id])).map((r) => r.action);
  for (const a of ['coupon_created', 'coupon_updated', 'coupon_disabled', 'coupon_enabled', 'coupon_deleted']) assert.ok(actions.includes(a), a);

  const used = await w.mkCoupon({ code: 'USEDCODE' });
  await buy(w.api, w.owner, { codes: ['USEDCODE'] });
  const refuse = await w.api.call('DELETE', `/api/console/coupons/${used.id}`, undefined, w.admin.token);
  assert.equal(refuse.status, 409);
  assert.equal(refuse.json.error, 'coupon_in_use');
});

test('admin: list search/filter/sort/pagination and a dashboard built from verified redemptions only', async (t) => {
  const w = await world(); t.after(() => w.api.close());
  const a = await w.mkCoupon({ code: 'ALPHA10', discountValue: 10 });
  await w.mkCoupon({ code: 'BETA20', discountValue: 20, customerType: 'BOTH' });
  await w.mkCoupon({ code: 'GAMMA', startsDate: istDate(3), expiresDate: istDate(9) });
  await w.mkCoupon({ code: 'DELTA', startsDate: '2026-01-01', expiresDate: '2026-01-02' });
  const off = await w.mkCoupon({ code: 'EPSILON' });
  await w.api.call('POST', `/api/console/coupons/${off.id}/disable`, {}, w.admin.token);

  const search = await w.api.call('GET', '/api/console/coupons?search=alp', undefined, w.admin.token);
  assert.deepEqual(search.json.coupons.map((c) => c.code), ['ALPHA10']);
  const scheduled = await w.api.call('GET', '/api/console/coupons?status=SCHEDULED', undefined, w.admin.token);
  assert.deepEqual(scheduled.json.coupons.map((c) => c.code), ['GAMMA']);
  const both = await w.api.call('GET', '/api/console/coupons?customerType=BOTH', undefined, w.admin.token);
  assert.deepEqual(both.json.coupons.map((c) => c.code), ['BETA20']);
  const page = await w.api.call('GET', '/api/console/coupons?sort=code&dir=asc&limit=2&offset=2', undefined, w.admin.token);
  assert.equal(page.json.total, 5);
  assert.deepEqual(page.json.coupons.map((c) => c.code), ['DELTA', 'EPSILON']);
  const today = await w.api.call('GET', `/api/console/coupons?createdFrom=${istDate(0)}&createdTo=${istDate(0)}`, undefined, w.admin.token);
  assert.equal(today.json.total, 5);

  // One paid, one abandoned: only the paid one is a redemption.
  await buy(w.api, w.owner, { codes: ['ALPHA10'] });
  const other = await setupOwner(w.api, 'owner-b@test.in', 'Gym B');
  const q = await quote(w.api, other.token, { couponCodes: ['ALPHA10'] });
  await w.api.call('POST', '/api/enterprise/payment/order', { quoteId: q.json.quote.id }, other.token);

  const dash = await w.api.call('GET', '/api/console/coupons/summary', undefined, w.admin.token);
  assert.equal(dash.json.totalCoupons, 5);
  assert.equal(dash.json.active, 2);
  assert.equal(dash.json.scheduled, 1);
  assert.equal(dash.json.expired, 1);
  assert.equal(dash.json.disabled, 1);
  assert.equal(dash.json.successfulRedemptions, 1);
  assert.equal(dash.json.totalDiscountGiven, 1399.9);
  assert.equal(dash.json.grossRevenue, 12599.1);

  const detail = await w.api.call('GET', `/api/console/coupons/${a.id}`, undefined, w.admin.token);
  const an = detail.json.analytics;
  assert.equal(an.successfulRedemptions, 1);
  assert.equal(an.inFlight, 1, 'the unpaid order is in flight, not redeemed');
  assert.equal(an.totalDiscount, 1399.9);
  assert.equal(an.totalOriginalValue, 13999);
  assert.equal(an.totalRevenueCollected, 12599.1);
  assert.equal(an.uniqueCustomers, 1);
  assert.equal(an.enterpriseRedemptions, 1);
  assert.equal(an.independentRedemptions, 0);

  const hist = await w.api.call('GET', `/api/console/coupons/${a.id}/redemptions`, undefined, w.admin.token);
  assert.equal(hist.json.total, 1);
  assert.equal(hist.json.redemptions[0].org_name, 'Gym A');
  assert.ok(hist.json.redemptions[0].provider_payment_id, 'payment reference');
  assert.ok(hist.json.redemptions[0].invoice_number, 'invoice reference');
  assert.ok(hist.json.redemptions[0].subject_id, 'subscription reference');

  const csv = await w.api.call('GET', `/api/console/coupons/${a.id}/redemptions/export`, undefined, w.admin.token);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines.length, 2, 'header + the one verified redemption');
  assert.match(lines[0], /^redemption_id,coupon_code,status,gym/);
  assert.match(lines[1], /ALPHA10,REDEEMED,Gym A/);
  const all = await w.api.call('GET', '/api/console/coupons/export', undefined, w.admin.token);
  assert.equal(all.text.trim().split('\n').length, 6);
  assert.ok(await w.db.q1(`SELECT id FROM admin_audit_logs WHERE action = 'data_export'`), 'exports are audited');
});
