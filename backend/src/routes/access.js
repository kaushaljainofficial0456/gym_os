// ============================================================
// ACCESS CONTROL — the owner's API.
//
// Mounted at /api/admin/access (owner workspace) with one deliberate
// exception: the inbound webhook at /api/access/hook/:providerId, which
// is public by necessity and authenticated by HMAC signature instead of a
// session.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. ORG SCOPE ON EVERY QUERY. Every statement here carries org_id, and
//      every :id is re-read with an org_id filter rather than trusted from
//      the URL. A route that fetches by id alone is one guessed uuid away
//      from showing one gym another gym's door log.
//
//   2. SECRETS GO IN, NEVER OUT. No response in this file contains a
//      credential. The owner sees the last four characters and when it was
//      rotated; if they lose the value they rotate it, which is what they
//      would have to do after it had been on a screen anyway.
//
//   3. NOTHING IS CLAIMED THAT WAS NOT DONE. Test Connection reports what
//      the provider actually said, including "ready but no event has ever
//      arrived" -- which is a failure, because an owner who believes a
//      silent integration is working will not find out until they need
//      the data.
// ============================================================
import { Router } from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { requirePermission } from '../permissions.js';
import { rateLimit } from '../rateLimit.js';
import { getCrowdStatus, getFreshness } from '../services/crowdStatus.js';
import {
  liveOccupancy, demoOccupancy, occupancyByBranch, staleSessions, reconcileStaleSessions, closeSession,
} from '../services/access/presence.js';
import { ingestAccessEvent } from '../services/access/ingest.js';
import { writeAudit, listAudit } from '../services/access/audit.js';
import { storeSecret, describeSecrets } from '../services/access/secrets.js';
import { listProviders, getProvider, invoke, effectiveCapabilities } from '../services/access/providers/index.js';
import { reprocessUnmatched } from '../services/access/ingest.js';
import { createJob, runChunk, getJob, listJobs, retryJob, cancelJob, parseCsv } from '../services/access/jobs.js';
import { syncMapping, evaluateOrgAccess, setOverride } from '../services/access/membershipSync.js';
import { evaluateAlerts, listAlerts, acknowledgeAlert } from '../services/access/alerts.js';
import { hourlyAnalytics, maybeSnapshot, tallyToday } from '../services/access/analytics.js';
import { validHhmm } from '../services/access/localTime.js';
import { maybeTick, runAllOrgs, cronAuthorized } from '../services/access/tick.js';
import { liveCrowd } from '../services/access/liveCrowd.js';
import { readSecret } from '../services/access/secrets.js';
import { createHmac } from 'node:crypto';
import { assertSafeUrl as checkUrl } from '../services/access/safeUrl.js';
import '../services/access/providers/builtin.js';   // registers the adapters

const nowIso = () => new Date().toISOString();
const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* The SSRF guard lives in services/access/safeUrl.js now, because the
   adapters have to re-check at call time too (config can be edited after
   it is saved). Re-exported so existing callers and tests keep working. */
export { assertSafeUrl } from '../services/access/safeUrl.js';

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/** Everything an owner may see about a connection. Note what is absent. */
function publicProvider(row, secrets = [], adapter = null) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    name: row.display_name,
    branchId: row.branch_id,
    status: row.status,
    authType: row.auth_type,
    config: safeParse(row.config_json),
    // Per CONNECTION: a REST connection with no permission URL cannot push
    // access changes, and the UI renders controls from exactly this.
    capabilities: adapter ? effectiveCapabilities(adapter, safeParse(row.config_json) || {}) : (safeParse(row.capabilities_json) || {}),
    lastPolledAt: row.last_polled_at || null,
    // ↓ the only thing ever said about a credential
    secrets,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok == null ? null : !!row.last_test_ok,
    lastTestError: row.last_test_error,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
  };
}

export default function accessRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER'), orgScope);

  /**
   * THE ROLE THAT MATTERS HERE IS THE PER-GYM ONE.
   *
   * `users.role` -- which is what signToken puts in the JWT -- can only be
   * SUPER_ADMIN, GYM_OWNER, TRAINER or CLIENT; the schema's CHECK
   * constraint says so, deliberately (see gym_memberships' header: new
   * per-gym roles were added as a new table rather than by widening a
   * CHECK on a live column). MANAGER and STAFF therefore exist ONLY in
   * gym_memberships, and never arrive in req.user.role.
   *
   * Gating these routes on requireRole('MANAGER') would have been a gate
   * that can never open -- it would read as though front-desk staff were
   * supported while denying every one of them. So the effective role for
   * THIS gym is resolved here, from gym_memberships when a row exists and
   * from the JWT otherwise, and the permission checks run against that.
   *
   * Deliberately local to this feature rather than pushed into the shared
   * auth middleware: changing what req.user.role means globally would
   * touch every route in the product, and that is not a change to make as
   * a side effect of building access control.
   */
  r.use(async (req, res, next) => {
    try {
      const membership = await db.q1(
        `SELECT role FROM gym_memberships
          WHERE user_id = ? AND org_id = ? AND status = 'ACTIVE'
          ORDER BY created_at LIMIT 1`, [req.user?.sub, req.orgId]);
      // The JWT role stays the floor: a gym cannot grant someone more
      // than their account role by adding a membership row, and an owner
      // does not lose ownership by not having one.
      req.accessRole = req.user?.role === 'GYM_OWNER' ? 'GYM_OWNER' : (membership?.role || req.user?.role);
      next();
    } catch (e) { next(e); }
  });

  const can = (permission) => (req, res, next) =>
    requirePermission(permission)({ ...req, user: { ...req.user, role: req.accessRole } }, res, next);

  const readable = can('access.view');
  const manageable = can('access.manage');
  const connectable = can('access.connect');

  const actor = (req) => ({ actorUserId: req.user?.sub, actorRole: req.user?.role });

  /* ── catalogue ─────────────────────────────────────────────────── */

  // What can be connected, and honestly what each one can do. The five
  // vendor entries come back with implemented:false so the UI can show
  // them as recognised-but-not-built rather than offering a dead button.
  r.get('/providers/catalogue', readable, (_req, res) => {
    res.json({ providers: listProviders() });
  });

  /* ── connections ───────────────────────────────────────────────── */

  r.get('/providers', readable, async (req, res) => {
    const rows = await db.q('SELECT * FROM access_providers WHERE org_id = ? ORDER BY created_at', [req.orgId]);
    const out = [];
    for (const row of rows) {
      out.push(publicProvider(row, await describeSecrets(db, row.id), getProvider(row.provider_key)));
    }
    res.json({ providers: out });
  });

  const connectSchema = z.object({
    providerKey: z.string().min(1).max(60),
    displayName: z.string().min(1).max(80),
    branchId: z.string().max(40).nullish(),
    config: z.record(z.any()).optional(),
    secrets: z.record(z.string().min(1).max(4096)).optional(),
  });

  r.post('/providers', connectable, async (req, res, next) => {
    try {
      const body = connectSchema.parse(req.body);
      const adapter = getProvider(body.providerKey);
      if (!adapter) return res.status(404).json({ error: 'Unknown provider.' });
      // The rule from the spec: never offer what does not exist.
      if (adapter.implemented === false) {
        return res.status(400).json({
          error: `SK OS does not ship a ${adapter.name} adapter yet. `
            + 'Connect it as a Webhook or REST provider instead.',
          code: 'adapter_not_implemented',
        });
      }
      if (body.branchId) {
        const b = await db.q1('SELECT id FROM branches WHERE id = ? AND org_id = ?', [body.branchId, req.orgId]);
        if (!b) return res.status(400).json({ error: 'That branch does not belong to this gym.' });
      }
      const config = { ...(body.config || {}) };
      for (const k of ['baseUrl', 'permissionUrl']) if (config[k]) config[k] = checkUrl(config[k]);

      const id = randomUUID();
      const ts = nowIso();
      await db.run(
        `INSERT INTO access_providers
           (id, org_id, branch_id, provider_key, display_name, status, auth_type, config_json, capabilities_json, created_at, updated_at)
         VALUES (?,?,?,?,?,'CONFIGURED',?,?,?,?,?)`,
        [id, req.orgId, body.branchId || null, body.providerKey, body.displayName,
          adapter.authType || 'none', JSON.stringify(config),
          JSON.stringify(adapter.capabilities), ts, ts]);

      /* A webhook provider needs a signing secret to be usable at all, so
         one is generated rather than asked for -- an owner typing their
         own would type a weak one. Returned EXACTLY ONCE, in this
         response, and never again from any endpoint. */
      let generatedSecret = null;
      if (adapter.capabilities.supportsWebhooks) {
        generatedSecret = randomBytes(32).toString('hex');
        await storeSecret(db, { orgId: req.orgId, providerId: id, kind: 'webhook_secret', value: generatedSecret });
      }
      for (const [kind, value] of Object.entries(body.secrets || {})) {
        await storeSecret(db, { orgId: req.orgId, providerId: id, kind, value });
      }

      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.provider.connected',
        entityType: 'access_provider', entityId: id,
        after: { providerKey: body.providerKey, name: body.displayName, branchId: body.branchId || null },
      });

      const row = await db.q1('SELECT * FROM access_providers WHERE id = ?', [id]);
      res.status(201).json({
        provider: publicProvider(row, await describeSecrets(db, id), adapter),
        webhookUrl: adapter.capabilities.supportsWebhooks ? `/api/access/hook/${id}` : null,
        // Shown once, with that fact stated plainly in the UI.
        signingSecretShownOnce: generatedSecret,
      });
    } catch (e) { next(e); }
  });

  r.post('/providers/:id/test', connectable, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      const adapter = getProvider(row.provider_key);
      if (!adapter?.capabilities?.supportsTestConnection) {
        return res.status(400).json({ error: 'This provider cannot be tested from here.', code: 'capability_unsupported' });
      }
      const ctx = { db, orgId: req.orgId, provider: { ...row, config: safeParse(row.config_json) } };
      let result;
      try {
        result = await invoke(row.provider_key, 'supportsTestConnection', 'testConnection', ctx);
      } catch (e) {
        result = { ok: false, message: e?.message || 'The test could not be completed.' };
      }
      /* The connection becomes ACTIVE only on a real success. A failed
         test leaves it ERROR, so nothing downstream polls a connection
         we have just been told does not work. */
      await db.run(
        `UPDATE access_providers SET last_tested_at = ?, last_test_ok = ?, last_test_error = ?, status = ?, updated_at = ?
          WHERE id = ?`,
        [nowIso(), result.ok ? 1 : 0, result.ok ? null : (result.message || 'failed'),
          result.ok ? 'ACTIVE' : 'ERROR', nowIso(), row.id]);

      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.provider.tested',
        entityType: 'access_provider', entityId: row.id,
        result: result.ok ? 'OK' : 'FAILED', reason: result.ok ? null : result.message,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/providers/:id/rotate-secret', connectable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      const kind = z.enum(['webhook_secret', 'api_key', 'bearer', 'client_secret', 'hmac_secret'])
        .parse(req.body?.kind || 'webhook_secret');
      const value = kind === 'webhook_secret'
        ? randomBytes(32).toString('hex')
        : z.string().min(8).max(4096).parse(req.body?.value);
      await storeSecret(db, { orgId: req.orgId, providerId: row.id, kind, value });
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.provider.secret_rotated',
        entityType: 'access_provider', entityId: row.id, after: { kind },
      });
      // The generated value is returned once; a supplied one never is.
      res.json({ ok: true, shownOnce: kind === 'webhook_secret' ? value : null });
    } catch (e) { next(e); }
  });

  r.delete('/providers/:id', connectable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      /* Disabled, not deleted. The event history references this
         connection and is what explains months of attendance; deleting
         the row would orphan it. Disabling stops all traffic, which is
         what the owner actually wants. */
      await db.run("UPDATE access_providers SET status = 'DISABLED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
      await db.run('DELETE FROM access_provider_secrets WHERE provider_id = ?', [row.id]);
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.provider.disconnected',
        entityType: 'access_provider', entityId: row.id,
        before: { status: row.status }, after: { status: 'DISABLED', secretsDeleted: true },
      });
      res.json({ ok: true, status: 'DISABLED', note: 'Event history is kept; credentials were deleted.' });
    } catch (e) { next(e); }
  });

  /* ── devices ───────────────────────────────────────────────────── */

  r.get('/devices', readable, async (req, res) => {
    const rows = await db.q(
      `SELECT d.*, b.name AS branch_name, p.display_name AS provider_name
         FROM access_devices d
         LEFT JOIN branches b ON b.id = d.branch_id
         LEFT JOIN access_providers p ON p.id = d.provider_id
        WHERE d.org_id = ? AND d.status != 'REMOVED'
        ORDER BY d.created_at`, [req.orgId]);
    res.json({ devices: rows.map(publicDevice) });
  });

  const deviceSchema = z.object({
    name: z.string().min(1).max(80),
    deviceIdentifier: z.string().min(1).max(120),
    deviceType: z.enum(['fingerprint', 'rfid', 'qr', 'face', 'turnstile', 'manual', 'other']).default('other'),
    direction: z.enum(['entry', 'exit', 'both']).default('both'),
    branchId: z.string().max(40).nullish(),
    providerId: z.string().max(40).nullish(),
  });

  r.post('/devices', manageable, async (req, res, next) => {
    try {
      const b = deviceSchema.parse(req.body);
      if (b.branchId) {
        const br = await db.q1('SELECT id FROM branches WHERE id = ? AND org_id = ?', [b.branchId, req.orgId]);
        if (!br) return res.status(400).json({ error: 'That branch does not belong to this gym.' });
      }
      if (b.providerId) {
        const p = await db.q1('SELECT id FROM access_providers WHERE id = ? AND org_id = ?', [b.providerId, req.orgId]);
        if (!p) return res.status(400).json({ error: 'That connection does not belong to this gym.' });
      }
      const id = randomUUID();
      const ts = nowIso();
      try {
        await db.run(
          `INSERT INTO access_devices (id, org_id, branch_id, provider_id, device_name, device_identifier,
             device_type, direction, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'ACTIVE',?,?)`,
          [id, req.orgId, b.branchId || null, b.providerId || null, b.name, b.deviceIdentifier,
            b.deviceType, b.direction, ts, ts]);
      } catch (e) {
        if (/UNIQUE|duplicate key/i.test(String(e?.message || ''))) {
          return res.status(409).json({
            error: `A device with the identifier "${b.deviceIdentifier}" already exists at this gym.`,
            code: 'device_identifier_taken',
          });
        }
        throw e;
      }
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.device.added',
        entityType: 'access_device', entityId: id, branchId: b.branchId || null, after: b,
      });
      const row = await db.q1('SELECT * FROM access_devices WHERE id = ?', [id]);
      res.status(201).json({ device: publicDevice(row) });
    } catch (e) { next(e); }
  });

  r.patch('/devices/:id', manageable, async (req, res, next) => {
    try {
      const before = await db.q1('SELECT * FROM access_devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!before) return res.status(404).json({ error: 'Device not found.' });
      const b = deviceSchema.partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }).parse(req.body);
      if (b.branchId) {
        const br = await db.q1('SELECT id FROM branches WHERE id = ? AND org_id = ?', [b.branchId, req.orgId]);
        if (!br) return res.status(400).json({ error: 'That branch does not belong to this gym.' });
      }
      await db.run(
        `UPDATE access_devices SET device_name = ?, branch_id = ?, device_type = ?, direction = ?, status = ?, updated_at = ?
          WHERE id = ? AND org_id = ?`,
        [b.name ?? before.device_name, b.branchId === undefined ? before.branch_id : b.branchId,
          b.deviceType ?? before.device_type, b.direction ?? before.direction,
          b.status ?? before.status, nowIso(), before.id, req.orgId]);
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.device.updated',
        entityType: 'access_device', entityId: before.id,
        before: { name: before.device_name, branchId: before.branch_id, status: before.status }, after: b,
      });
      const row = await db.q1('SELECT * FROM access_devices WHERE id = ?', [before.id]);
      res.json({ device: publicDevice(row) });
    } catch (e) { next(e); }
  });

  r.delete('/devices/:id', manageable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Device not found.' });
      // Soft delete: the event log points at this device and is the record
      // of who was in the building.
      await db.run("UPDATE access_devices SET status = 'REMOVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.device.removed',
        entityType: 'access_device', entityId: row.id, before: { name: row.device_name },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ── member mapping ────────────────────────────────────────────── */

  r.get('/mappings', readable, async (req, res) => {
    const rows = await db.q(
      `SELECT m.*, u.name AS user_name, u.email AS user_email, p.display_name AS provider_name
         FROM access_member_mappings m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN access_providers p ON p.id = m.provider_id
        WHERE m.org_id = ?
        ORDER BY u.name
        LIMIT 500`, [req.orgId]);
    /* People with no mapping at all -- the list an owner works through.
       Trainers included: staff scan in too, and an unmapped trainer's
       scans would otherwise sit in the unrecognised queue forever. */
    const unmapped = await db.q(
      `SELECT u.id, u.name, u.email, u.role FROM users u
        WHERE u.org_id = ? AND u.role IN ('CLIENT','TRAINER') AND u.active = 1
          AND NOT EXISTS (SELECT 1 FROM access_member_mappings m WHERE m.user_id = u.id AND m.org_id = u.org_id)
        ORDER BY u.name LIMIT 300`, [req.orgId]);
    res.json({
      mappings: rows.map((m) => ({
        id: m.id,
        userId: m.user_id,
        userName: m.user_name,
        userEmail: m.user_email,
        providerId: m.provider_id,
        providerName: m.provider_name || null,
        externalUserId: m.external_user_id,
        desiredAccess: m.desired_access || null,
        overrideAccess: m.override_access || null,
        overrideReason: m.override_reason || null,
        overrideAt: m.override_at || null,
        accessStatus: m.access_status,
        syncStatus: m.sync_status,
        syncError: m.sync_error,
        lastSyncedAt: m.last_synced_at,
      })),
      unmapped,
    });
  });

  r.post('/mappings', manageable, async (req, res, next) => {
    try {
      const b = z.object({
        userId: z.string().min(1).max(40),
        providerId: z.string().max(40).nullish(),
        externalUserId: z.string().min(1).max(120),
      }).parse(req.body);

      const user = await db.q1('SELECT id FROM users WHERE id = ? AND org_id = ?', [b.userId, req.orgId]);
      if (!user) return res.status(404).json({ error: 'That member is not at this gym.' });
      const client = await db.q1('SELECT id FROM clients WHERE user_id = ? AND org_id = ?', [b.userId, req.orgId]);

      /* ONE IDENTIFIER, ONE PERSON — checked here rather than left to the
         unique index, because the index cannot express it.

         The constraint is UNIQUE(org_id, provider_id, external_user_id),
         and SQL treats NULLs as distinct: two mappings for the same card
         with no provider set do not collide, so the same badge could be
         handed to two members and every scan from then on would be
         attributed to whichever row the lookup happened to order first.

         What the rule actually is cannot be written as a unique index:
         the SAME person may hold the same identifier under two providers
         (one physical card, two readers), but two DIFFERENT people may
         never share one. That is a condition across rows, so it is
         enforced in code -- and the index stays as the backstop for the
         provider-scoped case. */
      const heldByAnother = await db.q1(
        `SELECT m.user_id, u.name FROM access_member_mappings m
           LEFT JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ? AND m.external_user_id = ? AND m.user_id != ?
          LIMIT 1`, [req.orgId, b.externalUserId, b.userId]);
      if (heldByAnother) {
        return res.status(409).json({
          error: `That access ID is already mapped to ${heldByAnother.name || 'another member'}.`,
          code: 'mapping_conflict',
          existingUserId: heldByAnother.user_id,
        });
      }

      const ts = nowIso();
      try {
        await db.run(
          `INSERT INTO access_member_mappings
             (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [randomUUID(), req.orgId, b.userId, client?.id || null, b.providerId || null, b.externalUserId, ts, ts]);
      } catch (e) {
        if (/UNIQUE|duplicate key/i.test(String(e?.message || ''))) {
          /* Two people cannot share one card. Reported as a conflict
             naming the existing holder, because the owner's next question
             is always "then who has it?" */
          const existing = await db.q1(
            `SELECT m.user_id, u.name FROM access_member_mappings m
               LEFT JOIN users u ON u.id = m.user_id
              WHERE m.org_id = ? AND m.external_user_id = ?`, [req.orgId, b.externalUserId]);
          return res.status(409).json({
            error: `That access ID is already mapped to ${existing?.name || 'another member'}.`,
            code: 'mapping_conflict',
            existingUserId: existing?.user_id || null,
          });
        }
        throw e;
      }
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.member.mapped',
        entityType: 'user', entityId: b.userId, after: { externalUserId: b.externalUserId },
      });
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/mappings/:id', manageable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_member_mappings WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Mapping not found.' });
      await db.run('DELETE FROM access_member_mappings WHERE id = ?', [row.id]);
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.member.unmapped',
        entityType: 'user', entityId: row.user_id, before: { externalUserId: row.external_user_id },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ── events ────────────────────────────────────────────────────── */

  r.get('/events', readable, async (req, res) => {
    const where = ['e.org_id = ?'];
    const params = [req.orgId];
    for (const [q, col] of [['status', 'e.processing_status'], ['type', 'e.event_type'],
      ['branchId', 'e.branch_id'], ['deviceId', 'e.device_id']]) {
      if (req.query[q]) { where.push(`${col} = ?`); params.push(req.query[q]); }
    }
    if (req.query.before) { where.push('e.occurred_at < ?'); params.push(req.query.before); }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    params.push(limit);
    const rows = await db.q(
      `SELECT e.*, u.name AS user_name, d.device_name, b.name AS branch_name
         FROM access_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN access_devices d ON d.id = e.device_id
         LEFT JOIN branches b ON b.id = e.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.occurred_at DESC LIMIT ?`, params);
    res.json({
      events: rows.map((e) => ({
        id: e.id,
        type: e.event_type,
        occurredAt: e.occurred_at,
        receivedAt: e.received_at,
        member: e.user_name || null,
        externalUserId: e.external_user_id,
        device: e.device_name || null,
        branch: e.branch_name || null,
        source: e.source,
        status: e.processing_status,
        error: e.error_reason,
        occupancyDelta: e.affected_occupancy,
        verification: e.verification_status,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1].occurred_at : null,
    });
  });

  /* ── live occupancy, owner view ────────────────────────────────── */

  r.get('/live', readable, async (req, res) => {
    /* Housekeeping rides along on the dashboard load, at most once a
       minute per gym, and never fails the load: the owner came here to
       see the number, not to wait on a poll. */
    try { await maybeTick(db, req.orgId); } catch (e) { console.error('[access] lazy tick failed', e?.message); }
    const settings = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    const capacity = Number(settings?.crowd_capacity) || null;
    // Real occupancy excludes the sandbox; the simulated count is reported
    // alongside it and labelled, never folded in.
    const inside = await liveOccupancy(db, req.orgId);
    const simulated = await demoOccupancy(db, req.orgId);
    const branches = await occupancyByBranch(db, req.orgId);
    const branchRows = await db.q('SELECT id, name FROM branches WHERE org_id = ?', [req.orgId]);
    /* "Today" is the gym's day, not UTC's: slicing the UTC date would start
       an Indian gym's day at 5:30am and file its early rush under
       yesterday. Pull a window wide enough for any timezone and bucket it
       locally -- the same rule analytics.js uses, so the two screens agree.
       Demo scans are left out of the real counts, as they are from
       `inside`; the simulated figure is reported separately. */
    const now = new Date();
    const recent = await db.q(
      `SELECT event_type, affected_occupancy, processing_status, occurred_at, source
         FROM access_events WHERE org_id = ? AND occurred_at >= ?`,
      [req.orgId, new Date(now.getTime() - 36 * 3600_000).toISOString()]);
    const counts = tallyToday(recent, req.tz, now);
    // The feed's last word, whenever it was -- not just today's. A door
    // that last spoke at 11pm yesterday is a quiet door, not no door.
    const last = await db.q1(
      "SELECT MAX(occurred_at) AS last_event FROM access_events WHERE org_id = ? AND source != 'demo'", [req.orgId]);
    counts.last_event = last?.last_event || null;

    const stale = await staleSessions(db, req.orgId, { maxHours: 12 });
    const devices = await db.q(
      "SELECT id, device_name, status, last_seen_at FROM access_devices WHERE org_id = ? AND status = 'ACTIVE'", [req.orgId]);
    const deviceOnlineCutoff = new Date(Date.now() - 30 * 60_000).toISOString();

    const calculatedAt = nowIso();
    res.json({
      // The owner always sees real counts -- showExactCount is a member
      // privacy setting, not an owner one.
      crowd: getCrowdStatus({
        occupancyCount: inside,
        capacity,
        thresholds: {
          quiet: settings?.crowd_threshold_quiet,
          moderate: settings?.crowd_threshold_moderate,
          busy: settings?.crowd_threshold_busy,
        },
      }),
      inside,
      // Present only when there is some, so an owner who has never opened
      // the sandbox never sees a demo row on their dashboard.
      simulatedInside: simulated || undefined,
      capacity,
      entriesToday: Number(counts?.entries) || 0,
      exitsToday: Number(counts?.exits) || 0,
      unresolved: { unmatched: Number(counts?.unmatched) || 0, rejected: Number(counts?.rejected) || 0, staleSessions: stale.length },
      freshness: getFreshness({ calculatedAt, lastEventAt: counts?.last_event || null }),
      branches: branchRows.map((b) => ({
        id: b.id, name: b.name,
        occupancy: Number(branches.find((x) => x.branch_id === b.id)?.occupancy) || 0,
      })),
      devices: {
        total: devices.length,
        // "Online" means it spoke recently, not that it was configured.
        online: devices.filter((d) => d.last_seen_at && d.last_seen_at > deviceOnlineCutoff).length,
      },
      calculatedAt,
    });
  });

  /* ── reconciliation and manual correction ──────────────────────── */

  r.get('/reconciliation', readable, async (req, res) => {
    const stale = await staleSessions(db, req.orgId, { maxHours: Number(req.query.hours) || 12 });
    const unmatched = await db.q(
      `SELECT id, external_user_id, occurred_at, event_type, source
         FROM access_events
        WHERE org_id = ? AND processing_status = 'UNMATCHED'
        ORDER BY occurred_at DESC LIMIT 100`, [req.orgId]);
    res.json({
      staleSessions: stale.map((s) => ({
        id: s.id, member: s.user_name, enteredAt: s.entered_at,
        hoursOpen: Math.round((Date.now() - Date.parse(s.entered_at)) / 3600_000),
      })),
      unmatchedEvents: unmatched,
    });
  });

  r.post('/reconciliation/run', manageable, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
    try {
      const hours = Math.min(72, Math.max(1, parseInt(req.body?.maxHours, 10) || 12));
      const result = await reconcileStaleSessions(db, req.orgId, { maxHours: hours });
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.reconciliation.run',
        reason: `auto-close sessions open over ${hours}h`, after: { closed: result.closed },
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  r.post('/sessions/:id/close', manageable, async (req, res, next) => {
    try {
      const s = await db.q1(
        "SELECT * FROM gym_presence_sessions WHERE id = ? AND org_id = ? AND status = 'OPEN'",
        [req.params.id, req.orgId]);
      if (!s) return res.status(404).json({ error: 'No open session with that id at this gym.' });
      const reason = z.string().min(3).max(200).parse(req.body?.reason);
      // exitedAt stays null: a manual correction knows they left, not when.
      await closeSession(db, s, { exitedAt: null, reason: 'manual_correction', confidence: 'estimated' });
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.session.manually_closed',
        entityType: 'presence_session', entityId: s.id, reason,
        before: { status: 'OPEN', enteredAt: s.entered_at }, after: { status: 'CLOSED', confidence: 'estimated' },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ── demo mode ─────────────────────────────────────────────────── */

  /**
   * Simulate an entry or exit.
   *
   * Only against a provider whose key is 'demo'. That check is the whole
   * isolation guarantee: a demo event can never be injected into a real
   * connection, and every event it creates carries source='demo'
   * permanently, so the two can always be told apart afterwards.
   */
  r.post('/demo/:providerId/event', manageable, rateLimit({ windowMs: 60_000, max: 120 }), async (req, res, next) => {
    try {
      const p = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.providerId, req.orgId]);
      if (!p) return res.status(404).json({ error: 'Connection not found.' });
      if (p.provider_key !== 'demo') {
        return res.status(400).json({
          error: 'Simulated events can only be sent to a demo connection.',
          code: 'not_a_demo_provider',
        });
      }
      const b = z.object({
        externalUserId: z.string().min(1).max(120),
        eventType: z.enum(['ENTRY', 'EXIT', 'DENIED']),
        occurredAt: z.string().datetime().optional(),
      }).parse(req.body);

      const result = await ingestAccessEvent(db, {
        orgId: req.orgId, providerId: p.id, branchId: p.branch_id,
        externalUserId: b.externalUserId,
        externalEventId: `demo-${randomUUID()}`,
        eventType: b.eventType,
        occurredAt: b.occurredAt || nowIso(),
        verificationStatus: 'verified',
        source: 'demo',
        actorUserId: req.user?.sub,
      });
      res.json({ ...result, demo: true });
    } catch (e) { next(e); }
  });

  /* ── audit ─────────────────────────────────────────────────────── */

  r.get('/audit', readable, async (req, res) => {
    res.json({
      entries: await listAudit(db, req.orgId, {
        limit: parseInt(req.query.limit, 10) || 50,
        before: req.query.before || null,
        entityType: req.query.entityType || null,
      }),
    });
  });


  /* ── connection configuration (the Custom API builder) ──────────── */

  const fieldMapSchema = z.record(
    z.enum(['externalUserId', 'externalEventId', 'deviceIdentifier', 'eventType', 'occurredAt']),
    z.string().max(120).regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/, 'Use a field name or a dotted path like data.user.id'),
  );

  const configSchema = z.object({
    displayName: z.string().min(1).max(80).optional(),
    branchId: z.string().max(40).nullish(),
    config: z.object({
      baseUrl: z.string().max(500).nullish(),
      permissionUrl: z.string().max(500).nullish(),
      eventsPath: z.string().max(80).nullish(),
      sinceParam: z.string().max(40).regex(/^[A-Za-z0-9_.-]*$/).nullish(),
      untilParam: z.string().max(40).regex(/^[A-Za-z0-9_.-]*$/).nullish(),
      limitParam: z.string().max(40).regex(/^[A-Za-z0-9_.-]*$/).nullish(),
      pollIntervalSec: z.number().int().min(60).max(86400).nullish(),
      timezone: z.string().max(60).nullish(),
      // Only these canonical keys may be mapped, each to a dotted path of
      // plain identifiers. No expressions, no templates, no code: a field
      // map is data, and the spec is explicit that nothing an owner types
      // here may execute.
      fieldMap: fieldMapSchema.optional(),
    }).partial().optional(),
  });

  r.patch('/providers/:id', connectable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      const body = configSchema.parse(req.body);
      if (body.branchId) {
        const b = await db.q1('SELECT id FROM branches WHERE id = ? AND org_id = ?', [body.branchId, req.orgId]);
        if (!b) return res.status(400).json({ error: 'That branch does not belong to this gym.' });
      }
      const before = safeParse(row.config_json) || {};
      const config = { ...before };
      for (const [k, v] of Object.entries(body.config || {})) {
        if (v === null || v === '') delete config[k]; else config[k] = v;
      }
      for (const k of ['baseUrl', 'permissionUrl']) if (config[k]) config[k] = checkUrl(config[k]);
      await db.run(
        'UPDATE access_providers SET display_name = ?, branch_id = ?, config_json = ?, updated_at = ? WHERE id = ?',
        [body.displayName ?? row.display_name, body.branchId === undefined ? row.branch_id : body.branchId,
          JSON.stringify(config), nowIso(), row.id]);
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.provider.configured',
        entityType: 'access_provider', entityId: row.id, before, after: config,
      });
      const fresh = await db.q1('SELECT * FROM access_providers WHERE id = ?', [row.id]);
      res.json({ provider: publicProvider(fresh, await describeSecrets(db, row.id), getProvider(fresh.provider_key)) });
    } catch (e) { next(e); }
  });

  /**
   * Show what a sample payload becomes under a field map, without
   * recording anything. This is the "JSON preview" of the builder: the
   * owner pastes what their system sends and sees, field by field, what
   * SK OS would read out of it -- before a single real event depends on it.
   */
  r.post('/providers/:id/preview-mapping', manageable, async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      const adapter = getProvider(row.provider_key);
      if (typeof adapter?.normalizeEvent !== 'function') {
        return res.status(400).json({ error: 'This connection does not map fields.' });
      }
      const { sample, fieldMap } = z.object({
        sample: z.any(),
        fieldMap: fieldMapSchema.optional(),
      }).parse(req.body);
      const config = { ...(safeParse(row.config_json) || {}), ...(fieldMap ? { fieldMap } : {}) };
      const items = Array.isArray(sample?.events) ? sample.events : Array.isArray(sample) ? sample : [sample];
      const results = items.slice(0, 20).map((item, i) => {
        const n = adapter.normalizeEvent({ provider: { ...row, config } }, item);
        if (!n) {
          return { index: i, ok: false, problem: 'No member identifier or no timestamp could be found in this record.' };
        }
        const problems = [];
        if (Number.isNaN(Date.parse(n.occurredAt))) problems.push(`"${n.occurredAt}" is not a timestamp SK OS can read.`);
        const t = String(n.eventType || '').toUpperCase();
        if (!['ENTRY', 'IN', 'CHECK_IN', 'CHECKIN', 'EXIT', 'OUT', 'CHECK_OUT', 'CHECKOUT', 'DENIED', 'REJECTED', 'FAILED'].includes(t)) {
          problems.push(n.eventType == null
            ? 'No direction found. That is fine for a one-way reader; a two-way device must send one.'
            : `Direction "${n.eventType}" is not recognised. Use entry/exit, in/out or check_in/check_out.`);
        }
        if (!n.externalEventId) problems.push('No event id found. SK OS will derive one from the scan so repeats are still ignored.');
        return { index: i, ok: problems.length === 0, normalized: n, problems };
      });
      res.json({ results, recorded: false });
    } catch (e) { next(e); }
  });

  /**
   * Send a signed test event through the real verification path.
   *
   * Signs a sample with the connection's own stored secret and runs it
   * through verifyWebhook and the field map exactly as a real delivery
   * would -- then STOPS. Nothing is written: a test that created a
   * presence session would put a phantom person in the gym. The result
   * says which stage passed and which did not.
   */
  r.post('/providers/:id/test-event', connectable, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
    try {
      const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Connection not found.' });
      const adapter = getProvider(row.provider_key);
      if (!adapter?.capabilities?.supportsWebhooks) {
        return res.status(400).json({ error: 'Test events are for webhook connections.' });
      }
      const secret = await readSecret(db, { providerId: row.id, kind: 'webhook_secret' });
      if (!secret) return res.json({ ok: false, stages: [{ stage: 'secret', ok: false, detail: 'No signing secret is set.' }] });

      const sample = req.body?.sample && typeof req.body.sample === 'object' ? req.body.sample : {
        user_id: 'TEST-CARD', event_id: `test-${Date.now()}`, direction: 'entry', timestamp: nowIso(),
      };
      const rawBody = JSON.stringify(sample);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = {
        'x-skos-timestamp': ts,
        'x-skos-signature': createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'),
      };
      const ctx = { db, orgId: req.orgId, provider: { ...row, config: safeParse(row.config_json) || {} } };
      const stages = [];
      const v = await adapter.verifyWebhook(ctx, { headers, rawBody });
      stages.push({ stage: 'signature', ok: v.ok, detail: v.ok ? 'Signature and timestamp verified.' : v.reason });
      const n = v.ok ? adapter.normalizeEvent(ctx, sample) : null;
      stages.push({
        stage: 'mapping', ok: !!n,
        detail: n ? `Read member "${n.externalUserId}", direction "${n.eventType ?? 'none'}", time ${n.occurredAt}.`
          : 'The field map could not find a member and a timestamp in the sample.',
      });
      if (n) {
        const mapped = await db.q1('SELECT user_id FROM access_member_mappings WHERE org_id = ? AND external_user_id = ?',
          [req.orgId, n.externalUserId]);
        stages.push({
          stage: 'member', ok: !!mapped,
          detail: mapped ? 'That access ID is mapped to a member.' : 'That access ID is not mapped yet; a real event would be kept as unmatched.',
        });
      }
      res.json({ ok: stages.every((x) => x.ok), stages, recorded: false });
    } catch (e) { next(e); }
  });

  /* ── sync center ────────────────────────────────────────────────── */

  r.get('/jobs', readable, async (req, res) => {
    res.json({ jobs: await listJobs(db, req.orgId, { limit: parseInt(req.query.limit, 10) || 30 }) });
  });

  r.get('/jobs/:id', readable, async (req, res) => {
    const job = await getJob(db, req.orgId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job });
  });

  const jobLimit = rateLimit({ windowMs: 60_000, max: 60 });

  r.post('/jobs/:id/continue', manageable, jobLimit, async (req, res) => {
    const job = await runChunk(db, req.orgId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job });
  });

  r.post('/jobs/:id/retry', manageable, jobLimit, async (req, res) => {
    const job = await retryJob(db, req.orgId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ job: await runChunk(db, req.orgId, job.id) });
  });

  r.post('/jobs/:id/cancel', manageable, async (req, res) => {
    const job = await cancelJob(db, req.orgId, req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    await writeAudit(db, { orgId: req.orgId, ...actor(req), action: 'access.job.cancelled', entityType: 'access_sync_job', entityId: job.id });
    res.json({ job });
  });

  async function connectionFor(req, capability) {
    const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return { error: [404, 'Connection not found.'] };
    const caps = effectiveCapabilities(getProvider(row.provider_key), safeParse(row.config_json) || {});
    if (capability && !caps[capability]) {
      return { error: [400, 'This connection cannot do that. Check that its URL is configured.'] };
    }
    if (row.status === 'DISABLED') return { error: [400, 'This connection is disconnected.'] };
    return { row };
  }

  r.post('/providers/:id/sync', manageable, jobLimit, async (req, res, next) => {
    try {
      const { row, error } = await connectionFor(req, 'supportsPolling');
      if (error) return res.status(error[0]).json({ error: error[1] });
      const job = await createJob(db, { orgId: req.orgId, providerId: row.id, jobType: 'event_poll' });
      await writeAudit(db, { orgId: req.orgId, ...actor(req), action: 'access.sync.started', entityType: 'access_provider', entityId: row.id });
      res.status(202).json({ job: await runChunk(db, req.orgId, job.id) });
    } catch (e) { next(e); }
  });

  r.post('/providers/:id/import', manageable, jobLimit, async (req, res, next) => {
    try {
      const { row, error } = await connectionFor(req, 'supportsHistoricalImport');
      if (error) return res.status(error[0]).json({ error: error[1] });
      const { from, to } = z.object({ from: z.string().datetime(), to: z.string().datetime().optional() }).parse(req.body);
      if (to && to <= from) return res.status(400).json({ error: 'The end of the range must be after the start.' });
      const job = await createJob(db, { orgId: req.orgId, providerId: row.id, jobType: 'historical_import', cursor: { from, to: to || null } });
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.import.started',
        entityType: 'access_provider', entityId: row.id, after: { from, to: to || null },
      });
      res.status(202).json({ job: await runChunk(db, req.orgId, job.id) });
    } catch (e) { next(e); }
  });

  r.post('/providers/:id/import-csv', manageable, jobLimit, async (req, res, next) => {
    try {
      const target = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!target) return res.status(404).json({ error: 'Connection not found.' });
      if (target.provider_key !== 'csv_import') {
        return res.status(400).json({ error: 'CSV files are imported through a CSV import connection.' });
      }
      if (target.status === 'DISABLED') return res.status(400).json({ error: 'This connection is disconnected.' });
      const { csv } = z.object({ csv: z.string().min(1).max(3_000_000) }).parse(req.body);
      const { header, records, truncated } = parseCsv(csv, { maxRows: 20000 });
      if (!records.length) return res.status(400).json({ error: 'The file has a header row but no data rows.' });
      const job = await createJob(db, {
        orgId: req.orgId, providerId: target.id, jobType: 'historical_import',
        cursor: { mode: 'csv', rows: records, offset: 0 }, total: records.length,
      });
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.import.csv',
        entityType: 'access_provider', entityId: target.id, after: { rows: records.length, columns: header, truncated: !!truncated },
      });
      res.status(202).json({ job: await runChunk(db, req.orgId, job.id), columns: header, truncated: !!truncated });
    } catch (e) { next(e); }
  });

  /* ── unmatched scans, second chance ─────────────────────────────── */

  r.post('/events/reprocess-unmatched', manageable, jobLimit, async (req, res, next) => {
    try {
      const summary = await reprocessUnmatched(db, req.orgId, { limit: 500 });
      await writeAudit(db, { orgId: req.orgId, ...actor(req), action: 'access.events.reprocessed', after: summary });
      res.json(summary);
    } catch (e) { next(e); }
  });

  /* ── membership access sync ─────────────────────────────────────── */

  r.post('/access-sync/run', manageable, jobLimit, async (req, res, next) => {
    try {
      const summary = await evaluateOrgAccess(db, req.orgId, { actorUserId: req.user?.sub, tz: req.tz });
      await writeAudit(db, { orgId: req.orgId, ...actor(req), action: 'access.sync.evaluated', after: summary });
      res.json(summary);
    } catch (e) { next(e); }
  });

  r.post('/mappings/:id/sync', manageable, async (req, res, next) => {
    try {
      const m = await db.q1('SELECT * FROM access_member_mappings WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!m) return res.status(404).json({ error: 'Mapping not found.' });
      const settings = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId])) || {};
      res.json(await syncMapping(db, m, { settings, actorUserId: req.user?.sub, force: true }));
    } catch (e) { next(e); }
  });

  r.post('/mappings/:id/override', manageable, async (req, res, next) => {
    try {
      const b = z.object({
        access: z.enum(['ALLOWED', 'DENIED']).nullable(),
        // A reason is required to override and optional to clear.
        reason: z.string().max(200).optional(),
      }).parse(req.body);
      if (b.access && (!b.reason || b.reason.trim().length < 3)) {
        return res.status(400).json({ error: 'Say why. An override without a reason cannot be reviewed later.' });
      }
      const out = await setOverride(db, {
        orgId: req.orgId, mappingId: req.params.id, access: b.access, reason: b.reason?.trim() || null,
        actorUserId: req.user?.sub, actorRole: req.accessRole,
      });
      if (!out) return res.status(404).json({ error: 'Mapping not found.' });
      res.json(out);
    } catch (e) { next(e); }
  });

  /* ── health ─────────────────────────────────────────────────────── */

  r.get('/health', readable, async (req, res) => {
    const providers = await db.q("SELECT * FROM access_providers WHERE org_id = ? AND status != 'DISABLED'", [req.orgId]);
    const devices = await db.q("SELECT * FROM access_devices WHERE org_id = ? AND status != 'REMOVED'", [req.orgId]);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const rejects = await db.q(
      `SELECT entity_id, COUNT(*) AS n FROM access_audit_logs
        WHERE org_id = ? AND action = 'access.webhook.rejected' AND created_at >= ? GROUP BY entity_id`, [req.orgId, hourAgo]);
    const errRate = await db.q(
      `SELECT provider_id, COUNT(*) AS total,
              SUM(CASE WHEN processing_status IN ('REJECTED','ERROR') THEN 1 ELSE 0 END) AS bad
         FROM access_events WHERE org_id = ? AND received_at >= ? GROUP BY provider_id`,
      [req.orgId, new Date(Date.now() - 86400000).toISOString()]);
    const failedJobs = await db.q(
      `SELECT provider_id, COUNT(*) AS n FROM access_sync_jobs
        WHERE org_id = ? AND status = 'FAILED' AND created_at >= ? GROUP BY provider_id`,
      [req.orgId, new Date(Date.now() - 86400000).toISOString()]);

    const stateFor = (p) => {
      const rej = Number(rejects.find((x) => x.entity_id === p.id)?.n || 0);
      const er = errRate.find((x) => x.provider_id === p.id);
      const bad = Number(er?.bad || 0);
      const total = Number(er?.total || 0);
      const failed = Number(failedJobs.find((x) => x.provider_id === p.id)?.n || 0);
      const lastAge = p.last_event_at ? (Date.now() - Date.parse(p.last_event_at)) / 60000 : null;
      let state = 'healthy';
      const reasons = [];
      if (p.status === 'ERROR') { state = 'disconnected'; reasons.push(p.last_test_error || 'Last connection test failed.'); }
      if (p.status === 'CONFIGURED' && !p.last_event_at) { state = 'not_verified'; reasons.push('Never tested and no event received yet.'); }
      if (rej >= 3) { state = 'degraded'; reasons.push(`${rej} webhook requests rejected in the last hour.`); }
      if (total >= 20 && bad / total > 0.1) { state = 'degraded'; reasons.push(`${Math.round((bad / total) * 100)}% of events failed processing today.`); }
      if (failed) { state = state === 'healthy' ? 'degraded' : state; reasons.push(`${failed} sync job${failed === 1 ? '' : 's'} failed today.`); }
      if (p.provider_key !== 'demo' && p.provider_key !== 'csv_import' && lastAge != null && lastAge > 360) {
        state = state === 'healthy' ? 'no_recent_events' : state;
        reasons.push(`No event for ${Math.round(lastAge / 60)} hours.`);
      }
      return { state, reasons };
    };

    res.json({
      providers: providers.map((p) => ({
        id: p.id, name: p.display_name, providerKey: p.provider_key, status: p.status,
        lastEventAt: p.last_event_at, lastPolledAt: p.last_polled_at, lastTestedAt: p.last_tested_at,
        ...stateFor(p),
      })),
      devices: devices.map(publicDevice),
      alerts: await listAlerts(db, req.orgId),
    });
  });

  /* ── alerts ─────────────────────────────────────────────────────── */

  r.get('/alerts', readable, async (req, res) => {
    const settings = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId])) || {};
    const crowd = await liveCrowd(db, req.orgId, req.tz, settings, { showExactCount: true });
    await evaluateAlerts(db, req.orgId, { settings, crowd, tz: req.tz });
    res.json({ alerts: await listAlerts(db, req.orgId, { includeResolved: req.query.all === '1' }) });
  });

  r.post('/alerts/:id/acknowledge', readable, async (req, res) => {
    const ok = await acknowledgeAlert(db, req.orgId, req.params.id, req.user?.sub);
    if (!ok) return res.status(404).json({ error: 'No open alert with that id.' });
    await writeAudit(db, { orgId: req.orgId, ...actor(req), action: 'access.alert.acknowledged', entityType: 'access_alert', entityId: req.params.id });
    res.json({ ok: true });
  });

  /* ── analytics ──────────────────────────────────────────────────── */

  r.get('/analytics', readable, async (req, res) => {
    const settings = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId])) || {};
    await maybeSnapshot(db, req.orgId, req.tz, settings);
    res.json(await hourlyAnalytics(db, req.orgId, req.tz));
  });

  /* ── people inside: the operational detail view ─────────────────── */

  /**
   * Who is inside, by name. Aggregate is the default everywhere; this is
   * the one place member-level presence is shown, it is for owners and
   * managers only (access.manage, not access.view -- front-desk staff see
   * the count), and every look is audited, because "who was in the
   * building at 7pm" is personal information.
   */
  r.get('/sessions', manageable, async (req, res) => {
    const rows = await db.q(
      `SELECT s.id, s.entered_at, s.branch_id, s.is_demo, u.name, u.role, b.name AS branch_name
         FROM gym_presence_sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.org_id = ? AND s.status = 'OPEN'
        ORDER BY s.entered_at DESC LIMIT 300`, [req.orgId]);
    await writeAudit(db, {
      orgId: req.orgId, ...actor(req), action: 'access.sessions.viewed', after: { count: rows.length },
    });
    res.json({
      sessions: rows.map((r2) => ({
        id: r2.id, name: r2.name || 'Unknown member', role: r2.role, branch: r2.branch_name,
        enteredAt: r2.entered_at, minutesInside: Math.round((Date.now() - Date.parse(r2.entered_at)) / 60000),
        demo: !!r2.is_demo,
      })),
    });
  });

  /* ── device removal impact ──────────────────────────────────────── */

  r.get('/devices/:id/impact', readable, async (req, res) => {
    const d = await db.q1('SELECT * FROM access_devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!d) return res.status(404).json({ error: 'Device not found.' });
    const events = await db.q1('SELECT COUNT(*) AS n, MAX(occurred_at) AS last FROM access_events WHERE device_id = ?', [d.id]);
    const others = await db.q1(
      "SELECT COUNT(*) AS n FROM access_devices WHERE org_id = ? AND status = 'ACTIVE' AND id != ?", [req.orgId, d.id]);
    const open = await db.q1(
      "SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE org_id = ? AND status = 'OPEN'", [req.orgId]);
    res.json({
      device: publicDevice(d),
      historicalEvents: Number(events?.n) || 0,
      lastEventAt: events?.last || null,
      otherActiveDevices: Number(others?.n) || 0,
      openSessions: Number(open?.n) || 0,
      consequences: [
        `Its ${Number(events?.n) || 0} past events stay in the history; removal does not delete attendance.`,
        Number(others?.n) === 0
          ? 'It is your only active device, so live occupancy will stop updating from the door.'
          : `${others.n} other active device${Number(others.n) === 1 ? '' : 's'} will keep occupancy updating.`,
        'Events that name this device after removal will still be recorded, but not attributed to a door.',
      ],
    });
  });

  /* ── access & crowd settings ────────────────────────────────────── */

  const SETTINGS_COLS = [
    'crowd_enabled', 'crowd_capacity', 'crowd_threshold_quiet', 'crowd_threshold_moderate', 'crowd_threshold_busy',
    'crowd_show_exact_count', 'crowd_client_visible', 'crowd_trainer_visible', 'crowd_open_time', 'crowd_close_time',
    'access_auto_close_hours', 'access_grace_days', 'access_sync_enabled',
  ];

  r.get('/settings', readable, async (req, res) => {
    const s = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId])) || {};
    res.json({ settings: Object.fromEntries(SETTINGS_COLS.map((k) => [k, s[k] ?? null])) });
  });

  r.put('/settings', connectable, async (req, res, next) => {
    try {
      const flag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
      const pct = z.number().int().min(1).max(99);
      const b = z.object({
        crowd_enabled: flag, crowd_show_exact_count: flag, crowd_client_visible: flag,
        crowd_trainer_visible: flag, access_sync_enabled: flag,
        crowd_capacity: z.number().int().min(1).max(20000).nullable(),
        crowd_threshold_quiet: pct, crowd_threshold_moderate: pct, crowd_threshold_busy: pct,
        crowd_open_time: z.string().nullable(), crowd_close_time: z.string().nullable(),
        access_auto_close_hours: z.number().int().min(1).max(72),
        access_grace_days: z.number().int().min(0).max(60),
      }).partial().strict().parse(req.body);

      for (const k of ['crowd_open_time', 'crowd_close_time']) {
        if (b[k] !== undefined && !validHhmm(b[k])) {
          return res.status(400).json({ error: 'Opening hours must be 24-hour times like 06:00 and 22:30.' });
        }
        if (b[k] === '') b[k] = null;
      }
      const s = (await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId])) || {};
      const merged = { ...Object.fromEntries(SETTINGS_COLS.map((k) => [k, s[k] ?? null])), ...b };
      /* Half-configured hours would silently mean "unknown" (see
         isOpenNow). Refusing is clearer than saving something that does
         nothing. */
      if ((merged.crowd_open_time == null) !== (merged.crowd_close_time == null)) {
        return res.status(400).json({ error: 'Set both an opening and a closing time, or neither.' });
      }
      if (!(merged.crowd_threshold_quiet < merged.crowd_threshold_moderate
        && merged.crowd_threshold_moderate < merged.crowd_threshold_busy)) {
        return res.status(400).json({ error: 'Thresholds must rise: quiet below moderate, moderate below busy.' });
      }
      if (!s.org_id) await db.run('INSERT INTO gym_settings (org_id) VALUES (?)', [req.orgId]);
      const cols = Object.keys(b);
      if (cols.length) {
        await db.run(
          `UPDATE gym_settings SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE org_id = ?`,
          [...cols.map((c) => b[c]), nowIso(), req.orgId]);
      }
      await writeAudit(db, {
        orgId: req.orgId, ...actor(req), action: 'access.settings.changed',
        before: Object.fromEntries(cols.map((c) => [c, s[c] ?? null])), after: b,
      });
      const fresh = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
      res.json({ settings: Object.fromEntries(SETTINGS_COLS.map((k) => [k, fresh[k] ?? null])) });
    } catch (e) { next(e); }
  });

  /* ── webhook details ────────────────────────────────────────────── */

  r.get('/providers/:id/webhook', readable, async (req, res) => {
    const row = await db.q1('SELECT * FROM access_providers WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Connection not found.' });
    if (!getProvider(row.provider_key)?.capabilities?.supportsWebhooks) {
      return res.status(400).json({ error: 'This connection does not use webhooks.' });
    }
    const since = new Date(Date.now() - 86400000).toISOString();
    const counts = await db.q1(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN processing_status IN ('PROCESSED','IGNORED_DUPLICATE','UNMATCHED') THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN processing_status IN ('REJECTED','ERROR') THEN 1 ELSE 0 END) AS failed,
              MAX(received_at) AS last
         FROM access_events WHERE provider_id = ? AND source = 'webhook' AND received_at >= ?`, [row.id, since]);
    const rejected = await db.q(
      `SELECT reason, created_at FROM access_audit_logs
        WHERE org_id = ? AND entity_id = ? AND action = 'access.webhook.rejected' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10`, [req.orgId, row.id, since]);
    res.json({
      url: `/api/access/hook/${row.id}`,
      signing: { algorithm: 'HMAC-SHA256', signedString: '<x-skos-timestamp>.<raw body>', headers: ['x-skos-timestamp', 'x-skos-signature'], maxSkewSeconds: 300 },
      secret: (await describeSecrets(db, row.id)).find((x) => x.kind === 'webhook_secret') || null,
      last24h: {
        received: Number(counts?.total) || 0, processed: Number(counts?.ok) || 0,
        failedProcessing: Number(counts?.failed) || 0, rejectedSignatures: rejected.length,
        lastReceivedAt: counts?.last || null,
      },
      recentRejections: rejected.map((x) => ({ reason: x.reason, at: x.created_at })),
    });
  });

  return r;
}

function publicDevice(d) {
  const online = !!d.last_seen_at && d.last_seen_at > new Date(Date.now() - 30 * 60_000).toISOString();
  return {
    id: d.id,
    name: d.device_name,
    identifier: d.device_identifier,
    type: d.device_type,
    direction: d.direction,
    status: d.status,
    branchId: d.branch_id,
    branch: d.branch_name || null,
    provider: d.provider_name || null,
    lastSeenAt: d.last_seen_at,
    lastEventAt: d.last_event_at,
    // Derived, and deliberately not stored: a device is online because it
    // spoke recently, and a stored flag would keep saying "online" long
    // after it stopped.
    online,
  };
}

/* ══════════════════════════════════════════════════════════════════
   THE INBOUND WEBHOOK — public, and authenticated by signature.

   Mounted separately (see index.js) because it cannot sit behind
   requireAuth: the caller is a door controller, not a person. What
   replaces the session is the adapter's verifyWebhook, which checks an
   HMAC over `${timestamp}.${body}` AND that the timestamp is recent --
   a valid signature on a request captured last week is still a replay.

   An unsigned or badly-signed request is never processed as a trusted
   event. It is counted and rejected.
   ══════════════════════════════════════════════════════════════════ */
export function accessWebhookRoutes(db) {
  const r = Router();

  /* The maintenance tick, for an external scheduler. Authenticated by
     CRON_SECRET, not by a session -- the caller is a scheduler. Refuses
     with 503 when the secret is not configured, so an unprotected tick
     endpoint can never exist by accident. */
  const cron = async (req, res, next) => {
    try {
      const auth = cronAuthorized(req);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 503 ? 'Scheduler not configured.' : 'Unauthorized.' });
      res.json(await runAllOrgs(db));
    } catch (e) { next(e); }
  };
  r.get('/cron/tick', cron);
  r.post('/cron/tick', cron);

  r.post('/hook/:providerId',
    rateLimit({ windowMs: 60_000, max: 600, keyFn: (req) => req.params.providerId }),
    async (req, res, next) => {
      try {
        const p = await db.q1("SELECT * FROM access_providers WHERE id = ? AND status != 'DISABLED'", [req.params.providerId]);
        // Same answer whether the connection is unknown or disabled: a
        // 404 that distinguishes them is an endpoint-enumeration oracle.
        if (!p) return res.status(404).json({ error: 'Unknown endpoint.' });

        const adapter = getProvider(p.provider_key);
        if (!adapter?.capabilities?.supportsWebhooks) {
          return res.status(400).json({ error: 'This connection does not accept webhooks.' });
        }

        const ctx = { db, orgId: p.org_id, provider: { ...p, config: safeParse(p.config_json) } };

        /* THE EXACT BYTES, not a re-serialization. This path is mounted
           with express.raw (see index.js, same reasoning as the Razorpay
           and WHOOP webhooks): parsing JSON and stringifying it again can
           reorder keys and change whitespace, which breaks a genuinely
           authentic HMAC. Verifying a signature against a body we
           reconstructed is verifying our own work. */
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});
        const verified = await adapter.verifyWebhook(ctx, { headers: req.headers, rawBody });
        if (!verified.ok) {
          await writeAudit(db, {
            orgId: p.org_id, action: 'access.webhook.rejected',
            entityType: 'access_provider', entityId: p.id,
            reason: verified.reason, result: 'FAILED',
          });
          return res.status(401).json({ error: 'Signature verification failed.', reason: verified.reason });
        }

        let body;
        try {
          body = Buffer.isBuffer(req.body) ? JSON.parse(rawBody || '{}') : (req.body ?? {});
        } catch {
          return res.status(400).json({ error: 'Body is not valid JSON.' });
        }

        // A provider may batch. One malformed entry must not discard the
        // rest of the delivery.
        const items = Array.isArray(body?.events) ? body.events : [body];
        const results = [];
        for (const item of items.slice(0, 500)) {
          const normalized = adapter.normalizeEvent(ctx, item);
          if (!normalized) {
            results.push({ status: 'rejected', reason: 'could not identify a member or a timestamp' });
            continue;
          }
          results.push(await ingestAccessEvent(db, {
            orgId: p.org_id,
            providerId: p.id,
            branchId: p.branch_id,
            verificationStatus: 'verified',
            source: 'webhook',
            payload: item,
            ...normalized,
          }));
        }
        res.json({
          received: results.length,
          accepted: results.filter((x) => x.status === 'accepted').length,
          duplicates: results.filter((x) => x.status === 'duplicate').length,
          rejected: results.filter((x) => x.status === 'rejected').length,
        });
      } catch (e) { next(e); }
    });

  return r;
}
