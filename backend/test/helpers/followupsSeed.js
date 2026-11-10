// ============================================================
// AI COMMUNICATION TEST FIXTURES -- a gym, its members, a campaign, and an
// API server over the owner, public and admin-console routes. Same shapes as
// the helpers inside followups.test.js (left as they are there).
// ============================================================
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';
import { memDb } from './followupsDb.js';

const engine = await import('../../src/services/followups/engine.js');
const { recordConsent } = await import('../../src/services/followups/consent.js');
const { saveScript } = await import('../../src/services/followups/studio.js');
const { normalizePhone } = await import('../../src/services/followups/render.js');
const { dayKey, shiftDayKey } = await import('../../src/utils/time.js');

export const TZ = 'Asia/Kolkata';
export const today = dayKey(new Date(), TZ);
export const noon = new Date(`${today}T12:00:00+05:30`);
export const K = (n) => shiftDayKey(today, n);
export const at = (hhmm, key = today) => new Date(`${key}T${hhmm}:00+05:30`);

export async function seedGym(db, org, { phoneOwner = '9876500000' } = {}) {
  await db.run(`INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)`, [org, `Gym ${org}`, org, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, created_at) VALUES (?, ?, ?, 'x', 'GYM_OWNER', ?, ?, 1, ?)`, [`owner_${org}`, org, `owner@${org}.in`, 'Vikram Owner', phoneOwner, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, 'x', 'TRAINER', ?, 1, ?)`, [`trainer_${org}`, org, `t@${org}.in`, 'Asha Trainer', '2026-01-01T00:00:00Z']);
}

let seq = 0;
export async function addMember(db, org, { name = 'Member', phone = '98765' + String(10000 + (++seq)).slice(-5), lastVisit = null, endIn = 30, startAgo = 60, consent = ['call'], trainer = true, unpaid = 0 } = {}) {
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

export async function enableGym(db, org, { window = ['09:00', '21:00'], days = '1111111' } = {}) {
  await engine.getSettings(db, org);
  await db.run(`UPDATE followup_settings SET enabled = 1, window_start = ?, window_end = ?, days_mask = ?, compliance_json = ? WHERE org_id = ?`,
    [window[0], window[1], days, JSON.stringify({ accepted_terms: true }), org]);
}

export async function voiceCampaign(db, org, { kind = 'missed_visits', sequence = [{ channel: 'call' }], config = {}, perDay = 1, extra = {} } = {}) {
  const script = await saveScript(db, org, `owner_${org}`, { name: 'Missed you', purpose: kind, channelType: 'voice', language: 'en', body: 'Hi {name}! We have not seen you in a while.' });
  const rid = `fr_${org}_${++seq}`;
  await db.run(`INSERT INTO followup_rules (id, org_id, name, kind, status, config_json, sequence_json, per_day, gap_hours, language, script_group_id, created_at, updated_at)
                VALUES (?, ?, 'Come back', ?, 'active', ?, ?, ?, 1, 'en', ?, ?, ?)`,
    [rid, org, kind, JSON.stringify(config), JSON.stringify(sequence), perDay, script.group_id, new Date().toISOString(), new Date().toISOString()]);
  for (const [k, v] of Object.entries(extra)) await db.run(`UPDATE followup_rules SET ${k} = ? WHERE id = ?`, [v, rid]);
  return rid;
}

/** An approved WhatsApp template wired to every campaign of the gym. */
export async function whatsappTemplate(db, org) {
  const ts = new Date().toISOString();
  await db.run(`INSERT INTO followup_templates (id, org_id, group_id, name, body, language, status, created_at, updated_at) VALUES (?, ?, ?, 'Miss you', 'Hi {name}', 'en', 'approved', ?, ?)`, [`t_${org}`, org, `ftg_${org}`, ts, ts]);
  await db.run(`UPDATE followup_rules SET template_group_id = ? WHERE org_id = ?`, [`ftg_${org}`, org]);
}

export const owner = (org) => ({ sub: `owner_${org}`, role: 'GYM_OWNER', org });
export const admin = () => ({ sub: 'founder', role: 'SUPER_ADMIN', org: null });

/** The owner + public follow-up routes and the admin console, on a fresh db. */
export async function startApi({ db = null } = {}) {
  db = db || await memDb();
  const { resetRateLimits } = await import('../../src/rateLimit.js');
  resetRateLimits();
  const routes = await import('../../src/routes/followups.js');
  const consoleRoutes = (await import('../../src/routes/console.js')).default;
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('founder', NULL, 'founder@x.in', 'x', 'SUPER_ADMIN', 'Founder', 1, '2026-01-01T00:00:00Z')`).catch(() => {});
  const app = express();
  app.set('db', db);
  app.use(['/api/followups/hooks/elevenlabs', '/api/followups/hooks/agent'], express.raw({ type: 'application/json' }));
  app.use('/api/followups/hooks', express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/followups', routes.followupPublicRoutes(db));
  app.use('/api/followups', routes.default(db));
  app.use('/api/console', consoleRoutes(db));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, url, who = {}, body, { headers: extra = {}, raw = null } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (who.sub) headers.Authorization = `Bearer ${jwt.sign({ sub: who.sub, role: who.role, org: who.org, name: 'U', email: 'u@x.in' }, config.jwtSecret)}`;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close, port };
}
