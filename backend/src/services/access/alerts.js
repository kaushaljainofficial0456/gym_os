// ============================================================
// OWNER ALERTS — what needs a human, derived from what is true now.
//
// Every alert here is computed from the current state of devices,
// providers, events, sessions and access mappings. None is a guess, and
// each carries the numbers that raised it so an owner can check them.
//
// Evaluation is idempotent: the same condition upserts the same row
// (keyed by alert_key), so re-evaluating every minute does not produce a
// thousand "device offline" rows. When a condition clears, its row is
// RESOLVED automatically -- an owner should not have to dismiss an alert
// about a door that has already come back. An acknowledged alert stays
// acknowledged until it resolves; acknowledging means "I know", not
// "it is fixed".
// ============================================================
import { randomUUID } from 'node:crypto';
import { dayKey, DEFAULT_TZ } from '../../utils/time.js';

const nowIso = () => new Date().toISOString();
const minsAgo = (m, now) => new Date(now.getTime() - m * 60_000).toISOString();

/** Current conditions, as [{ key, kind, severity, title, detail, entityType, entityId }]. */
export async function detectConditions(db, orgId, { settings = {}, crowd = null, now = new Date(), tz = DEFAULT_TZ } = {}) {
  const out = [];
  /* The gym's today. The rest of this feature buckets by the gym's
     calendar (see analytics.js), so counting "unmatched scans today"
     against the UTC date would put the same events in a different day
     from the chart the owner is reading them next to. */
  const today = dayKey(now, tz);

  // Devices that have spoken before and have gone quiet. A device that
  // has NEVER spoken is "not set up yet", which is a different message.
  const devices = await db.q(
    `SELECT id, device_name, last_seen_at FROM access_devices
      WHERE org_id = ? AND status = 'ACTIVE' AND last_seen_at IS NOT NULL AND last_seen_at < ?`,
    [orgId, minsAgo(30, now)]);
  for (const d of devices) {
    const mins = Math.round((now - Date.parse(d.last_seen_at)) / 60000);
    out.push({
      key: `device_offline:${d.id}`, kind: 'device_offline', severity: mins > 240 ? 'critical' : 'warning',
      title: `${d.device_name} has gone quiet`,
      detail: `No activity for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}. Occupancy from this door may be out of date.`,
      entityType: 'access_device', entityId: d.id,
    });
  }

  // Connections whose last test failed.
  const broken = await db.q(
    `SELECT id, display_name, last_test_error FROM access_providers
      WHERE org_id = ? AND status = 'ERROR' AND provider_key != 'demo'`, [orgId]);
  for (const p of broken) {
    out.push({
      key: `provider_error:${p.id}`, kind: 'provider_error', severity: 'critical',
      title: `${p.display_name} is not working`,
      detail: p.last_test_error || 'The last connection test failed.',
      entityType: 'access_provider', entityId: p.id,
    });
  }

  // Webhook signature failures in the last hour. Three is the threshold:
  // one is a misconfigured test, a stream of them is either a broken
  // integration or someone probing the endpoint.
  const rejected = await db.q(
    `SELECT entity_id, COUNT(*) AS n FROM access_audit_logs
      WHERE org_id = ? AND action = 'access.webhook.rejected' AND created_at >= ?
      GROUP BY entity_id`, [orgId, minsAgo(60, now)]);
  for (const r of rejected) {
    if (Number(r.n) < 3) continue;
    out.push({
      key: `webhook_rejections:${r.entity_id}`, kind: 'webhook_rejected', severity: 'warning',
      title: 'Webhook requests are being rejected',
      detail: `${r.n} requests failed signature checks in the last hour. Check the signing secret on your access system.`,
      entityType: 'access_provider', entityId: r.entity_id,
    });
  }

  // Scans we could not attribute today.
  const unmatched = await db.q1(
    `SELECT COUNT(*) AS n FROM access_events
      WHERE org_id = ? AND processing_status = 'UNMATCHED' AND source != 'demo' AND substr(occurred_at, 1, 10) = ?`,
    [orgId, today]);
  if (Number(unmatched?.n) >= 5) {
    out.push({
      key: 'unmatched_events', kind: 'unmatched_events', severity: 'warning',
      title: `${unmatched.n} scans today could not be matched to a member`,
      detail: 'They are recorded but not counted in occupancy. Map the access IDs to members, then reprocess.',
    });
  }

  // People still marked inside long after they plausibly left.
  const hours = Number(settings.access_auto_close_hours) || 12;
  const stale = await db.q1(
    `SELECT COUNT(*) AS n FROM gym_presence_sessions
      WHERE org_id = ? AND status = 'OPEN' AND is_demo = 0 AND entered_at < ?`, [orgId, minsAgo(hours * 60, now)]);
  if (Number(stale?.n) > 0) {
    out.push({
      key: 'stale_sessions', kind: 'stale_sessions', severity: 'warning',
      title: `${stale.n} ${Number(stale.n) === 1 ? 'person is' : 'people are'} still marked inside after ${hours} hours`,
      detail: 'They probably left without scanning out. Close the sessions so occupancy is accurate.',
    });
  }

  // Capacity. Only when the number is live -- warning an owner their gym
  // is full on the strength of a six-hour-old count is its own problem.
  if (crowd?.crowd && crowd?.freshness?.isLive) {
    if (crowd.crowd.status === 'over_capacity') {
      out.push({
        key: 'capacity_full', kind: 'capacity', severity: 'critical',
        title: 'The gym is at or over capacity',
        detail: crowd.crowd.description,
      });
    } else if (crowd.crowd.status === 'very_busy') {
      out.push({
        key: 'capacity_high', kind: 'capacity', severity: 'warning',
        title: 'The gym is very busy',
        detail: crowd.crowd.description,
      });
    }
  }

  // Access sync failures.
  const failed = await db.q1(
    "SELECT COUNT(*) AS n FROM access_member_mappings WHERE org_id = ? AND access_status = 'SYNC_FAILED'", [orgId]);
  if (Number(failed?.n) > 0) {
    out.push({
      key: 'access_sync_failed', kind: 'access_sync', severity: 'warning',
      title: `Access could not be updated for ${failed.n} ${Number(failed.n) === 1 ? 'member' : 'members'}`,
      detail: 'The access system refused or did not answer. Their door access is unchanged; SK OS will retry.',
    });
  }

  // Lapsed members whose access SK OS cannot revoke itself. Excludes demo
  // connections: nobody needs to walk to a simulated door.
  const manual = await db.q1(
    `SELECT COUNT(*) AS n FROM access_member_mappings m
       LEFT JOIN access_providers p ON p.id = m.provider_id
      WHERE m.org_id = ? AND m.desired_access = 'DENIED' AND m.access_status IN ('NOT_SUPPORTED','MANUAL_REVIEW')
        AND COALESCE(p.provider_key, '') != 'demo'`, [orgId]);
  if (Number(manual?.n) > 0) {
    out.push({
      key: 'access_revoke_manual', kind: 'access_sync', severity: 'warning',
      title: `${manual.n} ${Number(manual.n) === 1 ? 'member has' : 'members have'} a lapsed membership but may still open the door`,
      detail: 'Your access system cannot be updated from SK OS. Remove them at the device.',
    });
  }

  // Someone SK OS thinks should be denied got in today.
  const lapsedEntry = await db.q1(
    `SELECT COUNT(DISTINCT e.user_id) AS n FROM access_events e
       JOIN access_member_mappings m ON m.user_id = e.user_id AND m.org_id = e.org_id
      WHERE e.org_id = ? AND e.event_type = 'ENTRY' AND e.affected_occupancy = 1 AND e.source != 'demo'
        AND m.desired_access = 'DENIED' AND substr(e.occurred_at, 1, 10) = ?`, [orgId, today]);
  if (Number(lapsedEntry?.n) > 0) {
    out.push({
      key: 'lapsed_member_entered', kind: 'access_sync', severity: 'warning',
      title: `${lapsedEntry.n} ${Number(lapsedEntry.n) === 1 ? 'member' : 'members'} with a lapsed membership came in today`,
      detail: 'They are counted in occupancy -- they are physically inside -- but their membership has ended.',
    });
  }

  return out;
}

/** Upsert current conditions, resolve the ones that cleared. */
export async function evaluateAlerts(db, orgId, opts = {}) {
  const now = opts.now || new Date();
  const conditions = await detectConditions(db, orgId, { ...opts, now });
  const live = await db.q("SELECT * FROM access_alerts WHERE org_id = ? AND status != 'RESOLVED'", [orgId]);
  const byKey = new Map(live.map((a) => [a.alert_key, a]));
  const ts = nowIso();
  const seen = new Set();

  for (const c of conditions) {
    seen.add(c.key);
    const existing = byKey.get(c.key);
    if (existing) {
      await db.run(
        `UPDATE access_alerts SET severity = ?, title = ?, detail = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
        [c.severity, c.title, c.detail || null, ts, ts, existing.id]);
    } else {
      try {
        await db.run(
          `INSERT INTO access_alerts (id, org_id, alert_key, kind, severity, title, detail, entity_type, entity_id,
             status, first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?)`,
          [randomUUID(), orgId, c.key, c.kind, c.severity, c.title, c.detail || null,
            c.entityType || null, c.entityId || null, ts, ts, ts, ts]);
      } catch (e) {
        // A concurrent evaluation inserted it first; the unique index is
        // doing its job.
        if (!/UNIQUE|duplicate key/i.test(String(e?.message || ''))) throw e;
      }
    }
  }
  for (const a of live) {
    if (!seen.has(a.alert_key)) {
      await db.run(
        "UPDATE access_alerts SET status = 'RESOLVED', resolved_at = ?, updated_at = ? WHERE id = ?", [ts, ts, a.id]);
    }
  }
  return listAlerts(db, orgId);
}

export async function listAlerts(db, orgId, { includeResolved = false, limit = 50 } = {}) {
  const rows = await db.q(
    `SELECT a.*, u.name AS acknowledged_by_name FROM access_alerts a
       LEFT JOIN users u ON u.id = a.acknowledged_by
      WHERE a.org_id = ? ${includeResolved ? '' : "AND a.status != 'RESOLVED'"}
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.last_seen_at DESC
      LIMIT ?`, [orgId, limit]);
  return rows.map((a) => ({
    id: a.id, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail,
    entityType: a.entity_type, entityId: a.entity_id, status: a.status,
    firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at,
    acknowledgedBy: a.acknowledged_by_name || null, acknowledgedAt: a.acknowledged_at,
    resolvedAt: a.resolved_at,
  }));
}

export async function acknowledgeAlert(db, orgId, id, userId) {
  const r = await db.run(
    `UPDATE access_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND org_id = ? AND status = 'OPEN'`, [userId, nowIso(), nowIso(), id, orgId]);
  return r.changes > 0;
}

export default { detectConditions, evaluateAlerts, listAlerts, acknowledgeAlert };
