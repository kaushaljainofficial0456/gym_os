// ============================================================
// eSSL / ZKTeco TERMINALS (ADMS), TESTED AS AN ATTACKER WOULD READ IT.
//
// /iclock is public: a terminal cannot log in, and ADMS carries no
// signature. So most of what is pinned here is what must NOT happen:
//
//   * an unregistered serial must learn nothing and change nothing;
//   * a serial registered at two gyms must not be delivered to either;
//   * a pinned IP must not be satisfied by a forged X-Forwarded-For entry;
//   * a resent batch must never move occupancy twice;
//   * a terminal whose clock runs fast must not write future punches;
//   * biometric tables must be acknowledged and never stored.
//
// And the happy path: one terminal at reception, members punch in and out
// on it, occupancy follows.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAttlog, localToUtcIso, punchDirection, handshakeResponse, clientIp, allowedIps,
} from '../src/services/access/adms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';
const SN = 'BJ2C201460001';

/* ── the protocol helpers ─────────────────────────────────────────── */

test('ATTLOG lines parse the way firmware actually sends them', () => {
  const body = '101\t2026-10-20 07:15:02\t0\t1\t0\t0\r\n'
    + '102  2026-10-20 07:16:40  1  15\n'      // runs of spaces, no tabs
    + '\n'                                       // blank line
    + '103\t2026-10-20 07:20\n'                  // no seconds, no trailing fields
    + 'garbage line\n';
  const { punches, bad } = parseAttlog(body);
  assert.deepEqual(punches.map((p) => [p.pin, p.local, p.status]), [
    ['101', '2026-10-20 07:15:02', 0],
    ['102', '2026-10-20 07:16:40', 1],
    ['103', '2026-10-20 07:20:00', null],
  ]);
  assert.equal(bad, 1, 'an unreadable line is counted, not guessed at');
});

test('a device wall time is read in the gym timezone', () => {
  assert.equal(localToUtcIso('2026-10-20 07:15:02', 'Asia/Kolkata'), '2026-10-20T01:45:02.000Z');
  assert.equal(localToUtcIso('not a time', 'Asia/Kolkata'), null);
});

test('direction: the door beats the key, toggle reads presence', () => {
  assert.equal(punchDirection({ status: 1, device: { direction: 'entry' } }), 'ENTRY');
  assert.equal(punchDirection({ status: 0, device: { direction: 'exit' } }), 'EXIT');
  assert.equal(punchDirection({ status: 1, device: { direction: 'both' } }), 'EXIT');
  assert.equal(punchDirection({ status: 0, device: {}, punchMode: 'toggle', isInside: true }), 'EXIT');
  assert.equal(punchDirection({ status: 0, device: {}, punchMode: 'toggle', isInside: false }), 'ENTRY');
});

test('the handshake asks for attendance only', () => {
  const h = handshakeResponse(SN);
  assert.match(h, new RegExp(`GET OPTION FROM: ${SN}`));
  assert.match(h, /TransFlag=TransData AttLog/);
  assert.doesNotMatch(h, /FPLOG|BIODATA|FACE/i);
});

test('the client IP is the hop our edge added, not the one the sender wrote', () => {
  const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, ip: '10.0.0.1' });
  assert.equal(clientIp(req('203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req('203.0.113.7, 198.51.100.9')), '198.51.100.9');
  assert.equal(clientIp({ headers: {}, ip: '::ffff:192.0.2.4' }), '192.0.2.4');
  assert.deepEqual([...allowedIps({ allowed_ips: '203.0.113.7, 198.51.100.9' })], ['203.0.113.7', '198.51.100.9']);
  assert.equal(allowedIps({}), null);
});

/* ── the endpoint ─────────────────────────────────────────────────── */

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

async function startTerminalApi({ config = {}, providerStatus = 'ACTIVE' } = {}) {
  const express = (await import('express')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  const admsRoutes = (await import('../src/routes/adms.js')).default;
  resetRateLimits();

  const db = await memDb();
  for (const [org, slug] of [['o1', 'gym-one'], ['o2', 'gym-two']]) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)', [org, org, slug, 'Asia/Kolkata', ts]);
    await db.run('INSERT INTO gym_settings (org_id, crowd_capacity) VALUES (?,?)', [org, 100]);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','u1@x.in','x','CLIENT','Rahul',1,?)`, [ts]);
  await db.run(`INSERT INTO clients (id, user_id, org_id, created_at) VALUES ('c1','u1','o1',?)`, [ts]);
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, auth_type, config_json, created_at, updated_at)
                VALUES ('p1','o1','essl','Front desk',?,'none',?,?,?)`, [providerStatus, JSON.stringify(config), ts, ts]);
  await db.run(`INSERT INTO access_devices (id, org_id, provider_id, device_name, device_identifier, device_type, direction, status, created_at, updated_at)
                VALUES ('d1','o1','p1','Reception',?,'fingerprint','both','ACTIVE',?,?)`, [SN, ts, ts]);
  await db.run(`INSERT INTO access_member_mappings (id, org_id, provider_id, external_user_id, user_id, client_id, created_at, updated_at)
                VALUES ('m1','o1','p1','101','u1','c1',?,?)`, [ts, ts]);

  const app = express();
  app.use('/iclock', express.text({ type: () => true, limit: '1mb' }));
  app.use(express.json());
  app.use('/iclock', admsRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/iclock`;
  const call = async (method, pathQs, body, headers = {}) => {
    const r = await fetch(`${base}${pathQs}`, { method, body, headers: { 'Content-Type': 'text/plain', ...headers } });
    return { status: r.status, text: await r.text() };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

/** Wall time in IST, `minutesAgo` before now -- what the terminal would print. */
function istWall(minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60_000 + 330 * 60_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

test('an unregistered or malformed serial learns nothing and changes nothing', async (t) => {
  const { db, call, close } = await startTerminalApi();
  t.after(close);
  const unknown = await call('GET', '/cdata?SN=NOPE123&options=all');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, 'Unknown device');
  const post = await call('POST', '/cdata?SN=NOPE123&table=ATTLOG', `101\t${istWall(5)}\t0\t1`);
  assert.equal(post.status, 404);
  assert.equal((await call('GET', '/cdata?SN=../../etc&options=all')).status, 400);
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 0);
});

test('the handshake answers a registered terminal and marks it seen', async (t) => {
  const { db, call, close } = await startTerminalApi();
  t.after(close);
  const r = await call('GET', `/cdata?SN=${SN}&options=all&pushver=2.4.1`);
  assert.equal(r.status, 200);
  assert.match(r.text, /TransFlag=TransData AttLog/);
  assert.ok((await db.q1("SELECT last_seen_at FROM access_devices WHERE id = 'd1'")).last_seen_at);
  // Heartbeats and command results are "OK", from the .aspx firmware too.
  assert.equal((await call('GET', `/getrequest.aspx?SN=${SN}`)).text, 'OK');
  assert.equal((await call('POST', `/devicecmd?SN=${SN}`, 'ID=1&Return=0')).text, 'OK');
});

test('one terminal, in and out: the second punch is the way out, and a resend changes nothing', async (t) => {
  const { db, call, close } = await startTerminalApi({ config: { punch_mode: 'toggle' } });
  t.after(close);
  const batch = `101\t${istWall(40)}\t0\t1\t0\t0\n101\t${istWall(5)}\t0\t1\t0\t0\n`;
  const first = await call('POST', `/cdata?SN=${SN}&table=ATTLOG&Stamp=9999`, batch);
  assert.equal(first.status, 200);
  assert.equal(first.text, 'OK: 2');

  const events = await db.q('SELECT event_type, verification_status, processing_status FROM access_events ORDER BY occurred_at');
  assert.deepEqual(events.map((e) => e.event_type), ['ENTRY', 'EXIT']);
  assert.ok(events.every((e) => e.verification_status === 'unverified'), 'ADMS is never "verified"');
  assert.ok(events.every((e) => e.processing_status === 'PROCESSED'));
  assert.equal((await db.q1("SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE status = 'OPEN'")).n, 0);

  // The firmware resends until it is acknowledged -- and sometimes after.
  const again = await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, batch);
  assert.equal(again.text, 'OK: 2');
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 2);
});

test('a double scan at the door is one arrival, not an arrival and a departure', async (t) => {
  const { db, call, close } = await startTerminalApi({ config: { punch_mode: 'toggle' } });
  t.after(close);
  // 40 s apart: a finger that did not read the first time.
  const now = Date.now();
  const wall = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, `101\t${wall(now - 120_000)}\t0\t1\n101\t${wall(now - 80_000)}\t0\t1\n`);
  assert.equal((await db.q1("SELECT COUNT(*) AS n FROM gym_presence_sessions WHERE status = 'OPEN'")).n, 1, 'still inside');
});

test('In / Out keys are honoured when the gym uses them', async (t) => {
  const { db, call, close } = await startTerminalApi({ config: { punch_mode: 'status' } });
  t.after(close);
  await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, `101\t${istWall(30)}\t0\t1\n101\t${istWall(20)}\t0\t1\n101\t${istWall(10)}\t1\t1\n`);
  const types = (await db.q('SELECT event_type FROM access_events ORDER BY occurred_at')).map((e) => e.event_type);
  assert.deepEqual(types, ['ENTRY', 'ENTRY', 'EXIT'], 'status 0 is in, 1 is out -- whatever presence says');
});

test('a terminal whose clock runs fast is refused, acknowledged, and reported', async (t) => {
  const { db, call, close } = await startTerminalApi();
  t.after(close);
  const r = await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, `101\t${istWall(-120)}\t0\t1\n`);
  assert.equal(r.text, 'OK: 1', 'acknowledged, or the device resends it forever');
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 0);
  const audit = await db.q1("SELECT reason FROM access_audit_logs WHERE action = 'access.adms.clock_ahead'");
  assert.match(audit.reason, /date and time/);
});

test('biometric tables are acknowledged and never stored', async (t) => {
  const { db, call, close } = await startTerminalApi();
  t.after(close);
  for (const table of ['FPLOG', 'BIODATA', 'ATTPHOTO', 'OPERLOG']) {
    const r = await call('POST', `/cdata?SN=${SN}&table=${table}`, 'PIN=101\tFID=6\tSize=1024\tTMP=TUxNUzIxAAAD...');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'OK');
  }
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 0);
});

test('a pinned IP is not satisfied by a forged first X-Forwarded-For entry', async (t) => {
  const { db, call, close } = await startTerminalApi({ config: { allowed_ips: '203.0.113.7' } });
  t.after(close);
  const body = `101\t${istWall(5)}\t0\t1\n`;
  const forged = await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, body, { 'X-Forwarded-For': '203.0.113.7, 198.51.100.66' });
  assert.equal(forged.status, 403);
  assert.ok(await db.q1("SELECT id FROM access_audit_logs WHERE action = 'access.adms.rejected'"));
  const real = await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, body, { 'X-Forwarded-For': '198.51.100.66, 203.0.113.7' });
  assert.equal(real.status, 200);
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 1);
});

test('a disabled connection or a serial claimed by two gyms delivers nothing', async (t) => {
  const off = await startTerminalApi({ providerStatus: 'DISABLED' });
  t.after(off.close);
  assert.equal((await off.call('GET', `/cdata?SN=${SN}&options=all`)).status, 404);

  const { db, call, close } = await startTerminalApi();
  t.after(close);
  await db.run(`INSERT INTO access_providers (id, org_id, provider_key, display_name, status, auth_type, created_at, updated_at)
                VALUES ('p2','o2','essl','Other gym','ACTIVE','none',?,?)`, [ts, ts]);
  await db.run(`INSERT INTO access_devices (id, org_id, provider_id, device_name, device_identifier, status, created_at, updated_at)
                VALUES ('d2','o2','p2','Squatter',?,'ACTIVE',?,?)`, [SN, ts, ts]);
  const r = await call('POST', `/cdata?SN=${SN}&table=ATTLOG`, `101\t${istWall(5)}\t0\t1\n`);
  assert.equal(r.status, 409);
  assert.equal((await db.q1('SELECT COUNT(*) AS n FROM access_events')).n, 0);
  assert.equal((await db.q1("SELECT COUNT(*) AS n FROM access_audit_logs WHERE action = 'access.adms.rejected'")).n, 2, 'both gyms are told');
});

test('the catalogue offers eSSL as connectable, with no secret to show', async () => {
  const { listProviders, getProvider } = await import('../src/services/access/providers/index.js');
  await import('../src/services/access/providers/builtin.js');
  const essl = listProviders().find((p) => p.key === 'essl');
  assert.equal(essl.implemented, true);
  assert.equal(essl.capabilities.supportsWebhooks, false, 'no HMAC secret is generated for a terminal');
  assert.ok(essl.requiredFields.every((f) => f.optional), 'connecting needs nothing typed');
  assert.equal(listProviders().find((p) => p.key === 'zkteco').implemented, false, 'BioTime is still not built');
  assert.equal(typeof getProvider('essl').testConnection, 'function');
});
