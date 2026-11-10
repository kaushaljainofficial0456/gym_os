// ============================================================
// AI COMMUNICATION (follow-ups) -- schedules, consent, the ledger, the
// engine end to end in test mode, the API's isolation and permissions,
// purchases and webhook authentication.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

const { dueStep, normalizeConfig, describeSchedule } = await import('../src/services/followups/schedule.js');
const { evaluate } = await import('../src/services/followups/consent.js');
const { smsSegments, normalizePlaceholders, missingDetails, normalizePhone } = await import('../src/services/followups/render.js');
const wallet = await import('../src/services/followups/wallet.js');
const engine = await import('../src/services/followups/engine.js');
const { recordConsent } = await import('../src/services/followups/consent.js');
const { saveScript } = await import('../src/services/followups/studio.js');
const { dayKey, shiftDayKey } = await import('../src/utils/time.js');

const TZ = 'Asia/Kolkata';
const today = dayKey(new Date(), TZ);
const noon = new Date(`${today}T12:00:00+05:30`);
const K = (n) => shiftDayKey(today, n);

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const db = {
    driver: 'sqlite',
    async q(sql, p = []) { return raw.prepare(sql).all(...p); },
    async q1(sql, p = []) { return raw.prepare(sql).all(...p)[0] || null; },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { changes: Number(r.changes) }; },
    exec(sql) { raw.exec(sql); },
    async tx(fn) {
      raw.exec('BEGIN');
      try { const out = await fn(db); raw.exec('COMMIT'); return out; } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* */ } throw e; }
    },
    raw,
  };
  return db;
}

async function seedGym(db, org, { phoneOwner = '9876500000' } = {}) {
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)`, [org, `Gym ${org}`, org, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, created_at) VALUES (?, ?, ?, 'x', 'GYM_OWNER', ?, ?, 1, ?)`, [`owner_${org}`, org, `owner@${org}.in`, 'Vikram Owner', phoneOwner, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'TRAINER', ?, 1, ?)`, [`trainer_${org}`, org, `t@${org}.in`, 'Asha Trainer', '2026-01-01T00:00:00Z']);
}

let seq = 0;
async function addMember(db, org, { name = 'Member', phone = '98765' + String(10000 + (++seq)).slice(-5), lastVisit = null, endIn = 30, startAgo = 60, consent = ['call'], trainer = true, unpaid = 0 } = {}) {
  const uid = `u_${org}_${seq}_${Math.random().toString(36).slice(2, 6)}`;
  const cid = `c_${uid}`;
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, created_at) VALUES (?, ?, ?, 'x', 'CLIENT', ?, ?, 1, ?)`, [uid, org, `${uid}@x.in`, name, phone, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?, ?, ?, ?, ?)`, [cid, uid, org, trainer ? `trainer_${org}` : null, `${K(-startAgo)}T08:00:00Z`]);
  await db.run(`INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status) VALUES (?, ?, ?, 'Quarterly', 3000, ?, ?, 'active', ?)`,
    [`s_${cid}`, org, cid, K(-startAgo), K(endIn), unpaid ? 'pending' : 'paid']);
  if (lastVisit !== null) await db.run(`INSERT INTO attendance (id, org_id, client_id, date, present) VALUES (?, ?, ?, ?, 1)`, [`a_${cid}`, org, cid, K(-lastVisit)]);
  if (consent.length) await recordConsent(db, { orgId: org, clientId: cid, channels: consent, action: 'granted', source: 'owner', evidence: 'Signed membership form', actorId: `owner_${org}` });
  return { uid, cid, phone: normalizePhone(phone) };
}

async function enableGym(db, org) {
  await engine.getSettings(db, org);
  await db.run(`UPDATE followup_settings SET enabled = 1, window_start = '09:00', window_end = '21:00', days_mask = '1111111', compliance_json = ? WHERE org_id = ?`,
    [JSON.stringify({ accepted_terms: true }), org]);
}

async function voiceCampaign(db, org, { kind = 'missed_visits', sequence = [{ channel: 'call' }], config = {}, extra = {} } = {}) {
  const script = await saveScript(db, org, `owner_${org}`, { name: 'Missed you', purpose: kind, channelType: 'voice', language: 'en', body: 'Hi {name}! We have not seen you for {days_absent} days.' });
  const rid = `fr_${org}_${++seq}`;
  await db.run(`INSERT INTO followup_rules (id, org_id, name, kind, status, config_json, sequence_json, per_day, gap_hours, language, script_group_id, created_at, updated_at)
                VALUES (?, ?, 'Come back', ?, 'active', ?, ?, 1, 3, 'en', ?, ?, ?)`,
    [rid, org, kind, JSON.stringify(config), JSON.stringify(sequence), script.group_id, new Date().toISOString(), new Date().toISOString()]);
  for (const [k, v] of Object.entries(extra)) await db.run(`UPDATE followup_rules SET ${k} = ? WHERE id = ?`, [v, rid]);
  return rid;
}

/* ═════════════════════ schedules ═════════════════════ */

test('missed visits: first step after N days, then every K, at most M, latest step when catching up', () => {
  const m = { id: 's', startKey: K(-100), endKey: K(30), status: 'active' };
  const cfg = { after_days: 7, repeat_every: 3, max_contacts: 3 };
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-6), membership: m }, today), null);
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-7), membership: m }, today).stepKey, 'm7');
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-9), membership: m }, today).stepKey, 'm7', 'between steps -> the latest one due');
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-13), membership: m }, today).stepKey, 'm13');
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-16), membership: m }, today), null, 'past the last contact');
  assert.equal(dueStep('missed_visits', cfg, { lastVisitKey: K(-10), membership: { ...m, endKey: K(-1) } }, today), null, 'lapsed members are not "not coming"');
});

test('membership ending: several offsets before, on the day, then every K after -- and renewal ends it', () => {
  const cfg = { before: [7, 4, 2, 0], after_every: 2, after_max: 2 };
  const at = (endIn) => dueStep('membership_ending', cfg, { membership: { id: 's1', startKey: K(-80), endKey: K(endIn), status: 'active' } }, today);
  assert.equal(at(8), null);
  assert.equal(at(7).stepKey, 'b7');
  assert.equal(at(5).stepKey, 'b7');
  assert.equal(at(4).stepKey, 'b4');
  assert.equal(at(1).stepKey, 'b2');
  assert.equal(at(0).stepKey, 'b0');
  assert.equal(at(-1), null);
  assert.equal(at(-2).stepKey, 'a2');
  assert.equal(at(-4).stepKey, 'a4');
  assert.equal(at(-6), null);
  assert.equal(at(60), null, 'a renewed membership (end far away) is not due');
  assert.match(describeSchedule('membership_ending', cfg), /7, 4 and 2 days before it ends, and on the day; then every 2 days after/);
});

test('payment due and onboarding schedules', () => {
  const pay = dueStep('payment_due', { start_after: 0, every: 2, max_contacts: 2 }, { payment: { subscriptionId: 's', sinceKey: K(-2), amountDue: 500 } }, today);
  assert.equal(pay.stepKey, 'p2');
  assert.equal(pay.variables.amount_due, 500);
  assert.equal(dueStep('payment_due', {}, { payment: { subscriptionId: 's', sinceKey: K(-2), amountDue: 0 } }, today), null);
  const m = { id: 's', startKey: K(-4), endKey: K(26), status: 'active' };
  assert.equal(dueStep('onboarding', { after_days: 3 }, { joinedKey: K(-4), membership: m }, today).stepKey, 'o3');
  assert.equal(dueStep('onboarding', { after_days: 3 }, { joinedKey: K(-4), lastVisitKey: K(-1), membership: m }, today), null, 'they came in');
  assert.deepEqual(normalizeConfig('membership_ending', { before: [99, 3, 3, -1] }).before, [30, 3, 0]);
});

/* ═════════════════════ consent ═════════════════════ */

test('consent evaluation: DENY without permission or after a stop, DEFER for hours and caps, ALLOW otherwise', () => {
  const base = { phone: '+919876500001', channel: 'call', todayKey: today, inGymHours: true, callsToday: 0, messagesToday: 0, contactsThisWeek: 0, caps: { perCall: 2, perWeek: 6 } };
  const ok = { call_consent: 'granted' };
  assert.deepEqual(evaluate({ ...base, prefs: ok }), { decision: 'ALLOW', reason: null });
  assert.equal(evaluate({ ...base, prefs: {} }).reason, 'no_permission');
  assert.equal(evaluate({ ...base, prefs: { ...ok, call_opted_out_at: 'x' } }).reason, 'opted_out');
  assert.equal(evaluate({ ...base, channel: 'agent', prefs: { ...ok, call_opted_out_at: 'x' } }).reason, 'opted_out', 'an AI call is a call');
  assert.equal(evaluate({ ...base, prefs: { ...ok, human_only: 1 } }).decision, 'DENY');
  assert.equal(evaluate({ ...base, prefs: ok, phone: null }).reason, 'no_phone');
  assert.equal(evaluate({ ...base, prefs: ok, inGymHours: false }).decision, 'DEFER');
  assert.equal(evaluate({ ...base, prefs: ok, callsToday: 2 }).reason, 'daily_cap');
  assert.equal(evaluate({ ...base, prefs: ok, contactsThisWeek: 6 }).reason, 'weekly_cap');
  assert.equal(evaluate({ ...base, prefs: { ...ok, window_start: '18:00', window_end: '20:00' }, localMinutes: 12 * 60 }).reason, 'outside_member_window');
  assert.equal(evaluate({ ...base, prefs: ok, callbackPending: true }).reason, 'callback_pending');
  assert.equal(evaluate({ ...base, channel: 'sms', prefs: ok }).reason, 'no_permission', 'permission is per channel');
});

/* ═════════════════════ rendering ═════════════════════ */

test('SMS segments are counted the way carriers bill them', () => {
  assert.deepEqual(smsSegments('Hi Rahul, see you soon!'), { encoding: 'GSM-7', length: 23, segments: 1 });
  assert.equal(smsSegments('a'.repeat(160)).segments, 1);
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('a'.repeat(306)).segments, 2);
  assert.equal(smsSegments('a'.repeat(307)).segments, 3);
  assert.equal(smsSegments('[]'.repeat(40)).segments, 1, '80 extension characters = 160 septets = 1 segment');
  assert.equal(smsSegments('[]'.repeat(41)).segments, 2, 'extension characters cost two septets');
  assert.equal(smsSegments('नमस्ते').encoding, 'Unicode');
  assert.equal(smsSegments('x'.repeat(70)).segments, 1);
  assert.equal(smsSegments('₹' + 'x'.repeat(70)).segments, 2, 'one Unicode character makes the whole message Unicode');
});

test('placeholders: master-prompt names map, and a missing detail is caught (never spoken blank)', () => {
  assert.equal(normalizePlaceholders('Hi {{client_first_name}} from {{gym_name}}, ends {{membership_expiry_date}}'), 'Hi {name} from {gym}, ends {end_date}');
  assert.deepEqual(missingDetails('Hi {name}, your trainer {trainer}', { name: 'Rahul', trainer: null }), ['trainer']);
  assert.equal(normalizePhone('098765 43210'), '+919876543210');
  assert.equal(normalizePhone('12345'), null);
});

/* ═════════════════════ pricing & ledger ═════════════════════ */

test('price book: every default pack recovers cost plus the margin, and nonsense is refused', () => {
  const b = wallet.DEFAULT_PRICE_BOOK;
  for (const p of b.packs) assert.ok(wallet.evaluatePack(p, b).healthy, `${p.id} is priced below cost + margin`);
  const cheap = wallet.evaluatePack({ plan: 'voice', units: { 'voice:premium': 1000 }, price: 100 }, b);
  assert.equal(cheap.healthy, false);
  assert.throws(() => wallet.cleanPriceBook({ packs: [{ id: 'x', plan: 'voice', units: {}, price: 10 }] }), /includes nothing/);
  assert.throws(() => wallet.cleanPriceBook({ margin_pct: -5 }), /Margin/);
  const t = wallet.taxed(1180, { tax: { rate_pct: 18, inclusive: true } });
  assert.deepEqual(t, { net: 1000, tax: 180, total: 1180 });
});

test('ledger: holds settle once, unanswered calls cost nothing, refunds happen once, balances never go negative', async () => {
  const db = await memDb();
  await seedGym(db, 'o1');
  await wallet.creditUnits(db, 'o1', { 'voice:standard': 10, sms: 5 }, { values: { 'voice:standard': 100, sms: 10 }, reason: 'purchase' });
  const ts = new Date().toISOString();
  const mk = async (jid, channel) => db.run(`INSERT INTO followup_jobs (id, org_id, channel, dedupe_key, day_key, status, created_at, updated_at) VALUES (?, 'o1', ?, ?, ?, 'dialing', ?, ?)`, [jid, channel, jid, today, ts, ts]);

  await mk('j1', 'call');
  assert.equal(await wallet.holdUnits(db, 'o1', 'voice:standard', 1, { jobId: 'j1' }), true);
  assert.equal((await wallet.getWallet(db, 'o1'))['voice:standard'], 9);
  const job1 = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'j1'`);
  assert.equal(await wallet.settleJob(db, job1, { used: 2 }), 2);
  assert.equal(await wallet.settleJob(db, job1, { used: 2 }), 2, 'a duplicate settle changes nothing');
  assert.equal((await wallet.getWallet(db, 'o1'))['voice:standard'], 8);
  const usage = await db.q1(`SELECT SUM(charge_inr) AS v FROM followup_ledger WHERE job_id = 'j1' AND reason = 'usage'`);
  assert.equal(Number(usage.v), 20, 'revenue at the value paid: 2 x 10');

  await mk('j2', 'call');
  await wallet.holdUnits(db, 'o1', 'voice:standard', 1, { jobId: 'j2' });
  await wallet.settleJob(db, await db.q1(`SELECT * FROM followup_jobs WHERE id = 'j2'`), { used: 0 });
  assert.equal((await wallet.getWallet(db, 'o1'))['voice:standard'], 8, 'an unanswered call gives its hold back');

  await mk('j3', 'sms');
  const j3 = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'j3'`);
  assert.equal(await wallet.chargeMessage(db, j3, 'sms', 2), true);
  assert.equal(await wallet.refundJob(db, j3, 'failed'), true);
  assert.equal(await wallet.refundJob(db, j3, 'failed'), false, 'refunded once');
  assert.equal((await wallet.getWallet(db, 'o1')).sms, 5);

  await mk('j4', 'sms');
  assert.equal(await wallet.chargeMessage(db, await db.q1(`SELECT * FROM followup_jobs WHERE id = 'j4'`), 'sms', 99), false, 'short balance refuses');
  assert.equal((await wallet.getWallet(db, 'o1')).sms, 5);
});

/* ═════════════════════ engine, end to end (test mode) ═════════════════════ */

test('engine: contacts only members with permission, settles usage, and a "press 9" stops every number of that gym', async () => {
  const db = await memDb();
  await seedGym(db, 'g1');
  await enableGym(db, 'g1');
  await wallet.creditUnits(db, 'g1', { 'voice:standard': 50 }, { values: { 'voice:standard': 500 }, reason: 'purchase' });
  const ok = await addMember(db, 'g1', { name: 'Rahul Shah', lastVisit: 10 });
  const noPerm = await addMember(db, 'g1', { name: 'No Perm', lastVisit: 10, consent: [] });
  const stopped = await addMember(db, 'g1', { name: 'Stopped', lastVisit: 10 });
  await recordConsent(db, { orgId: 'g1', clientId: stopped.cid, channels: ['call'], action: 'opted_out', source: 'member' });
  await addMember(db, 'g1', { name: 'Regular', lastVisit: 1 });
  await voiceCampaign(db, 'g1', { config: { after_days: 7, repeat_every: 3, max_contacts: 3 } });

  const plan = await engine.planOrg(db, 'g1', { at: noon });
  assert.equal(plan.queued, 1, JSON.stringify(plan));
  assert.equal(plan.skipped.no_permission, 1);
  assert.equal(plan.skipped.opted_out, 1);
  const again = await engine.planOrg(db, 'g1', { at: noon });
  assert.equal(again.queued, 0, 'planning twice does not double-queue');

  await engine.dispatchOrg(db, 'g1');
  const job = await db.q1(`SELECT * FROM followup_jobs WHERE client_id = ?`, [ok.cid]);
  assert.ok(['completed', 'no_answer', 'busy'].includes(job.status), job.status);
  assert.match(job.message_text, /automated call from Gym g1.*Hi Rahul! We have not seen you for 10 days.*press 9/);
  const held = await db.q1(`SELECT SUM(units_held) AS h FROM followup_jobs WHERE org_id = 'g1'`);
  assert.equal(Number(held.h), 0, 'no hold left behind');
  const w = await wallet.getWallet(db, 'g1');
  assert.equal(w['voice:standard'], 50 - Number(job.units), 'charged exactly what was settled');
  if (job.status !== 'completed') assert.equal(Number(job.units), 0, 'unanswered calls cost nothing');
  assert.equal((await db.q1(`SELECT COUNT(*) AS n FROM followup_jobs WHERE client_id = ?`, [noPerm.cid])).n, 0);

  // The member presses 9: suppressed for every campaign and every number.
  // (Test mode simulates a key press from the job id -- clear it, so this
  // test controls the key and does not depend on the random id.)
  await db.run('UPDATE followup_jobs SET digits = NULL, outcome = NULL WHERE id = ?', [job.id]);
  await db.run('DELETE FROM followup_callbacks WHERE client_id = ?', [ok.cid]);
  await engine.applyKeypress(db, { ...job, digits: null }, '9');
  const prefs = await db.q1('SELECT call_opted_out_at FROM followup_member_prefs WHERE client_id = ?', [ok.cid]);
  assert.ok(prefs.call_opted_out_at);
  const log = await db.q1(`SELECT * FROM followup_consent_log WHERE client_id = ? AND action = 'opted_out'`, [ok.cid]);
  assert.equal(log.source, 'keypad');
  await db.run(`INSERT INTO followup_numbers (id, org_id, number, created_at, updated_at) VALUES ('n2', 'g1', '+918000000002', ?, ?)`, [noon.toISOString(), noon.toISOString()]);
  await voiceCampaign(db, 'g1', { config: { after_days: 5 } });
  const later = await engine.planOrg(db, 'g1', { at: noon });
  assert.equal(later.queued, 0);
  // And the owner cannot quietly undo the member's own stop.
  const changed = await recordConsent(db, { orgId: 'g1', clientId: ok.cid, channels: ['call'], action: 'granted', source: 'owner', evidence: 'form' });
  assert.deepEqual(changed, []);
});

test('engine: "press 1" opens a callback for the trainer and pauses automation for that member', async () => {
  const db = await memDb();
  await seedGym(db, 'g2');
  await enableGym(db, 'g2');
  await wallet.creditUnits(db, 'g2', { 'voice:standard': 20 }, { reason: 'purchase' });
  const m = await addMember(db, 'g2', { lastVisit: 8 });
  await voiceCampaign(db, 'g2');
  await engine.planOrg(db, 'g2', { at: noon });
  const job = await db.q1('SELECT * FROM followup_jobs WHERE client_id = ?', [m.cid]);
  await db.run(`UPDATE followup_jobs SET status = 'dialing' WHERE id = ?`, [job.id]);
  await engine.applyKeypress(db, job, '1');
  const cb = await db.q1('SELECT * FROM followup_callbacks WHERE client_id = ?', [m.cid]);
  assert.equal(cb.status, 'assigned');
  assert.equal(cb.assigned_to, 'trainer_g2');
  await voiceCampaign(db, 'g2', { config: { after_days: 5 } });
  const p = await engine.planOrg(db, 'g2', { at: noon });
  assert.equal(p.queued, 0);
  assert.ok(p.skipped.callback_pending >= 1, JSON.stringify(p));
});

test('engine: a sequence skips a channel the member refused and goes straight to the next', async () => {
  const db = await memDb();
  await seedGym(db, 'g3');
  await enableGym(db, 'g3');
  await wallet.creditUnits(db, 'g3', { 'voice:standard': 20, whatsapp: 20 }, { reason: 'purchase' });
  const m = await addMember(db, 'g3', { lastVisit: 9, consent: ['call'] });
  await voiceCampaign(db, 'g3', { sequence: [{ channel: 'whatsapp' }, { channel: 'call', after_hours: 4 }] });
  const tplGroup = 'ftg_x';
  await db.run(`INSERT INTO followup_templates (id, org_id, group_id, name, body, language, status, created_at, updated_at) VALUES ('t1', 'g3', ?, 'Miss you', 'Hi {name}', 'en', 'approved', ?, ?)`, [tplGroup, noon.toISOString(), noon.toISOString()]);
  await db.run(`UPDATE followup_rules SET template_group_id = ? WHERE org_id = 'g3'`, [tplGroup]);
  await engine.planOrg(db, 'g3', { at: noon });
  const jobs = await db.q('SELECT channel FROM followup_jobs WHERE client_id = ?', [m.cid]);
  assert.deepEqual(jobs.map((j) => j.channel), ['call'], 'no WhatsApp permission: straight to the call, no 4-hour wait');
});

test('engine: campaign budget, end date and the owner monthly cap all stop contact', async () => {
  const db = await memDb();
  await seedGym(db, 'g4');
  await enableGym(db, 'g4');
  await wallet.creditUnits(db, 'g4', { 'voice:standard': 20 }, { values: { 'voice:standard': 200 }, reason: 'purchase' });
  await addMember(db, 'g4', { lastVisit: 9 });
  const rid = await voiceCampaign(db, 'g4', { extra: { ends_on: K(-1) } });
  let p = await engine.planOrg(db, 'g4', { at: noon });
  assert.equal(p.skipped.campaign_ended, 1);
  await db.run('UPDATE followup_rules SET ends_on = NULL, budget_json = ? WHERE id = ?', [JSON.stringify({ voice: 1 }), rid]);
  await db.run(`INSERT INTO followup_ledger (id, org_id, unit, delta, reason, rule_id, charge_inr, created_at) VALUES ('l1', 'g4', 'voice:standard', -1, 'usage', ?, 10, ?)`, [rid, new Date().toISOString()]);
  p = await engine.planOrg(db, 'g4', { at: noon });
  assert.equal(p.skipped.budget_reached, 1);
  await db.run('UPDATE followup_rules SET budget_json = NULL WHERE id = ?', [rid]);
  await db.run('UPDATE followup_settings SET monthly_cap_inr = 5 WHERE org_id = ?', ['g4']);
  p = await engine.planOrg(db, 'g4', { at: noon });
  assert.equal(p.reason, 'spend_cap');
});

/* ═════════════════════ API ═════════════════════ */

async function startApi() {
  const db = await memDb();
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();
  const routes = await import('../src/routes/followups.js');
  const app = express();
  app.set('db', db);
  app.use('/api/followups/hooks/elevenlabs', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/followups', routes.followupPublicRoutes(db));
  app.use('/api/followups', routes.default(db));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, url, { sub, role, org } = {}, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (sub) headers.Authorization = `Bearer ${jwt.sign({ sub, role, org, name: 'U', email: 'u@x.in' }, config.jwtSecret)}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, port };
}

const owner = (org) => ({ sub: `owner_${org}`, role: 'GYM_OWNER', org });

test('API: owners see their own gym only; members and trainers cannot use owner routes', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'a');
    await seedGym(api.db, 'b');
    const ov = await api.call('GET', '/api/followups/overview', owner('a'));
    assert.equal(ov.status, 200);
    assert.equal(ov.json.setup.mode, 'test');
    assert.ok(ov.json.wallet['voice:standard'] > 0, 'trial capacity granted');
    assert.ok(ov.json.products.some((p) => p.key === 'voice:premium' && p.tagline), 'tiers are described');
    const script = await api.call('POST', '/api/followups/scripts', owner('a'), { name: 'Hi', purpose: 'missed_visits', language: 'en', body: 'Hi {name}, we miss you.' });
    assert.equal(script.status, 200);
    const camp = await api.call('POST', '/api/followups/rules', owner('a'), { name: 'Come back', kind: 'missed_visits', sequence: [{ channel: 'call' }], script_group_id: script.json.script.group_id });
    assert.equal(camp.status, 200, JSON.stringify(camp.json));
    const id = camp.json.campaign.id;
    // Gym B cannot touch gym A's campaign, nor use gym A's script.
    const cross = await api.call('PUT', `/api/followups/rules/${id}`, owner('b'), { name: 'Hijack', kind: 'missed_visits', sequence: [{ channel: 'call' }], script_group_id: script.json.script.group_id });
    assert.equal(cross.status, 404, JSON.stringify(cross.json));
    const steal = await api.call('POST', '/api/followups/rules', owner('b'), { name: 'Hijack', kind: 'missed_visits', sequence: [{ channel: 'call' }], script_group_id: script.json.script.group_id });
    assert.equal(steal.status, 422);
    assert.match(steal.json.error, /does not belong/);
    assert.equal((await api.call('GET', '/api/followups/rules', owner('b'))).json.campaigns.length, 0);
    // Activation needs the compliance checklist.
    const act = await api.call('POST', `/api/followups/rules/${id}/status`, owner('a'), { status: 'active' });
    assert.equal(act.status, 409);
    assert.equal((await api.call('PUT', '/api/followups/compliance', owner('a'), { business_registered: true, consent_basis: 'Members sign our consent form', accepted_terms: true })).status, 200);
    assert.equal((await api.call('POST', `/api/followups/rules/${id}/status`, owner('a'), { status: 'active' })).status, 200);
    // Roles.
    assert.equal((await api.call('GET', '/api/followups/overview', { sub: 'trainer_a', role: 'TRAINER', org: 'a' })).status, 403);
    assert.equal((await api.call('GET', '/api/followups/overview', { sub: 'x', role: 'CLIENT', org: 'a' })).status, 403);
    assert.equal((await api.call('GET', '/api/followups/overview')).status, 401);
  } finally { await api.close(); }
});

test('API: a member controls their own channels, and the owner cannot override a member stop', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'a');
    const m = await addMember(api.db, 'a', { consent: [] });
    const asMember = { sub: m.uid, role: 'CLIENT', org: 'a' };
    assert.equal((await api.call('PUT', '/api/followups/me', asMember, { call: true, whatsapp: false, language: 'hi' })).status, 200);
    const mine = await api.call('GET', '/api/followups/me', asMember);
    assert.equal(mine.json.channels.call, true);
    assert.equal(mine.json.channels.whatsapp, false);
    const att = await api.call('POST', '/api/followups/members/consent', owner('a'), { client_ids: [m.cid], channels: ['whatsapp'], action: 'granted', evidence: 'Signed the form', attest: true });
    assert.equal(att.json.kept_member_choice, 1, 'the member turned WhatsApp off; the owner cannot turn it back on');
    const again = await api.call('GET', '/api/followups/me', asMember);
    assert.equal(again.json.channels.whatsapp, false);
  } finally { await api.close(); }
});

test('API: test calls go only to the owner\'s own phone', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'a', { phoneOwner: '' });
    await api.call('GET', '/api/followups/overview', owner('a'));
    const r = await api.call('POST', '/api/followups/test', owner('a'), { channel: 'call', language: 'en' });
    assert.equal(r.status, 422);
    await api.db.run(`UPDATE users SET phone = '9876500099' WHERE id = 'owner_a'`);
    const ok = await api.call('POST', '/api/followups/test', owner('a'), { channel: 'call', language: 'en' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.job.to_number, '+919876500099');
    assert.equal(ok.json.job.is_test, 1);
  } finally { await api.close(); }
});

test('API: buying a pack credits capacity once, whichever confirmation arrives', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'a');
    const { mockSimulateCheckout } = await import('../src/services/payments/paymentProvider.js');
    const cat = await api.call('GET', '/api/followups/catalogue', owner('a'));
    const pack = cat.json.packs.find((p) => p.plan === 'voice' && p.tier === 'premium');
    const unit = Object.keys(pack.units)[0];
    assert.equal(unit, 'voice:premium');
    assert.ok(pack.tagline && pack.available);
    assert.ok(pack && pack.total > 0 && pack.cost === undefined, 'owners never see cost');
    const before = (await api.call('GET', '/api/followups/catalogue', owner('a'))).json.wallet[unit];
    const o = await api.call('POST', '/api/followups/orders', owner('a'), { packId: pack.id });
    assert.equal(o.status, 200, JSON.stringify(o.json));
    const { paymentId, signature } = mockSimulateCheckout(o.json.order.provider_order_id);
    const v1 = await api.call('POST', `/api/followups/orders/${o.json.order.id}/verify`, owner('a'), { providerPaymentId: paymentId, signature });
    assert.equal(v1.json.order.status, 'SUCCESS');
    await api.call('POST', `/api/followups/orders/${o.json.order.id}/verify`, owner('a'), { providerPaymentId: paymentId, signature });
    const { confirmFromWebhook } = await import('../src/services/followups/orders.js');
    await confirmFromWebhook(api.db, await api.db.q1('SELECT * FROM followup_orders WHERE id = ?', [o.json.order.id]), { status: 'SUCCESS', providerPaymentId: paymentId });
    const after = (await api.call('GET', '/api/followups/catalogue', owner('a'))).json.wallet;
    assert.equal(after[unit] - before, pack.units[unit], 'credited exactly once, to that tier');
    assert.equal(after['voice:standard'], 0, 'other tiers untouched');
    const forged = await api.call('POST', '/api/followups/orders', owner('a'), { packId: pack.id });
    const bad = await api.call('POST', `/api/followups/orders/${forged.json.order.id}/verify`, owner('a'), { providerPaymentId: 'pay_x', signature: 'ab'.repeat(32) });
    assert.equal(bad.status, 422);
  } finally { await api.close(); }
});

test('webhooks: the ElevenLabs result must be signed; a signed result settles once', async () => {
  const api = await startApi();
  const prev = process.env.ELEVENLABS_WEBHOOK_SECRET;
  process.env.ELEVENLABS_WEBHOOK_SECRET = 'whsec_test_123456';
  try {
    await seedGym(api.db, 'a');
    await wallet.creditUnits(api.db, 'a', { 'agent:advanced': 10 }, { values: { 'agent:advanced': 120 }, reason: 'purchase' });
    const ts = new Date().toISOString();
    await api.db.run(`INSERT INTO followup_jobs (id, org_id, channel, dedupe_key, day_key, status, created_at, updated_at) VALUES ('ja', 'a', 'agent', 'ja', ?, 'dialing', ?, ?)`, [today, ts, ts]);
    await wallet.holdUnits(api.db, 'a', 'agent:advanced', 3, { jobId: 'ja' });
    const { jobToken } = await import('../src/services/followups/config.js');
    const body = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'conv1', metadata: { call_duration_secs: 95 }, analysis: { data_collection_results: { outcome: { value: 'coming_back' }, reason: { value: 'Was travelling' } } }, conversation_initiation_client_data: { dynamic_variables: { followup_job: jobToken('ja') } } } });
    const post = (sig) => fetch(`http://127.0.0.1:${api.port}/api/followups/hooks/elevenlabs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ElevenLabs-Signature': sig }, body });
    assert.equal((await post('t=1,v0=deadbeef')).status, 401);
    const t = Math.floor(Date.now() / 1000);
    const good = `t=${t},v0=${crypto.createHmac('sha256', 'whsec_test_123456').update(`${t}.${body}`).digest('hex')}`;
    assert.equal((await post(good)).status, 200);
    assert.equal((await post(good)).status, 200);
    const job = await api.db.q1(`SELECT * FROM followup_jobs WHERE id = 'ja'`);
    assert.equal(job.outcome, 'coming_back');
    assert.equal(Number(job.units), 2, '95 seconds = 2 minutes');
    assert.equal((await wallet.getWallet(api.db, 'a'))['agent:advanced'], 8, 'charged once, hold released');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET; else process.env.ELEVENLABS_WEBHOOK_SECRET = prev;
    await api.close();
  }
});

test('tiers: a campaign spends from its own tier, and a tier without a live provider is not sold in live mode', async () => {
  const db = await memDb();
  await seedGym(db, 't1');
  await enableGym(db, 't1');
  await wallet.creditUnits(db, 't1', { 'voice:premium': 5, 'voice:basic': 5 }, { reason: 'purchase' });
  await addMember(db, 't1', { lastVisit: 9 });
  const rid = await voiceCampaign(db, 't1');
  await db.run(`UPDATE followup_rules SET voice_tier = 'basic' WHERE id = ?`, [rid]);
  await engine.planOrg(db, 't1', { at: noon });
  await engine.dispatchOrg(db, 't1');
  const job = await db.q1('SELECT * FROM followup_jobs WHERE rule_id = ?', [rid]);
  assert.equal(job.unit, 'voice:basic');
  const w = await wallet.getWallet(db, 't1');
  assert.equal(w['voice:premium'], 5, 'premium untouched');
  assert.equal(w['voice:basic'], 5 - Number(job.units));
  const book = await wallet.getPriceBook(db);
  const { tierAvailable } = await import('../src/services/followups/providers/index.js');
  const live = wallet.catalogue(book, (product, tier) => tier.provider === 'elevenlabs');
  assert.equal(live.find((p) => p.id === 'voice_basic_500').available, false, 'basic needs your own speech server');
  assert.equal(live.find((p) => p.id === 'voice_premium_300').available, true);
  assert.equal(tierAvailable('voice', book.tiers.voice[0]), true, 'test mode simulates every tier');
});
