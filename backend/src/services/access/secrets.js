// ============================================================
// PROVIDER SECRETS — written once, never handed back.
//
// An access provider's API key opens the doors of a real building. The
// rules here are narrow on purpose:
//
//   1. Encrypted at rest (AES-256-GCM, authenticated so a tampered
//      ciphertext fails loudly rather than decrypting to garbage).
//   2. NEVER returned to any API caller. There is no "reveal" endpoint
//      and no code path that selects `ciphertext` into a response; the
//      owner UI shows a four-character hint and nothing else. If someone
//      loses a key they rotate it, which is what they would have to do
//      anyway once it had been displayed on a screen.
//   3. Read only by the adapter that is about to make a request with it.
//
// WHY A SEPARATE TABLE (access_provider_secrets) rather than a column on
// the connection: the owner dashboard SELECTs connections constantly, and
// `SELECT *` is how a secret ends up in a JSON response. Keeping them in
// a table nothing else joins to makes that mistake impossible rather than
// merely discouraged.
//
// KEY MANAGEMENT. ACCESS_SECRET_KEY is the encryption key. In development
// it falls back to a key derived from JWT_SECRET so the feature works
// locally without extra setup -- but a derived key is NOT a substitute
// for a real one in production, and storeSecret refuses to run in
// production without ACCESS_SECRET_KEY set. Failing at write time is the
// only honest option: pretending to encrypt is worse than not encrypting,
// because it produces a system everyone believes is safe.
// ============================================================
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { config } from '../../config.js';

const ALGO = 'aes-256-gcm';

function encryptionKey() {
  const explicit = process.env.ACCESS_SECRET_KEY;
  if (explicit && explicit.length >= 32) return createHash('sha256').update(explicit).digest();
  if (config.isProd) {
    throw new Error(
      'ACCESS_SECRET_KEY is not set. Access-provider credentials cannot be stored '
      + 'without a dedicated encryption key in production.');
  }
  // Development only, and deliberately derived from something that is
  // already a secret rather than a constant in the repository.
  return createHash('sha256').update(`access-dev:${config.jwtSecret}`).digest();
}

/** iv:tag:ciphertext, all base64. Self-describing so rotation can tell formats apart. */
export function encryptSecret(plaintext) {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unreadable secret format');
  const [, iv, tag, data] = parts;
  const decipher = createDecipheriv(ALGO, encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** What the owner sees. Four characters is enough to tell two keys apart. */
export function maskSecret(plaintext) {
  const s = String(plaintext || '');
  if (s.length <= 4) return '••••';
  return `••••••••${s.slice(-4)}`;
}

/**
 * Store (or replace) one secret for a provider.
 *
 * Replaces rather than accumulates: a provider has one API key, and
 * keeping the old rows would mean a "rotate" that leaves the previous key
 * working.
 */
export async function storeSecret(db, { orgId, providerId, kind, value }) {
  if (!value) throw new Error('empty secret');
  const ciphertext = encryptSecret(value);   // throws in prod without a key — see header
  await db.run('DELETE FROM access_provider_secrets WHERE provider_id = ? AND kind = ?', [providerId, kind]);
  const id = randomUUID();
  await db.run(
    `INSERT INTO access_provider_secrets (id, org_id, provider_id, kind, ciphertext, hint, rotated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, orgId, providerId, kind, ciphertext, String(value).slice(-4), new Date().toISOString(), new Date().toISOString()]);
  return { id, hint: maskSecret(value) };
}

/**
 * Read a secret back, for an adapter that is about to use it.
 *
 * The only function in the codebase that returns plaintext. Route
 * handlers must never call it; adapters call it immediately before an
 * outbound request and never put the result anywhere that is serialized.
 */
export async function readSecret(db, { providerId, kind }) {
  const row = await db.q1(
    'SELECT ciphertext FROM access_provider_secrets WHERE provider_id = ? AND kind = ?', [providerId, kind]);
  if (!row) return null;
  return decryptSecret(row.ciphertext);
}

/** Safe for an API response: which secrets exist, and their last four. */
export async function describeSecrets(db, providerId) {
  const rows = await db.q(
    'SELECT kind, hint, rotated_at FROM access_provider_secrets WHERE provider_id = ?', [providerId]);
  return rows.map((r) => ({
    kind: r.kind,
    masked: r.hint ? `••••••••${r.hint}` : '••••••••',
    rotatedAt: r.rotated_at,
  }));
}

export default { storeSecret, readSecret, describeSecrets, maskSecret, encryptSecret, decryptSecret };
