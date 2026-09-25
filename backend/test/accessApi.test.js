// ============================================================
// THE ACCESS-CONTROL API, TESTED AS AN ATTACKER WOULD READ IT.
//
// This surface hands out the ability to open a building. The tests below
// are mostly about what must NOT happen:
//
//   * a credential must never come back out of the API, in any response,
//     including the one that created it;
//   * one gym must never see another gym's doors, events or connections;
//   * an unsigned or stale webhook must never be processed as trusted;
//   * an owner-supplied URL must never be used to make SK OS call its own
//     internal network;
//   * a provider we have not actually built must never be connectable.
//
// The happy paths are here too, but they are the easy half.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeUrl } from '../src/routes/access.js';

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
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const accessRoutes = (await import('../src/routes/access.js'));
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  for (const [org, slug] of [['o1', 'gym-one'], ['o2', 'gym-two']]) {
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', [org, org, slug, ts]);
    await db.run('INSERT INTO gym_settings (org_id, crowd_capacity) VALUES (?,?)', [org, 100]);
  }
  /* MANAGER and STAFF do not exist in users.role -- the schema's CHECK
     constraint allows only SUPER_ADMIN/GYM_OWNER/TRAINER/CLIENT, and the
     per-gym roles live in gym_memberships by design. So they are seeded
     the way the product actually creates them: an ordinary account plus a
     membership row carrying the gym role. The access routes resolve the
     effective role from that, which is the only reason a manager can
     reach these endpoints at all. */
  const people = [
    ['own1', 'o1', 'GYM_OWNER', null],
    ['mgr1', 'o1', 'TRAINER', 'MANAGER'],
    ['stf1', 'o1', 'TRAINER', 'STAFF'],
    ['trn1', 'o1', 'TRAINER', null],
    ['cli1', 'o1', 'CLIENT', null],
    ['own2', 'o2', 'GYM_OWNER', null],
  ];
  for (const [id, org, role, gymRole] of people) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,?,?,'x',?,?,1,?)`, [id, org, `${id}@x.in`, role, id, ts]);
    if (gymRole) {
      await db.run(`INSERT INTO gym_memberships (id, user_id, org_id, role, status, joined_at, created_at, updated_at)
                    VALUES (?,?,?,?,'ACTIVE',?,?,?)`, [`gm-${id}`, id, org, gymRole, ts, ts, ts]);
    }
  }
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c1', 'cli1', 'o1', ts]);

  const app = express();
  app.use('/api/access/hook', express.raw({ type: 'application/json', limit: '512kb' }));
  app.use(express.json());
  app.use('/api/access', accessRoutes.accessWebhookRoutes(db));
  app.use('/api/admin/access', accessRoutes.default(db));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  });

  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const tokenFor = (id) => {
    const p = people.find((x) => x[0] === id);
    // The JWT carries users.role, exactly as signToken does in production.
    return jwt.sign({ sub: id, role: p[2], org: p[1], name: id, email: `${id}@x.in` }, config.jwtSecret);
  };
  const call = (who, method, url, body) => fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, port, close };
}

/* ── the catalogue is honest ───────────────────────────────────────── */

test('providers we have not built are listed but not connectable', async (t) => {
  /* The spec's rule, and the one most likely to be quietly broken: an
     owner must never be offered a ZKTeco Connect button backed by a guess
     at ZKTeco's payload format. */
  const { call, close } = await startApi();
  t.after(() => close());

  const cat = await (await call('own1', 'GET', '/api/admin/access/providers/catalogue')).json();
  const zk = cat.providers.find((p) => p.key === 'zkteco');
  assert.ok(zk, 'the vendor is still recognised, so the owner knows we know it');
  assert.equal(zk.implemented, false);

  const attempt = await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'zkteco', displayName: 'Front door' });
  assert.equal(attempt.status, 400);
  const body = await attempt.json();
  assert.equal(body.code, 'adapter_not_implemented');
  assert.match(body.error, /Webhook or REST/i, 'and is told what does work');

  const demo = cat.providers.find((p) => p.key === 'demo');
  assert.equal(demo.implemented, true);
});

/* ── secrets ───────────────────────────────────────────────────────── */

test('a signing secret is shown exactly once and never again', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());

  const created = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Main door' })).json();

  assert.ok(created.signingSecretShownOnce, 'returned once, at creation');
  assert.match(created.signingSecretShownOnce, /^[0-9a-f]{64}$/);
  assert.ok(created.webhookUrl.includes(created.provider.id));

  // Every later read shows a mask and nothing else.
  const list = await (await call('own1', 'GET', '/api/admin/access/providers')).json();
  const p = list.providers[0];
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes(created.signingSecretShownOnce), 'the secret is not in the listing');
  assert.ok(!/ciphertext/i.test(serialized), 'nor is the stored ciphertext');
  assert.equal(p.secrets.length, 1);
  assert.match(p.secrets[0].masked, /^•+[0-9a-f]{4}$/);
});

test('rotating a webhook secret invalidates the old one', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const created = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Main door' })).json();

  const rotated = await (await call('own1', 'POST',
    `/api/admin/access/providers/${created.provider.id}/rotate-secret`, { kind: 'webhook_secret' })).json();
  assert.ok(rotated.shownOnce);
  assert.notEqual(rotated.shownOnce, created.signingSecretShownOnce);

  // Exactly one secret row survives -- a rotate that left the old one
  // working would not be a rotate.
  const rows = await db.q('SELECT * FROM access_provider_secrets WHERE provider_id = ?', [created.provider.id]);
  assert.equal(rows.length, 1);
});

/* ── webhook authentication ────────────────────────────────────────── */

async function connectWebhookGym(call, db, { org = 'o1', who = 'own1' } = {}) {
  const created = await (await call(who, 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Main door' })).json();
  await db.run(`INSERT INTO access_member_mappings (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`,
  [`map-${org}`, org, org === 'o1' ? 'cli1' : 'own2', org === 'o1' ? 'c1' : null, created.provider.id, 'badge-7', ts, ts]);
  return created;
}

function signed(secret, body, atSec = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      'x-skos-timestamp': String(atSec),
      'x-skos-signature': createHmac('sha256', secret).update(`${atSec}.${raw}`).digest('hex'),
    },
  };
}

test('a correctly signed event is accepted and moves occupancy', async (t) => {
  const { db, call, port, close } = await startApi();
  t.after(() => close());
  const created = await connectWebhookGym(call, db);

  const { raw, headers } = signed(created.signingSecretShownOnce, {
    user_id: 'badge-7', event_id: 'e1', direction: 'entry', timestamp: '2026-09-16T09:00:00Z',
  });
  const res = await fetch(`http://127.0.0.1:${port}/api/access/hook/${created.provider.id}`,
    { method: 'POST', headers, body: raw });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accepted, 1);
  const n = await db.q1("SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE status='OPEN'");
  assert.equal(Number(n.n), 1);
});

test('an unsigned or wrongly signed request is never processed', async (t) => {
  const { db, call, port, close } = await startApi();
  t.after(() => close());
  const created = await connectWebhookGym(call, db);
  const url = `http://127.0.0.1:${port}/api/access/hook/${created.provider.id}`;
  const payload = { user_id: 'badge-7', event_id: 'e2', direction: 'entry', timestamp: '2026-09-16T09:00:00Z' };

  // No headers at all.
  const bare = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(bare.status, 401);

  // Signed with the wrong key.
  const wrong = signed('not-the-secret', payload);
  const bad = await fetch(url, { method: 'POST', headers: wrong.headers, body: wrong.raw });
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).reason, /signature/i);

  const n = await db.q1('SELECT COUNT(*) AS n FROM access_events');
  assert.equal(Number(n.n), 0, 'nothing untrusted reached the event log');
});

test('a valid signature from last week is still a replay', async (t) => {
  /* Signature alone is not enough. Without the timestamp check, anyone who
     captured one authentic request could re-send it forever and open the
     count by one each time. */
  const { db, call, port, close } = await startApi();
  t.after(() => close());
  const created = await connectWebhookGym(call, db);

  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const { raw, headers } = signed(created.signingSecretShownOnce, {
    user_id: 'badge-7', event_id: 'e3', direction: 'entry', timestamp: '2026-09-16T09:00:00Z',
  }, weekAgo);
  const res = await fetch(`http://127.0.0.1:${port}/api/access/hook/${created.provider.id}`,
    { method: 'POST', headers, body: raw });

  assert.equal(res.status, 401);
  assert.match((await res.json()).reason, /replay|window/i);
  assert.equal(Number((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n), 0);
});

test('the same signed event delivered twice counts once', async (t) => {
  const { db, call, port, close } = await startApi();
  t.after(() => close());
  const created = await connectWebhookGym(call, db);
  const url = `http://127.0.0.1:${port}/api/access/hook/${created.provider.id}`;
  const payload = { user_id: 'badge-7', event_id: 'retry-1', direction: 'entry', timestamp: '2026-09-16T09:00:00Z' };

  const a = signed(created.signingSecretShownOnce, payload);
  const first = await (await fetch(url, { method: 'POST', headers: a.headers, body: a.raw })).json();
  const b = signed(created.signingSecretShownOnce, payload);
  const second = await (await fetch(url, { method: 'POST', headers: b.headers, body: b.raw })).json();

  assert.equal(first.accepted, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(second.accepted, 0);
  assert.equal(Number((await db.q1("SELECT COUNT(*) AS n FROM gym_presence_sessions")).n), 1);
});

test('an unknown or disabled endpoint answers the same way', async (t) => {
  // Distinguishing them would tell an attacker which connection ids exist.
  const { db, call, port, close } = await startApi();
  t.after(() => close());
  const created = await connectWebhookGym(call, db);

  const unknown = await fetch(`http://127.0.0.1:${port}/api/access/hook/does-not-exist`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await call('own1', 'DELETE', `/api/admin/access/providers/${created.provider.id}`);
  const disabled = await fetch(`http://127.0.0.1:${port}/api/access/hook/${created.provider.id}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  assert.equal(unknown.status, 404);
  assert.equal(disabled.status, 404);
  assert.deepEqual(await unknown.json(), await disabled.json());
});

/* ── tenant isolation ──────────────────────────────────────────────── */

test('one gym cannot see or touch another gym connections and doors', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mine = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'demo', displayName: 'My demo' })).json();
  await call('own1', 'POST', '/api/admin/access/devices',
    { name: 'North', deviceIdentifier: 'NORTH', direction: 'both' });

  // The other gym's owner sees nothing of ours.
  const theirList = await (await call('own2', 'GET', '/api/admin/access/providers')).json();
  assert.equal(theirList.providers.length, 0);
  const theirDevices = await (await call('own2', 'GET', '/api/admin/access/devices')).json();
  assert.equal(theirDevices.devices.length, 0);

  // And cannot act on ours by id.
  assert.equal((await call('own2', 'POST', `/api/admin/access/providers/${mine.provider.id}/test`)).status, 404);
  assert.equal((await call('own2', 'DELETE', `/api/admin/access/providers/${mine.provider.id}`)).status, 404);
  assert.equal((await call('own2', 'POST', `/api/admin/access/demo/${mine.provider.id}/event`,
    { externalUserId: 'x', eventType: 'ENTRY' })).status, 404);

  const still = await db.q1('SELECT status FROM access_providers WHERE id = ?', [mine.provider.id]);
  assert.equal(still.status, 'CONFIGURED', 'untouched');
});

test('a device cannot be attached to another gym branch', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await db.run('INSERT INTO branches (id, org_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ['theirs', 'o2', 'Their branch', ts, ts]);

  const res = await call('own1', 'POST', '/api/admin/access/devices',
    { name: 'Sneaky', deviceIdentifier: 'SNEAK', branchId: 'theirs' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not belong/i);
});

/* ── role boundaries ───────────────────────────────────────────────── */

test('only the owner holds the keys to the front door', async (t) => {
  /* A manager runs the gym day to day and can add a device or map a
     member. Pointing the gym at a different access system, or rotating
     the signing secret, is a different level of trust. */
  const { call, close } = await startApi();
  t.after(() => close());

  assert.equal((await call('mgr1', 'POST', '/api/admin/access/providers',
    { providerKey: 'demo', displayName: 'Manager demo' })).status, 403);
  assert.equal((await call('stf1', 'POST', '/api/admin/access/providers',
    { providerKey: 'demo', displayName: 'Staff demo' })).status, 403);

  // But a manager can run the floor.
  assert.equal((await call('mgr1', 'GET', '/api/admin/access/live')).status, 200);
  assert.equal((await call('mgr1', 'POST', '/api/admin/access/devices',
    { name: 'Side', deviceIdentifier: 'SIDE' })).status, 201);

  // Front-desk staff can look, not change.
  assert.equal((await call('stf1', 'GET', '/api/admin/access/live')).status, 200);
  assert.equal((await call('stf1', 'POST', '/api/admin/access/devices',
    { name: 'Nope', deviceIdentifier: 'NOPE' })).status, 403);
});

test('trainers and clients never reach the access surfaces at all', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  for (const who of ['trn1', 'cli1']) {
    for (const url of ['/api/admin/access/providers', '/api/admin/access/devices',
      '/api/admin/access/events', '/api/admin/access/live', '/api/admin/access/audit']) {
      const res = await call(who, 'GET', url);
      assert.equal(res.status, 403, `${who} reached ${url}`);
    }
  }
});

test('an anonymous caller reaches nothing', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const res = await call(null, 'GET', '/api/admin/access/providers');
  assert.equal(res.status, 401);
});

/* ── SSRF ──────────────────────────────────────────────────────────── */

test('an owner-supplied URL cannot be pointed at our own network', async () => {
  /* The owner dashboard takes a URL and SK OS then calls it. Without this
     guard that is a request-forgery primitive aimed at cloud metadata and
     every internal service we run. */
  const blocked = [
    'http://localhost:4000/admin',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
    'http://172.16.0.9/',
    'http://db.internal/dump',
    'file:///etc/passwd',
    'gopher://evil/',
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeUrl(url), /private|internal|http/i, `${url} must be refused`);
  }
  // An ordinary vendor endpoint still works.
  assert.equal(assertSafeUrl('https://panel.example.com/api/events'), 'https://panel.example.com/api/events');
});

test('a blocked URL is refused at the connect endpoint, not just in the helper', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const res = await call('own1', 'POST', '/api/admin/access/providers', {
    providerKey: 'generic_rest', displayName: 'Sneaky', config: { baseUrl: 'http://169.254.169.254/' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /private or internal/i);
});

/* ── demo isolation ────────────────────────────────────────────────── */

test('simulated events can only be sent to a demo connection', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const real = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Real door' })).json();

  const res = await call('own1', 'POST', `/api/admin/access/demo/${real.provider.id}/event`,
    { externalUserId: 'badge-7', eventType: 'ENTRY' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'not_a_demo_provider');
});

test('demo events are permanently tagged as demo', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const demo = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'demo', displayName: 'Sandbox' })).json();
  await db.run(`INSERT INTO access_member_mappings (id, org_id, user_id, client_id, provider_id, external_user_id, created_at, updated_at)
                VALUES ('dm','o1','cli1','c1',?,'demo-1',?,?)`, [demo.provider.id, ts, ts]);

  const res = await call('own1', 'POST', `/api/admin/access/demo/${demo.provider.id}/event`,
    { externalUserId: 'demo-1', eventType: 'ENTRY' });
  assert.equal(res.status, 200);
  const ev = await db.q1('SELECT * FROM access_events ORDER BY created_at DESC LIMIT 1');
  assert.equal(ev.source, 'demo', 'so real and simulated attendance can always be told apart');
});

/* ── mapping conflicts ─────────────────────────────────────────────── */

test('one card cannot belong to two members', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('cli2','o1','c2@x.in','x','CLIENT','Second',1,?)`, [ts]);

  assert.equal((await call('own1', 'POST', '/api/admin/access/mappings',
    { userId: 'cli1', externalUserId: 'card-1' })).status, 201);

  const clash = await call('own1', 'POST', '/api/admin/access/mappings',
    { userId: 'cli2', externalUserId: 'card-1' });
  assert.equal(clash.status, 409);
  const body = await clash.json();
  assert.equal(body.code, 'mapping_conflict');
  assert.match(body.error, /already mapped to/i, 'and names who has it');
});

/* ── test connection tells the truth ───────────────────────────────── */

test('a webhook that has never received anything is not reported as working', async (t) => {
  /* The failure this blocks: an owner finishes setup, sees a green tick,
     and discovers three weeks later that their panel was never pointed at
     us. "Configured" is not "working". */
  const { call, close } = await startApi();
  t.after(() => close());
  const created = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Main door' })).json();

  const result = await (await call('own1', 'POST',
    `/api/admin/access/providers/${created.provider.id}/test`)).json();
  assert.equal(result.ok, false);
  assert.match(result.message, /no event has arrived/i);

  const after = await (await call('own1', 'GET', '/api/admin/access/providers')).json();
  assert.equal(after.providers[0].status, 'ERROR', 'and the connection is not marked active');
});

/* ── audit ─────────────────────────────────────────────────────────── */

test('every credential change is audited, with no credential in the audit', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  const created = await (await call('own1', 'POST', '/api/admin/access/providers',
    { providerKey: 'generic_webhook', displayName: 'Main door' })).json();
  await call('own1', 'POST', `/api/admin/access/providers/${created.provider.id}/rotate-secret`,
    { kind: 'webhook_secret' });

  const audit = await (await call('own1', 'GET', '/api/admin/access/audit')).json();
  const actions = audit.entries.map((e) => e.action);
  assert.ok(actions.includes('access.provider.connected'));
  assert.ok(actions.includes('access.provider.secret_rotated'));
  assert.equal(audit.entries[0].actor, 'own1', 'and who did it');

  const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes(created.signingSecretShownOnce), 'the secret is not in the audit log either');
});

/* ── "today" is the gym's today ─────────────────────────────────────── */

/**
 * The owner dashboard counted entries with substr(occurred_at, 1, 10)
 * against the UTC date. For a gym in Asia/Kolkata that files every scan
 * between midnight and 5:30am under yesterday; for one in Auckland it
 * counts tomorrow's early scans today -- on the figure an owner checks
 * against the till at closing time.
 *
 * Tested against the helper with a fixed clock rather than through the
 * route, so the result does not depend on the hour the suite runs.
 */
test('today is the gym day, not the UTC day, and demo scans are not in it', async () => {
  const { tallyToday } = await import('../src/services/access/analytics.js');
  const tz = 'Asia/Kolkata';                       // UTC+5:30
  const now = new Date('2026-03-10T02:00:00Z');    // 07:30 on the 10th, locally

  const entry = (occurredAt, extra = {}) => ({
    event_type: 'ENTRY', affected_occupancy: 1, processing_status: 'PROCESSED',
    source: 'webhook', occurred_at: occurredAt, ...extra,
  });

  const rows = [
    // 00:30 local on the 10th -- yesterday by the UTC date, today by the gym's.
    entry('2026-03-09T19:00:00Z'),
    // 23:30 local on the 9th -- today by the UTC date, yesterday by the gym's.
    entry('2026-03-09T18:00:00Z'),
    // Today, but simulated: never part of a real count.
    entry('2026-03-09T19:05:00Z', { source: 'demo' }),
    { ...entry('2026-03-09T20:00:00Z'), event_type: 'EXIT', affected_occupancy: -1 },
  ];

  const t = tallyToday(rows, tz, now);
  assert.equal(t.entries, 1, 'the 00:30 local scan counts; the 23:30-yesterday one does not; demo never does');
  assert.equal(t.exits, 1);

  /* The same rows read against the UTC date -- what the dashboard used to
     do -- put every one of them on the 9th and report a gym that has been
     open since half past midnight as having had nobody through the door. */
  const utc = tallyToday(rows, 'UTC', now);
  assert.equal(utc.entries, 0, 'which is exactly the bug this replaced');
});

test('a closed gym reports no head-count in its description', async (t) => {
  /* "The gym is currently closed. 1 of 150 people." is a sentence that
     argues with itself, and the 1 is a staff member or a session nobody
     scanned out of -- never something a member should read as occupancy. */
  const { getCrowdStatus } = await import('../src/services/crowdStatus.js');
  const closed = getCrowdStatus({ occupancyCount: 1, capacity: 150, open: false });
  assert.equal(closed.status, 'closed');
  assert.ok(!/1 of 150/.test(closed.description), closed.description);
  assert.equal(closed.occupancyPercentage, null, 'and no percentage while shut');

  const open = getCrowdStatus({ occupancyCount: 1, capacity: 150, open: true });
  assert.match(open.description, /1 of 150 people/, 'an open gym still says it');
});
