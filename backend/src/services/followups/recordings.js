// ============================================================
// RECORDINGS -- the gym's own prerecorded messages (MODE A, one-way calls).
//
// A recording is stored once per gym as phone-ready WAV (wav.js) in the
// database, like the TTS cache, so it survives serverless restarts and is
// covered by the same tenant isolation (RLS). A call plays:
//
//     "This is an automated call from {gym}."   (fixed notice, TTS)
//     <the owner's recording>
//     "To talk to us, press 1 ... press 9 to stop."   (keypad menu, TTS)
//
// joined into one file, because the notice and the opt-out are not optional
// and Exotel's Gather step plays a single audio URL. A prerecorded call never
// listens to speech: the keypad is its only input, so nothing it does can be
// mistaken for an AI conversation.
// ============================================================
import crypto from 'node:crypto';
import { id, now } from '../../ids.js';
import { checkRecording, joinPhoneWavs } from './wav.js';
import { ensureAudio, readAudio } from './audio.js';
import { isLanguage } from './languages.js';

const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PUBLIC_COLS = 'id, org_id, name, language, purpose, bytes, duration_secs, original_name, status, created_by, created_at, updated_at';

export async function saveRecording(db, orgId, userId, { buffer, name, language = 'en', purpose = null, originalName = null }) {
  const label = String(name || '').trim().slice(0, 80);
  if (label.length < 2) throw err('Give the recording a name');
  if (!isLanguage(language)) throw err('That language is not supported');
  const { wav, seconds } = checkRecording(buffer);
  const hash = sha(wav);
  const ts = now();
  const same = await db.q1('SELECT id FROM followup_recordings WHERE org_id = ? AND sha256 = ?', [orgId, hash]);
  if (same) {
    await db.run(`UPDATE followup_recordings SET name = ?, language = ?, purpose = ?, status = 'active', updated_at = ? WHERE id = ?`, [label, language, purpose, ts, same.id]);
    return db.q1(`SELECT ${PUBLIC_COLS} FROM followup_recordings WHERE id = ?`, [same.id]);
  }
  const rid = id('frec');
  await db.run(
    `INSERT INTO followup_recordings (id, org_id, name, language, purpose, mime, data_b64, bytes, duration_secs, sha256, original_name, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'audio/wav', ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [rid, orgId, label, language, purpose ? String(purpose).slice(0, 120) : null, wav.toString('base64'), wav.length, seconds, hash, originalName ? String(originalName).slice(0, 120) : null, userId, ts, ts]);
  return db.q1(`SELECT ${PUBLIC_COLS} FROM followup_recordings WHERE id = ?`, [rid]);
}

export const listRecordings = (db, orgId, { archived = false } = {}) =>
  db.q(`SELECT ${PUBLIC_COLS} FROM followup_recordings WHERE org_id = ? AND status = ? ORDER BY created_at DESC`, [orgId, archived ? 'archived' : 'active']);

export const getRecording = (db, orgId, recordingId) =>
  db.q1(`SELECT ${PUBLIC_COLS} FROM followup_recordings WHERE id = ? AND org_id = ?`, [recordingId, orgId]);

/** The audio of one of THIS gym's recordings (null when it is not theirs). */
export async function recordingAudio(db, orgId, recordingId) {
  const row = await db.q1('SELECT data_b64 FROM followup_recordings WHERE id = ? AND org_id = ?', [recordingId, orgId]);
  return row ? Buffer.from(row.data_b64, 'base64') : null;
}

export async function updateRecording(db, orgId, recordingId, { name, language, status }) {
  const cur = await getRecording(db, orgId, recordingId);
  if (!cur) throw err('Recording not found', 404);
  const sets = [];
  const vals = [];
  if (name !== undefined) { const n = String(name).trim().slice(0, 80); if (n.length < 2) throw err('Give the recording a name'); sets.push('name = ?'); vals.push(n); }
  if (language !== undefined) { if (!isLanguage(language)) throw err('That language is not supported'); sets.push('language = ?'); vals.push(language); }
  if (status !== undefined) { if (!['active', 'archived'].includes(status)) throw err('Unknown status'); sets.push('status = ?'); vals.push(status); }
  if (sets.length) await db.run(`UPDATE followup_recordings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now(), cur.id]);
  return getRecording(db, orgId, recordingId);
}

/** Campaigns and scheduled call backs that would play it -- so archiving can warn. */
export async function recordingInUse(db, orgId, recordingId) {
  const rules = await db.q(`SELECT id, name, status FROM followup_rules WHERE org_id = ? AND recording_id = ?`, [orgId, recordingId]);
  const callbacks = await db.q(`SELECT id FROM followup_callbacks WHERE org_id = ? AND recording_id = ? AND status IN ('scheduled','processing')`, [orgId, recordingId]);
  return { campaigns: rules, callbacks: callbacks.length };
}

/**
 * The single audio file a prerecorded call plays: notice + recording + menu,
 * cached in followup_audio like any spoken message. `voiceId` speaks the
 * notice and the menu (the gym's default voice for the language).
 */
export async function callAudio(db, orgId, { recordingId, voiceId, language, notice, menu }) {
  const rec = await db.q1('SELECT sha256, data_b64 FROM followup_recordings WHERE id = ? AND org_id = ?', [recordingId, orgId]);
  if (!rec) throw err('The recording for this call is missing', 409);
  const hash = sha(Buffer.from(`rec|${rec.sha256}|${voiceId}|${language}|${notice}|${menu}`));
  const hit = await db.q1('SELECT id FROM followup_audio WHERE org_id = ? AND hash = ?', [orgId, hash]);
  if (hit) {
    await db.run('UPDATE followup_audio SET last_used_at = ? WHERE id = ?', [now(), hit.id]);
    return hit.id;
  }
  const n = await ensureAudio(db, orgId, { voiceId, language, text: notice });
  const m = await ensureAudio(db, orgId, { voiceId, language, text: menu });
  const joined = joinPhoneWavs([await readAudio(db, n.id), Buffer.from(rec.data_b64, 'base64'), await readAudio(db, m.id)]);
  const audioId = id('fa');
  const ts = now();
  try {
    await db.run(
      `INSERT INTO followup_audio (id, org_id, hash, voice_id, model_id, chars, data_b64, bytes, created_at, last_used_at)
       VALUES (?, ?, ?, ?, 'recording', 0, ?, ?, ?, ?)`,
      [audioId, orgId, hash, voiceId, joined.toString('base64'), joined.length, ts, ts]);
  } catch (e) {
    if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e;
    return (await db.q1('SELECT id FROM followup_audio WHERE org_id = ? AND hash = ?', [orgId, hash])).id;
  }
  return audioId;
}
