// ============================================================
// AI COMMUNICATION -- PRODUCTION HARDENING
//
// Security (tenant isolation through direct API calls, admin boundary,
// webhook authentication and replay), money (exactly-once ledger, lost
// purchases, unknown call durations, negative balances, pricing properties),
// the queue (calling-hours boundaries incl. DST, send-time revalidation,
// crash recovery, retries, provider timeouts), provider adapter contracts,
// consent persistence, the owner audit trail and the admin health checks.
//
// Runs on in-memory SQLite by default and, unchanged, on real PostgreSQL
// when TEST_DATABASE_URL is set (helpers/followupsDb.js). Provider contract
// tests use recorded/documented payload shapes and stubbed fetch: they prove
// the adapters' parsing and requests, NOT a live provider account.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { memDb, driverName } from './helpers/followupsDb.js';
import { seedGym, addMember, enableGym, voiceCampaign, whatsappTemplate, owner, admin, startApi, today, noon, K, at } from './helpers/followupsSeed.js';

const wallet = await import('../src/services/followups/wallet.js');
const engine = await import('../src/services/followups/engine.js');
const exotel = await import('../src/services/followups/providers/exotel.js');
const elevenlabs = await import('../src/services/followups/providers/elevenlabs.js');
const http = await import('../src/services/followups/providers/http.js');
const mock = await import('../src/services/followups/providers/mock.js');
const { recordConsent } = await import('../src/services/followups/consent.js');
const { jobToken, sign } = await import('../src/services/followups/config.js');
const { redactUrl } = await import('../src/utils/redactUrl.js');

const num = (v) => Number(v || 0);
const ledger = (db, jobId, reason) => db.q(`SELECT * FROM followup_ledger WHERE job_id = ? AND reason = ?`, [jobId, reason]);
async function job(db, { id, org, channel = 'call', status = 'dialing', client = null, provider = 'exotel', ref = null, dialedMinAgo = 1, unit = 'voice:standard' }) {
  const ts = new Date(Date.now() - dialedMinAgo * 60_000).toISOString();
  await db.run(`INSERT INTO followup_jobs (id, org_id, client_id, channel, dedupe_key, day_key, status, provider, provider_ref, unit, created_at, dialed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, org, client, channel, id, today, status, provider, ref, unit, ts, ts, ts]);
  return db.q1('SELECT * FROM followup_jobs WHERE id = ?', [id]);
}
/** Swap a function on a provider adapter for one test. */
async function withStub(obj, key, fn, body) {
  const prev = obj[key];
  obj[key] = fn;
  try { return await body(); } finally { obj[key] = prev; }
}
async function withEnv(vars, body) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await body(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function withFetch(fake, body) {
  const prev = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await body(); } finally { globalThis.fetch = prev; }
}
const EXOTEL_ENV = { EXOTEL_SID: 'acme', EXOTEL_API_KEY: 'k_test', EXOTEL_API_TOKEN: 't_test', EXOTEL_SUBDOMAIN: 'api.in.exotel.com', EXOTEL_FLOW_APP_ID: '123' };

/* ═══════════════════════ security: tenant isolation ═══════════════════════ */

test('security: gym A cannot read or change gym B through direct API calls with B\'s ids', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'ga'); await seedGym(db, 'gb');
    const mb = await addMember(db, 'gb', { lastVisit: 9 });
    const ts = new Date().toISOString();
    await db.run(`INSERT INTO followup_numbers (id, org_id, number, is_primary, created_at, updated_at) VALUES ('nb', 'gb', '+918000000009', 1, ?, ?)`, [ts, ts]);
    await db.run(`INSERT INTO followup_callbacks (id, org_id, client_id, channel, status, created_at, updated_at) VALUES ('cbb', 'gb', ?, 'call', 'new', ?, ?)`, [mb.cid, ts, ts]);
    const rid = await voiceCampaign(db, 'gb');
    await db.run(`INSERT INTO followup_orders (id, org_id, pack_id, pack_json, amount, provider, provider_order_id, status, created_at, updated_at) VALUES ('ob', 'gb', 'sms_1000', '{}', 449, 'mock', 'order_b', 'CREATED', ?, ?)`, [ts, ts]);

    const A = owner('ga');
    assert.equal((await api.call('GET', `/api/followups/members/${mb.cid}/history`, A)).status, 404, 'member history');
    assert.equal((await api.call('PUT', `/api/followups/members/${mb.cid}/prefs`, A, { paused_until: K(3) })).status, 404, 'member prefs');
    const bulk = await api.call('POST', '/api/followups/members/consent', A, { client_ids: [mb.cid], channels: ['whatsapp'], action: 'granted', evidence: 'Forged form', attest: true });
    assert.equal(bulk.json.changed, 0, 'consent for another gym\'s member is ignored');
    assert.equal((await db.q1('SELECT wa_consent FROM followup_member_prefs WHERE client_id = ?', [mb.cid])).wa_consent, null);
    assert.equal((await api.call('PUT', '/api/followups/numbers/nb', A, { label: 'Mine now', is_primary: true })).status, 404, 'caller number');
    assert.equal((await db.q1(`SELECT label, is_primary FROM followup_numbers WHERE id = 'nb'`)).label, null);
    assert.equal((await api.call('PUT', '/api/followups/callbacks/cbb', A, { status: 'completed' })).status, 404, 'callback');
    assert.equal((await api.call('POST', '/api/followups/orders/ob/verify', A, { providerPaymentId: 'pay', signature: 'x' })).status, 404, 'order');
    assert.equal((await api.call('POST', `/api/followups/rules/${rid}/status`, A, { status: 'paused' })).status, 404, 'campaign');
    await api.call('DELETE', `/api/followups/rules/${rid}`, A);
    assert.ok(await db.q1('SELECT id FROM followup_rules WHERE id = ?', [rid]), 'B\'s campaign survives A\'s delete');
    const members = await api.call('GET', '/api/followups/members', A);
    assert.ok(!JSON.stringify(members.json).includes(mb.cid), 'B\'s member not listed to A');
    const usage = await api.call('GET', '/api/followups/usage', A);
    assert.equal(usage.status, 200);
    assert.ok(!JSON.stringify(usage.json).includes('gb'), 'no trace of gym B in A\'s usage');
  } finally { await api.close(); }
});

test('security: only the platform admin reaches the AI Communication console; members never reach owner settings', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'ga');
    for (const who of [owner('ga'), { sub: 'trainer_ga', role: 'TRAINER', org: 'ga' }, { sub: 'm', role: 'CLIENT', org: 'ga' }]) {
      assert.equal((await api.call('GET', '/api/console/communication/health', who)).status, 403, `${who.role} health`);
      assert.equal((await api.call('PUT', '/api/console/communication/pricing', who, { margin_pct: 1 })).status, 403, `${who.role} price book`);
      assert.equal((await api.call('POST', '/api/console/communication/gyms/ga/adjust', who, { unit: 'sms', delta: 1000, reason: 'free money' })).status, 403, `${who.role} adjust`);
      assert.equal((await api.call('PUT', '/api/console/communication/platform', who, { paused: false, paused_channels: [] })).status, 403, `${who.role} platform`);
    }
    assert.equal((await api.call('GET', '/api/console/communication/health')).status, 401, 'no session');
    assert.equal((await api.call('GET', '/api/followups/settings', { sub: 'm', role: 'CLIENT', org: 'ga' })).status, 403, 'member on owner settings');
    assert.equal((await api.call('PUT', '/api/followups/settings', { sub: 'trainer_ga', role: 'TRAINER', org: 'ga' }, { enabled: true })).status, 403, 'trainer on owner settings');
    assert.equal((await api.call('GET', '/api/console/communication/health', admin())).status, 200, 'the admin');
  } finally { await api.close(); }
});

/* ═══════════════════════ security: webhooks ═══════════════════════ */

test('webhooks: ElevenLabs signature -- documented scheme, 30-minute replay window, rotation, tampering', () => {
  const secret = 'whsec_contract';
  const body = '{"type":"post_call_transcription","data":{}}';
  const now = 1_800_000_000;
  const sig = (t, b = body, s = secret) => crypto.createHmac('sha256', s).update(`${t}.${b}`).digest('hex');
  const ok = (h, b = body) => elevenlabs.verifyWebhook(b, h, secret, 1800, now);
  assert.equal(ok(`t=${now},v0=${sig(now)}`), true, 'valid');
  assert.equal(ok(`t=${now - 1799},v0=${sig(now - 1799)}`), true, 'inside the window');
  assert.equal(ok(`t=${now - 1801},v0=${sig(now - 1801)}`), false, 'replayed after 30 minutes');
  assert.equal(ok(`t=${now + 1801},v0=${sig(now + 1801)}`), false, 'from the future');
  assert.equal(ok(`t=${now},v0=${sig(now)}`, `${body} `), false, 'body changed by one byte');
  assert.equal(ok(`t=${now},v0=${sig(now, body, 'other')}`), false, 'wrong secret');
  assert.equal(ok(`t=${now},v0=deadbeef,v0=${sig(now)}`), true, 'two signatures during a secret rotation, one valid');
  assert.equal(ok(`v0=${sig(now)}`), false, 'no timestamp');
  assert.equal(ok(''), false, 'no header');
  assert.equal(elevenlabs.verifyWebhook(body, `t=${now},v0=${sig(now)}`, '', 1800, now), false, 'no secret configured: refuse');
});

test('webhooks: forged or mismatched Exotel callbacks change nothing; WhatsApp needs its key; malformed agent results are 400', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'ga');
    await wallet.creditUnits(db, 'ga', { 'voice:standard': 5 }, { reason: 'purchase' });
    await job(db, { id: 'jx', org: 'ga', ref: 'CA_real' });
    await wallet.holdUnits(db, 'ga', 'voice:standard', 1, { jobId: 'jx' });
    const forged = `jx.${'A'.repeat(22)}`;
    let r = await api.call('POST', `/api/followups/hooks/exotel/status?j=${encodeURIComponent(forged)}`, {}, { CallSid: 'CA_real', Status: 'completed', ConversationDuration: 600 });
    assert.equal(r.json.ok, false, 'forged token');
    r = await api.call('POST', `/api/followups/hooks/exotel/status?j=${encodeURIComponent(jobToken('jx'))}`, {}, { CallSid: 'CA_other', Status: 'completed', ConversationDuration: 600 });
    assert.equal(r.json.ok, false, 'someone else\'s call id');
    assert.equal((await db.q1(`SELECT status FROM followup_jobs WHERE id = 'jx'`)).status, 'dialing');
    assert.equal((await ledger(db, 'jx', 'usage')).length, 0);
    r = await api.call('POST', `/api/followups/hooks/exotel/keypress?CustomField=${encodeURIComponent(forged)}&digits=9`);
    assert.equal((await db.q1(`SELECT digits FROM followup_jobs WHERE id = 'jx'`)).digits, null, 'a forged keypress cannot opt anyone out');

    assert.equal((await api.call('POST', '/api/followups/hooks/exotel/whatsapp', {}, { messages: [{ from: '9876500001', content: { text: { body: 'STOP' } } }] })).status, 403, 'no key');
    assert.equal((await api.call('POST', '/api/followups/hooks/exotel/whatsapp?k=wrong', {}, { messages: [] })).status, 403, 'wrong key');
    assert.equal((await api.call('POST', `/api/followups/hooks/exotel/whatsapp?k=${sign('whatsapp-inbound')}`, {}, { unexpected: ['shape'] })).status, 200, 'unknown shape is ignored, not a 500');

    await withEnv({ ELEVENLABS_WEBHOOK_SECRET: 'whsec_x' }, async () => {
      const raw = '{not json';
      const t = Math.floor(Date.now() / 1000);
      const h = `t=${t},v0=${crypto.createHmac('sha256', 'whsec_x').update(`${t}.${raw}`).digest('hex')}`;
      const res = await api.call('POST', '/api/followups/hooks/elevenlabs', {}, null, { headers: { 'ElevenLabs-Signature': h }, raw });
      assert.equal(res.status, 400, 'signed but unreadable: a clean 400, not a retried 500');
    });
  } finally { await api.close(); }
});

test('logs: credentials in callback URLs are masked before the access log is written', () => {
  assert.equal(redactUrl('/api/followups/hooks/exotel/whatsapp?k=SECRETKEY'), '/api/followups/hooks/exotel/whatsapp?k=***');
  assert.equal(redactUrl('/api/followups/audio/fa1.wav?t=abc'), '/api/followups/audio/fa1.wav?t=***');
  assert.equal(redactUrl('/api/followups/hooks/exotel/status?j=fj_1.mac&x=1'), '/api/followups/hooks/exotel/status?j=***&x=1');
  assert.equal(redactUrl('/api/reset?token=t1&signature=s'), '/api/reset?token=***&signature=***');
  assert.equal(redactUrl('/api/followups/overview'), '/api/followups/overview');
  assert.equal(redactUrl('/api/x?page=2'), '/api/x?page=2');
});

/* ═══════════════════════ money ═══════════════════════ */

test('ledger: a second hold/release/usage/refund row for the same job is impossible, and a negative balance is refused by the database', async () => {
  const db = await memDb();
  await seedGym(db, 'g1');
  await wallet.creditUnits(db, 'g1', { sms: 10 }, { values: { sms: 5 }, reason: 'purchase' });
  await job(db, { id: 'j1', org: 'g1', channel: 'sms', unit: 'sms' });
  const j = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'j1'`);
  assert.equal(await wallet.chargeMessage(db, j, 'sms', 2), true);
  assert.equal(await wallet.chargeMessage(db, j, 'sms', 2), true, 'a repeated charge reports done');
  assert.equal((await ledger(db, 'j1', 'usage')).length, 1, 'charged once');
  assert.equal((await wallet.getWallet(db, 'g1')).sms, 8);
  await assert.rejects(db.run(`INSERT INTO followup_ledger (id, org_id, unit, delta, reason, job_id, created_at) VALUES ('dup', 'g1', 'sms', -2, 'usage', 'j1', ?)`, [new Date().toISOString()]), /UNIQUE|unique|duplicate/, 'database refuses a second usage row');
  assert.equal(await wallet.refundJob(db, j, 'failed'), true);
  assert.equal(await wallet.refundJob(db, j, 'failed'), false);
  assert.equal((await ledger(db, 'j1', 'refund')).length, 1);
  await assert.rejects(db.run(`UPDATE followup_balances SET balance = -1 WHERE org_id = 'g1' AND unit = 'sms'`), /CHECK|check/, 'no negative balance, whatever writes it');
});

test('ledger: every balance equals the sum of its ledger rows after a full mixed workload', async () => {
  const db = await memDb();
  await seedGym(db, 'g2');
  await enableGym(db, 'g2');
  await wallet.creditUnits(db, 'g2', { 'voice:standard': 40, whatsapp: 20 }, { values: { 'voice:standard': 400, whatsapp: 30 }, reason: 'purchase' });
  await wallet.grantTrialOnce(db, 'g2');
  for (let i = 0; i < 12; i++) await addMember(db, 'g2', { lastVisit: 8 + (i % 3), consent: ['call', 'whatsapp'] });
  await voiceCampaign(db, 'g2', { sequence: [{ channel: 'whatsapp' }, { channel: 'call', after_hours: 0 }] });
  await whatsappTemplate(db, 'g2');
  for (let i = 0; i < 3; i++) { await engine.planOrg(db, 'g2', { at: noon }); await engine.dispatchOrg(db, 'g2', { at: noon }); }
  const balances = await db.q(`SELECT unit, balance, value FROM followup_balances WHERE org_id = 'g2'`);
  for (const b of balances) {
    const s = await db.q1(`SELECT SUM(delta) AS s FROM followup_ledger WHERE org_id = 'g2' AND unit = ?`, [b.unit]);
    assert.ok(Math.abs(num(b.balance) - num(s.s)) < 1e-9, `${b.unit}: balance ${b.balance} = ledger ${s.s}`);
    assert.ok(num(b.value) >= 0);
  }
  const held = await db.q1(`SELECT SUM(units_held) AS h FROM followup_jobs WHERE org_id = 'g2'`);
  assert.equal(num(held.h), 0, 'no hold left behind');
});

test('purchases: a payment that lands after the order was cancelled or failed is still credited -- exactly once', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'gp');
    const { mockSimulateCheckout } = await import('../src/services/payments/paymentProvider.js');
    const { confirmFromWebhook } = await import('../src/services/followups/orders.js');
    const cat = await api.call('GET', '/api/followups/catalogue', owner('gp'));
    const pack = cat.json.packs.find((p) => p.id === 'sms_1000');
    const sms = async () => (await wallet.getWallet(db, 'gp')).sms;
    const start = await sms();

    // 1. Checkout closed (order cancelled) while the UPI payment completed; the webhook arrives later.
    const o1 = (await api.call('POST', '/api/followups/orders', owner('gp'), { packId: pack.id })).json.order;
    await api.call('POST', `/api/followups/orders/${o1.id}/cancel`, owner('gp'));
    assert.equal((await db.q1('SELECT status FROM followup_orders WHERE id = ?', [o1.id])).status, 'CANCELLED');
    const p1 = mockSimulateCheckout(o1.provider_order_id);
    await confirmFromWebhook(db, await db.q1('SELECT * FROM followup_orders WHERE id = ?', [o1.id]), { status: 'SUCCESS', providerPaymentId: p1.paymentId, amount: o1.amount, currency: 'INR' });
    await confirmFromWebhook(db, await db.q1('SELECT * FROM followup_orders WHERE id = ?', [o1.id]), { status: 'SUCCESS', providerPaymentId: p1.paymentId, amount: o1.amount, currency: 'INR' });
    assert.equal((await db.q1('SELECT status FROM followup_orders WHERE id = ?', [o1.id])).status, 'SUCCESS');
    assert.equal(await sms() - start, 1000, 'credited once');

    // 2. A first attempt failed, the retry on the same order succeeded (checkout verification path).
    const o2 = (await api.call('POST', '/api/followups/orders', owner('gp'), { packId: pack.id })).json.order;
    await confirmFromWebhook(db, await db.q1('SELECT * FROM followup_orders WHERE id = ?', [o2.id]), { status: 'FAILED' });
    assert.equal((await db.q1('SELECT status FROM followup_orders WHERE id = ?', [o2.id])).status, 'FAILED');
    const p2 = mockSimulateCheckout(o2.provider_order_id);
    const v = await api.call('POST', `/api/followups/orders/${o2.id}/verify`, owner('gp'), { providerPaymentId: p2.paymentId, signature: p2.signature });
    assert.equal(v.json.order.status, 'SUCCESS');
    assert.equal(await sms() - start, 2000);

    // 3. A wrong amount is never activated; a bad signature never activates a cancelled order.
    const o3 = (await api.call('POST', '/api/followups/orders', owner('gp'), { packId: pack.id })).json.order;
    const r3 = await confirmFromWebhook(db, await db.q1('SELECT * FROM followup_orders WHERE id = ?', [o3.id]), { status: 'SUCCESS', providerPaymentId: 'pay_x', amount: 1, currency: 'INR' });
    assert.equal(r3.reason, 'amount_mismatch');
    await api.call('POST', `/api/followups/orders/${o3.id}/cancel`, owner('gp'));
    const bad = await api.call('POST', `/api/followups/orders/${o3.id}/verify`, owner('gp'), { providerPaymentId: 'pay_x', signature: 'ab'.repeat(32) });
    assert.equal(bad.status, 422);
    assert.equal(await sms() - start, 2000, 'nothing extra credited');
    const purchases = await db.q(`SELECT order_id FROM followup_ledger WHERE org_id = 'gp' AND reason = 'purchase'`);
    assert.equal(purchases.length, 2);
  } finally { await api.close(); }
});

test('calls: an answered call with no reported duration keeps its hold, then settles from the provider\'s record -- never at zero', async () => {
  const db = await memDb();
  await seedGym(db, 'gd');
  await wallet.creditUnits(db, 'gd', { 'voice:standard': 10 }, { values: { 'voice:standard': 100 }, reason: 'purchase' });

  // A: the callback says completed without a duration; Call Details later says 125 s.
  let j = await job(db, { id: 'ja', org: 'gd', ref: 'CA_a', dialedMinAgo: 10 });
  await wallet.holdUnits(db, 'gd', 'voice:standard', 1, { jobId: 'ja' });
  await engine.applyCallStatus(db, j, exotel.parseCallStatus({ CallSid: 'CA_a', Status: 'completed' }));
  j = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'ja'`);
  assert.equal(j.status, 'completed');
  assert.equal(num(j.units_held), 1, 'hold kept');
  assert.equal((await ledger(db, 'ja', 'usage')).length, 0, 'not settled at zero');
  assert.equal((await wallet.pendingHolds(db, 'gd'))['voice:standard'], 1, 'shown as on hold');
  await engine.applyCallStatus(db, j, { status: 'no_answer', duration: 0 });
  assert.equal((await ledger(db, 'ja', 'usage')).length, 0, 'a late contradictory status is ignored');
  const telephony = { fetchCall: async (ref) => (ref === 'CA_a' ? { status: 'completed', duration: 125 } : null) };
  await engine.sweep(db, 'gd', { telephony, at: Date.now() + 5 * 60_000 });
  const ua = await ledger(db, 'ja', 'usage');
  assert.equal(ua.length, 1);
  assert.equal(num(ua[0].delta), -3, '125 s = 3 minutes');
  assert.equal(ua[0].provider_ref, 'CA_a');

  // B: the provider never reports a duration -> nothing for an hour, then the 1-minute minimum, labelled.
  j = await job(db, { id: 'jb', org: 'gd', ref: 'CA_b', dialedMinAgo: 2 });
  await wallet.holdUnits(db, 'gd', 'voice:standard', 1, { jobId: 'jb' });
  await engine.applyCallStatus(db, j, { status: 'completed', duration: null });
  const none = { fetchCall: async () => ({ status: 'completed', duration: null }) };
  await engine.sweep(db, 'gd', { telephony: none, at: Date.now() + 30 * 60_000 });
  assert.equal((await ledger(db, 'jb', 'usage')).length, 0, 'still waiting at 30 minutes');
  await engine.sweep(db, 'gd', { telephony: none, at: Date.now() + 61 * 60_000 });
  const ub = await ledger(db, 'jb', 'usage');
  assert.equal(num(ub[0]?.delta), -1, 'charged the minimum pulse');
  assert.equal((await db.q1(`SELECT error FROM followup_jobs WHERE id = 'jb'`)).error, engine.UNKNOWN_DURATION_NOTE);

  // C: a duplicate completed callback after settlement changes nothing.
  await engine.applyCallStatus(db, await db.q1(`SELECT * FROM followup_jobs WHERE id = 'ja'`), { status: 'completed', duration: 900 });
  assert.equal((await ledger(db, 'ja', 'usage')).length, 1);
  assert.equal((await wallet.getWallet(db, 'gd'))['voice:standard'], 10 - 3 - 1);
});

test('queue: a call lost in a crash (claimed, never placed) is released by the sweep -- nothing charged, nothing stuck', async () => {
  const db = await memDb();
  await seedGym(db, 'gc');
  await wallet.creditUnits(db, 'gc', { 'voice:standard': 5 }, { reason: 'purchase' });
  await job(db, { id: 'jl', org: 'gc', ref: null, dialedMinAgo: 31 });
  await wallet.holdUnits(db, 'gc', 'voice:standard', 1, { jobId: 'jl' });
  assert.equal((await wallet.getWallet(db, 'gc'))['voice:standard'], 4);
  await engine.sweep(db, 'gc', { telephony: mock.telephony });
  const j = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'jl'`);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /No result from the provider/);
  assert.equal(num(j.units_held), 0);
  assert.equal((await wallet.getWallet(db, 'gc'))['voice:standard'], 5, 'hold given back');
  // A job still queued from long ago (e.g. before a long outage) is never sent late.
  await job(db, { id: 'jq', org: 'gc', status: 'queued', dialedMinAgo: 7 * 60 });
  await engine.sweep(db, 'gc', { telephony: mock.telephony });
  assert.equal((await db.q1(`SELECT status FROM followup_jobs WHERE id = 'jq'`)).status, 'skipped');
});

test('pricing: tax, markup and floors hold for every pack and for 400 random price books (property test)', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const books = [wallet.DEFAULT_PRICE_BOOK];
  for (let i = 0; i < 400; i++) {
    const b = JSON.parse(JSON.stringify(wallet.DEFAULT_PRICE_BOOK));
    b.margin_pct = Math.round(rnd() * 80);
    b.tax = { rate_pct: [0, 5, 12, 18, 28][Math.floor(rnd() * 5)], inclusive: rnd() < 0.6, label: 'GST' };
    for (const k of Object.keys(b.costs)) b.costs[k] = r2(b.costs[k] * (0.2 + rnd() * 3));
    for (const p of b.packs) p.price = Math.max(1, Math.round(p.price * (0.3 + rnd() * 2)));
    books.push(wallet.cleanPriceBook(b));
  }
  for (const book of books) {
    const costs = wallet.unitCosts(book);
    for (const [k, c] of Object.entries(costs)) assert.ok(Number.isFinite(c) && c >= 0, `cost ${k}`);
    for (const p of book.packs) {
      const t = wallet.taxed(p.price, book);
      assert.ok(Math.abs(t.net + t.tax - t.total) <= 0.01, `net + tax = total (${p.id})`);
      if (book.tax.inclusive !== false) assert.equal(t.total, r2(p.price), 'inclusive: the price is what the gym pays');
      else assert.ok(Math.abs(t.total - p.price * (1 + book.tax.rate_pct / 100)) <= 0.01);
      const e = wallet.evaluatePack(p, book);
      assert.equal(e.healthy, e.net >= e.floor, 'healthy iff the pre-tax price covers cost + margin');
      assert.ok(Math.abs(e.profit - (e.net - e.cost)) <= 0.011);
      assert.ok(e.floor >= e.cost);
    }
  }
  for (const p of wallet.DEFAULT_PRICE_BOOK.packs) assert.ok(wallet.evaluatePack(p, wallet.DEFAULT_PRICE_BOOK).healthy, `default ${p.id} covers cost + margin`);
});

test('pricing: spending a balance in random chunks never takes more value than was paid, and empties to zero', async () => {
  const db = await memDb();
  await seedGym(db, 'gv');
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  await wallet.creditUnits(db, 'gv', { sms: 997 }, { values: { sms: 1234.57 }, reason: 'purchase' });
  let left = 997;
  let taken = 0;
  for (let i = 0; left > 0; i++) {
    const n = Math.min(left, 1 + Math.floor(rnd() * 37));
    assert.equal(await wallet.holdUnits(db, 'gv', 'sms', n, { jobId: `jv${i}` }), true);
    taken += num((await ledger(db, `jv${i}`, 'hold'))[0].charge_inr);
    left -= n;
  }
  const w = await db.q1(`SELECT balance, value FROM followup_balances WHERE org_id = 'gv' AND unit = 'sms'`);
  assert.equal(num(w.balance), 0);
  assert.ok(num(w.value) >= 0 && num(w.value) < 0.05, `value left ${w.value}`);
  assert.ok(taken <= 1234.57 + 0.01 && taken >= 1234.57 - 0.05, `value taken ${taken}`);
  assert.equal(await wallet.holdUnits(db, 'gv', 'sms', 1, { jobId: 'jv_over' }), false, 'nothing left: refused');
});

test('sales: in "off" mode (production, providers not set up) nothing can be bought -- not even SMS or WhatsApp', async () => {
  const { config } = await import('../src/config.js');
  const prev = config.nodeEnv;
  const api = await startApi();
  try {
    await seedGym(api.db, 'go');
    config.nodeEnv = 'production';
    const cat = await api.call('GET', '/api/followups/catalogue', owner('go'));
    assert.equal(cat.status, 200);
    assert.ok(cat.json.packs.length > 0);
    assert.deepEqual(cat.json.packs.filter((p) => p.available).map((p) => p.id), [], 'every pack shows "coming soon"');
    for (const packId of ['sms_1000', 'wa_500', 'line_30', 'voice_standard_300']) {
      const o = await api.call('POST', '/api/followups/orders', owner('go'), { packId });
      assert.equal(o.status, 409, `${packId} cannot be bought`);
    }
    assert.equal(num((await api.db.q1(`SELECT COUNT(*) AS n FROM followup_orders WHERE org_id = 'go'`)).n), 0, 'no order, so no checkout and no charge');
    config.nodeEnv = prev;
    const test = await api.call('GET', '/api/followups/catalogue', owner('go'));
    assert.ok(test.json.packs.find((p) => p.id === 'sms_1000').available, 'test mode still sells (simulated)');
  } finally { config.nodeEnv = prev; await api.close(); }
});

test('pricing: an order keeps the price-book version and value it was sold at, whatever is saved after', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'gpv');
    const { mockSimulateCheckout } = await import('../src/services/payments/paymentProvider.js');
    const o = (await api.call('POST', '/api/followups/orders', owner('gpv'), { packId: 'wa_500' })).json.order;
    const book = await wallet.getPriceBook(db);
    const next = { ...book, packs: book.packs.map((p) => (p.id === 'wa_500' ? { ...p, price: 9999 } : p)) };
    assert.equal((await api.call('PUT', '/api/console/communication/pricing', admin(), next)).status, 200);
    const p = mockSimulateCheckout(o.provider_order_id);
    await api.call('POST', `/api/followups/orders/${o.id}/verify`, owner('gpv'), { providerPaymentId: p.paymentId, signature: p.signature });
    const row = await db.q1(`SELECT charge_inr, pricing_version FROM followup_ledger WHERE order_id = ? AND reason = 'purchase'`, [o.id]);
    assert.equal(num(row.pricing_version), 0, 'sold under the defaults');
    assert.equal(num(row.charge_inr), wallet.taxed(899, wallet.DEFAULT_PRICE_BOOK).net, 'valued at what was paid, not the new price');
    assert.equal((await api.call('GET', '/api/followups/catalogue', owner('gpv'))).json.packs.find((x) => x.id === 'wa_500').price, 9999, 'new buyers see the new price');
  } finally { await api.close(); }
});

/* ═══════════════════════ queue & schedule ═══════════════════════ */

test('calling hours: 09:00-21:00 hard limits, the owner\'s window, days off, and DST in another timezone', () => {
  const s = { window_start: '09:00', window_end: '21:00', days_mask: '1111111' };
  const IN = 'Asia/Kolkata';
  assert.equal(engine.inCallingHours(s, IN, at('08:59')), false);
  assert.equal(engine.inCallingHours(s, IN, at('09:00')), true);
  assert.equal(engine.inCallingHours(s, IN, at('20:59')), true);
  assert.equal(engine.inCallingHours(s, IN, at('21:00')), false, '21:00 is already outside');
  const wide = { ...s, window_start: '06:00', window_end: '23:30' };
  assert.equal(engine.inCallingHours(wide, IN, at('08:30')), false, 'an owner cannot open before 09:00');
  assert.equal(engine.inCallingHours(wide, IN, at('21:15')), false, 'or after 21:00');
  const sunday = '2026-11-15';
  assert.equal(engine.inCallingHours({ ...s, days_mask: '1111110' }, IN, at('12:00', sunday)), false, 'Sunday off');
  assert.equal(engine.inCallingHours({ ...s, days_mask: '1111110' }, IN, at('12:00', '2026-11-16')), true, 'Monday on');
  const NY = 'America/New_York';
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-03-07T14:30:00Z')), true, '09:30 EST');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-03-07T13:30:00Z')), false, '08:30 EST');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-03-08T13:30:00Z')), true, '09:30 EDT, the morning clocks went forward');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-03-08T12:30:00Z')), false, '08:30 EDT');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-11-01T14:00:00Z')), true, '09:00 EST, the morning clocks went back');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-11-02T01:59:00Z')), true, '20:59 EST');
  assert.equal(engine.inCallingHours(s, NY, new Date('2026-11-02T02:00:00Z')), false, '21:00 EST');
});

test('dispatch: a visit, a renewal or a payment after planning stops the contact before it is placed', async () => {
  const db = await memDb();
  await seedGym(db, 'gs');
  await enableGym(db, 'gs');
  await wallet.creditUnits(db, 'gs', { 'voice:standard': 30 }, { reason: 'purchase' });
  const away = await addMember(db, 'gs', { lastVisit: 9 });
  const ending = await addMember(db, 'gs', { lastVisit: 1, endIn: 3 });
  const owing = await addMember(db, 'gs', { lastVisit: 1, unpaid: 1, startAgo: 2 });   // billed 2 days ago: inside the payment campaign's contacts
  const stays = await addMember(db, 'gs', { lastVisit: 9 });
  await voiceCampaign(db, 'gs', { kind: 'missed_visits' });
  await voiceCampaign(db, 'gs', { kind: 'membership_ending', config: { before: [3] } });
  await voiceCampaign(db, 'gs', { kind: 'payment_due' });
  const plan = await engine.planOrg(db, 'gs', { at: noon });
  assert.ok(plan.queued >= 4, JSON.stringify(plan));
  await db.run(`INSERT INTO attendance (id, org_id, client_id, date, present) VALUES ('a_now', 'gs', ?, ?, 1)`, [away.cid, today]);
  await db.run(`UPDATE subscriptions SET end_date = ? WHERE client_id = ?`, [K(90), ending.cid]);
  await db.run(`INSERT INTO payments (id, org_id, client_id, subscription_id, amount, status, paid_at) VALUES ('p_now', 'gs', ?, ?, 3000, 'paid', ?)`, [owing.cid, `s_${owing.cid}`, new Date().toISOString()]);
  await engine.dispatchOrg(db, 'gs', { at: noon });
  const st = async (cid, kind) => db.q1(`SELECT j.status, j.error FROM followup_jobs j JOIN followup_rules r ON r.id = j.rule_id WHERE j.client_id = ? AND r.kind = ?`, [cid, kind]);
  for (const [cid, kind] of [[away.cid, 'missed_visits'], [ending.cid, 'membership_ending'], [owing.cid, 'payment_due']]) {
    const r = await st(cid, kind);
    assert.equal(r.status, 'skipped', `${kind} skipped`);
    assert.match(r.error, /No longer due/);
  }
  assert.notEqual((await st(stays.cid, 'missed_visits')).status, 'queued', 'the member who stayed away is still contacted');
});

test('dispatch: retries stop at the campaign\'s attempts per day, spaced by its gap; a provider timeout releases the hold', async () => {
  const db = await memDb();
  await seedGym(db, 'gr');
  await enableGym(db, 'gr');
  await wallet.creditUnits(db, 'gr', { 'voice:standard': 10 }, { reason: 'purchase' });
  const m = await addMember(db, 'gr', { lastVisit: 9 });
  await voiceCampaign(db, 'gr', { perDay: 2 });
  const noAnswer = async ({ seed }) => ({ ref: `CA_${seed}`, simulated: { status: 'no_answer', digits: null, duration: 0 } });
  await withStub(mock.telephony, 'placeMessageCall', noAnswer, async () => {
    await engine.planOrg(db, 'gr', { at: at('10:00') }); await engine.dispatchOrg(db, 'gr', { at: at('10:00') });
    // The engine stamps ended_at with the REAL clock while this test plans at a
    // simulated 10:00. Pin the stamps to the simulated time BEFORE the gap
    // check, or the test fails whenever it runs in the early hours IST (the
    // real stamp is then hours "before" 10:00 and the gap looks over).
    await db.run(`UPDATE followup_jobs SET ended_at = ?, created_at = ? WHERE client_id = ?`, [at('10:00').toISOString(), at('10:00').toISOString(), m.cid]);
    assert.equal((await engine.planOrg(db, 'gr', { at: at('10:00') })).queued, 0, 'not again inside the gap');
    assert.equal((await engine.planOrg(db, 'gr', { at: at('11:30') })).queued, 1, 'second attempt after the gap');
    await engine.dispatchOrg(db, 'gr', { at: at('11:30') });
    await db.run(`UPDATE followup_jobs SET ended_at = ?, created_at = ? WHERE client_id = ?`, [at('11:30').toISOString(), at('11:30').toISOString(), m.cid]);
    assert.equal((await engine.planOrg(db, 'gr', { at: at('15:00') })).queued, 0, 'attempts for the day exhausted');
  });
  assert.equal((await db.q(`SELECT id FROM followup_jobs WHERE client_id = ?`, [m.cid])).length, 2);
  assert.equal((await wallet.getWallet(db, 'gr'))['voice:standard'], 10, 'unanswered calls cost nothing');

  const m2 = await addMember(db, 'gr', { lastVisit: 9 });
  const timeout = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await withStub(mock.telephony, 'placeMessageCall', timeout, async () => {
    await engine.planOrg(db, 'gr', { at: at('15:00') }); await engine.dispatchOrg(db, 'gr', { at: at('15:00') });
  });
  const j = await db.q1(`SELECT * FROM followup_jobs WHERE client_id = ?`, [m2.cid]);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /timeout/);
  assert.equal(num(j.units_held), 0);
  assert.equal((await wallet.getWallet(db, 'gr'))['voice:standard'], 10, 'hold released on a provider timeout');
});

test('dispatch: a queue left by a restart is placed by the next tick, once', async () => {
  const db = await memDb();
  await seedGym(db, 'gq');
  await enableGym(db, 'gq');
  await wallet.creditUnits(db, 'gq', { 'voice:standard': 10 }, { reason: 'purchase' });
  for (let i = 0; i < 3; i++) await addMember(db, 'gq', { lastVisit: 9 });
  await voiceCampaign(db, 'gq');
  assert.equal((await engine.planOrg(db, 'gq', { at: noon })).queued, 3);
  // ... the process dies here. A new one starts and ticks:
  const first = await engine.dispatchOrg(db, 'gq', { at: noon });
  const second = await engine.dispatchOrg(db, 'gq', { at: noon });
  assert.equal(first.placed, 3);
  assert.equal(second.placed, 0, 'each job placed once');
  assert.equal(num((await db.q1(`SELECT COUNT(*) AS n FROM followup_jobs WHERE org_id = 'gq' AND status = 'queued'`)).n), 0);
});

test('scheduler: the longest-waiting gym is ticked first, and every gym reports back', async () => {
  const db = await memDb();
  for (const g of ['f1', 'f2', 'f3']) { await seedGym(db, g); await enableGym(db, g); }
  await db.run(`UPDATE followup_settings SET last_tick_at = ? WHERE org_id = 'f1'`, [new Date().toISOString()]);
  await db.run(`UPDATE followup_settings SET last_tick_at = NULL WHERE org_id = 'f2'`);
  await db.run(`UPDATE followup_settings SET last_tick_at = ? WHERE org_id = 'f3'`, [new Date(Date.now() - 3600_000).toISOString()]);
  const r = await engine.runAll(db, { budgetMs: 30_000 });
  assert.deepEqual(Object.keys(r.results), ['f2', 'f3', 'f1'], 'never-ticked, then oldest, then most recent');
  assert.equal(r.waiting, 0);
  const again = await engine.runAll(db, { budgetMs: 30_000 });
  assert.equal(Object.keys(again.results)[0], 'f2', 'order follows last_tick_at, so the rotation continues');
});

/* ═══════════════════════ provider contracts ═══════════════════════ */

test('contract: Exotel status callback -- documented fields, hyphenated statuses, unknown duration is null', () => {
  const doc = { CallSid: 'b6cfaf0a', Status: 'completed', DateUpdated: '2026-11-10 10:00:00', RecordingUrl: null, EventType: 'terminal', ConversationDuration: 64, CustomField: 'fj_1.mac', Legs: [{ OnCallDuration: 70, Status: 'completed' }] };
  assert.deepEqual(exotel.parseCallStatus(doc), { ref: 'b6cfaf0a', status: 'completed', duration: 64, customField: 'fj_1.mac' });
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'completed', Legs: [{ OnCallDuration: 33 }] }).duration, 33, 'legs when no conversation duration');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'completed' }).duration, null, 'default payload: unknown, not 0');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'no-answer' }).status, 'no_answer');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'busy' }).status, 'busy');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'canceled' }).status, 'failed');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'ringing' }).status, null, 'not an outcome yet');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'in-progress' }).status, 'answered');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'something-new' }).status, 'failed');
  assert.equal(exotel.parseCallStatus({ Sid: 'x', CallStatus: 'completed', DialCallDuration: '41' }).duration, 41, 'form-encoded variant');
  assert.equal(exotel.parseCallStatus({ CallSid: 'x', Status: 'completed', ConversationDuration: 'abc' }).duration, null);
  assert.deepEqual(exotel.parseCallStatus(null), { ref: null, status: null, duration: null, customField: null });
});

test('contract: Exotel keypad digits and SMS delivery reports', () => {
  assert.equal(exotel.parseDigits('"2"'), '2');
  assert.equal(exotel.parseDigits('9#'), '9');
  assert.equal(exotel.parseDigits('12'), '1', 'the first key pressed');
  assert.equal(exotel.parseDigits(''), null);
  assert.equal(exotel.parseDigits('"x"'), null, 'no digit, no choice');
  assert.equal(exotel.parseDigits(undefined), null);
  assert.equal(exotel.parseSmsStatus({ SmsSid: 's1', Status: 'delivered' }).status, 'delivered');
  assert.equal(exotel.parseSmsStatus({ SmsSid: 's1', Status: 'failed-dnd' }).status, 'failed');
  assert.equal(exotel.parseSmsStatus({ SmsSid: 's1', Status: 'undelivered' }).status, 'failed');
  assert.equal(exotel.parseSmsStatus({ SmsSid: 's1', Status: 'sent' }).status, 'sent');
  assert.equal(exotel.parseSmsStatus({}).status, null);
});

test('contract: Exotel requests -- the call into the flow, and the Call Details fallback', async () => {
  await withEnv(EXOTEL_ENV, async () => {
    const seen = [];
    await withFetch(async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ Call: { Sid: 'CA_new' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, async () => {
      const r = await exotel.placeFlowCall({ to: '+919876500001', callerId: '+918047180000', customField: 'fj_1.mac', statusUrl: 'https://app.example/api/followups/hooks/exotel/status?j=fj_1.mac' });
      assert.equal(r.ref, 'CA_new');
    });
    const { url, init } = seen[0];
    assert.equal(url, 'https://api.in.exotel.com/v1/Accounts/acme/Calls/connect.json');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('From'), '+919876500001');
    assert.equal(form.get('CallerId'), '+918047180000');
    assert.equal(form.get('Url'), 'http://my.exotel.com/acme/exoml/start_voice/123');
    assert.equal(form.get('CustomField'), 'fj_1.mac');
    assert.match(form.get('StatusCallback'), /\/hooks\/exotel\/status\?j=/);
    assert.equal(form.get('StatusCallbackEvents[0]'), 'terminal');
    assert.ok(init.signal, 'every request has a timeout');
    assert.match(init.headers.Authorization, /^Basic /);
    assert.ok(!init.body.includes('t_test'), 'the token travels only in the auth header');

    await withFetch(async () => new Response('{}', { status: 200 }), async () => {
      await assert.rejects(exotel.placeFlowCall({ to: '+91', callerId: '+91', customField: 'x', statusUrl: 'https://x' }), /no call id/);
    });
    await withFetch(async () => new Response('{"RestException":{"Message":"Invalid From"}}', { status: 400 }), async () => {
      await assert.rejects(exotel.placeFlowCall({ to: '+91', callerId: '+91', customField: 'x', statusUrl: 'https://x' }), /Invalid From/);
    });

    let detailsUrl = '';
    await withFetch(async (u) => { detailsUrl = String(u); return new Response(JSON.stringify({ Call: { Sid: 'CA_a', Status: 'completed', Duration: '75', Details: { ConversationDuration: 70 } } }), { status: 200 }); }, async () => {
      assert.deepEqual(await exotel.fetchCall('CA_a'), { status: 'completed', duration: 70 });
    });
    assert.match(detailsUrl, /\/Calls\/CA_a\.json\?details=true$/);
    await withFetch(async () => new Response(JSON.stringify({ Call: { Status: 'completed', Duration: '' } }), { status: 200 }), async () => {
      assert.deepEqual(await exotel.fetchCall('CA_b'), { status: 'completed', duration: null }, 'duration not filled in yet');
    });
    await withFetch(async () => new Response('', { status: 404 }), async () => { assert.equal(await exotel.fetchCall('CA_gone'), null); });
    await withFetch(async () => new Response('down', { status: 503 }), async () => { await assert.rejects(exotel.fetchCall('CA_c'), /503/); });
  });
});

test('contract: Exotel WhatsApp events -- statuses and replies from every known shape; junk is ignored', () => {
  const nested = { whatsapp: { messages: [{ sid: 'wa1', status: 'delivered' }, { sid: 'wa2', status: 'read' }, { sid: 'wa3', status: 'failed' }] } };
  assert.deepEqual(exotel.parseWhatsAppEvents(nested).statuses, [{ ref: 'wa1', status: 'delivered' }, { ref: 'wa2', status: 'read' }, { ref: 'wa3', status: 'failed' }]);
  const reply = exotel.parseWhatsAppEvents({ messages: [{ from: '919876500001', to: '918047180000', content: { type: 'text', text: { body: 'STOP' } } }] });
  assert.deepEqual(reply.replies, [{ from: '919876500001', to: '918047180000', text: 'STOP' }]);
  assert.equal(exotel.parseWhatsAppEvents({ messages: [{ from: '91', content: { button: { text: 'Call me' } } }] }).replies[0].text, 'Call me');
  assert.equal(exotel.parseWhatsAppEvents({ messages: [{ from: '91', content: { interactive: { button_reply: { title: "I'm on it" } } } }] }).replies[0].text, "I'm on it");
  assert.equal(exotel.parseWhatsAppEvents({ sid: 'flat', status: 'sent' }).statuses[0].status, 'sent', 'a flat single event');
  assert.equal(exotel.parseWhatsAppEvents({ sid: 'u', status: 'undelivered' }).statuses[0].status, 'failed', '"undelivered" is a failure (refunded), not a delivery');
  for (const junk of [null, 'text', 42, [], { messages: 'no' }, { messages: [null, 7, { from: '9', content: { text: { body: 42 } } }] }]) {
    assert.deepEqual(exotel.parseWhatsAppEvents(junk), { statuses: [], replies: [] }, JSON.stringify(junk));
  }
});

test('contract: ElevenLabs and self-hosted agent results; an unknown status cannot break settlement', async () => {
  const tok = jobToken('fj_e');
  const pc = elevenlabs.conversation.parseResult(JSON.stringify({ type: 'post_call_transcription', event_timestamp: 1, data: { agent_id: 'a', conversation_id: 'conv_9', status: 'done', metadata: { call_duration_secs: 22 }, analysis: { transcript_summary: 'Will come Monday', data_collection_results: { outcome: { value: 'coming_back' } } }, conversation_initiation_client_data: { dynamic_variables: { followup_job: tok } } } }));
  assert.deepEqual(pc, { token: tok, ref: 'conv_9', status: 'completed', duration: 22, outcome: 'coming_back', summary: 'Will come Monday' });
  const fail = (reason) => elevenlabs.conversation.parseResult(JSON.stringify({ type: 'call_initiation_failure', data: { conversation_id: 'c', failure_reason: reason, conversation_initiation_client_data: { dynamic_variables: { followup_job: tok } } } }));
  assert.equal(fail('busy').status, 'busy');
  assert.equal(fail('no-answer').status, 'no_answer');
  assert.equal(fail('unknown').status, 'failed');
  assert.equal(elevenlabs.conversation.parseResult(JSON.stringify({ type: 'post_call_audio', data: { full_audio: 'AAAA' } })), null, 'audio events are not results');

  await withEnv({ FOLLOWUP_HTTP_TOKEN: 'own_tok' }, async () => {
    const body = JSON.stringify({ followup_job: tok, call_id: 'own_1', status: 'weird-status', duration_secs: 61 });
    const good = crypto.createHmac('sha256', 'own_tok').update(body).digest('hex');
    assert.equal(http.conversation.verifyWebhook(body, { 'x-followup-signature': good }), true);
    assert.equal(http.conversation.verifyWebhook(body, { 'x-followup-signature': good.replace(/.$/, '0') }), false);
    assert.equal(http.conversation.verifyWebhook(body, {}), false);
    const db = await memDb();
    await seedGym(db, 'ge');
    await wallet.creditUnits(db, 'ge', { 'agent:standard': 5 }, { reason: 'purchase' });
    const j = await job(db, { id: 'fj_e', org: 'ge', channel: 'agent', unit: 'agent:standard', provider: 'http' });
    await wallet.holdUnits(db, 'ge', 'agent:standard', 3, { jobId: 'fj_e' });
    await engine.applyAgentResult(db, j, http.conversation.parseResult(body));
    const after = await db.q1(`SELECT status, units_held FROM followup_jobs WHERE id = 'fj_e'`);
    assert.equal(after.status, 'failed', 'an unknown status is recorded as failed, not rejected by the CHECK');
    assert.equal(num(after.units_held), 0, 'and the hold is released');
    assert.equal((await wallet.getWallet(db, 'ge'))['agent:standard'], 5, 'nothing charged for a call that did not complete');
  });
});

/* ═══════════════════════ consent & compliance ═══════════════════════ */

test('consent: "press 9" persists -- the owner cannot re-grant it, no campaign reaches the member, only the member can undo it', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'gk');
    await enableGym(db, 'gk');
    await wallet.creditUnits(db, 'gk', { 'voice:standard': 10 }, { reason: 'purchase' });
    const m = await addMember(db, 'gk', { lastVisit: 9 });
    await job(db, { id: 'jk', org: 'gk', client: m.cid });
    await engine.applyKeypress(db, { id: 'jk' }, '9');
    const regrant = await api.call('POST', '/api/followups/members/consent', owner('gk'), { client_ids: [m.cid], channels: ['call'], action: 'granted', evidence: 'They said yes at the desk', attest: true });
    assert.equal(regrant.json.kept_member_choice, 1);
    await voiceCampaign(db, 'gk');
    const p = await engine.planOrg(db, 'gk', { at: noon });
    assert.equal(p.queued, 0);
    assert.equal(p.skipped.opted_out, 1);
    const log = await db.q(`SELECT action, source, evidence FROM followup_consent_log WHERE client_id = ? ORDER BY created_at`, [m.cid]);
    assert.ok(log.some((l) => l.action === 'opted_out' && l.source === 'keypad' && /Pressed 9/.test(l.evidence)), 'evidence kept');
    await recordConsent(db, { orgId: 'gk', clientId: m.cid, channels: ['call'], action: 'opted_in', source: 'member' });
    assert.equal((await engine.planOrg(db, 'gk', { at: noon })).queued, 1, 'the member turned it back on');
  } finally { await api.close(); }
});

test('consent: WhatsApp STOP words and the "Stop messages" button are honoured; a member who wants a person gets no automation', async () => {
  const db = await memDb();
  await seedGym(db, 'gw');
  const m1 = await addMember(db, 'gw', { consent: ['whatsapp'] });
  const m2 = await addMember(db, 'gw', { consent: ['whatsapp'] });
  const m3 = await addMember(db, 'gw', { consent: ['whatsapp'] });
  const ts = new Date().toISOString();
  for (const [i, m] of [m1, m2, m3].entries()) {
    await db.run(`INSERT INTO followup_jobs (id, org_id, client_id, channel, dedupe_key, day_key, status, to_number, created_at, updated_at) VALUES (?, 'gw', ?, 'whatsapp', ?, ?, 'delivered', ?, ?, ?)`, [`w${i}`, m.cid, `w${i}`, today, m.phone, ts, ts]);
  }
  assert.equal((await engine.applyWhatsAppReply(db, { from: m1.phone, text: '  STOP ' })).outcome, 'opted_out');
  assert.equal((await engine.applyWhatsAppReply(db, { from: m2.phone, text: 'Stop messages' })).outcome, 'opted_out');
  assert.equal((await engine.applyWhatsAppReply(db, { from: m3.phone, text: 'बंद करें' })).outcome, 'opted_out');
  for (const m of [m1, m2, m3]) assert.ok((await db.q1('SELECT wa_opted_out_at FROM followup_member_prefs WHERE client_id = ?', [m.cid])).wa_opted_out_at);
  assert.equal((await engine.applyWhatsAppReply(db, { from: '+910000000000', text: 'STOP' })).matched, false, 'unknown sender: nothing happens');

  await enableGym(db, 'gw');
  await wallet.creditUnits(db, 'gw', { 'voice:standard': 10 }, { reason: 'purchase' });
  const human = await addMember(db, 'gw', { lastVisit: 9 });
  await db.run('UPDATE followup_member_prefs SET human_only = 1 WHERE client_id = ?', [human.cid]);
  await voiceCampaign(db, 'gw');
  const p = await engine.planOrg(db, 'gw', { at: noon });
  assert.equal(p.queued, 0);
  assert.equal(p.skipped.human_only, 1);
});

/* ═══════════════════════ audit & operations ═══════════════════════ */

test('audit: owner changes are recorded with who, what, before and after -- and shown to the admin', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'ga');
    await api.call('GET', '/api/followups/overview', owner('ga'));
    assert.equal((await api.call('PUT', '/api/followups/settings', owner('ga'), { max_per_day: 3, window_end: '20:00' })).status, 200);
    assert.equal((await api.call('PUT', '/api/followups/compliance', owner('ga'), { business_registered: true, consent_basis: 'Signed membership form with a contact clause', accepted_terms: true })).status, 200);
    const script = await api.call('POST', '/api/followups/scripts', owner('ga'), { name: 'Hi', purpose: 'missed_visits', language: 'en', body: 'Hi {name}, we miss you.' });
    const camp = await api.call('POST', '/api/followups/rules', owner('ga'), { name: 'Come back', kind: 'missed_visits', sequence: [{ channel: 'call' }], script_group_id: script.json.script.group_id });
    await api.call('POST', `/api/followups/rules/${camp.json.campaign.id}/status`, owner('ga'), { status: 'active' });
    const rows = await api.db.q(`SELECT * FROM followup_audit WHERE org_id = 'ga' ORDER BY created_at`);
    assert.deepEqual(rows.map((r) => r.action), ['settings_updated', 'compliance_confirmed', 'campaign_created', 'campaign_started']);
    assert.equal(rows[0].actor_id, 'owner_ga');
    assert.deepEqual(JSON.parse(rows[0].before_json), { max_per_day: 2, window_end: '19:30' });
    assert.deepEqual(JSON.parse(rows[0].after_json), { max_per_day: 3, window_end: '20:00' });
    const view = await api.call('GET', '/api/console/communication/gyms/ga', admin());
    assert.equal(view.json.owner_changes.length, 4);
    assert.equal(view.json.owner_changes[0].action, 'campaign_started', 'newest first');
    assert.equal((await api.call('GET', '/api/console/communication/gyms/ga', owner('ga'))).status, 403);
  } finally { await api.close(); }
});

test('operations: health reports queue, stuck calls, a stopped scheduler and any balance that disagrees with its ledger', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'gh');
    await enableGym(db, 'gh');
    await wallet.creditUnits(db, 'gh', { sms: 50, 'voice:standard': 5 }, { values: { sms: 20 }, reason: 'purchase' });
    let h = (await api.call('GET', '/api/console/communication/health', admin())).json;
    assert.deepEqual(h.discrepancies, []);
    assert.ok(h.alerts.some((a) => a.code === 'scheduler_stopped' && a.level === 'critical'), 'gym on, scheduler never ran');
    await db.run(`UPDATE followup_settings SET last_tick_at = ? WHERE org_id = 'gh'`, [new Date().toISOString()]);
    await job(db, { id: 'js', org: 'gh', dialedMinAgo: 45 });
    await db.run(`UPDATE followup_balances SET balance = balance + 7 WHERE org_id = 'gh' AND unit = 'sms'`);
    h = (await api.call('GET', '/api/console/communication/health', admin())).json;
    assert.ok(!h.alerts.some((a) => a.code === 'scheduler_stopped'));
    assert.equal(h.queue.stuck, 1);
    assert.ok(h.alerts.some((a) => a.code === 'jobs_stuck'));
    assert.deepEqual(h.discrepancies.map((x) => [x.unit, x.diff]), [['sms', 7]]);
    assert.equal(h.alerts[0].code, 'credit_discrepancy', 'critical alerts first');
    assert.ok(!JSON.stringify(h).match(/98765\d{5}/), 'no member phone numbers in the health report');
  } finally { await api.close(); }
});

test(`environment: this suite ran on ${driverName}`, () => { assert.ok(['sqlite', 'postgres'].includes(driverName)); });
