// ============================================================
// FOLLOW-UP AUDIO -- spoken messages, made once and served to the phone.
//
// Audio is cached per gym by (voice, language, exact text): a retry the
// same day, the shared menu and the "thank you" lines cost nothing after
// the first time. Exotel fetches the audio from a signed URL; nothing
// else can list or guess it. Old audio is pruned.
// ============================================================
import crypto from 'node:crypto';
import { id, now } from '../../ids.js';
import { publicBase, sign } from './config.js';
import { synthesize } from './providers/index.js';

const hashOf = (voiceId, language, text) => crypto.createHash('sha256').update(`${voiceId}|${language}|${text}`).digest('hex');

/** The audio id for this text in this voice, generating it if needed. */
export async function ensureAudio(db, orgId, { voiceId, language, text }) {
  // voiceId is provider-qualified ("sarvam:priya"); the registry routes it.
  const hash = hashOf(voiceId, language, text);
  const hit = await db.q1('SELECT id FROM followup_audio WHERE org_id = ? AND hash = ?', [orgId, hash]);
  if (hit) {
    await db.run('UPDATE followup_audio SET last_used_at = ? WHERE id = ?', [now(), hit.id]);
    return { id: hit.id, cached: true, chars: 0 };
  }
  const { audio, model: modelId } = await synthesize({ voiceRef: voiceId, text, language });
  const audioId = id('fa');
  const ts = now();
  try {
    await db.run(
      `INSERT INTO followup_audio (id, org_id, hash, voice_id, model_id, chars, data_b64, bytes, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [audioId, orgId, hash, voiceId, modelId, text.length, audio.toString('base64'), audio.length, ts, ts]);
  } catch (e) {
    // Two dispatches made the same audio at once: keep the first.
    if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e;
    const row = await db.q1('SELECT id FROM followup_audio WHERE org_id = ? AND hash = ?', [orgId, hash]);
    return { id: row.id, cached: true, chars: text.length };
  }
  return { id: audioId, cached: false, chars: text.length };
}

export async function readAudio(db, audioId) {
  const row = await db.q1('SELECT data_b64 FROM followup_audio WHERE id = ?', [audioId]);
  return row ? Buffer.from(row.data_b64, 'base64') : null;
}

export const audioUrl = (audioId) => `${publicBase()}/api/followups/audio/${audioId}.wav?t=${sign(audioId)}`;

/** Drop audio nobody has played for two weeks. */
export async function pruneAudio(db, days = 14) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const r = await db.run('DELETE FROM followup_audio WHERE last_used_at < ?', [cutoff]);
  return r.changes;
}
