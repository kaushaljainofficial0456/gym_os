// ============================================================
// ACCESS AUDIT — who changed what, and what it was before.
//
// Access control decides whether a person can get into a building. Every
// change to that -- a revoked card, a manually corrected presence
// session, a rotated webhook secret, a disconnected provider -- is a
// decision someone made, and a month later somebody will ask who.
//
// APPEND-ONLY, AND NEVER FATAL. An audit write that throws must not take
// the operation down with it: refusing to revoke a card because the log
// was briefly unavailable is worse than a gap in the log. Failures are
// reported to the server console and swallowed.
//
// SECRETS NEVER REACH THIS TABLE. before/after states are passed through
// the same redaction as event payloads, because "rotated the API key"
// audits perfectly well without the key in it.
// ============================================================
import { randomUUID } from 'node:crypto';

const SENSITIVE = /(secret|password|token|api[_-]?key|credential|ciphertext|authorization)/i;

/** Drop anything that should never be written down. */
export function redactState(value, depth = 0) {
  if (value == null || depth > 4) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactState(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redactState(v, depth + 1);
  }
  return out;
}

export async function writeAudit(db, {
  orgId, actorUserId = null, actorRole = null, action,
  entityType = null, entityId = null, branchId = null,
  reason = null, before = null, after = null, result = 'OK',
}) {
  try {
    await db.run(
      `INSERT INTO access_audit_logs
         (id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, branch_id,
          reason, before_json, after_json, result, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), orgId, actorUserId, actorRole, action, entityType, entityId, branchId,
        reason,
        before == null ? null : JSON.stringify(redactState(before)),
        after == null ? null : JSON.stringify(redactState(after)),
        result, new Date().toISOString()]);
  } catch (e) {
    // See the header: a broken log must not break the thing being logged.
    console.error('[access-audit] failed to record', action, e?.message || e);
  }
}

/** Newest first, org-scoped. Pagination is a cursor on created_at. */
export async function listAudit(db, orgId, { limit = 50, before = null, entityType = null, action = null } = {}) {
  /* Every column is qualified with the alias. `users` also has an org_id,
     so the unqualified form was ambiguous and the whole listing threw --
     which, because writeAudit deliberately swallows its own failures, is
     the kind of break that shows up as an empty audit page rather than as
     an error anywhere. */
  const where = ['a.org_id = ?'];
  const params = [orgId];
  if (before) { where.push('a.created_at < ?'); params.push(before); }
  if (entityType) { where.push('a.entity_type = ?'); params.push(entityType); }
  if (action) { where.push('a.action = ?'); params.push(action); }
  params.push(Math.min(200, Math.max(1, limit)));
  const rows = await db.q(
    `SELECT a.*, u.name AS actor_name
       FROM access_audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ?`, params);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor: r.actor_name || 'System',
    actorRole: r.actor_role,
    entityType: r.entity_type,
    entityId: r.entity_id,
    branchId: r.branch_id,
    reason: r.reason,
    before: safeParse(r.before_json),
    after: safeParse(r.after_json),
    result: r.result,
    at: r.created_at,
  }));
}

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export default { writeAudit, listAudit, redactState };
