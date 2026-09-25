// ============================================================
// MAINTENANCE TICK — everything that should happen "every few minutes".
//
// There is no scheduler in this codebase and it deploys to serverless
// functions, so "every few minutes" has three possible drivers, all of
// which call runOrgMaintenance and none of which is required:
//
//   1. /api/access/cron/tick, protected by CRON_SECRET, for whoever wires
//      up a scheduler (Vercel Cron on a plan that allows it, or any
//      external pinger such as cron-job.org).
//   2. The owner's live dashboard, which ticks lazily when it loads and at
//      most once a minute per gym (maybeTick).
//   3. The owner's Sync Center, which continues jobs while it is open.
//
// Without any of them the feature still works -- events are processed
// the moment they arrive, and occupancy is read live. What waits for a
// tick is housekeeping: polling REST providers, closing sessions left
// open, snapshots for history, membership re-evaluation, and alerts.
//
// EACH STEP IS INDEPENDENT. A failing poll must not stop stale sessions
// closing, so every step is caught and reported separately.
// ============================================================
import { timingSafeEqual } from 'node:crypto';
import { reconcileStaleSessions, closeSession } from './presence.js';
import { lastClosingBefore } from './localTime.js';
import { createJob, runChunk, pendingJobIds } from './jobs.js';
import { evaluateOrgAccess } from './membershipSync.js';
import { evaluateAlerts } from './alerts.js';
import { maybeSnapshot } from './analytics.js';
import { liveCrowd } from './liveCrowd.js';
import { getProvider, effectiveCapabilities } from './providers/index.js';
import { writeAudit } from './audit.js';
import { getOrgTz } from '../../utils/time.js';

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function step(summary, name, fn) {
  try { summary[name] = await fn(); } catch (e) { summary[name] = { error: String(e?.message || e).slice(0, 200) }; }
}

/**
 * Close sessions still open after the gym's closing time. Only when hours
 * are configured; only sessions that STARTED before that closing (someone
 * who came in after a late close is a different case, handled by the
 * max-duration rule). The exit time stays null -- we know they left, not
 * when -- and the session is marked estimated.
 */
async function closeAfterHours(db, orgId, settings, tz, now) {
  const closing = lastClosingBefore(settings, tz, now);
  if (!closing) return { closed: 0, reason: 'hours not configured' };
  const open = await db.q(
    `SELECT * FROM gym_presence_sessions
      WHERE org_id = ? AND status = 'OPEN' AND entered_at < ?`, [orgId, closing.toISOString()]);
  for (const s of open) await closeSession(db, s, { exitedAt: null, reason: 'auto_closed', confidence: 'estimated' });
  if (open.length) {
    await writeAudit(db, {
      orgId, action: 'access.sessions.closed_after_hours',
      reason: `closing time ${settings.crowd_close_time}`, after: { closed: open.length },
    });
  }
  return { closed: open.length };
}

/** Poll REST providers whose interval has elapsed. */
async function pollDue(db, orgId, now) {
  const providers = await db.q(
    "SELECT * FROM access_providers WHERE org_id = ? AND status != 'DISABLED'", [orgId]);
  const started = [];
  for (const p of providers) {
    const config = safeParse(p.config_json) || {};
    const caps = effectiveCapabilities(getProvider(p.provider_key), config);
    if (!caps.supportsPolling) continue;
    // Never more often than once a minute, whatever the config says --
    // a vendor rate-limiting us would take the feed down entirely.
    const interval = Math.max(60, Number(config.pollIntervalSec) || 300) * 1000;
    if (p.last_polled_at && now - Date.parse(p.last_polled_at) < interval) continue;
    // One poll in flight per provider.
    const inflight = await db.q1(
      "SELECT id FROM access_sync_jobs WHERE provider_id = ? AND job_type = 'event_poll' AND status IN ('PENDING','RUNNING')",
      [p.id]);
    const job = inflight || await createJob(db, { orgId, providerId: p.id, jobType: 'event_poll' });
    const res = await runChunk(db, orgId, job.id, { budgetMs: 4000 });
    started.push({ providerId: p.id, status: res?.status, processed: res?.processed });
  }
  return started;
}

export async function runOrgMaintenance(db, orgId, { now = new Date(), tz: tzIn = null } = {}) {
  const tz = tzIn || await getOrgTz(db, orgId);
  const settings = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [orgId])) || {};
  const summary = { orgId, at: now.toISOString() };

  await step(summary, 'staleSessions', () => reconcileStaleSessions(db, orgId, {
    maxHours: Math.min(72, Math.max(1, Number(settings.access_auto_close_hours) || 12)), now,
  }));
  await step(summary, 'afterHours', () => closeAfterHours(db, orgId, settings, tz, now));
  await step(summary, 'polls', () => pollDue(db, orgId, now));
  await step(summary, 'jobs', async () => {
    const out = [];
    for (const id of await pendingJobIds(db, orgId, 2)) {
      const j = await runChunk(db, orgId, id, { budgetMs: 3000 });
      out.push({ id, status: j?.status });
    }
    return out;
  });
  if (settings.access_sync_enabled !== 0) {
    await step(summary, 'access', () => evaluateOrgAccess(db, orgId, { settings, now, limit: 200, tz }));
  }
  await step(summary, 'snapshot', () => maybeSnapshot(db, orgId, tz, settings, { now }));
  await step(summary, 'alerts', async () => {
    const crowd = await liveCrowd(db, orgId, tz, settings, { showExactCount: true });
    const alerts = await evaluateAlerts(db, orgId, { settings, crowd, now, tz });
    return { open: alerts.length };
  });
  return summary;
}

const lastTick = new Map();

/**
 * Tick at most once a minute per gym from this instance. The dashboard
 * calls this on load; it must never make that load noticeably slower, so
 * it is skipped entirely when a tick ran recently.
 */
export async function maybeTick(db, orgId, { minIntervalMs = 60_000 } = {}) {
  const last = lastTick.get(orgId) || 0;
  if (Date.now() - last < minIntervalMs) return null;
  lastTick.set(orgId, Date.now());
  return runOrgMaintenance(db, orgId);
}

/** Every gym that has access control or crowd tracking worth maintaining. */
export async function runAllOrgs(db, { budgetMs = 50_000 } = {}) {
  const orgs = await db.q(
    `SELECT DISTINCT org_id FROM access_providers WHERE status != 'DISABLED'
     UNION
     SELECT DISTINCT org_id FROM gym_presence_sessions WHERE status = 'OPEN'`);
  const deadline = Date.now() + budgetMs;
  const results = [];
  for (const { org_id: orgId } of orgs) {
    if (Date.now() > deadline) { results.push({ orgId, skipped: 'time budget' }); continue; }
    results.push(await runOrgMaintenance(db, orgId));
  }
  return { orgs: orgs.length, results };
}

/**
 * Constant-time check of the cron secret. Accepts `Authorization: Bearer
 * <secret>` -- which is what Vercel Cron sends -- or `x-cron-secret`.
 */
export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return { ok: false, status: 503, reason: 'CRON_SECRET is not configured' };
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-cron-secret'] || '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, reason: 'bad secret' };
  return { ok: true };
}

export default { runOrgMaintenance, maybeTick, runAllOrgs, cronAuthorized };
