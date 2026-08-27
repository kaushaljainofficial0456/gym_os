// ============================================================
// ERROR CENTER + SYSTEM HEALTH (Phase 3c) -- the platform-wide
// counterpart to the existing org-scoped GET /api/admin/errors (see
// admin.js), reusing the SAME events table (no new error-storage
// mechanism) rather than duplicating it.
//
// System health reuses REAL, already-exported config-summary functions
// (paymentConfigSummary, foodAIConfigSummary) instead of re-deriving
// provider state -- and a genuine DB round-trip for the database check,
// never a hardcoded "ok". Nothing here is a synthetic/simulated status.
// ============================================================
import { paymentConfigSummary } from '../payments/paymentProvider.js';
import { foodAIConfigSummary } from '../intelligence/foodAI.js';

function safeParseJson(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

/** Every server/client error across every org, newest first -- the
 *  cross-tenant view the org-scoped /api/admin/errors route can't
 *  provide (it's deliberately WHERE org_id = req.orgId). */
export async function listPlatformErrors(db, { type = null, limit = 100 } = {}) {
  const conds = [`e.type IN ('server_error', 'client_error')`]; const params = [];
  if (type && ['server_error', 'client_error'].includes(type)) { conds.push('e.type = ?'); params.push(type); }
  const rows = await db.q(
    `SELECT e.id, e.type, e.org_id, e.user_id, e.data_json, e.created_at, o.name AS org_name
       FROM events e LEFT JOIN organizations o ON o.id = e.org_id
      WHERE ${conds.join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`,
    [...params, limit]);
  return rows.map((r) => {
    const data = safeParseJson(r.data_json);
    return { id: r.id, type: r.type, orgId: r.org_id, orgName: r.org_name, userId: r.user_id, createdAt: r.created_at, ...data };
  });
}

async function countErrors(db, sinceIso) {
  const row = await db.q1(`SELECT COUNT(*) AS n FROM events WHERE type IN ('server_error', 'client_error') AND created_at >= ?`, [sinceIso]);
  return Number(row?.n || 0);
}

/** Real health signals only -- a component this pass genuinely cannot
 *  check (no external uptime probe, no queue depth, etc.) is simply
 *  absent rather than faked green. */
export async function getSystemHealth(db) {
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  let dbHealthy = true;
  let dbLatencyMs = null;
  try {
    const t0 = Date.now();
    await db.q1('SELECT 1 AS ok');
    dbLatencyMs = Date.now() - t0;
  } catch {
    dbHealthy = false;
  }

  const [errorsLastHour, errorsLastDay, payment, ai] = await Promise.all([
    countErrors(db, hourAgo),
    countErrors(db, dayAgo),
    Promise.resolve(paymentConfigSummary()),
    foodAIConfigSummary(db),
  ]);

  return {
    database: { healthy: dbHealthy, latencyMs: dbLatencyMs },
    errors: { lastHour: errorsLastHour, lastDay: errorsLastDay },
    payments: { provider: payment.provider, liveConfigured: payment.liveConfigured, webhookSecretConfigured: payment.webhookSecretConfigured },
    ai: {
      chain: ai.chain,
      chainAvailability: ai.chainAvailability,
      anyProviderConfigured: Object.values(ai.chainAvailability).some(Boolean),
    },
  };
}
