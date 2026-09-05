// ============================================================
// STORAGE ABSTRACTION — private image storage.
//   * Dev/default: `local` driver — files under backend/data/uploads,
//     served ONLY through the authenticated /uploads route (ownership-checked).
//   * Production: `s3` driver — real S3-compatible object storage (AWS S3 /
//     Cloudflare R2 / Supabase Storage all speak the same API). The
//     database stores storage_key metadata, never the image bytes.
// The DB never stores base64 for new uploads; `data_url` columns remain
// only as read-back compat for rows written before this abstraction.
//
// F-12i: 'local' is UNSAFE in production (this app deploys as a Vercel
// serverless function -- see the production-only guard below) and now
// fails loudly there instead of silently losing files. To actually use
// uploads in production, set:
//   STORAGE_DRIVER=s3
//   STORAGE_S3_BUCKET=<bucket name>
//   STORAGE_S3_ACCESS_KEY_ID=<access key>
//   STORAGE_S3_SECRET_ACCESS_KEY=<secret key>
//   STORAGE_S3_ENDPOINT=<only for R2/Supabase/non-AWS -- e.g. R2's
//     https://<account-id>.r2.cloudflarestorage.com; leave unset for real AWS S3>
//   STORAGE_S3_REGION=<optional; defaults to 'auto', which R2 accepts and
//     real AWS S3 ignores in favor of the bucket's own region metadata>
// The bucket must be PRIVATE (no public-read policy) -- this driver never
// sets a public ACL on upload, and GET /uploads/:key proxies the bytes
// through the backend's own ownership check on every access rather than
// handing out a shareable URL. The s3 driver's own request/response
// shape is contract-tested (storageProductionGate.test.js, via an
// injectable mock client) -- there is no live S3-compatible bucket in
// this development environment to verify against, so treat this as
// "correctly implemented and unit-tested" rather than "proven against a
// real bucket"; verify against a real bucket once real credentials exist
// (any AWS S3 / Cloudflare R2 / Supabase Storage account will do, since
// this driver only speaks the standard S3 API) before relying on it.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

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

// ---- S3-compatible driver (AWS S3 / Cloudflare R2 / Supabase Storage) ----
// @aws-sdk/client-s3 talks the S3 API, which all three of those speak --
// only the endpoint/region differ (R2 and Supabase both need
// STORAGE_S3_ENDPOINT; real AWS S3 leaves it unset). Bucket is assumed
// PRIVATE by default (no public-read ACL is ever set on PutObject below)
// -- objects are only ever reachable through GET /uploads/:key, which
// re-checks the requester's ownership on every single access (see
// index.js) rather than handing back a shareable/cacheable URL, so
// "private bucket, backend-mediated access" stays true regardless of the
// underlying driver.
let _s3Client = null;
let _s3Bucket = null;
function getS3() {
  if (_s3Client) return { client: _s3Client, bucket: _s3Bucket };
  const bucket = process.env.STORAGE_S3_BUCKET;
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('STORAGE_DRIVER=s3 requires STORAGE_S3_BUCKET, STORAGE_S3_ACCESS_KEY_ID, and STORAGE_S3_SECRET_ACCESS_KEY (plus STORAGE_S3_ENDPOINT for R2/Supabase, STORAGE_S3_REGION if not using the default).');
  }
  _s3Client = new S3Client({
    region: process.env.STORAGE_S3_REGION || 'auto',
    endpoint: process.env.STORAGE_S3_ENDPOINT || undefined, // unset -> real AWS S3; set -> R2/Supabase/any S3-compatible endpoint
    credentials: { accessKeyId, secretAccessKey },
  });
  _s3Bucket = bucket;
  return { client: _s3Client, bucket: _s3Bucket };
}

/** TEST-ONLY: inject a fake S3 client (no live credentials exist in this
 *  environment; the driver is contract-tested against a mock, exactly
 *  like upstashRateLimitStore.js's own mocked-fetch test posture -- never
 *  claimed as live-infrastructure-verified). Pass null to reset. */
export function _setS3ClientForTests(client, bucket = 'test-bucket') {
  _s3Client = client;
  _s3Bucket = bucket;
}

const CONTENT_TYPE_FOR_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

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
    const { client, bucket } = getS3();
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: parsed.buf,
      ContentType: CONTENT_TYPE_FOR_EXT[parsed.ext] || 'application/octet-stream',
      // Deliberately NO ACL: 'public-read' -- see the module-level comment
      // above. The bucket stays private; GET /uploads/:key is the only path.
    }));
    return { storageKey: key, storage: 's3', ext: parsed.ext };
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
  if (!storageKey) return;
  if (STORAGE_DRIVER === 's3') {
    try {
      const { client, bucket } = getS3();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    } catch (e) {
      console.error('[sk-os] deleteObject (s3) failed (best-effort, ignored):', e?.message || e);
    }
    return;
  }
  const abs = path.join(UPLOAD_ROOT, storageKey);
  if (abs.startsWith(UPLOAD_ROOT + path.sep) && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch {}
  }
}

/** Resolve a stored object to an authenticated URL path (or null for legacy data_url rows). */
export function objectUrl(storageKey) {
  return storageKey ? `/uploads/${storageKey}` : null;
}

/** Stream a stored object's bytes for the s3 driver -- used by GET
 *  /uploads/:key (see index.js), which re-checks ownership on every
 *  access before ever calling this, exactly like it does for the local
 *  driver's res.sendFile. Returns { body, contentType } (body is a
 *  Node Readable) or null if the object doesn't exist. Not used for the
 *  local driver -- that path still uses res.sendFile directly. */
export async function getObjectStream(storageKey) {
  if (STORAGE_DRIVER !== 's3' || !storageKey) return null;
  const { client, bucket } = getS3();
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
    return { body: out.Body, contentType: out.ContentType || 'application/octet-stream' };
  } catch (e) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
