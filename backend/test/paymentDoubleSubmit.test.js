// ============================================================
// A DOUBLE-CLICK MUST NOT BOOK THE MONEY TWICE.
//
// Two identical concurrent POSTs to /api/admin/payments both returned
// 201 and wrote two rows. So a double tap on "Record payment", or a
// retry after a connection blip, silently recorded a member as having
// paid twice — wrong in the direction that inflates revenue and clears a
// debt nobody settled. Spec 47 names this case exactly.
//
// The guard is a 60-second window rather than a client-supplied
// idempotency key, because this is a human filling in a form at a
// counter and the real failure is one hand hitting one button twice. The
// tests below are mostly about what it must NOT block: the window has to
// be narrow enough that legitimate takings still go through.
//
// And it REPORTS the refusal (409) rather than swallowing it. A silent
// 201 would tell the owner it saved when it deliberately did not — they
// need to know the first one landed.
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

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  for (const [u, c] of [['u1', 'c1'], ['u2', 'c2']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT','C',1,?)`, [u, `${u}@x.in`, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, 'o1', ts]);
  }
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('own','o1','o@x.in','x','GYM_OWNER','O',1,?)`, [ts]);

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: 'own', role: 'GYM_OWNER', org: 'o1', name: 'O', email: 'o@x.in' }, config.jwtSecret);
  const pay = (client_id, amount) => fetch(`http://127.0.0.1:${port}/api/admin/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ client_id, amount, method: 'UPI' }),
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, pay, close };
}

const countRows = (db) => db.q1('SELECT COUNT(*) AS n FROM payments').then((r) => Number(r.n));

test('the same payment submitted twice records once', async (t) => {
  const { db, pay, close } = await startApi();
  t.after(() => close());

  const first = await pay('c1', 1500);
  const second = await pay('c1', 1500);

  assert.equal(first.status, 201);
  assert.equal(second.status, 409, 'refused, and SAID so');
  assert.equal(await countRows(db), 1);
});

test('the refusal explains itself and names the payment that landed', async (t) => {
  // A bare 409 would read as "the app broke". The owner needs to know the
  // first one went through.
  const { pay, close } = await startApi();
  t.after(() => close());

  await pay('c1', 1500);
  const body = await (await pay('c1', 1500)).json();
  assert.match(body.error, /recorded moments ago/i);
  assert.ok(body.existingPaymentId, 'points at the row that already exists');
});

test('two members paying the same amount both go through', async (t) => {
  // Two people on the same monthly plan paying at the counter together is
  // ordinary. Blocking that would be worse than the bug.
  const { db, pay, close } = await startApi();
  t.after(() => close());

  assert.equal((await pay('c1', 1999)).status, 201);
  assert.equal((await pay('c2', 1999)).status, 201);
  assert.equal(await countRows(db), 2);
});

test('one member paying two different amounts goes through', async (t) => {
  // Membership plus a personal-training top-up, entered back to back.
  const { db, pay, close } = await startApi();
  t.after(() => close());

  assert.equal((await pay('c1', 1999)).status, 201);
  assert.equal((await pay('c1', 500)).status, 201);
  assert.equal(await countRows(db), 2);
});

test('an identical payment outside the window is allowed', async (t) => {
  // The guard is a double-click guard, not a rule that a member may never
  // pay the same amount twice. Backdating the first row past the window
  // is what a second, genuine payment looks like later.
  const { db, pay, close } = await startApi();
  t.after(() => close());

  await pay('c1', 1999);
  await db.run("UPDATE payments SET paid_at = ? WHERE amount = 1999",
    [new Date(Date.now() - 10 * 60_000).toISOString()]);

  assert.equal((await pay('c1', 1999)).status, 201, 'ten minutes later is a real second payment');
  assert.equal(await countRows(db), 2);
});

test('concurrent submits do not both slip through', async (t) => {
  // The double-click as it actually arrives: two requests in flight at
  // once, not one after the other.
  const { db, pay, close } = await startApi();
  t.after(() => close());

  const results = await Promise.all([pay('c1', 2500), pay('c1', 2500)]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409]);
  assert.equal(await countRows(db), 1);
});
