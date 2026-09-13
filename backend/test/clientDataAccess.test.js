// ============================================================
// WHO CAN READ ONE CLIENT'S DATA.
//
// The permission matrix and branch isolation are already covered
// (multiGymAccess, admin-tenant-isolation). What was not is the boundary
// that actually carries a person's body weight, food log, photos and
// payment history: /api/clients/:id/*.
//
// Three separate walls, and all three have to hold:
//
//   A trainer must not read a client who is not theirs — same gym, wrong
//   coach. This is the everyday case and the easiest to regress, because
//   the row IS in their org and an org-scoped query alone would return it.
//
//   Nobody reads across gyms, owner included. An owner is the most
//   privileged role in the product and still has no business in another
//   gym's records.
//
//   Money is owner-only even for the trainer's OWN client. The endpoint
//   returns `payments: null` rather than [] so the UI can say "not yours
//   to see" instead of the false "no payments recorded".
//
// Asserted against the live routes rather than a helper, because the
// question is what the HTTP surface does — a service that refuses
// correctly behind a route that never calls it protects nothing.
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
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

/** Two gyms. Gym A has two trainers and two clients, one assigned to
 *  each trainer; gym B has its own owner and client. */
async function world(db) {
  const mkOrg = async (id, name) =>
    db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', [id, name, id, ts]);
  const mkUser = async (id, org, role) =>
    db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
            VALUES (?,?,?,'x',?,?,1,?)`, [id, org, `${id}@x.in`, role, id, ts]);
  const mkClient = async (id, org, user, trainer) =>
    db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?,?,?,?,?)',
      [id, user, org, trainer, ts]);

  await mkOrg('orgA', 'Gym A');
  await mkOrg('orgB', 'Gym B');

  await mkUser('ownerA', 'orgA', 'GYM_OWNER');
  await mkUser('trainerA1', 'orgA', 'TRAINER');
  await mkUser('trainerA2', 'orgA', 'TRAINER');
  await db.run('INSERT INTO trainers (user_id, org_id) VALUES (?,?)', ['trainerA1', 'orgA']);
  await db.run('INSERT INTO trainers (user_id, org_id) VALUES (?,?)', ['trainerA2', 'orgA']);
  await mkUser('uMine', 'orgA', 'CLIENT');
  await mkUser('uTheirs', 'orgA', 'CLIENT');
  await mkClient('cMine', 'orgA', 'uMine', 'trainerA1');
  await mkClient('cTheirs', 'orgA', 'uTheirs', 'trainerA2');

  await mkUser('ownerB', 'orgB', 'GYM_OWNER');
  await mkUser('uOther', 'orgB', 'CLIENT');
  await mkClient('cOther', 'orgB', 'uOther', null);

  // Money on the trainer's own client, so "owner-only" is a real refusal
  // rather than an empty list that happens to look the same.
  await db.run(
    `INSERT INTO subscriptions (id, org_id, client_id, plan_name, amount, start_date, end_date, status, payment_status)
     VALUES ('subM','orgA','cMine','Monthly',1500,'2026-01-01','2026-12-31','active','paid')`);
  await db.run(
    `INSERT INTO payments (id, org_id, client_id, amount, status, paid_at)
     VALUES ('payM','orgA','cMine',1500,'paid','2026-02-01')`);
}

async function startApi(db) {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const clientRoutes = (await import('../src/routes/clients.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const app = express();
  app.use(express.json());
  app.use('/api/clients', clientRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;

  const as = (sub, role, org) => jwt.sign({ sub, role, org, name: sub, email: `${sub}@x.in` }, config.jwtSecret);
  const get = (url, token) => fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${token}` } });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { as, get, close };
}

const PATHS = (id) => ({
  overview: `/api/clients/${id}/overview`,
  account: `/api/clients/${id}/account`,
  weights: `/api/clients/${id}/weights`,
  measurements: `/api/clients/${id}/measurements`,
  photos: `/api/clients/${id}/photos`,
});

test('a trainer cannot read a client who belongs to another trainer', async (t) => {
  // Same gym, wrong coach — the row IS in their org, so an org-scoped
  // query alone would hand it over.
  const db = await memDb();
  await world(db);
  const { as, get, close } = await startApi(db);
  t.after(() => close());

  const token = as('trainerA1', 'TRAINER', 'orgA');
  for (const [name, url] of Object.entries(PATHS('cTheirs'))) {
    const res = await get(url, token);
    assert.equal(res.status, 403, `${name} must refuse another trainer's client`);
  }
});

test('a trainer CAN read their own client', async (t) => {
  const db = await memDb();
  await world(db);
  const { as, get, close } = await startApi(db);
  t.after(() => close());

  const token = as('trainerA1', 'TRAINER', 'orgA');
  for (const [name, url] of Object.entries(PATHS('cMine'))) {
    const res = await get(url, token);
    assert.equal(res.status, 200, `${name} should be allowed for an assigned client`);
  }
});

test('nobody reads across gyms — not even an owner', async (t) => {
  // An owner is the most privileged role in the product and still has no
  // business in another gym's records.
  const db = await memDb();
  await world(db);
  const { as, get, close } = await startApi(db);
  t.after(() => close());

  const token = as('ownerA', 'GYM_OWNER', 'orgA');
  for (const [name, url] of Object.entries(PATHS('cOther'))) {
    const res = await get(url, token);
    assert.equal(res.status, 403, `${name} must refuse another gym's client`);
  }
});

test('payments are owner-only, even for the trainer\'s own client', async (t) => {
  const db = await memDb();
  await world(db);
  const { as, get, close } = await startApi(db);
  t.after(() => close());

  const owner = await (await get(PATHS('cMine').account, as('ownerA', 'GYM_OWNER', 'orgA'))).json();
  assert.ok(Array.isArray(owner.payments), 'the owner sees the list');
  assert.equal(owner.payments.length, 1);

  const trainer = await (await get(PATHS('cMine').account, as('trainerA1', 'TRAINER', 'orgA'))).json();
  assert.equal(trainer.payments, null,
    'null, not [] — the UI must be able to say "not yours to see" rather than "none recorded"');
  assert.ok(trainer.membership, 'membership dates still reach the coach');
  assert.ok(trainer.attendance, 'and so does attendance');
});

test('a client can read their own record and no one else\'s', async (t) => {
  const db = await memDb();
  await world(db);
  const { as, get, close } = await startApi(db);
  t.after(() => close());

  const token = as('uMine', 'CLIENT', 'orgA');
  assert.equal((await get(PATHS('cMine').weights, token)).status, 200, 'their own');
  assert.equal((await get(PATHS('cTheirs').weights, token)).status, 403, 'a gym-mate\'s');
  assert.equal((await get(PATHS('cOther').weights, token)).status, 403, 'another gym\'s');
});
