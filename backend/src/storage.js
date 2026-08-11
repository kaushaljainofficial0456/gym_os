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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'uploads');

export const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local'; // local | s3

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
