// ============================================================
// EVERY WAY A REAL DOOR LIES.
//
// Occupancy is the number the member's crowd card, the owner dashboard
// and the capacity alerts are all built on, so the presence state machine
// is the single piece of this feature that cannot be approximately right.
// These tests are written from the failure modes a physical gym actually
// produces -- people scanning twice, forgetting to scan out, devices going
// offline and uploading a backlog, providers retrying webhooks -- rather
// than from the happy path, which never breaks.
//
// The invariant underneath all of them: occupancy is a COUNT OF OPEN
// SESSIONS. It cannot go negative because there is no row to close, not
// because a number gets clamped somewhere.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestAccessEvent, redactPayload, resolveEventType } from '../src/services/access/ingest.js';
import { liveOccupancy, reconcileStaleSessions, staleSessions, RE_ENTRY_RECONCILE_MS } from '../src/services/access/presence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw,
  });
  return mk();
}

async function gym(db, { members = 3, branches = 0 } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, created_at, updated_at)
                VALUES ('p1','o1','generic_webhook','Main door','ACTIVE',?,?)`, [ts, ts]);
  for (let i = 0; i < branches; i += 1) {
    await db.run('INSERT INTO branches (id, org_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
      [`b${i + 1}`, 'o1', `Branch ${i + 1}`, ts, ts]);
  }
  for (let i = 0; i < members; i += 1) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT',?,1,?)`, [`u${i}`, `u${i}@x.in`, `Member ${i}`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [`c${i}`, `u${i}`, 'o1', ts]);
    await db.run(`INSERT INTO access_member_mappings
                    (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
                  VALUES (?,?,?,?,'p1',?,?,?)`,
      [`m${i}`, 'o1', `u${i}`, `c${i}`, `ext${i}`, ts, ts]);
  }
  return db;
}

let evSeq = 0;
const scan = (db, { who = 'ext0', type = 'ENTRY', at, eventId, device = null, branch = null, source = 'webhook' } = {}) =>
  ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1',
    externalUserId: who,
    externalEventId: eventId === undefined ? `evt${evSeq += 1}` : eventId,
    eventType: type,
    occurredAt: at || new Date().toISOString(),
    deviceIdentifier: device, branchId: branch, source,
  });

const occ = (db, branchId) => liveOccupancy(db, 'o1', { branchId });

/* ── the ordinary case ─────────────────────────────────────────────── */

test('entry puts one person inside, exit takes them out', async () => {
  const db = await memDb();
  await gym(db);

  assert.equal(await occ(db), 0);
  const a = await scan(db, { type: 'ENTRY', at: '2026-09-16T09:00:00Z' });
  assert.equal(a.outcome, 'entered');
  assert.equal(await occ(db), 1);

  const b = await scan(db, { type: 'EXIT', at: '2026-09-16T10:30:00Z' });
  assert.equal(b.outcome, 'exited');
  assert.equal(await occ(db), 0);

  const session = await db.q1("SELECT * FROM gym_presence_sessions WHERE org_id='o1'");
  assert.equal(session.status, 'CLOSED');
  assert.equal(session.closure_reason, 'normal_exit');
  assert.equal(session.confidence, 'exact', 'a real scan gives an exact time');
  assert.equal(session.duration_sec, 90 * 60);
});

/* ── the four spec cases ───────────────────────────────────────────── */

test('a second entry while already inside does not add a second person', async () => {
  // People press again when a door is slow. This is the most common
  // non-event in the whole system.
  const db = await memDb();
  await gym(db);
  await scan(db, { type: 'ENTRY', at: '2026-09-16T10:00:00Z' });
  const dup = await scan(db, { type: 'ENTRY', at: '2026-09-16T10:01:00Z' });

  assert.equal(dup.outcome, 'duplicate_entry');
  assert.equal(dup.occupancyDelta, 0);
  assert.equal(await occ(db), 1);
  // Recorded, not discarded -- the owner's queue needs to be able to
  // explain the count.
  const row = await db.q1("SELECT * FROM access_events WHERE processing_status='IGNORED_DUPLICATE'");
  assert.ok(row, 'the duplicate is still written down');
  assert.equal(row.affected_occupancy, 0);
});

test('an exit with nobody inside cannot drive occupancy negative', async () => {
  const db = await memDb();
  await gym(db);
  const a = await scan(db, { type: 'EXIT', at: '2026-09-16T11:00:00Z' });
  assert.equal(a.outcome, 'duplicate_exit');
  assert.equal(await occ(db), 0, 'not -1');

  await scan(db, { type: 'ENTRY', at: '2026-09-16T11:05:00Z' });
  await scan(db, { type: 'EXIT', at: '2026-09-16T12:00:00Z' });
  const b = await scan(db, { type: 'EXIT', at: '2026-09-16T12:01:00Z' });
  assert.equal(b.outcome, 'duplicate_exit');
  assert.equal(await occ(db), 0);
});

test('a denied scan is somebody who did not come in', async () => {
  const db = await memDb();
  await gym(db);
  const r = await scan(db, { type: 'DENIED', at: '2026-09-16T09:00:00Z' });
  assert.equal(r.outcome, 'denied');
  assert.equal(await occ(db), 0);
  const row = await db.q1("SELECT * FROM access_events WHERE event_type='DENIED'");
  assert.equal(row.processing_status, 'PROCESSED', 'it is a real record, just not an arrival');
  assert.equal(row.affected_occupancy, 0);
});

test('an unrecognised person is kept for reconciliation, not dropped', async () => {
  const db = await memDb();
  await gym(db);
  const r = await scan(db, { who: 'nobody-we-know', type: 'ENTRY', at: '2026-09-16T09:00:00Z' });
  assert.equal(r.outcome, 'unmatched');
  assert.equal(await occ(db), 0);
  const row = await db.q1("SELECT * FROM access_events WHERE processing_status='UNMATCHED'");
  assert.equal(row.external_user_id, 'nobody-we-know', 'their identifier is kept so it can be mapped later');
  assert.equal(row.user_id, null);
});

/* ── idempotency ───────────────────────────────────────────────────── */

test('the same provider event delivered twice moves nothing', async () => {
  // Providers retry. A retry that adds a person is the bug that makes a
  // gym report double its real crowd on a flaky network.
  const db = await memDb();
  await gym(db);
  const first = await scan(db, { type: 'ENTRY', at: '2026-09-16T09:00:00Z', eventId: 'vendor-99' });
  const second = await scan(db, { type: 'ENTRY', at: '2026-09-16T09:00:00Z', eventId: 'vendor-99' });

  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.occupancyDelta, 0);
  assert.equal(await occ(db), 1);
  const n = await db.q1("SELECT COUNT(*) AS n FROM access_events WHERE external_event_id='vendor-99'");
  assert.equal(Number(n.n), 1, 'one vendor event is one row');
});

test('two members can share an event id across different providers', async () => {
  // Vendor event ids are only unique within a vendor. Treating them as
  // globally unique would silently drop a second provider's traffic.
  const db = await memDb();
  await gym(db);
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, created_at, updated_at)
                VALUES ('p2','o1','generic_rest','Side door','ACTIVE',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_member_mappings (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
                VALUES ('m9','o1','u1','c1','p2','ext1',?,?)`, [ts, ts]);

  await scan(db, { who: 'ext0', type: 'ENTRY', at: '2026-09-16T09:00:00Z', eventId: 'shared-1' });
  const other = await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p2', externalUserId: 'ext1', externalEventId: 'shared-1',
    eventType: 'ENTRY', occurredAt: '2026-09-16T09:01:00Z',
  });
  assert.equal(other.status, 'accepted');
  assert.equal(await occ(db), 2);
});

/* ── missing exits ─────────────────────────────────────────────────── */

test('re-entry hours later closes the forgotten session instead of ignoring the scan', async () => {
  /* If this were treated as a plain duplicate, the member would stay
     "inside" forever and the gym's occupancy would gain one permanent
     phantom per forgotten exit -- the single biggest source of drift in
     any real access system. */
  const db = await memDb();
  await gym(db);
  const morning = '2026-09-16T07:00:00Z';
  const evening = new Date(Date.parse(morning) + RE_ENTRY_RECONCILE_MS + 60_000).toISOString();

  await scan(db, { type: 'ENTRY', at: morning });
  const again = await scan(db, { type: 'ENTRY', at: evening });

  assert.equal(again.outcome, 'entered', 'the evening visit is a real visit');
  assert.equal(await occ(db), 1, 'still one person, not two');

  const sessions = await db.q('SELECT * FROM gym_presence_sessions ORDER BY entered_at');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].status, 'CLOSED');
  assert.equal(sessions[0].closure_reason, 'next_entry_reconciliation');
  assert.equal(sessions[0].confidence, 'estimated');
  assert.equal(sessions[0].exited_at, null, 'we know they left, not when — so we do not invent a time');
  assert.equal(sessions[0].duration_sec, null, 'and therefore claim no duration');
});

test('auto-close sweeps sessions nobody ended, and says they are estimates', async () => {
  const db = await memDb();
  await gym(db);
  const longAgo = new Date(Date.now() - 20 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 1 * 3600_000).toISOString();
  await scan(db, { who: 'ext0', type: 'ENTRY', at: longAgo });
  await scan(db, { who: 'ext1', type: 'ENTRY', at: recent });

  assert.equal(await occ(db), 2);
  const pending = await staleSessions(db, 'o1', { maxHours: 12 });
  assert.equal(pending.length, 1, 'only the overnight one is stale');

  const result = await reconcileStaleSessions(db, 'o1', { maxHours: 12 });
  assert.equal(result.closed, 1);
  assert.equal(await occ(db), 1, 'the member who is genuinely still here stays');

  const closed = await db.q1("SELECT * FROM gym_presence_sessions WHERE status='CLOSED'");
  assert.equal(closed.closure_reason, 'auto_closed');
  assert.equal(closed.confidence, 'estimated');
  assert.equal(closed.exited_at, null);
});

/* ── late and out-of-order events ──────────────────────────────────── */

test('an exit stamped before its own entry is refused', async () => {
  // A device with a wrong clock. Accepting it produces a negative
  // duration, which becomes a negative average visit length on the
  // owner's dashboard.
  const db = await memDb();
  await gym(db);
  await scan(db, { type: 'ENTRY', at: '2026-09-16T10:00:00Z' });
  const bad = await scan(db, { type: 'EXIT', at: '2026-09-16T09:00:00Z' });

  assert.equal(bad.outcome, 'invalid');
  assert.equal(await occ(db), 1, 'the person is still inside');
  const open = await db.q1("SELECT * FROM gym_presence_sessions WHERE status='OPEN'");
  assert.ok(open);
});

test('an unusable timestamp is rejected and recorded, never guessed', async () => {
  const db = await memDb();
  await gym(db);
  for (const bad of ['', 'yesterday', null, undefined, 'not-a-date']) {
    const r = await ingestAccessEvent(db, {
      orgId: 'o1', providerId: 'p1', externalUserId: 'ext0',
      externalEventId: `bad-${String(bad)}`, eventType: 'ENTRY', occurredAt: bad,
    });
    assert.equal(r.status, 'rejected', `${JSON.stringify(bad)} must not be accepted`);
  }
  assert.equal(await occ(db), 0);
  const n = await db.q1("SELECT COUNT(*) AS n FROM access_events WHERE processing_status='REJECTED'");
  assert.equal(Number(n.n), 5, 'each one is written down with its reason');
});

/* ── branches ──────────────────────────────────────────────────────── */

test('branches count separately and do not leak into each other', async () => {
  const db = await memDb();
  await gym(db, { branches: 2 });
  await db.run(`INSERT INTO access_devices (id, org_id, branch_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('d1','o1','b1','p1','North door','NORTH','both',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_devices (id, org_id, branch_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('d2','o1','b2','p1','South door','SOUTH','both',?,?)`, [ts, ts]);

  await scan(db, { who: 'ext0', type: 'ENTRY', at: '2026-09-16T09:00:00Z', device: 'NORTH' });
  await scan(db, { who: 'ext1', type: 'ENTRY', at: '2026-09-16T09:05:00Z', device: 'SOUTH' });
  await scan(db, { who: 'ext2', type: 'ENTRY', at: '2026-09-16T09:06:00Z', device: 'SOUTH' });

  assert.equal(await occ(db, 'b1'), 1);
  assert.equal(await occ(db, 'b2'), 2);
  assert.equal(await occ(db), 3, 'the org total is every branch');

  // Exiting at the wrong branch does not close the other branch's session.
  await scan(db, { who: 'ext0', type: 'EXIT', at: '2026-09-16T10:00:00Z', device: 'SOUTH' });
  assert.equal(await occ(db, 'b1'), 1, 'they are still inside the branch they entered');
});

test('the same member can be inside two branches only as two sessions', async () => {
  // Physically odd, operationally real (staff moving between sites). What
  // must not happen is one branch's exit closing the other's session.
  const db = await memDb();
  await gym(db, { branches: 2 });
  await db.run(`INSERT INTO access_devices (id, org_id, branch_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('d1','o1','b1','p1','A','A','both',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_devices (id, org_id, branch_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('d2','o1','b2','p1','B','B','both',?,?)`, [ts, ts]);

  await scan(db, { who: 'ext0', type: 'ENTRY', at: '2026-09-16T09:00:00Z', device: 'A' });
  await scan(db, { who: 'ext0', type: 'ENTRY', at: '2026-09-16T09:10:00Z', device: 'B' });
  assert.equal(await occ(db, 'b1'), 1);
  assert.equal(await occ(db, 'b2'), 1);

  const open = await db.q("SELECT * FROM gym_presence_sessions WHERE status='OPEN'");
  assert.equal(open.length, 2);
});

test('a single-branch gym (branch_id NULL) still matches its own open session', async () => {
  /* `branch_id = NULL` is never true in SQL. A naive lookup therefore
     finds no open session for a single-branch gym, opens a second one,
     and the unique index rejects it -- leaving occupancy frozen at
     whatever the first scan of the day produced. */
  const db = await memDb();
  await gym(db);
  await scan(db, { type: 'ENTRY', at: '2026-09-16T09:00:00Z' });
  const dup = await scan(db, { type: 'ENTRY', at: '2026-09-16T09:02:00Z' });
  assert.equal(dup.outcome, 'duplicate_entry', 'the open session was found despite the null branch');

  const out = await scan(db, { type: 'EXIT', at: '2026-09-16T10:00:00Z' });
  assert.equal(out.outcome, 'exited');
  assert.equal(await occ(db), 0);
});

/* ── device direction ──────────────────────────────────────────────── */

test('a one-way reader tells us what its events mean', async () => {
  const db = await memDb();
  await gym(db);
  await db.run(`INSERT INTO access_devices (id, org_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('din','o1','p1','In gate','IN','entry',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_devices (id, org_id, provider_id, device_name, device_identifier, direction, created_at, updated_at)
                VALUES ('dout','o1','p1','Out gate','OUT','exit',?,?)`, [ts, ts]);

  await scan(db, { type: null, at: '2026-09-16T09:00:00Z', device: 'IN' });
  assert.equal(await occ(db), 1);
  await scan(db, { type: null, at: '2026-09-16T10:00:00Z', device: 'OUT' });
  assert.equal(await occ(db), 0);
});

test('a two-way device that omits the direction is UNKNOWN, never guessed', async () => {
  // Guessing "entry" is how a gym ends up with a count that only rises.
  assert.equal(resolveEventType(null, { direction: 'both' }), 'UNKNOWN');
  assert.equal(resolveEventType('', null), 'UNKNOWN');
  assert.equal(resolveEventType('in', { direction: 'both' }), 'ENTRY');
  assert.equal(resolveEventType('punch_out', { direction: 'both' }), 'UNKNOWN');
  assert.equal(resolveEventType('OUT', { direction: 'both' }), 'EXIT');
});

/* ── the biometric boundary ────────────────────────────────────────── */

test('nothing that looks like biometric or credential data is ever stored', async () => {
  /* The promise this feature makes. A vendor that helpfully includes the
     matched template in its webhook must not have it persisted, and the
     check is on the FIELD NAME so an unknown vendor's unknown field still
     gets caught. */
  const db = await memDb();
  await gym(db);
  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1', externalUserId: 'ext0', externalEventId: 'bio-1',
    eventType: 'ENTRY', occurredAt: '2026-09-16T09:00:00Z',
    payload: {
      user_id: 'ext0',
      fingerprint_template: 'AAAABBBBCCCC...',
      face_embedding: [0.1, 0.2, 0.3],
      photo_base64: 'iVBORw0KGgo=',
      api_key: 'sk_live_supersecret',
      device: { serial: 'NORTH-1', biometric_data: 'xxx' },
      note: 'ordinary field survives',
    },
  });

  const row = await db.q1("SELECT payload_json FROM access_events WHERE external_event_id='bio-1'");
  const stored = JSON.parse(row.payload_json);
  assert.equal(stored.fingerprint_template, '[redacted]');
  assert.equal(stored.face_embedding, '[redacted]');
  assert.equal(stored.photo_base64, '[redacted]');
  assert.equal(stored.api_key, '[redacted]');
  assert.equal(stored.device.biometric_data, '[redacted]', 'nested fields too');
  assert.equal(stored.note, 'ordinary field survives');
  assert.equal(stored.device.serial, 'NORTH-1');

  // And nothing anywhere in the whole row spells the secret out.
  assert.ok(!/supersecret|AAAABBBB|iVBORw/.test(row.payload_json), row.payload_json);
});

test('redaction survives long strings and deep nesting without blowing up', async () => {
  const deep = { a: { b: { c: { d: { e: { fingerprint: 'x' } } } } } };
  assert.doesNotThrow(() => redactPayload(deep));
  const long = redactPayload({ blob: 'x'.repeat(5000) });
  assert.ok(long.blob.length < 200, 'a huge string is truncated, not stored whole');
});

/* ── cross-gym isolation ───────────────────────────────────────────── */

test('one gym cannot see or affect another gym occupancy', async () => {
  const db = await memDb();
  await gym(db);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o2', 'Other', 'other', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('ou','o2','o@x.in','x','CLIENT','Other',1,?)`, [ts]);
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, created_at, updated_at)
                VALUES ('op','o2','demo','Other door','ACTIVE',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_member_mappings (id, org_id, user_id, provider_id, external_user_id, created_at, updated_at)
                VALUES ('om','o2','ou','op','ext0',?,?)`, [ts, ts]);

  await scan(db, { who: 'ext0', type: 'ENTRY', at: '2026-09-16T09:00:00Z' });
  await ingestAccessEvent(db, {
    orgId: 'o2', providerId: 'op', externalUserId: 'ext0',
    externalEventId: 'other-1', eventType: 'ENTRY', occurredAt: '2026-09-16T09:00:00Z',
  });

  assert.equal(await liveOccupancy(db, 'o1'), 1);
  assert.equal(await liveOccupancy(db, 'o2'), 1);
  // The SAME external id in two gyms is two different people, and must
  // not resolve across the tenant boundary.
  const mine = await db.q1("SELECT user_id FROM access_events WHERE org_id='o1'");
  const theirs = await db.q1("SELECT user_id FROM access_events WHERE org_id='o2'");
  assert.equal(mine.user_id, 'u0');
  assert.equal(theirs.user_id, 'ou');
});
