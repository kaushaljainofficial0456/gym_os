// ============================================================
// AI COMMUNICATION 2.0 -- prerecorded calls (MODE A), the audio library,
// announcements, and the separate permission for promotional contact.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { memDb } from './helpers/followupsDb.js';
import { seedGym, addMember, enableGym, voiceCampaign, owner, startApi, today, noon, K } from './helpers/followupsSeed.js';

const wallet = await import('../src/services/followups/wallet.js');
const engine = await import('../src/services/followups/engine.js');
const wav = await import('../src/services/followups/wav.js');
const recs = await import('../src/services/followups/recordings.js');
const { readAudio } = await import('../src/services/followups/audio.js');
const { recordConsent } = await import('../src/services/followups/consent.js');
const { dueStep } = await import('../src/services/followups/schedule.js');
const { buildVoiceMessage } = await import('../src/services/followups/render.js');
const cbs = await import('../src/services/followups/callbacks.js');

/** A test tone as a WAV file in any PCM shape. */
function tone({ rate = 44100, channels = 2, secs = 2, bits = 16, float = false, amp = 0.5, freq = 440, formatTag = null } = {}) {
  const frames = Math.round(rate * secs);
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      if (float) data.writeFloatLE(v, p);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), p);
      else if (bits === 8) data.writeUInt8(Math.round(v * 127 + 128), p);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), p, 3);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(formatTag ?? (float ? 3 : 1), 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bytes, 28); h.writeUInt16LE(channels * bytes, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

/* ═══════════════════════ audio ═══════════════════════ */

test('wav: any PCM WAV becomes phone audio (8 kHz, mono, 16-bit) and keeps its length', () => {
  for (const shape of [{ rate: 44100, channels: 2 }, { rate: 48000, channels: 1, bits: 32, float: true }, { rate: 16000, channels: 1, bits: 24 }, { rate: 8000, channels: 1, bits: 8 }, { rate: 22050, channels: 2, bits: 16 }]) {
    const { wav: out, seconds, peak } = wav.toPhoneWav(tone({ ...shape, secs: 1.5 }));
    const p = wav.parseWav(out);
    assert.deepEqual({ rate: p.rate, channels: p.channels, bits: p.bits, format: p.format }, { rate: 8000, channels: 1, bits: 16, format: 1 }, JSON.stringify(shape));
    assert.ok(close(seconds, 1.5), `${JSON.stringify(shape)}: ${seconds}s`);
    assert.ok(peak > 0.4 && peak < 0.6, `${JSON.stringify(shape)}: level kept (${peak})`);
  }
});

test('wav: refuses what a phone cannot play, with a reason the owner understands', () => {
  assert.throws(() => wav.checkRecording(Buffer.from('ID3\u0003\u0000\u0000\u0000 mp3 data that is long enough to pass the size check......')), /not a WAV recording/);
  assert.throws(() => wav.checkRecording(tone({ formatTag: 0x55 })), /Only uncompressed \(PCM\) WAV/);
  assert.throws(() => wav.checkRecording(tone({ amp: 0 })), /silent/);
  assert.throws(() => wav.checkRecording(tone({ secs: 0.5 })), /shorter than a second/);
  assert.throws(() => wav.checkRecording(tone({ rate: 8000, channels: 1, secs: 121 })), /under 2 minutes \(this one is 121 seconds\)/);
  assert.throws(() => wav.parseWav(Buffer.alloc(10)), /not a WAV/);
});

test('wav: notice + recording + menu join into one playable file with short pauses', () => {
  const joined = wav.joinPhoneWavs([tone({ secs: 1 }), tone({ secs: 2, rate: 8000, channels: 1 }), tone({ secs: 1, rate: 16000, channels: 1 })]);
  const p = wav.parseWav(joined);
  assert.equal(p.rate, 8000);
  assert.ok(close(p.frames / 8000, 4 + 2 * 0.35), `${p.frames / 8000}s`);
});

/* ═══════════════════════ the library ═══════════════════════ */

test('recordings: upload, same file twice is one recording, preview, rename, archive only when nothing running plays it', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'lib');
    await seedGym(db, 'other');
    await enableGym(db, 'lib');
    const me = owner('lib');
    const audio = tone({ secs: 2 });
    const up = (body, q = 'name=Holiday%20closure&language=en&file=holiday.mp3') => api.call('POST', `/api/followups/recordings?${q}`, me, null, { headers: { 'Content-Type': 'audio/wav' }, raw: body });
    const first = await up(audio);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.recording.name, 'Holiday closure');
    assert.ok(close(Number(first.json.recording.duration_secs), 2, 0.1));
    assert.equal(first.json.recording.data_b64, undefined, 'the audio itself is never sent in a listing');
    assert.equal((await up(audio, 'name=Same%20file&language=en')).json.recording.id, first.json.recording.id, 'same audio, same recording (renamed)');
    assert.equal((await up(Buffer.from('ID3 this is an mp3 file, not a wav file at all.......'))).status, 422);
    assert.equal((await up(audio, 'name=x&language=xx')).status, 422, 'unknown language');

    const id = first.json.recording.id;
    const token = (await import('jsonwebtoken')).default.sign({ sub: 'owner_lib', role: 'GYM_OWNER', org: 'lib', name: 'U', email: 'u@x.in' }, (await import('../src/config.js')).config.jwtSecret);
    const res = await fetch(`http://127.0.0.1:${api.port}/api/followups/recordings/${id}/audio`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');

    // Another gym can neither hear nor change it.
    assert.equal((await api.call('GET', `/api/followups/recordings/${id}/audio`, owner('other'))).status, 404);
    assert.equal((await api.call('PUT', `/api/followups/recordings/${id}`, owner('other'), { name: 'Mine now' })).status, 404);
    assert.equal((await api.call('GET', '/api/followups/recordings', owner('other'))).json.recordings.length, 0);

    // A running announcement plays it: archiving is refused until it is paused.
    const camp = await api.call('POST', '/api/followups/rules', me, { name: 'Diwali closure', kind: 'announcement', config: { send_on: K(1), audience: 'all' }, sequence: [{ channel: 'call' }], recording_id: id, purpose: 'service' });
    assert.equal(camp.status, 200, JSON.stringify(camp.json));
    assert.equal(camp.json.campaign.mode, 'prerecorded');
    assert.equal((await api.call('POST', `/api/followups/rules/${camp.json.campaign.id}/status`, me, { status: 'active' })).status, 200);
    const blocked = await api.call('PUT', `/api/followups/recordings/${id}`, me, { status: 'archived' });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error, /In use by 1 running campaign/);
    await api.call('POST', `/api/followups/rules/${camp.json.campaign.id}/status`, me, { status: 'paused' });
    assert.equal((await api.call('PUT', `/api/followups/recordings/${id}`, me, { status: 'archived' })).json.recording.status, 'archived');
    assert.equal((await api.call('GET', '/api/followups/recordings', me)).json.recordings.length, 0);
    assert.ok((await db.q(`SELECT action FROM followup_audit WHERE org_id = 'lib' AND entity_type = 'followup_recordings'`)).length >= 3, 'every change is audited');
  } finally { await api.close(); }
});

/* ═══════════════════════ prerecorded calls ═══════════════════════ */

test('prerecorded campaign: the recording plays between the fixed notice and the keypad menu; it is never an AI conversation', async () => {
  const db = await memDb();
  await seedGym(db, 'pr');
  await enableGym(db, 'pr');
  await wallet.creditUnits(db, 'pr', { 'voice:standard': 20 }, { reason: 'purchase' });
  const rec = await recs.saveRecording(db, 'pr', 'owner_pr', { buffer: tone({ secs: 2 }), name: 'Come back offer', language: 'en' });
  const rid = await voiceCampaign(db, 'pr', { extra: { recording_id: rec.id, script_group_id: null } });
  for (let i = 0; i < 6; i++) await addMember(db, 'pr', { lastVisit: 9 });
  const plan = await engine.planOrg(db, 'pr', { at: noon });
  assert.equal(plan.queued, 6);
  await engine.dispatchOrg(db, 'pr', { at: noon });
  const jobs = await db.q('SELECT * FROM followup_jobs WHERE rule_id = ?', [rid]);
  for (const j of jobs) {
    assert.equal(j.channel, 'call');
    assert.match(j.message_text, /^This is an automated call from Gym pr\. \[Recording: Come back offer, 2s\] To talk to us, press 1\./);
    assert.ok(['completed', 'no_answer', 'busy'].includes(j.status), j.status);
    assert.ok(!['renewing', 'coming_back', 'callback_scheduled', 'question'].includes(j.outcome), 'only keypad outcomes for a one-way call');
  }
  assert.equal((await db.q(`SELECT id FROM followup_conversations WHERE org_id = 'pr'`)).length, 0, 'no conversation record: nothing was understood');
  const used = await db.q1(`SELECT SUM(-delta) AS n FROM followup_ledger WHERE org_id = 'pr' AND reason = 'usage' AND unit = 'voice:standard'`);
  const connected = jobs.filter((j) => j.status === 'completed').reduce((s, j) => s + Math.max(1, Math.ceil(Number(j.duration_secs) / 60)), 0);
  assert.equal(Number(used.n || 0), connected, 'only connected calls are billed, as voice minutes');
});

test('prerecorded call, live audio: ONE file = spoken notice + the recording + the spoken menu, cached', async () => {
  const db = await memDb();
  await seedGym(db, 'la');
  const rec = await recs.saveRecording(db, 'la', 'owner_la', { buffer: tone({ secs: 2, rate: 8000, channels: 1 }), name: 'Offer', language: 'en' });
  const voiceId = 'sarvam:priya';
  const notice = 'This is an automated call from Gym la.';
  const menu = 'To talk to us, press 1. To stop these calls, press 9.';
  // The TTS for the notice and menu, as the speech engine would have cached it.
  for (const [text, secs] of [[notice, 1], [menu, 1.5]]) {
    const b = tone({ secs, rate: 8000, channels: 1, freq: 300 });
    const hash = crypto.createHash('sha256').update(`${voiceId}|en|${text}`).digest('hex');
    await db.run(`INSERT INTO followup_audio (id, org_id, hash, voice_id, chars, data_b64, bytes, created_at, last_used_at) VALUES (?, 'la', ?, ?, ?, ?, ?, ?, ?)`,
      [`fa_${secs}`, hash, voiceId, text.length, b.toString('base64'), b.length, new Date().toISOString(), new Date().toISOString()]);
  }
  const id1 = await recs.callAudio(db, 'la', { recordingId: rec.id, voiceId, language: 'en', notice, menu });
  const p = wav.parseWav(await readAudio(db, id1));
  assert.ok(close(p.frames / 8000, 1 + 2 + 1.5 + 0.7), `${p.frames / 8000}s`);
  assert.equal(await recs.callAudio(db, 'la', { recordingId: rec.id, voiceId, language: 'en', notice, menu }), id1, 'made once, then cached');
  await assert.rejects(recs.callAudio(db, 'other_gym', { recordingId: rec.id, voiceId, language: 'en', notice, menu }), /missing/, 'another gym cannot use it');
});

test('a scheduled call back can play a recording instead of the AI', async () => {
  const db = await memDb();
  await seedGym(db, 'rc');
  await enableGym(db, 'rc');
  await wallet.creditUnits(db, 'rc', { 'voice:standard': 5 }, { reason: 'purchase' });
  const rec = await recs.saveRecording(db, 'rc', 'owner_rc', { buffer: tone({ secs: 2 }), name: 'Renewal reminder', language: 'en' });
  const m = await addMember(db, 'rc', { lastVisit: 1 });
  const cb = await cbs.createCallback(db, 'rc', 'owner_rc', { clientId: m.cid, date: K(1), time: '11:00', mode: 'call', recordingId: rec.id }, noon);
  assert.equal(cb.mode, 'call');
  const at = new Date(cb.scheduled_for);
  await cbs.queueDueCallbacks(db, 'rc', { at });
  await engine.dispatchOrg(db, 'rc', { at });
  const job = await db.q1('SELECT * FROM followup_jobs WHERE callback_id = ?', [cb.id]);
  assert.equal(job.channel, 'call');
  assert.match(job.message_text, /\[Recording: Renewal reminder/);
  const after = await cbs.getCallback(db, 'rc', cb.id);
  assert.equal(after.status, job.status === 'completed' ? 'completed' : 'scheduled', 'completed when it connected, else retried');
});

/* ═══════════════════════ announcements & promotions ═══════════════════════ */

test('announcement: only on its day and only to its audience; its menu asks nothing back', () => {
  const active = { membership: { id: 's1', startKey: K(-30), endKey: K(30), status: 'active' } };
  const lapsed = { membership: { id: 's2', startKey: K(-90), endKey: K(-10), status: 'active' } };
  const soon = { membership: { id: 's3', startKey: K(-80), endKey: K(4), status: 'active' } };
  const cfg = (audience) => ({ send_on: today, audience, expiring_days: 7 });
  assert.ok(dueStep('announcement', cfg('active'), active, today));
  assert.equal(dueStep('announcement', cfg('active'), lapsed, today), null);
  assert.ok(dueStep('announcement', cfg('expired'), lapsed, today));
  assert.ok(dueStep('announcement', cfg('expiring'), soon, today));
  assert.equal(dueStep('announcement', cfg('expiring'), active, today), null);
  assert.ok(dueStep('announcement', cfg('all'), lapsed, today));
  assert.equal(dueStep('announcement', cfg('all'), active, K(1)), null, 'never late');
  assert.equal(dueStep('announcement', { audience: 'all' }, active, today), null, 'no day, no send');
  const msg = buildVoiceMessage({ script: 'We are closed on Friday for Diwali.', language: 'en', kind: 'announcement', overrides: null, vars: { gym: 'Iron' } });
  assert.doesNotMatch(msg.menu, /press 2/);
  assert.match(msg.menu, /press 1.*press 9/);
});

test('promotions need the member\'s own, separate permission; a call back never grants it; turning it off stops queued offers', async () => {
  const db = await memDb();
  await seedGym(db, 'pm');
  await enableGym(db, 'pm');
  await wallet.creditUnits(db, 'pm', { 'voice:standard': 20 }, { reason: 'purchase' });
  const yes = await addMember(db, 'pm', { name: 'Yes Offers', lastVisit: 1 });
  const no = await addMember(db, 'pm', { name: 'No Offers', lastVisit: 1 });
  await recordConsent(db, { orgId: 'pm', clientId: yes.cid, channels: ['promo'], action: 'opted_in', source: 'member', evidence: 'Turned on offers in the app' });
  // A call back booked for the other member does not make them reachable for offers.
  await cbs.scheduleCallback(db, { orgId: 'pm', clientId: no.cid, mode: 'agent', at: new Date(Date.now() + 86_400_000).toISOString(), local: `${K(1)} 11:00`, timezone: 'Asia/Kolkata', source: 'member_request' });
  await db.run(`UPDATE followup_callbacks SET status = 'cancelled' WHERE client_id = ?`, [no.cid]);
  assert.equal((await db.q1('SELECT promo_consent FROM followup_member_prefs WHERE client_id = ?', [no.cid])).promo_consent, null);

  const rid = await voiceCampaign(db, 'pm', { kind: 'announcement', config: { send_on: today, audience: 'all' }, extra: { purpose: 'promotional' } });
  const plan = await engine.planOrg(db, 'pm', { at: noon });
  assert.equal(plan.queued, 1);
  assert.equal(plan.skipped.no_promo_permission, 1);
  const q = await db.q1('SELECT * FROM followup_jobs WHERE rule_id = ?', [rid]);
  assert.equal(q.client_id, yes.cid);

  await recordConsent(db, { orgId: 'pm', clientId: yes.cid, channels: ['promo'], action: 'opted_out', source: 'member', evidence: 'Turned off offers in the app' });
  const after = await db.q1('SELECT status, error FROM followup_jobs WHERE id = ?', [q.id]);
  assert.deepEqual({ ...after }, { status: 'skipped', error: 'Member stopped offers and promotions' });
  const log = await db.q1(`SELECT channel, purpose FROM followup_consent_log WHERE client_id = ? AND action = 'opted_out'`, [yes.cid]);
  assert.deepEqual({ ...log }, { channel: 'all', purpose: 'promotional' });
});

test('campaign rules: only announcements can be promotional; an announcement needs a future day; a call needs something to play', async () => {
  const api = await startApi();
  try {
    await seedGym(api.db, 'cr');
    const me = owner('cr');
    const post = (b) => api.call('POST', '/api/followups/rules', me, { name: 'Test', sequence: [{ channel: 'sms' }], sms_group_id: null, ...b });
    assert.match((await post({ kind: 'membership_ending', purpose: 'promotional', sequence: [{ channel: 'call' }], recording_id: null })).json.error, /pick the recording|Pick the recording/i);
    const { saveScript } = await import('../src/services/followups/studio.js');
    const gid = (await saveScript(api.db, 'cr', 'owner_cr', { name: 'x', purpose: 'general', channelType: 'voice', language: 'en', body: 'Hello {name}, renew soon.' })).group_id;
    assert.match((await post({ kind: 'membership_ending', purpose: 'promotional', sequence: [{ channel: 'call' }], script_group_id: gid })).json.error, /Only announcements can be promotional/);
    assert.match((await post({ kind: 'announcement', sequence: [{ channel: 'call' }], script_group_id: gid, config: { audience: 'all' } })).json.error, /Pick the day/);
    assert.match((await post({ kind: 'announcement', sequence: [{ channel: 'call' }], script_group_id: gid, config: { audience: 'all', send_on: K(-1) } })).json.error, /already passed/);
    const ok = await post({ kind: 'announcement', purpose: 'promotional', sequence: [{ channel: 'call' }], script_group_id: gid, config: { audience: 'active', send_on: K(2) } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.campaign.purpose, 'promotional');
    assert.match(ok.json.campaign.schedule, /^Once, on \d{4}-\d{2}-\d{2}, to members with an active membership$/);
  } finally { await api.close(); }
});

test('member app: offers switch on and off; turning calls off cancels a call back they booked', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    await seedGym(db, 'ma');
    await enableGym(db, 'ma');
    const m = await addMember(db, 'ma', { lastVisit: 1 });
    const me = { sub: m.uid, role: 'CLIENT', org: 'ma' };
    assert.equal((await api.call('GET', '/api/followups/me', me)).json.offers, false);
    await api.call('PUT', '/api/followups/me', me, { offers: true });
    assert.equal((await api.call('GET', '/api/followups/me', me)).json.offers, true);
    const cb = await cbs.scheduleCallback(db, { orgId: 'ma', clientId: m.cid, mode: 'agent', at: new Date(Date.now() + 86_400_000).toISOString(), local: `${K(1)} 11:00`, timezone: 'Asia/Kolkata' });
    await api.call('PUT', '/api/followups/me', me, { call: false });
    assert.equal((await cbs.getCallback(db, 'ma', cb.id)).status, 'cancelled');
    await api.call('PUT', '/api/followups/me', me, { offers: false });
    assert.equal((await api.call('GET', '/api/followups/me', me)).json.offers, false);
  } finally { await api.close(); }
});
