// ============================================================
// MEASUREMENT EDIT AND DELETE — the two operations that did not exist.
//
// A measurement set could be created and never corrected. A tape read
// into the wrong column, or a reading saved against the wrong date, was
// permanent -- and because these rows feed the trend charts, one bad
// entry bends a line the user then has to reason around forever.
//
// The interesting cases are not the happy paths:
//
//   * A row id from ANOTHER client must not be editable by passing your
//     own client id in the path. resolveClient only proves you may touch
//     THAT client; the row's own client_id is what proves the row is
//     theirs, and checking one without the other is the classic IDOR.
//   * `null` must clear one reading rather than being rejected, or
//     removing a single bad figure means deleting the whole set.
//   * Deleting a measurement must NOT cascade into weight_logs. Those
//     are their own record of a weigh-in, and silently removing history
//     the user did not ask to remove is what section 18 forbids.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const clientRoutes = (await import('../src/routes/clients.js')).default;

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  for (const [u, c, mail] of [['u1', 'c1', 'a@x.in'], ['u2', 'c2', 'b@x.in']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT','Client',1,?)`, [u, mail, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, current_weight, created_at) VALUES (?,?,?,?,?)', [c, u, 'o1', 80, ts]);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/clients', clientRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const tokenFor = (sub) => jwt.sign({ sub, role: 'CLIENT', org: 'o1', name: 'C', email: 'a@x.in' }, config.jwtSecret);
  const call = (method, url, { as = 'u1', body } = {}) => fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(as)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

async function seedMeasurement(db, clientId, over = {}) {
  const row = { id: `mea_${clientId}`, taken_at: '2026-09-01T09:00:00Z', weight: 80, waist: 90, chest: 100, ...over };
  await db.run(`INSERT INTO measurements (id, client_id, taken_at, weight, waist, chest) VALUES (?,?,?,?,?,?)`,
    [row.id, clientId, row.taken_at, row.weight, row.waist, row.chest]);
  return row.id;
}

test('a measurement can be corrected and the change persists', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');

  const res = await call('PATCH', `/api/clients/c1/measurements/${mid}`, { body: { waist: 88.5 } });
  assert.equal(res.status, 200);

  const row = await db.q1('SELECT * FROM measurements WHERE id = ?', [mid]);
  assert.equal(row.waist, 88.5);
  assert.equal(row.chest, 100, 'fields not sent are left alone');
});

test('null clears one reading instead of being rejected', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');

  const res = await call('PATCH', `/api/clients/c1/measurements/${mid}`, { body: { chest: null } });
  assert.equal(res.status, 200, 'an explicit null is an edit, not a validation error');
  const row = await db.q1('SELECT * FROM measurements WHERE id = ?', [mid]);
  assert.equal(row.chest, null);
  assert.equal(row.waist, 90, 'the rest of the set survives');
});

test('another client\'s row cannot be edited through your own client id', async (t) => {
  // resolveClient proves you may touch c1. It says nothing about whether
  // THIS row belongs to c1 -- checking one without the other is the
  // textbook insecure-direct-object-reference.
  const { db, call, close } = await startApi();
  t.after(() => close());
  const theirs = await seedMeasurement(db, 'c2');

  const res = await call('PATCH', `/api/clients/c1/measurements/${theirs}`, { as: 'u1', body: { waist: 60 } });
  assert.equal(res.status, 404);
  const row = await db.q1('SELECT waist FROM measurements WHERE id = ?', [theirs]);
  assert.equal(row.waist, 90, 'their reading is untouched');

  const del = await call('DELETE', `/api/clients/c1/measurements/${theirs}`, { as: 'u1' });
  assert.equal(del.status, 404);
  assert.ok(await db.q1('SELECT id FROM measurements WHERE id = ?', [theirs]), 'their row still exists');
});

test('you cannot reach another client at all', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const theirs = await seedMeasurement(db, 'c2');
  const res = await call('PATCH', '/api/clients/c2/measurements/' + theirs, { as: 'u1', body: { waist: 60 } });
  assert.equal(res.status, 403);
});

test('deleting a measurement does not delete the weight history', async (t) => {
  // A weight_log row is its own record of a weigh-in. Removing a tape
  // measurement removes the tape measurement.
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?,?,?,?,?,?)',
    ['wl1', 'c1', '2026-09-01', 80, 'manual', ts]);

  const res = await call('DELETE', `/api/clients/c1/measurements/${mid}`);
  assert.equal(res.status, 200);
  assert.equal(await db.q1('SELECT id FROM measurements WHERE id = ?', [mid]), null);
  assert.ok(await db.q1('SELECT id FROM weight_logs WHERE id = ?', ['wl1']), 'the weigh-in survives');
});

test('correcting a weight updates the client and the series row for that day', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');
  await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?,?,?,?,?,?)',
    ['wl1', 'c1', '2026-09-01', 80, 'manual', ts]);

  const res = await call('PATCH', `/api/clients/c1/measurements/${mid}`, { body: { weight: 78.2 } });
  assert.equal(res.status, 200);
  assert.equal((await db.q1('SELECT weight FROM weight_logs WHERE id = ?', ['wl1'])).weight, 78.2,
    'the series row for that date follows the correction');
  assert.equal((await db.q1('SELECT current_weight FROM clients WHERE id = ?', ['c1'])).current_weight, 78.2);
});

test('an out-of-range correction is refused', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');
  // 2149 is the slipped-decimal shape of a real typo, and the kind of
  // value that owned a chart forever before the bounds were tightened.
  const res = await call('PATCH', `/api/clients/c1/measurements/${mid}`, { body: { waist: 2149 } });
  // 422 is what validate() returns for a schema failure across this API.
  assert.equal(res.status, 422);
  assert.equal((await db.q1('SELECT waist FROM measurements WHERE id = ?', [mid])).waist, 90);
});

test('an empty patch is refused rather than silently doing nothing', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  const mid = await seedMeasurement(db, 'c1');
  const res = await call('PATCH', `/api/clients/c1/measurements/${mid}`, { body: {} });
  assert.equal(res.status, 400);
});

test('a measurement that does not exist is a 404, not a crash', async (t) => {
  const { call, close } = await startApi();
  t.after(() => close());
  assert.equal((await call('PATCH', '/api/clients/c1/measurements/mea_nope', { body: { waist: 88 } })).status, 404);
  assert.equal((await call('DELETE', '/api/clients/c1/measurements/mea_nope')).status, 404);
});
