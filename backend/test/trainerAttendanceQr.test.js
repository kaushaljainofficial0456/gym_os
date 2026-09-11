// ============================================================
// TRAINER ATTENDANCE — the QR gate.
//
// These are anti-fraud properties, so they are tested at the HTTP layer
// rather than against the service: the hole being closed here was a route
// that accepted `qr` as OPTIONAL. Tapping the button with no code at all
// recorded a present-and-correct attendance row from anywhere in the
// world, and check-out took no body at all -- so worked_minutes, the one
// number this feature exists to produce, rested on one observed event and
// one unobserved one. A trainer could scan in at the gym and check out
// from their sofa three hours later.
//
// A UI that hides the button is not a fix. Everything below goes straight
// at the endpoint the way anyone with a network tab would.
//
// The two-code design is the other half: arriving and leaving are
// separate codes, and each refuses the other's job, so a duration is
// always bounded by two scans that really happened at the gym.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
    raw: db,
  });
  return mk();
}

let seq = 0;
const uid = (p) => `${p}_${++seq}`;

async function seed(db, orgId) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)',
    [orgId, orgId, orgId, ts]);
  await db.run('INSERT INTO gym_settings (org_id, updated_at) VALUES (?,?)', [orgId, ts]);
  const trainer = uid('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,?,'TRAINER',?,1,?)`, [trainer, orgId, `${trainer}@a.in`, 'x', 'Trainer', ts]);
  await db.run('INSERT INTO trainers (user_id, org_id, max_clients) VALUES (?,?,50)', [trainer, orgId]);
  const owner = uid('usr');
  await db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,?,'GYM_OWNER',?,1,?)`, [owner, orgId, `${owner}@a.in`, 'x', 'Owner', ts]);
  return { trainer, owner };
}

async function startApp() {
  const db = await memDb();
  const a = await seed(db, 'o1');
  const b = await seed(db, 'o2');   // a second gym, for the cross-gym test

  const attendanceRoutes = (await import('../src/routes/attendance.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const tok = (sub, role, org) => jwt.sign({ sub, role, org, name: sub }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, who, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${tok(...who)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  const AS_TRAINER = [a.trainer, 'TRAINER', 'o1'];
  const AS_OWNER = [a.owner, 'GYM_OWNER', 'o1'];
  const AS_OTHER_OWNER = [b.owner, 'GYM_OWNER', 'o2'];

  const codes = async (who = AS_OWNER) => (await call('GET', '/api/attendance/qr', who)).json;

  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, codes, AS_TRAINER, AS_OWNER, AS_OTHER_OWNER, close };
}

test('a check-in with no code at all is refused — this is the hole being closed', async (t) => {
  const { db, call, AS_TRAINER, close } = await startApp(); t.after(() => close());

  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, {});
  assert.equal(res.status, 422, JSON.stringify(res.json));
  assert.equal(res.json.code, 'QR_REQUIRED');

  const rows = await db.q('SELECT id FROM trainer_attendance');
  assert.equal(rows.length, 0, 'and nothing was written — a refused check-in must leave no record');
});

test('a check-out with no code is refused too, so a duration cannot be half-invented', async (t) => {
  const { call, codes, AS_TRAINER, close } = await startApp(); t.after(() => close());

  const c = await codes();
  assert.equal((await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: c.in })).status, 200);

  // Checked in legitimately at the gym, now trying to leave from anywhere.
  const out = await call('POST', '/api/attendance/me/check-out', AS_TRAINER, {});
  assert.equal(out.status, 422);
  assert.equal(out.json.code, 'QR_REQUIRED');
});

test('the owner is issued two DIFFERENT codes, one per direction', async (t) => {
  const { codes, close } = await startApp(); t.after(() => close());

  const c = await codes();
  assert.ok(c.in && c.out, 'both codes are issued');
  assert.notEqual(c.in, c.out, 'arriving and leaving must not share a code');
  assert.ok(c.expiresIn > 0 && c.expiresIn <= 300, 'and they are short-lived');
});

test('each code refuses the other end of the day', async (t) => {
  const { call, codes, AS_TRAINER, close } = await startApp(); t.after(() => close());
  const c = await codes();

  const wrongIn = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: c.out });
  assert.equal(wrongIn.status, 422);
  assert.match(wrongIn.json.error, /check-out code/i, 'and says which code it actually was');

  assert.equal((await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: c.in })).status, 200);

  const wrongOut = await call('POST', '/api/attendance/me/check-out', AS_TRAINER, { qr: c.in });
  assert.equal(wrongOut.status, 422);
  assert.match(wrongOut.json.error, /check-in code/i);
});

test('two real scans produce a duration, recorded as GYM_QR', async (t) => {
  const { db, call, codes, AS_TRAINER, close } = await startApp(); t.after(() => close());
  const c = await codes();

  assert.equal((await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: c.in })).status, 200);
  assert.equal((await call('POST', '/api/attendance/me/check-out', AS_TRAINER, { qr: c.out })).status, 200);

  const row = await db.q1('SELECT check_in, check_out, worked_minutes, source FROM trainer_attendance');
  assert.ok(row.check_in, 'arrival is an observed event');
  assert.ok(row.check_out, 'so is departure');
  assert.equal(row.source, 'GYM_QR', 'and the record says it came from a scan, not a tap');
  assert.ok(row.worked_minutes != null, 'duration is derived from the two');
});

test('a code from another gym is refused', async (t) => {
  const { call, codes, AS_TRAINER, AS_OTHER_OWNER, close } = await startApp(); t.after(() => close());

  const theirs = await codes(AS_OTHER_OWNER);
  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: theirs.in });
  assert.equal(res.status, 403, 'a code someone forwarded from a different gym is not evidence you were here');
});

test('a tampered code is refused, and does not reveal why', async (t) => {
  const { call, codes, AS_TRAINER, close } = await startApp(); t.after(() => close());
  const c = await codes();

  // Flip the signature: same payload, different HMAC.
  const [body] = c.in.split('.');
  const forged = `${body}.${'A'.repeat(43)}`;
  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: forged });
  assert.equal(res.status, 422);
  assert.doesNotMatch(res.json.error, /signature|hmac|tamper/i,
    'the message must not coach someone probing the signature');
});

test('an expired code is refused', async (t) => {
  const { call, AS_TRAINER, close } = await startApp(); t.after(() => close());
  const { signQr } = await import('../src/routes/attendance.js');

  const stale = signQr('o1', 'IN', -10);   // expired ten seconds ago
  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, { qr: stale });
  assert.equal(res.status, 422, 'a screenshot of yesterday’s code is not a check-in');
});

test('only a trainer of THIS gym can record attendance, code or not', async (t) => {
  const { call, codes, AS_OWNER, close } = await startApp(); t.after(() => close());
  const c = await codes();

  const res = await call('POST', '/api/attendance/me/check-in', AS_OWNER, { qr: c.in });
  assert.equal(res.status, 403, 'an owner holding a valid code is still not a trainer clocking in');
});

test('a gym that deliberately turns the requirement off can still tap', async (t) => {
  const { db, call, AS_TRAINER, close } = await startApp(); t.after(() => close());

  // The setting exists for gyms with no display, or a single
  // self-employed trainer. It is opt-OUT, never the silent default.
  await db.run('UPDATE gym_settings SET attendance_require_qr = 0 WHERE org_id = ?', ['o1']);

  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, {});
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const row = await db.q1('SELECT source FROM trainer_attendance');
  assert.equal(row.source, 'TRAINER_SELF',
    'and it is recorded as self-reported, so the timesheet still says how it was captured');
});

test('an existing gym cannot end up without the requirement after upgrading', async (t) => {
  const { db, call, AS_TRAINER, close } = await startApp(); t.after(() => close());

  /* The rollout question: a gym whose settings row was written before
     this column existed must not silently keep the weaker rule.

     The guarantee is in the column definition rather than in defensive
     read code -- NOT NULL DEFAULT 1 means SQLite's ADD COLUMN backfills
     every existing row with 1, so "requirement missing" is not a state
     the database can be in. Asserted directly, because this is the thing
     that actually protects existing gyms; getPolicy's `== null ? true`
     is a second belt for the Postgres path and can never fire here. */
  const col = (await db.q('PRAGMA table_info(gym_settings)'))
    .find((c) => c.name === 'attendance_require_qr');
  assert.ok(col, 'the column exists');
  assert.equal(col.notnull, 1, 'it is NOT NULL, so no row can be missing a policy');
  assert.equal(String(col.dflt_value), '1', 'and it backfills to REQUIRED, not to off');

  // A gym seeded without ever mentioning the column still gets the rule.
  const row = await db.q1('SELECT attendance_require_qr FROM gym_settings WHERE org_id = ?', ['o1']);
  assert.equal(Number(row.attendance_require_qr), 1);

  const res = await call('POST', '/api/attendance/me/check-in', AS_TRAINER, {});
  assert.equal(res.status, 422, 'and the endpoint enforces it');
});
