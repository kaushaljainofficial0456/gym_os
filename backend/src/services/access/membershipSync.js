// ============================================================
// MEMBERSHIP → DOOR ACCESS.
//
// When a membership lapses, the door should stop opening. That sentence
// hides three separate facts, and the design keeps them separate because
// collapsing any two of them is how an owner gets misled:
//
//   desired_access   what SK OS thinks this person's access SHOULD be,
//                    from their membership (or a human override).
//   access_status    what we know the DEVICE has been told -- ALLOWED or
//                    DENIED when a push succeeded, or why we could not
//                    say: PENDING_SYNC, SYNC_FAILED, NOT_SUPPORTED,
//                    MANUAL_REVIEW.
//   the door itself  which we never observe directly.
//
// RULES THIS FILE HOLDS TO:
//
//   * A failed push changes nothing at the door, so it must not be shown
//     as a revocation. The member stays whatever the device last had, the
//     row says SYNC_FAILED, and the next evaluation retries. The spec's
//     "do not revoke access solely because of a temporary network
//     failure" is satisfied by construction: a network failure cannot
//     revoke anything, because revoking IS the push.
//
//   * When the provider cannot be updated from SK OS (most door systems
//     today), the row says NOT_SUPPORTED and the owner is told plainly
//     that a lapsed member must be removed at the device by hand. We do
//     not pretend to enforce what we cannot reach.
//
//   * Lapse is judged by DATES, with a grace period. A subscription row
//     whose status still says 'active' but whose end date has passed is
//     lapsed -- the same rule the rest of this codebase learned the hard
//     way (see gymPulse.js: nothing in the app expires a subscription, so
//     the status column alone is not evidence).
//
//   * Staff (a mapping with no client row) are not membership-gated.
//
//   * A human override beats the rule, and records who, when and why.
// ============================================================
import { getProvider, effectiveCapabilities } from './providers/index.js';
import { writeAudit } from './audit.js';
import { dayKey, DEFAULT_TZ } from '../../utils/time.js';

const nowIso = () => new Date().toISOString();
const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* Lifecycle states that end access regardless of dates -- taken from the
   actual CHECK on subscriptions.lifecycle_status (init-db.js), not from
   what the states might be called. A first draft listed FROZEN and
   BLOCKED, which that column cannot hold, and missed PAUSED -- so a
   paused membership would have kept its door access. */
const BLOCKING_LIFECYCLE = new Set([
  'PAUSED', 'SUSPENDED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'TRANSFERRED',
]);

/** YYYY-MM-DD, `days` before `from`, in the GYM's calendar.
 *
 * end_date is a local date somebody typed; deriving the cutoff from the
 * UTC date compared two different calendars. West of UTC that revoked a
 * member's door access up to a day early -- the turnstile refusing
 * someone whose membership still had a day left on it. */
function dayMinus(from, days, tz) {
  return dayKey(new Date(from.getTime() - days * 86400000), tz);
}

/**
 * Does this client hold a membership that should open the door today?
 *
 * 'overdue' counts as active: an overdue PAYMENT is a billing problem the
 * gym handles at the desk, not a reason for the turnstile to refuse
 * someone mid-contract. The end date, plus grace, is what ends access.
 */
export async function membershipAllowsAccess(db, { orgId, clientId, graceDays = 3, now = new Date(), tz = DEFAULT_TZ }) {
  const cutoff = dayMinus(now, Math.max(0, graceDays), tz);
  const rows = await db.q(
    `SELECT status, end_date, lifecycle_status FROM subscriptions
      WHERE org_id = ? AND client_id = ? AND status IN ('active','overdue')`, [orgId, clientId]);
  return rows.some((r) => {
    if (r.lifecycle_status && BLOCKING_LIFECYCLE.has(String(r.lifecycle_status).toUpperCase())) return false;
    if (!r.end_date) return true;
    return String(r.end_date).slice(0, 10) >= cutoff;
  });
}

export async function desiredAccessFor(db, mapping, { graceDays, now, tz = DEFAULT_TZ }) {
  if (mapping.override_access) return { desired: mapping.override_access, reason: 'override' };
  if (!mapping.client_id) return { desired: 'ALLOWED', reason: 'staff' };
  const ok = await membershipAllowsAccess(db, { orgId: mapping.org_id, clientId: mapping.client_id, graceDays, now, tz });
  return { desired: ok ? 'ALLOWED' : 'DENIED', reason: ok ? 'membership_active' : 'membership_lapsed' };
}

/**
 * Bring one mapping into line with what it should be.
 *
 * Returns { desired, accessStatus, pushed, changed, message }.
 */
export async function syncMapping(db, mapping, { settings = {}, actorUserId = null, now = new Date(), force = false, tz = DEFAULT_TZ } = {}) {
  const graceDays = Number.isFinite(Number(settings.access_grace_days)) ? Number(settings.access_grace_days) : 3;
  const syncEnabled = settings.access_sync_enabled !== 0;
  const { desired, reason } = await desiredAccessFor(db, mapping, { graceDays, now, tz });

  const provider = mapping.provider_id
    ? await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [mapping.provider_id, mapping.org_id])
    : null;
  const config = safeParse(provider?.config_json) || {};
  const adapter = provider ? getProvider(provider.provider_key) : null;
  const caps = effectiveCapabilities(adapter, config);
  const pushable = !!adapter && provider.status !== 'DISABLED' && caps.supportsAccessPermissionSync;

  let accessStatus = mapping.access_status;
  let syncStatus = mapping.sync_status;
  let syncError = mapping.sync_error;
  let pushed = false;
  let message = null;

  // The device already has what it should: nothing to push unless forced.
  const deviceHasDesired = mapping.access_status === desired && mapping.sync_status === 'OK';

  if (!pushable) {
    accessStatus = 'NOT_SUPPORTED';
    syncStatus = 'NEVER';
    message = desired === 'DENIED'
      ? 'This connection cannot be updated from SK OS. Remove this person at the device.'
      : null;
  } else if (!syncEnabled) {
    // Automatic sync is off: say what SHOULD happen, do not do it.
    if (!deviceHasDesired) { accessStatus = 'MANUAL_REVIEW'; message = 'Automatic access sync is off for this gym.'; }
  } else if (!deviceHasDesired || force) {
    try {
      const res = await adapter.updateAccessPermission(
        { db, orgId: mapping.org_id, provider: { ...provider, config } },
        { externalUserId: mapping.external_user_id, allowed: desired === 'ALLOWED' });
      if (res?.ok) {
        accessStatus = desired; syncStatus = 'OK'; syncError = null; pushed = true;
        message = res.message || null;
      } else {
        // The device keeps whatever it had. SYNC_FAILED says so.
        accessStatus = 'SYNC_FAILED'; syncStatus = 'FAILED';
        syncError = String(res?.message || 'The provider refused the update.').slice(0, 300);
        message = syncError;
      }
    } catch (e) {
      accessStatus = 'SYNC_FAILED'; syncStatus = 'FAILED';
      syncError = String(e?.message || 'Could not reach the provider.').slice(0, 300);
      message = syncError;
    }
  }

  const changed = mapping.desired_access !== desired || mapping.access_status !== accessStatus
    || mapping.sync_status !== syncStatus;

  if (changed || pushed) {
    /* Computed here rather than with `CASE WHEN ? THEN` in SQL: SQLite
       accepts an integer parameter as a boolean and Postgres rejects it
       ("argument of CASE/WHEN must be type boolean"), so the SQL version
       passed every local test and would have failed on the first
       production sync. */
    const ts = nowIso();
    const lastSyncedAt = pushed ? ts : mapping.last_synced_at;
    const revokedAt = accessStatus === 'DENIED' && pushed ? ts
      : accessStatus === 'ALLOWED' ? null : mapping.revoked_at;
    await db.run(
      `UPDATE access_member_mappings
          SET desired_access = ?, access_status = ?, sync_status = ?, sync_error = ?,
              last_synced_at = ?, revoked_at = ?, updated_at = ?
        WHERE id = ?`,
      [desired, accessStatus, syncStatus, syncError, lastSyncedAt, revokedAt, ts, mapping.id]);
  }

  // Audit only real transitions. Re-evaluating an unchanged member every
  // tick must not bury the log.
  if (mapping.desired_access !== desired || pushed || (changed && accessStatus === 'SYNC_FAILED')) {
    await writeAudit(db, {
      orgId: mapping.org_id, actorUserId,
      action: pushed ? 'access.permission.pushed' : 'access.permission.evaluated',
      entityType: 'user', entityId: mapping.user_id,
      reason,
      before: { desired: mapping.desired_access, accessStatus: mapping.access_status },
      after: { desired, accessStatus, pushed },
      result: accessStatus === 'SYNC_FAILED' ? 'FAILED' : 'OK',
    });
  }

  return { desired, accessStatus, pushed, changed, message, reason };
}

/**
 * Re-evaluate every mapping in a gym. Bounded, so it fits in a request;
 * members whose push failed are retried first.
 */
export async function evaluateOrgAccess(db, orgId, { settings = null, limit = 300, now = new Date(), actorUserId = null, tz = DEFAULT_TZ } = {}) {
  const s = settings || (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [orgId])) || {};
  const mappings = await db.q(
    `SELECT * FROM access_member_mappings WHERE org_id = ?
      ORDER BY CASE access_status WHEN 'SYNC_FAILED' THEN 0 WHEN 'PENDING_SYNC' THEN 1 ELSE 2 END, updated_at
      LIMIT ?`, [orgId, limit]);
  const summary = { evaluated: 0, pushed: 0, failed: 0, notSupported: 0, denied: 0, changed: 0 };
  for (const m of mappings) {
    const r = await syncMapping(db, m, { settings: s, now, actorUserId, tz });
    summary.evaluated += 1;
    if (r.pushed) summary.pushed += 1;
    if (r.accessStatus === 'SYNC_FAILED') summary.failed += 1;
    if (r.accessStatus === 'NOT_SUPPORTED') summary.notSupported += 1;
    if (r.desired === 'DENIED') summary.denied += 1;
    if (r.changed) summary.changed += 1;
  }
  return summary;
}

/** A human decision that beats the membership rule. `access: null` clears it. */
export async function setOverride(db, { orgId, mappingId, access, reason, actorUserId, actorRole }) {
  const m = await db.q1('SELECT * FROM access_member_mappings WHERE id = ? AND org_id = ?', [mappingId, orgId]);
  if (!m) return null;
  await db.run(
    `UPDATE access_member_mappings
        SET override_access = ?, override_reason = ?, override_by = ?, override_at = ?, updated_at = ?
      WHERE id = ?`,
    [access, access ? reason : null, access ? actorUserId : null, access ? nowIso() : null, nowIso(), m.id]);
  await writeAudit(db, {
    orgId, actorUserId, actorRole,
    action: access ? 'access.permission.overridden' : 'access.permission.override_cleared',
    entityType: 'user', entityId: m.user_id, reason: reason || null,
    before: { override: m.override_access }, after: { override: access },
  });
  const fresh = await db.q1('SELECT * FROM access_member_mappings WHERE id = ?', [m.id]);
  const settings = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [orgId])) || {};
  return syncMapping(db, fresh, { settings, actorUserId });
}

export default { membershipAllowsAccess, desiredAccessFor, syncMapping, evaluateOrgAccess, setOverride };
