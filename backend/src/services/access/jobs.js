// ============================================================
// SYNC JOBS — long work, done in pieces a serverless function can finish.
//
// WHY NOT A BACKGROUND WORKER. This app deploys to Vercel functions, which
// end when their response is sent. A promise left running after `res.json`
// is not a background job; it is a job that sometimes finishes and
// sometimes silently does not, depending on how quickly the platform
// reclaims the instance. An import that reports RUNNING forever, or one
// that claims SUCCEEDED having done half its rows, is worse than no import.
//
// SO EVERY JOB IS A CURSOR. runChunk() does a bounded amount of work
// inside the request that called it, saves where it got to, and returns.
// A job that is RUNNING with a cursor has more to do, and is continued by:
//   - the next /api/access/cron/tick, when a scheduler is configured,
//   - the owner's Sync Center, which calls /continue while it is open,
//   - the lazy tick on the owner's live dashboard.
// None of those is required for correctness; each just makes it finish
// sooner. Nothing is ever lost between chunks because the cursor is in
// the database, not in memory.
//
// PROGRESS IS REPORTED HONESTLY. `total` is null until something actually
// told us how many there are (a CSV knows; a vendor event feed usually
// does not). The UI shows a count, not a percentage, when total is null,
// and never shows 100% unless status is SUCCEEDED.
// ============================================================
import { randomUUID, createHash } from 'node:crypto';
import { ingestAccessEvent } from './ingest.js';
import { getProvider } from './providers/index.js';
import { writeAudit } from './audit.js';

const nowIso = () => new Date().toISOString();
const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** Default time budget per chunk. Well under a serverless timeout. */
export const CHUNK_BUDGET_MS = 6000;
const PAGE_LIMIT = 500;
const CSV_ROWS_PER_CHUNK = 400;

/**
 * An idempotency key for a vendor event that did not come with one.
 *
 * Polling re-reads overlapping windows, and an event with no id cannot be
 * recognised the second time it arrives -- so without this, every poll
 * that overlapped the last would add the same people again. Derived from
 * the facts of the event, so the same scan always hashes the same way.
 */
export function derivedEventId(n) {
  const basis = [n.externalUserId, n.occurredAt, n.eventType || '', n.deviceIdentifier || ''].join('|');
  return `derived:${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

export async function createJob(db, { orgId, providerId = null, jobType, cursor = null, total = null }) {
  const id = randomUUID();
  const ts = nowIso();
  await db.run(
    `INSERT INTO access_sync_jobs (id, org_id, provider_id, job_type, status, processed, total, cursor_json, created_at, updated_at)
     VALUES (?,?,?,?,'PENDING',0,?,?,?,?)`,
    [id, orgId, providerId, jobType, total, cursor ? JSON.stringify(cursor) : null, ts, ts]);
  return getJob(db, orgId, id);
}

export async function getJob(db, orgId, id) {
  const row = await db.q1('SELECT * FROM access_sync_jobs WHERE id = ? AND org_id = ?', [id, orgId]);
  return row ? publicJob(row) : null;
}

export async function listJobs(db, orgId, { limit = 30 } = {}) {
  const rows = await db.q(
    `SELECT j.*, p.display_name AS provider_name FROM access_sync_jobs j
       LEFT JOIN access_providers p ON p.id = j.provider_id
      WHERE j.org_id = ? ORDER BY j.created_at DESC LIMIT ?`, [orgId, Math.min(100, limit)]);
  return rows.map(publicJob);
}

function publicJob(r) {
  const cursor = safeParse(r.cursor_json) || {};
  return {
    id: r.id,
    providerId: r.provider_id,
    providerName: r.provider_name || null,
    type: r.job_type,
    status: r.status,
    processed: r.processed,
    total: r.total,
    retries: r.retry_count,
    error: r.error_message,
    // More to do: RUNNING with a cursor that is not finished.
    hasMore: r.status === 'RUNNING' && !cursor.done,
    // Row data for CSV imports is never sent back -- it can be large and
    // it is member attendance.
    result: safeParse(r.result_json),
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  };
}

async function save(db, id, patch) {
  const cols = Object.keys(patch);
  await db.run(
    `UPDATE access_sync_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...cols.map((c) => patch[c]), nowIso(), id]);
}

function tally(result, outcome) {
  const r = result || { accepted: 0, duplicates: 0, rejected: 0, unmatched: 0 };
  if (outcome.status === 'duplicate') r.duplicates += 1;
  else if (outcome.status === 'rejected') r.rejected += 1;
  else if (outcome.outcome === 'unmatched') { r.unmatched += 1; r.accepted += 1; }
  else r.accepted += 1;
  return r;
}

/**
 * Ingest one raw vendor record through the provider's field mapping.
 * Returns the ingestion outcome, or { status: 'rejected' } when the
 * record has no identifiable person or time.
 */
async function ingestRaw(db, provider, adapter, raw, source) {
  const ctx = { db, orgId: provider.org_id, provider };
  const n = adapter.normalizeEvent(ctx, raw);
  if (!n) return { status: 'rejected' };
  return ingestAccessEvent(db, {
    orgId: provider.org_id,
    providerId: provider.id,
    branchId: provider.branch_id,
    verificationStatus: 'unverified',
    source,
    payload: raw,
    ...n,
    externalEventId: n.externalEventId ?? derivedEventId(n),
  });
}

/**
 * Do one bounded piece of a job.
 *
 * Safe to call on a job in any state: a finished job is returned as-is,
 * and two callers racing on the same job cannot both claim a chunk --
 * the claim is a conditional UPDATE, and the loser gets the job back
 * without doing anything.
 */
export async function runChunk(db, orgId, jobId, { budgetMs = CHUNK_BUDGET_MS } = {}) {
  const row = await db.q1('SELECT * FROM access_sync_jobs WHERE id = ? AND org_id = ?', [jobId, orgId]);
  if (!row) return null;
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return publicJob(row);

  // Claim. `updated_at` doubles as a lease: a chunk that is already being
  // worked (updated in the last budget window) is left alone.
  const leaseCutoff = new Date(Date.now() - budgetMs - 2000).toISOString();
  const claimed = await db.run(
    `UPDATE access_sync_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND (status = 'PENDING' OR (status = 'RUNNING' AND updated_at < ?))`,
    [nowIso(), nowIso(), jobId, leaseCutoff]);
  if (!claimed.changes) return publicJob(row);

  const provider = row.provider_id
    ? await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [row.provider_id, orgId])
    : null;
  if (provider) provider.config = safeParse(provider.config_json) || {};
  const adapter = provider ? getProvider(provider.provider_key) : null;
  const cursor = safeParse(row.cursor_json) || {};
  let result = safeParse(row.result_json);
  let processed = row.processed;
  const deadline = Date.now() + budgetMs;

  try {
    if (!provider || !adapter) throw new Error('The connection for this job no longer exists.');
    if (provider.status === 'DISABLED') throw new Error('The connection was disconnected before the job finished.');

    if (row.job_type === 'event_poll' || (row.job_type === 'historical_import' && cursor.mode !== 'csv')) {
      /* Page through the vendor feed. `since` advances to the newest
         occurred_at seen, and derived ids make the overlap between one
         page and the next harmless. */
      let since = cursor.since ?? (row.job_type === 'event_poll' ? provider.poll_cursor : cursor.from) ?? null;
      const until = cursor.to || null;
      let pages = 0;
      while (Date.now() < deadline) {
        const page = await adapter.fetchEvents({ db, orgId, provider }, { since, until, limit: PAGE_LIMIT });
        pages += 1;
        let newest = since;
        for (const raw of page) {
          const out = await ingestRaw(db, provider, adapter, raw, row.job_type === 'event_poll' ? 'poll' : 'import');
          result = tally(result, out);
          processed += 1;
          const n = adapter.normalizeEvent({ provider }, raw);
          if (n?.occurredAt && (!newest || n.occurredAt > newest)) newest = n.occurredAt;
        }
        const exhausted = page.length < PAGE_LIMIT || newest === since;
        since = newest;
        if (exhausted) { cursor.done = true; break; }
        // A poll is one page by design -- it runs every few minutes.
        if (row.job_type === 'event_poll' && pages >= 1) { cursor.done = true; break; }
      }
      cursor.since = since;
      if (row.job_type === 'event_poll') {
        await db.run('UPDATE access_providers SET poll_cursor = ?, last_polled_at = ?, updated_at = ? WHERE id = ?',
          [since, nowIso(), nowIso(), provider.id]);
      }
    } else if (row.job_type === 'historical_import' && cursor.mode === 'csv') {
      const rows = cursor.rows || [];
      let i = cursor.offset || 0;
      while (i < rows.length && Date.now() < deadline) {
        const end = Math.min(rows.length, i + CSV_ROWS_PER_CHUNK);
        for (; i < end; i += 1) {
          result = tally(result, await ingestRaw(db, provider, adapter, rows[i], 'import'));
          processed += 1;
        }
      }
      cursor.offset = i;
      if (i >= rows.length) { cursor.done = true; cursor.rows = []; }  // drop the data once used
    } else {
      throw new Error(`Unknown job type ${row.job_type}.`);
    }

    const done = !!cursor.done;
    await save(db, jobId, {
      status: done ? 'SUCCEEDED' : 'RUNNING',
      processed,
      cursor_json: JSON.stringify(cursor),
      result_json: JSON.stringify(result || {}),
      error_message: null,
      completed_at: done ? nowIso() : null,
    });
    if (done) {
      await writeAudit(db, {
        orgId, action: `access.job.${row.job_type}.completed`,
        entityType: 'access_sync_job', entityId: jobId, after: { processed, ...(result || {}) },
      });
    }
  } catch (e) {
    // The cursor is kept, so a retry resumes where this stopped rather
    // than re-importing everything before it.
    await save(db, jobId, {
      status: 'FAILED',
      processed,
      cursor_json: JSON.stringify(cursor),
      result_json: JSON.stringify(result || {}),
      error_message: String(e?.message || e).slice(0, 500),
      completed_at: nowIso(),
    });
    await writeAudit(db, {
      orgId, action: `access.job.${row.job_type}.failed`,
      entityType: 'access_sync_job', entityId: jobId, reason: String(e?.message || e).slice(0, 200), result: 'FAILED',
    });
  }
  return getJob(db, orgId, jobId);
}

export async function retryJob(db, orgId, id) {
  const row = await db.q1('SELECT * FROM access_sync_jobs WHERE id = ? AND org_id = ?', [id, orgId]);
  if (!row) return null;
  if (row.status !== 'FAILED') return publicJob(row);
  await save(db, id, { status: 'PENDING', retry_count: row.retry_count + 1, error_message: null, completed_at: null });
  return getJob(db, orgId, id);
}

export async function cancelJob(db, orgId, id) {
  const row = await db.q1('SELECT * FROM access_sync_jobs WHERE id = ? AND org_id = ?', [id, orgId]);
  if (!row) return null;
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return publicJob(row);
  // Rows already ingested stay ingested -- they are real events. Cancel
  // means "stop", not "undo".
  const cursor = safeParse(row.cursor_json) || {};
  cursor.rows = [];
  await save(db, id, { status: 'CANCELLED', completed_at: nowIso(), cursor_json: JSON.stringify(cursor) });
  return getJob(db, orgId, id);
}

/** Jobs with more to do, oldest first. Used by the tick. */
export async function pendingJobIds(db, orgId, limit = 3) {
  const rows = await db.q(
    `SELECT id FROM access_sync_jobs WHERE org_id = ? AND status IN ('PENDING','RUNNING')
      ORDER BY created_at LIMIT ?`, [orgId, limit]);
  return rows.map((r) => r.id);
}

/* ── CSV ───────────────────────────────────────────────────────────── */

/**
 * RFC-4180-ish parsing: quoted fields, escaped quotes, commas and newlines
 * inside quotes, CRLF. Returns an array of objects keyed by the header row.
 * Hand-written rather than a dependency because the input is small, the
 * format is simple, and this is on the import path of member attendance.
 */
export function parseCsv(text, { maxRows = 20000 } = {}) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) break;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
  if (rows.length < 2) return { header: rows[0] || [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1, maxRows + 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { header, records, truncated: rows.length - 1 > maxRows };
}

export default { createJob, getJob, listJobs, runChunk, retryJob, cancelJob, pendingJobIds, parseCsv, derivedEventId };
