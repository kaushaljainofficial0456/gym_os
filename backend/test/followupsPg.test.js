// ============================================================
// AI COMMUNICATION ON REAL POSTGRESQL -- CONCURRENCY AND ROW-LEVEL SECURITY
//
// What SQLite cannot show: many connections racing for the same balance,
// the same job, the same order; and the database itself refusing one gym's
// transaction access to another gym's AI Communication rows.
//
// Runs only with TEST_DATABASE_URL (CI's postgres:16 service; locally any
// throwaway UTF-8 database). Each run builds its own schema with schema.sql +
// rls.sql and drops it afterwards. Without the variable every test skips.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { PG_URL, pgPoolDb } from './helpers/followupsDb.js';
import { seedGym, addMember, enableGym, voiceCampaign, noon, today } from './helpers/followupsSeed.js';

const skip = PG_URL ? false : 'set TEST_DATABASE_URL to run the PostgreSQL concurrency and RLS suite';
const wallet = await import('../src/services/followups/wallet.js');
const engine = await import('../src/services/followups/engine.js');
const n = (v) => Number(v || 0);

async function newJob(db, id, org, unit = 'voice:standard', channel = 'call') {
  const ts = new Date().toISOString();
  await db.run(`INSERT INTO followup_jobs (id, org_id, channel, dedupe_key, day_key, status, provider, unit, created_at, dialed_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dialing', 'exotel', ?, ?, ?, ?)`, [id, org, channel, id, today, unit, ts, ts, ts]);
  return db.q1('SELECT * FROM followup_jobs WHERE id = ?', [id]);
}
async function ledgerMatchesBalances(db, org) {
  for (const b of await db.q('SELECT unit, balance, value FROM followup_balances WHERE org_id = ?', [org])) {
    const s = await db.q1('SELECT SUM(delta) AS s FROM followup_ledger WHERE org_id = ? AND unit = ?', [org, b.unit]);
    assert.ok(Math.abs(n(b.balance) - n(s.s)) < 1e-9, `${b.unit}: balance ${b.balance} vs ledger ${s.s}`);
    assert.ok(n(b.balance) >= 0 && n(b.value) >= 0, `${b.unit} never negative`);
  }
}

test('concurrency: 25 duplicate deliveries of the same call result settle it once', { skip }, async (t) => {
  const { db } = await pgPoolDb({ t });
  await seedGym(db, 'c1');
  await wallet.creditUnits(db, 'c1', { 'voice:standard': 10 }, { values: { 'voice:standard': 100 }, reason: 'purchase' });
  const j = await newJob(db, 'jc1', 'c1');
  await wallet.holdUnits(db, 'c1', 'voice:standard', 1, { jobId: 'jc1' });
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => engine.applyCallStatus(db, j, { status: 'completed', duration: 130 })));
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message), [], 'no delivery errors out');
  assert.equal((await db.q(`SELECT id FROM followup_ledger WHERE job_id = 'jc1' AND reason = 'usage'`)).length, 1);
  assert.equal((await db.q(`SELECT id FROM followup_ledger WHERE job_id = 'jc1' AND reason = 'release'`)).length, 1);
  assert.equal((await wallet.getWallet(db, 'c1'))['voice:standard'], 7, '130 s = 3 minutes, charged once');
  await ledgerMatchesBalances(db, 'c1');
});

test('concurrency: 25 racing refunds of one failed message give it back once', { skip }, async (t) => {
  const { db } = await pgPoolDb({ t });
  await seedGym(db, 'c2');
  await wallet.creditUnits(db, 'c2', { whatsapp: 5 }, { values: { whatsapp: 10 }, reason: 'purchase' });
  const j = await newJob(db, 'jc2', 'c2', 'whatsapp', 'whatsapp');
  assert.equal(await wallet.chargeMessage(db, j, 'whatsapp', 1), true);
  const out = await Promise.all(Array.from({ length: 25 }, () => wallet.refundJob(db, j, 'Not delivered')));
  assert.equal(out.filter(Boolean).length, 1, 'exactly one refund reported');
  assert.equal((await db.q(`SELECT id FROM followup_ledger WHERE job_id = 'jc2' AND reason = 'refund'`)).length, 1);
  assert.equal((await wallet.getWallet(db, 'c2')).whatsapp, 5);
  await ledgerMatchesBalances(db, 'c2');
});

test('concurrency: 40 messages racing for 10 units -- exactly 10 sent, the balance never below zero', { skip }, async (t) => {
  const { db } = await pgPoolDb({ max: 16, t });
  await seedGym(db, 'c3');
  await wallet.creditUnits(db, 'c3', { sms: 10 }, { values: { sms: 3.33 }, reason: 'purchase' });
  const jobs = [];
  for (let i = 0; i < 40; i++) jobs.push(await newJob(db, `jc3_${i}`, 'c3', 'sms', 'sms'));
  const ok = await Promise.all(jobs.map((j) => wallet.chargeMessage(db, j, 'sms', 1)));
  assert.equal(ok.filter(Boolean).length, 10);
  const w = await db.q1(`SELECT balance, value FROM followup_balances WHERE org_id = 'c3' AND unit = 'sms'`);
  assert.equal(n(w.balance), 0);
  assert.ok(n(w.value) >= 0 && n(w.value) < 0.05);
  await ledgerMatchesBalances(db, 'c3');
});

test('concurrency: 15 calls settling at once against a short balance -- usage rows match exactly what was taken', { skip }, async (t) => {
  const { db } = await pgPoolDb({ max: 16, t });
  await seedGym(db, 'c4');
  await wallet.creditUnits(db, 'c4', { 'voice:standard': 20 }, { values: { 'voice:standard': 200 }, reason: 'purchase' });
  const jobs = [];
  for (let i = 0; i < 15; i++) {
    const j = await newJob(db, `jc4_${i}`, 'c4');
    assert.equal(await wallet.holdUnits(db, 'c4', 'voice:standard', 1, { jobId: j.id }), true);
    jobs.push(j);
  }
  // Each call lasted 3 minutes: 45 wanted, 20 exist. Nobody may be charged for units that were not there.
  await Promise.all(jobs.map((j) => engine.applyCallStatus(db, j, { status: 'completed', duration: 170 })));
  const used = await db.q1(`SELECT SUM(-delta) AS u FROM followup_ledger WHERE org_id = 'c4' AND reason = 'usage'`);
  assert.equal(n(used.u), 20, 'all 20 units used, none conjured');
  assert.equal((await wallet.getWallet(db, 'c4'))['voice:standard'], 0);
  await ledgerMatchesBalances(db, 'c4');
});

test('concurrency: checkout verification and 10 webhooks for one paid order credit it once', { skip }, async (t) => {
  const { db } = await pgPoolDb({ t });
  await seedGym(db, 'c5');
  const { activateOrder } = await import('../src/services/followups/orders.js');
  const ts = new Date().toISOString();
  const pack = { id: 'sms_1000', plan: 'sms', name: '1,000 SMS', units: { sms: 1000 }, price: 449, quantity: 1, net: 380.51 };
  await db.run(`INSERT INTO followup_orders (id, org_id, pack_id, pack_json, pricing_version, amount, tax_amount, provider, provider_order_id, status, created_at, updated_at) VALUES ('oc5', 'c5', 'sms_1000', ?, 0, 449, 68.49, 'mock', 'order_c5', 'CANCELLED', ?, ?)`, [JSON.stringify(pack), ts, ts]);
  const order = await db.q1(`SELECT * FROM followup_orders WHERE id = 'oc5'`);
  await Promise.all(Array.from({ length: 11 }, () => activateOrder(db, order, { providerPaymentId: 'pay_c5' })));
  assert.equal((await db.q(`SELECT id FROM followup_ledger WHERE order_id = 'oc5' AND reason = 'purchase'`)).length, 1);
  assert.equal((await wallet.getWallet(db, 'c5')).sms, 1000);
  assert.equal((await db.q1(`SELECT status FROM followup_orders WHERE id = 'oc5'`)).status, 'SUCCESS');
});

test('concurrency: ten first visits at once grant the free trial once', { skip }, async (t) => {
  const { db } = await pgPoolDb({ t });
  await seedGym(db, 'c6');
  const granted = await Promise.all(Array.from({ length: 10 }, () => wallet.grantTrialOnce(db, 'c6')));
  assert.equal(granted.filter(Boolean).length, 1);
  const w = await wallet.getWallet(db, 'c6');
  assert.equal(w['voice:standard'], wallet.DEFAULT_PRICE_BOOK.trial['voice:standard']);
  await ledgerMatchesBalances(db, 'c6');
});

test('concurrency: overlapping scheduler ticks plan each contact once and place each job once', { skip }, async (t) => {
  const { db } = await pgPoolDb({ max: 16, t });
  await seedGym(db, 'c7');
  await enableGym(db, 'c7');
  await wallet.creditUnits(db, 'c7', { 'voice:standard': 100 }, { reason: 'purchase' });
  for (let i = 0; i < 12; i++) await addMember(db, 'c7', { lastVisit: 9 });
  await voiceCampaign(db, 'c7');
  await Promise.all(Array.from({ length: 5 }, () => engine.planOrg(db, 'c7', { at: noon })));
  assert.equal(n((await db.q1(`SELECT COUNT(*) AS n FROM followup_jobs WHERE org_id = 'c7'`)).n), 12, 'one job per member');
  const placed = await Promise.all(Array.from({ length: 4 }, () => engine.dispatchOrg(db, 'c7', { at: noon })));
  assert.equal(placed.reduce((s, p) => s + n(p.placed), 0), 12, 'each job placed by exactly one tick');
  assert.equal(n((await db.q1(`SELECT COUNT(*) AS n FROM followup_ledger WHERE org_id = 'c7' AND reason = 'hold'`)).n), 12, 'one hold per job');
  await ledgerMatchesBalances(db, 'c7');
});

test('RLS: inside a gym\'s transaction, Postgres itself hides and refuses every other gym\'s AI Communication rows', { skip }, async (t) => {
  const { db, admin, schema } = await pgPoolDb({ t });
  await seedGym(db, 'ra');
  await seedGym(db, 'rb');
  for (const g of ['ra', 'rb']) {
    await wallet.creditUnits(db, g, { sms: 5 }, { reason: 'purchase' });
    const m = await addMember(db, g, { consent: ['call', 'sms'] });
    await newJob(db, `jr_${g}`, g, 'sms', 'sms');
    await db.run(`INSERT INTO followup_audit (id, org_id, action, created_at) VALUES (?, ?, 'settings_updated', ?)`, [`au_${g}`, g, new Date().toISOString()]);
    assert.ok(m.cid);
  }
  // A role WITHOUT BYPASSRLS, like the production runtime role -- the superuser
  // running these tests would bypass every policy and prove nothing.
  const role = 'fu_rls_probe';
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; END IF; END $$`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const tables = ['followup_jobs', 'followup_ledger', 'followup_balances', 'followup_member_prefs', 'followup_consent_log', 'followup_audit', 'followup_settings'];
  const asGym = (org, fn) => db.tx(async (tx) => { await tx.run(`SET LOCAL ROLE ${role}`); return fn(tx); }, { orgId: org });
  for (const tbl of tables) {
    const seen = await asGym('ra', (t) => t.q(`SELECT DISTINCT org_id FROM ${tbl}`));
    assert.deepEqual(seen.map((r) => r.org_id).filter(Boolean).sort(), seen.length ? ['ra'] : [], `${tbl}: gym ra sees only its own rows`);
  }
  const leak = await asGym('ra', (t) => t.q1(`SELECT COUNT(*) AS n FROM followup_jobs WHERE org_id = 'rb'`));
  assert.equal(n(leak.n), 0, 'asking for rb by name returns nothing');
  await assert.rejects(asGym('ra', (t) => t.run(`INSERT INTO followup_ledger (id, org_id, unit, delta, reason, created_at) VALUES ('evil', 'rb', 'sms', 1000, 'adjustment', ?)`, [new Date().toISOString()])), /row-level security/, 'cannot write into rb');
  const upd = await asGym('ra', (t) => t.run(`UPDATE followup_balances SET balance = 0 WHERE org_id = 'rb'`));
  assert.equal(upd.changes, 0, 'cannot touch rb\'s balance');
  assert.equal((await wallet.getWallet(db, 'rb')).sms, 5);
});
