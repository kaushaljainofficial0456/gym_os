// ============================================================
// ONE BUILDING, ONE NUMBER.
//
// There are two occupancy engines in this codebase and both are correct:
// one replays the manual check-in log, one counts open presence sessions
// from a door feed. What is not acceptable is two ANSWERS, and that is
// exactly what shipped first: with a panel connected, the owner dashboard
// said three people were inside while the member crowd card said zero.
//
// The second failure these cover is worse and was also real: demo events
// created presence sessions that counted toward the crowd figure members
// are shown. An owner trying the sandbox would have sent invented
// occupancy to everyone deciding whether to drive over.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveCrowd, hasLiveAccessFeed } from '../src/services/access/liveCrowd.js';
import { ingestAccessEvent } from '../src/services/access/ingest.js';
import { liveOccupancy, demoOccupancy } from '../src/services/access/presence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const TZ = 'UTC';

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

async function gym(db, { members = 4 } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run('INSERT INTO gym_settings (org_id, crowd_capacity, crowd_enabled) VALUES (?,?,1)', ['o1', 100]);
  for (let i = 0; i < members; i += 1) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT',?,1,?)`, [`u${i}`, `u${i}@x.in`, `M${i}`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [`c${i}`, `u${i}`, 'o1', ts]);
  }
  return db;
}

async function provider(db, { id, key, status = 'CONFIGURED', lastEvent = null }) {
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, last_event_at, created_at, updated_at)
                VALUES (?,'o1',?,?,?,?,?,?)`, [id, key, `${key} door`, status, lastEvent, ts, ts]);
}

async function mapMember(db, { providerId, userId, ext }) {
  await db.run(`INSERT INTO access_member_mappings (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`,
  [`map-${ext}`, 'o1', userId, userId.replace('u', 'c'), providerId, ext, ts, ts]);
}

const settings = (extra = {}) => ({ crowd_enabled: 1, crowd_capacity: 100, ...extra });

const manualScan = (db, clientId, at, direction) => db.run(
  'INSERT INTO attendance_events (id, org_id, client_id, ts, direction) VALUES (?,?,?,?,?)',
  [`att-${clientId}-${at}-${direction}`, 'o1', clientId, at, direction]);

test('with no door feed, the manual check-in log is the answer', async () => {
  const db = await memDb();
  await gym(db);
  const today = new Date().toISOString().slice(0, 10);
  await manualScan(db, 'c0', `${today}T09:00:00.000Z`, 'entry');
  await manualScan(db, 'c1', `${today}T09:05:00.000Z`, 'entry');

  assert.equal(await hasLiveAccessFeed(db, 'o1'), false);
  const crowd = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(crowd.source, 'manual_checkin');
  assert.equal(crowd.current, 2);
});

test('a panel that is delivering events is the answer, even if nobody pressed Test', async () => {
  /* The first version of this gated on status = 'ACTIVE'. A gym whose
     panel had been posting signed events all morning still read
     CONFIGURED, so occupancy fell back to the manual log and reported an
     empty gym with three people in it. Whether a human clicked a button
     is not evidence about the building. */
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'CONFIGURED' });
  await mapMember(db, { providerId: 'p1', userId: 'u0', ext: 'badge-0' });

  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1', externalUserId: 'badge-0', externalEventId: 'e1',
    eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'webhook',
  });

  assert.equal(await hasLiveAccessFeed(db, 'o1'), true, 'it has spoken, so it counts');
  const crowd = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(crowd.source, 'access_control');
  assert.equal(crowd.current, 1);
});

test('the member card and the owner dashboard cannot disagree', async () => {
  // The bug in one line: two engines, one building, two numbers.
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'ACTIVE' });
  await mapMember(db, { providerId: 'p1', userId: 'u0', ext: 'a' });
  await mapMember(db, { providerId: 'p1', userId: 'u1', ext: 'b' });

  const today = new Date().toISOString().slice(0, 10);
  // Manual log says one thing...
  await manualScan(db, 'c2', `${today}T08:00:00.000Z`, 'entry');
  await manualScan(db, 'c3', `${today}T08:01:00.000Z`, 'entry');
  // ...the door says another.
  for (const ext of ['a', 'b']) {
    await ingestAccessEvent(db, {
      orgId: 'o1', providerId: 'p1', externalUserId: ext, externalEventId: `in-${ext}`,
      eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'webhook',
    });
  }

  const owner = await liveCrowd(db, 'o1', TZ, settings());
  const member = await liveCrowd(db, 'o1', TZ, settings(), { showExactCount: true });
  assert.equal(owner.current, member.current);
  assert.equal(owner.source, 'access_control');
  // NOT 4 -- the two sources describe overlapping people and are never
  // summed. A gym mid-migration would otherwise double every member.
  assert.equal(owner.current, 2);
});

/* ── demo isolation ────────────────────────────────────────────────── */

test('demo events never reach the crowd figure members are shown', async () => {
  /* Caught live. Demo entries created ordinary presence sessions, so an
     owner exploring the sandbox published invented occupancy to every
     member checking whether the gym was busy. */
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'pd', key: 'demo', status: 'ACTIVE' });
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'ACTIVE' });
  await mapMember(db, { providerId: 'pd', userId: 'u0', ext: 'sim-1' });
  await mapMember(db, { providerId: 'pd', userId: 'u1', ext: 'sim-2' });
  await mapMember(db, { providerId: 'p1', userId: 'u2', ext: 'real-1' });

  for (const ext of ['sim-1', 'sim-2']) {
    await ingestAccessEvent(db, {
      orgId: 'o1', providerId: 'pd', externalUserId: ext, externalEventId: `d-${ext}`,
      eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'demo',
    });
  }
  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1', externalUserId: 'real-1', externalEventId: 'r-1',
    eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'webhook',
  });

  assert.equal(await liveOccupancy(db, 'o1'), 1, 'one real person is inside');
  assert.equal(await demoOccupancy(db, 'o1'), 2, 'and the sandbox is separately visible');
  assert.equal(await liveOccupancy(db, 'o1', { includeDemo: true }), 3, 'only when asked for explicitly');

  const crowd = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(crowd.current, 1, 'members see the real building');
});

test('a demo-only gym is not switched onto a simulated feed', async () => {
  /* The other half of the isolation. Without this, an owner who opened
     the sandbox on a gym still using manual check-in would have flipped
     their whole crowd card onto invented data. */
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'pd', key: 'demo', status: 'ACTIVE', lastEvent: new Date().toISOString() });
  await mapMember(db, { providerId: 'pd', userId: 'u0', ext: 'sim-1' });
  const today = new Date().toISOString().slice(0, 10);
  await manualScan(db, 'c1', `${today}T09:00:00.000Z`, 'entry');

  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'pd', externalUserId: 'sim-1', externalEventId: 'd-1',
    eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'demo',
  });

  assert.equal(await hasLiveAccessFeed(db, 'o1'), false, 'a sandbox is not a door feed');
  const crowd = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(crowd.source, 'manual_checkin');
  assert.equal(crowd.current, 1, 'the real manual count, not the simulated one');
});

test('demo traffic does not make a dead panel look alive', async () => {
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'ACTIVE' });
  await provider(db, { id: 'pd', key: 'demo', status: 'ACTIVE' });
  await mapMember(db, { providerId: 'p1', userId: 'u0', ext: 'real-1' });
  await mapMember(db, { providerId: 'pd', userId: 'u1', ext: 'sim-1' });

  // A real event, six hours ago. Then demo traffic, just now.
  const old = new Date(Date.now() - 6 * 3600_000).toISOString();
  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1', externalUserId: 'real-1', externalEventId: 'r-1',
    eventType: 'ENTRY', occurredAt: old, source: 'webhook',
  });
  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'pd', externalUserId: 'sim-1', externalEventId: 'd-1',
    eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'demo',
  });

  const crowd = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(crowd.isLive, undefined);
  assert.equal(crowd.freshness.isLive, false, 'the real feed is six hours stale and says so');
  assert.equal(crowd.freshness.state, 'stale');
  assert.equal(crowd.lastEventAt, old, 'freshness tracks the real door, not the sandbox');
});

/* ── switches ──────────────────────────────────────────────────────── */

test('turning the engine off reports disabled, not an empty gym', async () => {
  // "0 people inside" and "we are not tracking this" are different facts,
  // and a member acting on the first when the second is true drives to a
  // packed gym.
  const db = await memDb();
  await gym(db);
  const crowd = await liveCrowd(db, 'o1', TZ, settings({ crowd_enabled: 0 }));
  assert.equal(crowd.enabled, false);
  assert.equal(crowd.source, 'disabled');
  assert.equal(crowd.current, null);
});

test('thresholds configured by the gym are what members are judged against', async () => {
  /* The whole reason crowd status is decided on the server. A 40-person
     studio and a 400-person warehouse do not mean the same thing by
     "busy", and four screens each banding a percentage themselves would
     drift the moment one gym changed its settings. */
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'ACTIVE' });
  for (let i = 0; i < 4; i += 1) {
    await mapMember(db, { providerId: 'p1', userId: `u${i}`, ext: `x${i}` });
    await ingestAccessEvent(db, {
      orgId: 'o1', providerId: 'p1', externalUserId: `x${i}`, externalEventId: `e${i}`,
      eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'webhook',
    });
  }

  // 4 of 100 is 4%: quiet under the defaults.
  const lax = await liveCrowd(db, 'o1', TZ, settings());
  assert.equal(lax.crowd.status, 'quiet');

  // A boutique studio that calls 4% busy is judged by its own numbers.
  const strict = await liveCrowd(db, 'o1', TZ, settings({
    crowd_threshold_quiet: 1, crowd_threshold_moderate: 2, crowd_threshold_busy: 3,
  }));
  assert.equal(strict.crowd.status, 'very_busy');
  assert.equal(strict.current, 4, 'the same four people, judged differently');
});

test('the member privacy setting applies whichever engine answers', async () => {
  const db = await memDb();
  await gym(db);
  await provider(db, { id: 'p1', key: 'generic_webhook', status: 'ACTIVE' });
  await mapMember(db, { providerId: 'p1', userId: 'u0', ext: 'a' });
  await ingestAccessEvent(db, {
    orgId: 'o1', providerId: 'p1', externalUserId: 'a', externalEventId: 'e1',
    eventType: 'ENTRY', occurredAt: new Date().toISOString(), source: 'webhook',
  });

  const hidden = await liveCrowd(db, 'o1', TZ, settings(), { showExactCount: false });
  assert.equal(hidden.current, null, 'the door-feed path honours it too');
  assert.equal(hidden.crowd.occupancyCount, null);
  assert.equal(hidden.crowd.occupancyPercentage, 1, 'how busy it is is still reported');
});
