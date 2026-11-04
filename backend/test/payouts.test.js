// ============================================================
// GYM PAYOUTS: membership money goes to the gym, through Razorpay Route.
//
// Run against a FAKE Razorpay (fetch replaced, fake keys), in a child
// process so the provider reads PAYMENT_PROVIDER=razorpay fresh, with a
// real in-memory SQLite schema. Never calls Razorpay.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => JSON.stringify(pathToFileURL(path.join(backend, p)).href);
const schemaPath = JSON.stringify(path.join(backend, '..', 'database', 'schema.sql'));

/** Runs `body(ctx)` in Razorpay mode against `fetchStub`; returns its JSON. */
function inRazorpay(fetchStub, body, env = {}) {
  const script = `
    import fs from 'node:fs';
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(${schemaPath}, 'utf8'));
    for (const c of ['provider_product_id TEXT', 'requirements_json TEXT']) { try { raw.exec('ALTER TABLE payment_accounts ADD COLUMN ' + c); } catch {} }
    const db = {
      async q(sql, p = []) { return raw.prepare(sql).all(...p); },
      async q1(sql, p = []) { return raw.prepare(sql).all(...p)[0] || null; },
      async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    };
    raw.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_gym1', 'Iron Gym', 'iron', '2026-01-01')");
    const calls = [];
    const stub = ${fetchStub};
    globalThis.fetch = async (u, init = {}) => { calls.push({ method: init.method || 'GET', url: u, body: init.body ? JSON.parse(init.body) : null }); return stub(u, init); };
    const payouts = await import(${url('src/services/payments/payouts.js')});
    const provider = await import(${url('src/services/payments/paymentProvider.js')});
    const out = await (${body})({ db, raw, calls, payouts, provider });
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: backend,
    env: { ...process.env, NODE_ENV: 'development', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_FAKE', RAZORPAY_KEY_SECRET: 'fake_secret', ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const okJson = (data) => `({ ok: true, status: 200, json: async () => (${JSON.stringify(data)}), text: async () => ${JSON.stringify(JSON.stringify(data))} })`;

test('the gym gets the payment less Razorpay\'s fee, and the two add up exactly', () => {
  const out = inRazorpay('async () => ({ ok: true })', 'async ({ payouts }) => [payouts.splitPayment(1999), payouts.splitPayment(1), payouts.feePercent()]');
  assert.deepEqual(out[0], { total: 199900, fee: 4718, gym: 195182 });
  assert.equal(out[0].fee + out[0].gym, out[0].total);
  assert.equal(out[1].fee + out[1].gym, 100);
  assert.equal(out[2], 2.36);
});

test('the fee can be set, within reason', () => {
  const out = inRazorpay('async () => ({ ok: true })', 'async ({ payouts }) => payouts.splitPayment(1000)', { RAZORPAY_ROUTE_FEE_PERCENT: '0' });
  assert.deepEqual(out, { total: 100000, fee: 0, gym: 100000 });
});

test('no online payment for a gym until its payout account is active', () => {
  const out = inRazorpay('async () => ({ ok: true })', `async ({ db, payouts }) => {
    const none = await payouts.memberCheckout(db, 'org_gym1', 1999);
    await db.run("INSERT INTO payment_accounts (org_id, provider, provider_account_id, status, updated_at) VALUES ('org_gym1', 'razorpay', 'acc_X', 'KYC_PENDING', 'now')");
    const pending = await payouts.memberCheckout(db, 'org_gym1', 1999);
    await db.run("UPDATE payment_accounts SET status = 'ACTIVE' WHERE org_id = 'org_gym1'");
    const active = await payouts.memberCheckout(db, 'org_gym1', 1999);
    return { none, pending, active };
  }`);
  assert.equal(out.none.ok, false);
  assert.equal(out.pending.ok, false, 'under review is not paid out to yet');
  assert.equal(out.active.ok, true);
  assert.deepEqual(out.active.transfers[0], {
    account: 'acc_X', amount: 195182, currency: 'INR',
    notes: { purpose: 'gym_membership', org_id: 'org_gym1' }, linked_account_notes: ['purpose'], on_hold: false,
  });
});

test('a member order carries the gym\'s share to its linked account', () => {
  const out = inRazorpay(`async () => ${okJson({ id: 'order_1' })}`, `async ({ provider, calls }) => {
    await provider.createProviderOrder({ amount: 1999, currency: 'INR', receipt: 'r1', transfers: [{ account: 'acc_X', amount: 195182, currency: 'INR' }] });
    return calls[0].body;
  }`);
  assert.equal(out.amount, 199900);
  assert.deepEqual(out.transfers, [{ account: 'acc_X', amount: 195182, currency: 'INR' }]);
});

const DETAILS = {
  legalBusinessName: 'Iron Gym Fitness LLP', displayName: 'Iron Gym', businessType: 'llp', contactName: 'Maya Kapoor',
  email: 'maya@irongym.in', phone: '9876543210', pan: 'ABCDE1234F', street1: '12 MG Road', city: 'Bengaluru',
  state: 'KARNATAKA', postalCode: '560001', accountNumber: '123456789012', ifsc: 'HDFC0001234', beneficiaryName: 'Iron Gym Fitness LLP',
};

test('setting up payouts creates the Route account, its contact, Route and its bank, and keeps no bank or PAN numbers', () => {
  const out = inRazorpay(`async (u, init) => {
    if (u.endsWith('/v2/accounts')) return ${okJson({ id: 'acc_NEW', status: 'created' })};
    if (u.endsWith('/stakeholders')) return ${okJson({ id: 'sth_1' })};
    if (u.endsWith('/products') && init.method === 'POST') return ${okJson({ id: 'acc_prd_1', activation_status: 'requested', requirements: [] })};
    return ${okJson({ id: 'acc_prd_1', activation_status: 'under_review', requirements: [{ field_reference: 'settlements.beneficiary_name', reason_code: 'needs_clarification', status: 'required' }] })};
  }`, `async ({ db, raw, calls, payouts }) => {
    const account = await payouts.submitPayoutDetails(db, 'org_gym1', ${JSON.stringify(DETAILS)});
    const stored = JSON.stringify(raw.prepare('SELECT * FROM payment_accounts').all());
    return { account, view: payouts.payoutView(account), calls: calls.map((c) => c.method + ' ' + c.url.replace('https://api.razorpay.com', '')), bodies: calls.map((c) => c.body), stored };
  }`);
  assert.deepEqual(out.calls, [
    'POST /v2/accounts', 'POST /v2/accounts/acc_NEW/stakeholders', 'POST /v2/accounts/acc_NEW/products', 'PATCH /v2/accounts/acc_NEW/products/acc_prd_1',
  ]);
  assert.equal(out.bodies[0].profile.category, 'healthcare');
  assert.equal(out.bodies[0].profile.subcategory, 'fitness');
  assert.equal(out.bodies[0].reference_id, 'org_gym1');
  assert.deepEqual(out.bodies[3].settlements, { account_number: '123456789012', ifsc_code: 'HDFC0001234', beneficiary_name: 'Iron Gym Fitness LLP' });
  assert.equal(out.account.provider_account_id, 'acc_NEW');
  assert.equal(out.account.provider_product_id, 'acc_prd_1');
  assert.equal(out.view.status, 'KYC_PENDING');
  assert.deepEqual(out.view.requirements, [{ field: 'settlements.beneficiary_name', reason: 'needs_clarification', status: 'required' }]);
  assert.ok(!out.stored.includes('123456789012'), 'no bank account number stored');
  assert.ok(!out.stored.includes('ABCDE1234F'), 'no PAN stored');
  assert.ok(!out.stored.includes('HDFC0001234'), 'no IFSC stored');
});

test('resubmitting fixes the bank details on the same account, never a second one', () => {
  const out = inRazorpay(`async () => ${okJson({ id: 'acc_prd_1', activation_status: 'activated', requirements: [] })}`, `async ({ db, calls, payouts }) => {
    await db.run("INSERT INTO payment_accounts (org_id, provider, provider_account_id, provider_product_id, status, updated_at) VALUES ('org_gym1', 'razorpay', 'acc_OLD', 'acc_prd_1', 'LIMITED', 'now')");
    const account = await payouts.submitPayoutDetails(db, 'org_gym1', ${JSON.stringify(DETAILS)});
    return { status: account.status, calls: calls.map((c) => c.method + ' ' + c.url.replace('https://api.razorpay.com', '')) };
  }`);
  assert.deepEqual(out.calls, ['PATCH /v2/accounts/acc_OLD/products/acc_prd_1']);
  assert.equal(out.status, 'ACTIVE');
});

test('Razorpay refusing a detail comes back as its own words, for the owner to fix', () => {
  const out = inRazorpay(`async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid PAN', field: 'legal_info.pan' } }) })`,
    `async ({ db, payouts }) => {
      try { await payouts.submitPayoutDetails(db, 'org_gym1', ${JSON.stringify(DETAILS)}); return { ok: true }; }
      catch (e) { return { code: e.code, status: e.status, message: e.publicMessage, field: e.field }; }
    }`);
  assert.deepEqual(out, { code: 'payment_gateway_rejected', status: 422, message: 'Invalid PAN', field: 'legal_info.pan' });
});

test('the status check reads Razorpay\'s answer into the account', () => {
  const out = inRazorpay(`async () => ${okJson({ id: 'acc_prd_1', activation_status: 'activated', requirements: [] })}`, `async ({ db, payouts }) => {
    await db.run("INSERT INTO payment_accounts (org_id, provider, provider_account_id, provider_product_id, status, updated_at) VALUES ('org_gym1', 'razorpay', 'acc_X', 'acc_prd_1', 'KYC_PENDING', 'now')");
    return (await payouts.refreshPayoutStatus(db, 'org_gym1')).status;
  }`);
  assert.equal(out, 'ACTIVE');
});
