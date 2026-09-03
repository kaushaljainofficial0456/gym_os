// ============================================================
// STORAGE ABSTRACTION — private image storage.
//   * Dev/default: `local` driver — files under backend/data/uploads,
//     served ONLY through the authenticated /uploads route (ownership-checked).
//   * Production: `s3` driver target — S3-compatible object storage
//     (AWS S3 / Cloudflare R2 / Supabase Storage). The database stores
//     storage_key metadata, never the image bytes.
// The DB never stores base64 for new uploads; `data_url` columns remain
// only as read-back compat for rows written before this abstraction.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'uploads');

export const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local'; // local | s3

// F-12i production readiness: this app deploys as a Vercel serverless
// function (see vercel.json's `functions` block) -- its filesystem
// outside /tmp is read-only, and even /tmp is ephemeral and NOT shared
// across concurrent/scaled instances. Writing under UPLOAD_ROOT (a path
// inside the deployed bundle, not /tmp) either throws immediately
// (read-only fs) or, in whatever environment happens to allow the write,
// produces a file the NEXT request (a different instance, or the same
// instance after a cold restart) can no longer see -- silent, sporadic
// "my photo disappeared" data loss, not a clean failure. There is no
// working S3-compatible driver in this codebase yet (see the 's3' branch
// below, which already refuses to pretend otherwise). Rather than let
// 'local' silently attempt a write that is unsafe in production and fail
// unpredictably, this fails loudly and immediately, in the same
// production-boot posture as config.js's payment-provider gate: an
// operator misconfiguration must be an obvious, actionable error, not a
// mystery bug report about vanishing photos.
if (config.nodeEnv === 'production' && STORAGE_DRIVER === 'local') {
  console.error('[sk-os] WARNING: STORAGE_DRIVER=local in production. Uploaded files (progress photos, etc.) will fail to save or will not persist across requests -- this deployment target has no durable local filesystem. Configure STORAGE_DRIVER=s3 with a real S3-compatible bucket before uploads are used in production.');
}

const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const m = dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED[mime]) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) return null;
  return { mime, ext: ALLOWED[mime], buf };
}

// Minimal dimension sanity from image headers (PNG/JPEG) — same logic as the
// label-scan route; used to reject nonsense payloads early.
function dims(buf, ext) {
  try {
    if (ext === 'png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (ext === 'jpg' && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length - 9) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
        }
        o += 2 + buf.readUInt16BE(o + 2);
      }
    }
  } catch {}
  return null;
}

/**
 * Persist an image. Returns { storageKey, storage, ext } or throws a
 * descriptive Error (callers turn it into a 400).
 *   scope: 'photos' | 'tmp'  (tmp is cleaned up on save; photos are permanent)
 */
export async function saveImage({ dataUrl, clientId, scope = 'photos', fileId }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error('Invalid or unsupported image — use PNG, JPEG, WebP or GIF (max 5 MB)');
  const d = dims(parsed.buf, parsed.ext);
  if (d && (d.w < 32 || d.h < 32)) throw new Error('Image is too small to be a valid photo');

  const key = `${scope}/${clientId}/${fileId || Date.now()}.${parsed.ext}`;

  if (STORAGE_DRIVER === 's3') {
    // S3-compatible driver slot (AWS S3 / Cloudflare R2 / Supabase Storage).
    // Implement by setting STORAGE_DRIVER=s3 plus STORAGE_* env vars and
    // adding an S3 SDK call here — the DB/API contract (storage_key) does not change.
    throw new Error('S3 storage driver is not configured yet — set STORAGE_DRIVER=local or implement the S3 driver');
  }

  // See the module-level comment above: 'local' cannot durably persist a
  // file on this deployment target in production. Fail clearly here,
  // before ever touching the filesystem, instead of a confusing EROFS (or
  // worse, an apparently-successful write that a later request can't see).
  if (config.nodeEnv === 'production') {
    throw new Error('File uploads are unavailable: STORAGE_DRIVER=local cannot persist files in production. Configure STORAGE_DRIVER=s3 with a real object-storage bucket.');
  }

  const abs = path.join(UPLOAD_ROOT, key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, parsed.buf);
  return { storageKey: key, storage: 'local', ext: parsed.ext };
}

/** Remove a stored object (best-effort; used on delete). */
export async function deleteObject(storageKey) {
  if (!storageKey || STORAGE_DRIVER !== 'local') return;
  const abs = path.join(UPLOAD_ROOT, storageKey);
  if (abs.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch {}
  }
}

/** Resolve a stored object to an authenticated URL path (or null for legacy data_url rows). */
export function objectUrl(storageKey) {
  return storageKey ? `/uploads/${storageKey}` : null;
}
