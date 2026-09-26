// ============================================================
// INGESTION — the one door every access event comes through.
//
// Webhook, poller, CSV import, manual correction and the demo provider
// all call ingestAccessEvent. There is deliberately no second path: the
// dedup key, the identity lookup, the presence state machine and the
// audit trail are the parts that are easy to get subtly wrong, and having
// them in one place is what stops a future vendor adapter from
// accidentally shipping its own slightly-different version.
//
// THE EVENT IS RECORDED EVEN WHEN IT CHANGES NOTHING. A duplicate, an
// unrecognised person, a refused card -- each is stored with the reason
// it did not move occupancy. That is what makes the owner's
// reconciliation queue possible, and it is the difference between "the
// count looks wrong" and "here are the fourteen events that explain why".
//
// BIOMETRIC BOUNDARY: this module accepts an opaque `externalUserId` that
// the vendor assigned, and nothing else about the person. Raw payloads
// are stored only after being passed through redactPayload, which drops
// any field whose name suggests a template, image or credential.
// ============================================================
import { randomUUID } from 'node:crypto';
import { applyAccessEvent, parseInstant } from './presence.js';
import { writeAudit } from './audit.js';

const nowIso = () => new Date().toISOString();

/* Field names we refuse to persist even if a vendor sends them. Matched
   loosely on purpose -- the cost of dropping a field we could have kept
   is nothing; the cost of storing a fingerprint template is the whole
   privacy promise of this feature. */
const FORBIDDEN_FIELD = /(finger|biometr|template|minutia|face[_-]?(data|image|template|embedding)|iris|palm|vein|photo|image|base64|password|secret|token|api[_-]?key)/i;

/** Strip anything that looks like biometric or credential material. */
export function redactPayload(payload, depth = 0) {
  if (payload == null || depth > 4) return null;
  if (Array.isArray(payload)) return payload.slice(0, 50).map((v) => redactPayload(v, depth + 1));
  if (typeof payload !== 'object') {
    // A very long string in a payload is the shape a base64 template
    // arrives in. Truncated rather than kept.
    return typeof payload === 'string' && payload.length > 512 ? `${payload.slice(0, 64)}…[truncated]` : payload;
  }
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (FORBIDDEN_FIELD.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = redactPayload(v, depth + 1);
  }
  return out;
}

/**
 * Resolve an external identity to a person.
 *
 * Returns { userId, clientId, mapping } or nulls. A miss is not an error:
 * the event is kept as UNMATCHED so an owner can map the person later and
 * so the gym can see how many scans it is failing to attribute.
 */
export async function resolveMember(db, { orgId, providerId, externalUserId }) {
  if (!externalUserId) return { userId: null, clientId: null, mapping: null };
  const mapping = await db.q1(
    `SELECT * FROM access_member_mappings
      WHERE org_id = ? AND external_user_id = ? AND (provider_id = ? OR provider_id IS NULL)
      ORDER BY CASE WHEN provider_id = ? THEN 0 ELSE 1 END
      LIMIT 1`,
    [orgId, String(externalUserId), providerId || null, providerId || null]);
  if (!mapping) return { userId: null, clientId: null, mapping: null };
  return { userId: mapping.user_id || null, clientId: mapping.client_id || null, mapping };
}

/**
 * What does this event mean, given the device it came from?
 *
 * A single-direction reader does not need to say: an "entry turnstile"
 * event IS an entry. A both-direction device that omits the direction is
 * genuinely ambiguous and becomes UNKNOWN rather than being guessed --
 * guessing is how a gym ends up with an occupancy that only ever rises.
 */
export function resolveEventType(rawType, device) {
  const t = String(rawType || '').toUpperCase();
  if (t === 'ENTRY' || t === 'IN' || t === 'CHECK_IN' || t === 'CHECKIN') return 'ENTRY';
  if (t === 'EXIT' || t === 'OUT' || t === 'CHECK_OUT' || t === 'CHECKOUT') return 'EXIT';
  if (t === 'DENIED' || t === 'REJECTED' || t === 'FAILED') return 'DENIED';
  if (device?.direction === 'entry') return 'ENTRY';
  if (device?.direction === 'exit') return 'EXIT';
  return 'UNKNOWN';
}

/**
 * Ingest one normalized event.
 *
 * @returns {{ status, eventId, outcome, duplicate, occupancyDelta }}
 */
export async function ingestAccessEvent(db, {
  orgId,
  providerId = null,
  deviceIdentifier = null,
  deviceId = null,
  branchId = null,
  externalUserId = null,
  externalEventId = null,
  eventType,
  occurredAt,
  verificationStatus = 'unverified',
  source = 'webhook',
  payload = null,
  actorUserId = null,
}) {
  const receivedAt = nowIso();
  const at = parseInstant(occurredAt);

  /* An event with no usable timestamp cannot be ordered, and ordering is
     the whole basis of the state machine. Recorded as REJECTED so it
     shows up in the owner's queue rather than vanishing. */
  if (!at) {
    const id = randomUUID();
    await db.run(
      `INSERT INTO access_events (id, org_id, branch_id, provider_id, device_id, external_user_id, external_event_id,
         event_type, occurred_at, received_at, verification_status, source, processing_status, error_reason,
         affected_occupancy, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'REJECTED',?,0,?,?)`,
      [id, orgId, branchId, providerId, deviceId, externalUserId, externalEventId,
        'UNKNOWN', receivedAt, receivedAt, verificationStatus, source,
        'unparseable timestamp', JSON.stringify(redactPayload(payload)), receivedAt]);
    return { status: 'rejected', eventId: id, outcome: 'invalid', duplicate: false, occupancyDelta: 0 };
  }

  // Resolve the device from the vendor's identifier when we were not
  // handed one directly. An unknown device is not fatal -- the event is
  // still real -- but it is worth surfacing.
  let device = null;
  if (deviceId) {
    device = await db.q1('SELECT * FROM access_devices WHERE id = ? AND org_id = ?', [deviceId, orgId]);
  } else if (deviceIdentifier) {
    device = await db.q1('SELECT * FROM access_devices WHERE org_id = ? AND device_identifier = ?',
      [orgId, String(deviceIdentifier)]);
  }
  const resolvedDeviceId = device?.id || null;
  // A device knows which branch it is bolted to; that beats whatever the
  // payload claims, because the payload is the thing that gets mis-
  // configured.
  const resolvedBranchId = device?.branch_id ?? branchId ?? null;

  const type = resolveEventType(eventType, device);

  /* IDEMPOTENCY. Providers retry, and a retry must never move the count.
     Checked before insert so the common case is a cheap read, and backed
     by a unique index so a genuinely concurrent redelivery still cannot
     get through. */
  if (externalEventId) {
    const existing = await db.q1(
      `SELECT id, processing_status FROM access_events
        WHERE org_id = ? AND external_event_id = ? AND (provider_id = ? OR (provider_id IS NULL AND ? IS NULL))`,
      [orgId, String(externalEventId), providerId, providerId]);
    if (existing) {
      return { status: 'duplicate', eventId: existing.id, outcome: 'duplicate_event', duplicate: true, occupancyDelta: 0 };
    }
  }

  const { userId, clientId } = await resolveMember(db, { orgId, providerId, externalUserId });
  const eventId = randomUUID();

  /* THE EVENT ROW IS WRITTEN FIRST, then processed.
     Not a style choice: gym_presence_sessions.entry_event_id references
     access_events(id), so creating the session first fails the foreign
     key outright. Recording before processing is also what makes the
     dedup index do the work -- a concurrent redelivery loses the INSERT
     race here, before any presence change exists to undo, so there is no
     window in which a phantom session can be observed. */
  try {
    await db.run(
      `INSERT INTO access_events (id, org_id, branch_id, provider_id, device_id, external_user_id, external_event_id,
         user_id, client_id, event_type, occurred_at, received_at, verification_status, source,
         processing_status, affected_occupancy, payload_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',0,?,?)`,
      [eventId, orgId, resolvedBranchId, providerId, resolvedDeviceId, externalUserId, externalEventId,
        userId, clientId, type, at, receivedAt, verificationStatus, source,
        JSON.stringify(redactPayload(payload)), receivedAt]);
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(String(e?.message || ''))) {
      const existing = await db.q1(
        'SELECT id FROM access_events WHERE org_id = ? AND external_event_id = ?',
        [orgId, String(externalEventId)]);
      return { status: 'duplicate', eventId: existing?.id || null, outcome: 'duplicate_event', duplicate: true, occupancyDelta: 0 };
    }
    throw e;
  }

  const result = await applyAccessEvent(db, {
    id: eventId, orgId, branchId: resolvedBranchId, userId, clientId,
    eventType: type, occurredAt: at,
    // Tagged on the SESSION, not just the event: occupancy counts sessions.
    isDemo: source === 'demo',
  });

  const processing = {
    entered: 'PROCESSED',
    exited: 'PROCESSED',
    duplicate_entry: 'IGNORED_DUPLICATE',
    duplicate_exit: 'IGNORED_DUPLICATE',
    denied: 'PROCESSED',
    unmatched: 'UNMATCHED',
    invalid: 'REJECTED',
  }[result.outcome] || 'ERROR';

  await db.run(
    `UPDATE access_events SET processing_status = ?, error_reason = ?, affected_occupancy = ? WHERE id = ?`,
    [processing, result.reason || null, result.affectedOccupancy || 0, eventId]);

  // Devices are considered alive because they spoke, not because they
  // were configured.
  if (resolvedDeviceId) {
    await db.run('UPDATE access_devices SET last_seen_at = ?, last_event_at = ?, updated_at = ? WHERE id = ?',
      [receivedAt, at, receivedAt, resolvedDeviceId]);
  }
  if (providerId) {
    await db.run('UPDATE access_providers SET last_event_at = ?, updated_at = ? WHERE id = ?',
      [at, receivedAt, providerId]);
  }

  // Manual events are somebody's decision and are audited as such.
  // Machine traffic is not: an audit row per door scan would bury the
  // entries that actually need review under a million that do not.
  if (source === 'manual') {
    await writeAudit(db, {
      orgId, actorUserId, action: 'access.event.manual',
      entityType: 'access_event', entityId: eventId, branchId: resolvedBranchId,
      after: { eventType: type, occurredAt: at, userId, outcome: result.outcome },
    });
  }

  return {
    status: 'accepted',
    eventId,
    outcome: result.outcome,
    duplicate: result.outcome.startsWith('duplicate'),
    occupancyDelta: result.affectedOccupancy || 0,
    processingStatus: processing,
  };
}

/**
 * Give unmatched scans a second chance, once their person is mapped.
 *
 * This is the other half of "keep unknown events for reconciliation": an
 * event stored as UNMATCHED is a real arrival we could not attribute, and
 * the moment an owner maps that card to a member it becomes attributable.
 * Processed in occurred_at order, so an entry and the exit that followed it
 * replay as a visit rather than as an exit with nobody inside.
 *
 * Old arrivals replayed now can open sessions that the stale-session sweep
 * will then close as estimated -- which is correct: we know when they came
 * in, and we still do not know when they left.
 */
export async function reprocessUnmatched(db, orgId, { limit = 500, externalUserId = null } = {}) {
  const rows = externalUserId
    ? await db.q(`SELECT * FROM access_events WHERE org_id = ? AND processing_status = 'UNMATCHED'
                    AND external_user_id = ? ORDER BY occurred_at LIMIT ?`, [orgId, externalUserId, limit])
    : await db.q(`SELECT * FROM access_events WHERE org_id = ? AND processing_status = 'UNMATCHED'
                    ORDER BY occurred_at LIMIT ?`, [orgId, limit]);
  const summary = { examined: rows.length, matched: 0, stillUnmatched: 0 };
  for (const e of rows) {
    const { userId, clientId } = await resolveMember(db, { orgId, providerId: e.provider_id, externalUserId: e.external_user_id });
    if (!userId) { summary.stillUnmatched += 1; continue; }
    const result = await applyAccessEvent(db, {
      id: e.id, orgId, branchId: e.branch_id, userId, clientId,
      eventType: e.event_type, occurredAt: e.occurred_at, isDemo: e.source === 'demo',
    });
    const processing = {
      entered: 'PROCESSED', exited: 'PROCESSED', denied: 'PROCESSED',
      duplicate_entry: 'IGNORED_DUPLICATE', duplicate_exit: 'IGNORED_DUPLICATE',
      unmatched: 'UNMATCHED', invalid: 'REJECTED',
    }[result.outcome] || 'ERROR';
    await db.run(
      `UPDATE access_events SET user_id = ?, client_id = ?, processing_status = ?, error_reason = ?, affected_occupancy = ?
        WHERE id = ?`,
      [userId, clientId, processing, result.reason || null, result.affectedOccupancy || 0, e.id]);
    summary.matched += 1;
  }
  return summary;
}

export default { ingestAccessEvent, resolveMember, resolveEventType, redactPayload, reprocessUnmatched };
