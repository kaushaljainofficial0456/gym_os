// ============================================================
// eSSL / ZKTeco TERMINALS — the ADMS "iclock" push endpoint.
//
// Mounted at /iclock, at the ROOT of the server rather than under /api:
// the terminal is configured with a host and port only, and its firmware
// always requests /iclock/cdata, /iclock/getrequest and /iclock/devicecmd
// (some older models append ".aspx"). The protocol itself, and why each
// answer is what it is, is in services/access/adms.js.
//
// PUBLIC BY NECESSITY, like the door webhook -- a terminal cannot log in.
// What stands in for a signature, since ADMS has none:
//
//   1. the serial must be registered under Devices, ACTIVE, against an
//      eSSL connection that is not disabled -- anything else is a 404 with
//      the same body, so the endpoint cannot be used to discover serials;
//   2. a serial registered at two gyms is refused outright rather than
//      delivered to whichever row the database returns first;
//   3. a connection can pin the gym's public IP (allowed_ips);
//   4. every punch is stored 'unverified', never 'verified'.
//
// Replies are plain text, because that is all the firmware parses. Every
// line of an ATTLOG batch is acknowledged -- including lines that could
// not be read or were refused -- since a device that is not told "OK: n"
// resends the same batch forever.
// ============================================================
import { Router } from 'express';
import { rateLimit } from '../rateLimit.js';
import { getOrgTzCached } from '../utils/time.js';
import { ingestAccessEvent, resolveMember } from '../services/access/ingest.js';
import { writeAudit } from '../services/access/audit.js';
import {
  parseAttlog, localToUtcIso, punchDirection, handshakeResponse, clientIp, allowedIps,
  punchEventId, MAX_CLOCK_AHEAD_MS,
} from '../services/access/adms.js';

const SERIAL = /^[A-Za-z0-9._-]{1,64}$/;
/** Two punches by one member this close together are one arrival scanned
 *  twice, not an arrival and a departure -- in toggle mode the second
 *  would otherwise check them straight back out. */
export const DOUBLE_PUNCH_MS = 2 * 60 * 1000;

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const plain = (res, status, body) => res.status(status).type('text/plain').send(body);

export default function admsRoutes(db) {
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, max: 240, keyFn: (req) => `adms:${String(req.query.SN || '')}:${clientIp(req)}` }));

  /** The registered terminal behind ?SN=, or the plain-text refusal. */
  async function terminal(req) {
    const sn = String(req.query.SN ?? req.query.sn ?? '').trim();
    if (!SERIAL.test(sn)) return { refuse: [400, 'Bad request'] };
    const rows = await db.q(
      `SELECT d.id, d.org_id, d.branch_id, d.direction, d.device_name,
              p.id AS provider_id, p.branch_id AS provider_branch_id, p.config_json
         FROM access_devices d
         JOIN access_providers p ON p.id = d.provider_id AND p.org_id = d.org_id
        WHERE d.device_identifier = ? AND d.status = 'ACTIVE'
          AND p.provider_key = 'essl' AND p.status != 'DISABLED'`, [sn]);
    if (!rows.length) return { refuse: [404, 'Unknown device'] };
    if (rows.length > 1) {
      // Which gym a punch belongs to cannot be guessed. Each gym is told.
      for (const row of rows) {
        await writeAudit(db, {
          orgId: row.org_id, action: 'access.adms.rejected', entityType: 'access_device', entityId: row.id,
          reason: `serial ${sn} is registered at more than one gym`, result: 'FAILED',
        });
      }
      return { refuse: [409, 'Device registered more than once'] };
    }
    const row = rows[0];
    const config = safeParse(row.config_json) || {};
    const ips = allowedIps(config);
    const ip = clientIp(req);
    if (ips && !ips.has(ip)) {
      await writeAudit(db, {
        orgId: row.org_id, action: 'access.adms.rejected', entityType: 'access_device', entityId: row.id,
        reason: `request from ${ip || 'an unknown address'}, not an allowed IP`, result: 'FAILED',
      });
      return { refuse: [403, 'Forbidden'] };
    }
    // Seen because it spoke, whatever it said.
    await db.run('UPDATE access_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), new Date().toISOString(), row.id]);
    return { sn, row, config };
  }

  /** Is this member inside right now, and since when -- for toggle mode. */
  async function openVisit(orgId, providerId, branchId, pin) {
    const { userId } = await resolveMember(db, { orgId, providerId, externalUserId: pin });
    if (!userId) return null;
    return branchId
      ? db.q1(`SELECT entered_at FROM gym_presence_sessions
                WHERE org_id = ? AND user_id = ? AND branch_id = ? AND status = 'OPEN'`, [orgId, userId, branchId])
      : db.q1(`SELECT entered_at FROM gym_presence_sessions
                WHERE org_id = ? AND user_id = ? AND branch_id IS NULL AND status = 'OPEN'`, [orgId, userId]);
  }

  async function ingestAttlog({ sn, row, config }, body) {
    const { punches, bad } = parseAttlog(body);
    const tz = await getOrgTzCached(db, row.org_id);
    const branchId = row.branch_id ?? row.provider_branch_id ?? null;
    // Toggle unless the owner said members press In / Out: one terminal at
    // reception with no keys pressed is the common gym, and read as
    // 'status' every one of its punches would be an arrival.
    const mode = config.punch_mode === 'status' ? 'status' : 'toggle';
    let unreadable = bad;
    let ahead = 0;
    // In order: in toggle mode each punch's meaning depends on the last.
    for (const punch of punches) {
      const occurredAt = localToUtcIso(punch.local, tz);
      if (!occurredAt) { unreadable += 1; continue; }
      // A clock running fast writes punches "in the future", which would
      // wedge the presence state machine. Refused, and the owner told.
      if (Date.parse(occurredAt) > Date.now() + MAX_CLOCK_AHEAD_MS) { ahead += 1; continue; }
      let eventType;
      if (mode === 'toggle') {
        const open = await openVisit(row.org_id, row.provider_id, branchId, punch.pin);
        const doubleScan = open && Date.parse(occurredAt) - Date.parse(open.entered_at) < DOUBLE_PUNCH_MS;
        eventType = doubleScan ? 'ENTRY' : punchDirection({ status: punch.status, device: row, punchMode: 'toggle', isInside: !!open });
      } else {
        eventType = punchDirection({ status: punch.status, device: row, punchMode: 'status' });
      }
      await ingestAccessEvent(db, {
        orgId: row.org_id,
        providerId: row.provider_id,
        deviceId: row.id,
        branchId,
        externalUserId: punch.pin,
        externalEventId: punchEventId(sn, punch),
        eventType,
        occurredAt,
        verificationStatus: 'unverified',
        source: 'webhook',
        // The device's own codes only: PIN, wall time, state, verify method.
        payload: { sn, pin: punch.pin, local: punch.local, status: punch.status, verify: punch.verify },
      });
    }
    if (ahead) {
      await writeAudit(db, {
        orgId: row.org_id, action: 'access.adms.clock_ahead', entityType: 'access_device', entityId: row.id,
        reason: `${ahead} punch${ahead === 1 ? '' : 'es'} timed ahead of the server clock -- check the terminal's date and time`,
        result: 'FAILED',
      });
    }
    if (unreadable) {
      await writeAudit(db, {
        orgId: row.org_id, action: 'access.adms.unreadable', entityType: 'access_device', entityId: row.id,
        reason: `${unreadable} attendance line${unreadable === 1 ? '' : 's'} could not be read`, result: 'FAILED',
      });
    }
    return punches.length + bad;
  }

  const handle = (fn) => async (req, res) => {
    try {
      const t = await terminal(req);
      if (t.refuse) return plain(res, ...t.refuse);
      return await fn(req, res, t);
    } catch {
      // Plain text even on failure: the firmware retries a non-OK reply.
      return plain(res, 500, 'ERROR');
    }
  };

  // Handshake: which tables to send, and how often.
  r.get(['/cdata', '/cdata.aspx'], handle((req, res, t) => plain(res, 200, handshakeResponse(t.sn))));

  r.post(['/cdata', '/cdata.aspx'], handle(async (req, res, t) => {
    const table = String(req.query.table || '').toUpperCase();
    const body = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (table === 'ATTLOG') return plain(res, 200, `OK: ${await ingestAttlog(t, body)}`);
    // Biometric templates and photos (BIOMETRIC_TABLES), if a device sends
    // them anyway, are acknowledged so it stops resending -- and discarded
    // unread. So is anything else we did not ask for (OPERLOG, user lists).
    return plain(res, 200, 'OK');
  }));

  // Heartbeat / command poll. We never send commands.
  r.get(['/getrequest', '/getrequest.aspx', '/ping'], handle((req, res) => plain(res, 200, 'OK')));
  r.post(['/devicecmd', '/devicecmd.aspx'], handle((req, res) => plain(res, 200, 'OK')));

  return r;
}
