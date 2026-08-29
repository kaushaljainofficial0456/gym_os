// ============================================================
// /api/messages -- trainer<->client in-app thread. Three-way access
// model: the client themselves, their assigned trainer, or any owner/
// admin in the org. Also covers a real bug found and fixed alongside
// this suite: GET / used `ORDER BY created_at ASC LIMIT 200`, which
// always returns the SAME oldest 200 rows no matter how many more exist
// -- any thread that outlives 200 total messages would silently freeze,
// with every message after the 200th ever sent invisible to both sides.
// Zero prior test coverage existed for this live, frontend-wired route.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    raw: db,
  };
}

const idp = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const makeToken = (userId, role, orgId) => jwt.sign({ sub: userId, role, org: orgId, name: 'Test', email: 't@test.com' }, config.jwtSecret, { expiresIn: '1h' });

async function seedOrg(db, suffix) {
  const orgId = idp('org'); const trainerId = idp('usr'); const ownerId = idp('usr'); const clientUserId = idp('usr'); const clientId = idp('cli');
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [orgId, `Org ${suffix}`, `org-${suffix}-${orgId}`, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Trainer', 1, ?)`, [trainerId, orgId, `t-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'GYM_OWNER', 'Owner', 1, ?)`, [ownerId, orgId, `o-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Client', 1, ?)`, [clientUserId, orgId, `c-${orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', [clientId, clientUserId, orgId, trainerId, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  return { orgId, trainerId, ownerId, clientUserId, clientId };
}

async function startApi(db) {
  const messageRoutes = (await import('../src/routes/messages.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/messages', messageRoutes(db));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/messages${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

test('GET /api/messages rejects an unauthenticated request', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/?client_id=${a.clientId}`);
  assert.equal(r.status, 401);
});

test('GET /api/messages requires client_id', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 422);
});

test('GET /api/messages 404s for a nonexistent client', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', '/?client_id=does_not_exist', { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 404);
});

test('GET /api/messages rejects a trainer from a different org (cross-org)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const b = await seedOrg(db, 'b');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(b.trainerId, 'TRAINER', b.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/messages rejects a same-org trainer who is not this client\'s assigned trainer', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherTrainerId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'TRAINER', 'Other', 1, ?)`, [otherTrainerId, a.orgId, `other-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(otherTrainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 403);
});

test('GET /api/messages allows the owner regardless of trainer assignment', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(a.ownerId, 'GYM_OWNER', a.orgId) });
  assert.equal(r.status, 200);
});

test('GET /api/messages rejects a client reading someone else\'s thread', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherClientUserId = idp('usr');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Other Client', 1, ?)`, [otherClientUserId, a.orgId, `oc-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(otherClientUserId, 'CLIENT', a.orgId) });
  assert.equal(r.status, 403);
});

test('POST /api/messages: a client can message their own trainer, and it round-trips through GET', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const post = await call('POST', '/', { token: makeToken(a.clientUserId, 'CLIENT', a.orgId), body: { client_id: a.clientId, body: 'Hey coach' } });
  assert.equal(post.status, 201);

  const get = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(get.status, 200);
  assert.equal(get.json.messages.length, 1);
  assert.equal(get.json.messages[0].body, 'Hey coach');
  assert.equal(get.json.messages[0].from_user, a.clientUserId);
  assert.equal(get.json.messages[0].to_user, a.trainerId);

  // Mirrored into the recipient's notification center.
  const notif = await db.q1(`SELECT * FROM notifications WHERE user_id = ? AND type = 'message'`, [a.trainerId]);
  assert.ok(notif, 'a message must mirror into the recipient\'s notifications');
});

test('POST /api/messages rejects a client messaging on behalf of a different client_id', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const otherClientUserId = idp('usr'); const otherClientId = idp('cli');
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Other', 1, ?)`, [otherClientUserId, a.orgId, `oc2-${a.orgId}@test.com`, 'x', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, goal, created_at) VALUES (?, ?, ?, ?, ?, ?)', [otherClientId, otherClientUserId, a.orgId, a.trainerId, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('POST', '/', { token: makeToken(a.clientUserId, 'CLIENT', a.orgId), body: { client_id: otherClientId, body: 'Impersonation attempt' } });
  assert.equal(r.status, 403);
  const rows = await db.q('SELECT * FROM messages WHERE client_id = ?', [otherClientId]);
  assert.equal(rows.length, 0);
});

test('POST /api/messages rejects a trainer messaging a client outside their org', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const b = await seedOrg(db, 'b');
  const { call, close } = await startApi(db); t.after(() => close());
  const r = await call('POST', '/', { token: makeToken(b.trainerId, 'TRAINER', b.orgId), body: { client_id: a.clientId, body: 'Cross-org' } });
  assert.equal(r.status, 403);
});

test('POST /api/messages rejects a body over 2000 chars and a missing client_id (schema-validated)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  const { call, close } = await startApi(db); t.after(() => close());

  const tooLong = await call('POST', '/', { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { client_id: a.clientId, body: 'x'.repeat(2001) } });
  assert.equal(tooLong.status, 422);

  const noClient = await call('POST', '/', { token: makeToken(a.trainerId, 'TRAINER', a.orgId), body: { body: 'hi' } });
  assert.equal(noClient.status, 422);
});

test('GET /api/messages returns the 200 MOST RECENT messages, not the oldest 200 (pagination bug regression)', async (t) => {
  resetRateLimits();
  const db = await memDb();
  const a = await seedOrg(db, 'a');
  // Insert 210 messages directly with strictly increasing timestamps so
  // ordering is unambiguous, cheaper than 210 real HTTP round-trips.
  for (let i = 0; i < 210; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await db.run(
      `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
       VALUES (?, ?, ?, ?, ?, 'message', ?, 'inapp', 0, ?)`,
      [`msg_${i}`, a.orgId, a.trainerId, a.clientUserId, a.clientId, `message ${i}`, ts]);
  }
  const { call, close } = await startApi(db); t.after(() => close());

  const r = await call('GET', `/?client_id=${a.clientId}`, { token: makeToken(a.trainerId, 'TRAINER', a.orgId) });
  assert.equal(r.status, 200);
  assert.equal(r.json.messages.length, 200, 'must return 200 rows, the configured cap');
  // The oldest 10 (message 0..9) must have been dropped in favor of the
  // newest 200 (message 10..209) -- the exact regression this test guards.
  assert.equal(r.json.messages[0].body, 'message 10', 'the oldest surviving message must be #10, not #0');
  assert.equal(r.json.messages[r.json.messages.length - 1].body, 'message 209', 'the newest message must always be present');
  // Still returned oldest-first for chat-style display.
  const bodies = r.json.messages.map((m) => m.body);
  assert.deepEqual(bodies, [...bodies].sort((x, y) => Number(x.split(' ')[1]) - Number(y.split(' ')[1])));
});
