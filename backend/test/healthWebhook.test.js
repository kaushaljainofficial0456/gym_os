// ============================================================
// HTTP-level test for POST /api/health/providers/:provider/webhook
// (backend/src/routes/health.js) -- the automatic-sync path that
// replaces "the user has to keep tapping Sync now". Mounts health.js's
// real router with the SAME express.raw() wiring index.js uses for this
// exact path (signature verification is HMAC'd over WHOOP's raw bytes,
// so a pre-parsed JSON body would never verify), against a real
// (in-memory) SQLite DB, with global fetch mocked ONLY for WHOOP's API
// host -- everything else (the test's own HTTP calls) goes through.
//
// Covers: valid signature -> immediate sync + real health_records
// written; invalid signature -> 401, never syncs; unknown/disconnected
// external_account_id -> 200 no-op (not an error WHOOP should retry);
// a .deleted event type -> 200 no-op (deletion isn't handled yet -- see
// whoopProvider.js's header -- acked honestly rather than pretending to
// process it).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../src/config.js';
import healthRoutes from '../src/routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

const WEBHOOK_SECRET = 'webhook-test-secret';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
  });
  return mk();
}

async function seedConnectedWhoop(db, { externalAccountId = '999', status = 'connected' } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Org', 'org', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@test.com', 'x', 'Client', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO clients (id, user_id, org_id, goal, current_weight, age, sex, height_cm, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['c1', 'u1', 'o1', 'GENERAL', 78, 30, 'male', 178, '2026-01-01T00:00:00Z']);
  await db.run(
    `INSERT INTO health_provider_connections (id, user_id, org_id, provider, status, external_account_id, access_token, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['hconn1', 'u1', 'o1', 'whoop', status, externalAccountId, 'test-access-token', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  return { userId: 'u1', orgId: 'o1', connId: 'hconn1' };
}

// Mirrors index.js's exact middleware order for this one path: raw body
// for the webhook route, express.json() for everything else.
async function startApp(db) {
  const app = express();
  app.use('/api/health/providers/whoop/webhook', express.raw({ type: 'application/json', limit: '256kb' }));
  app.use(express.json());
  app.use('/api/health', healthRoutes(db));
  const server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function sign(rawBody, timestamp, secret = WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('base64');
}

function mockWhoopApi(t) {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (!u.includes('api.prod.whoop.com')) return realFetch(url, opts);
    if (u.includes('/activity/workout')) {
      return new Response(JSON.stringify({ records: [{
        id: 'w1', start: '2026-02-01T18:00:00Z', end: '2026-02-01T18:30:00Z', sport_id: 45, score_state: 'SCORED',
        score: { strain: 10, average_heart_rate: 130, max_heart_rate: 160, kilojoule: 800 },
      }] }), { status: 200 });
    }
    // No new recovery/sleep for this event -- keeps the fixture focused.
    return new Response(JSON.stringify({ records: [] }), { status: 200 });
  });
}

test('WHOOP webhook: valid signature triggers an immediate sync, writes a real health_record', async (t) => {
  const originalSecret = config.whoopClientSecret;
  config.whoopClientSecret = WEBHOOK_SECRET;
  t.after(() => { config.whoopClientSecret = originalSecret; });

  const db = await memDb();
  const { connId } = await seedConnectedWhoop(db);
  const { port, close } = await startApp(db);
  t.after(() => close());
  mockWhoopApi(t);

  const rawBody = JSON.stringify({ user_id: 999, id: 'evt1', type: 'workout.updated', trace_id: 'trace1' });
  const timestamp = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${port}/api/health/providers/whoop/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WHOOP-Signature': sign(rawBody, timestamp), 'X-WHOOP-Signature-Timestamp': timestamp },
    body: rawBody,
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.synced, true);
  assert.equal(json.result.ok, true);
  assert.equal(json.result.recordsInserted, 1);

  const record = await db.q1('SELECT * FROM health_records WHERE provider = ? AND provider_record_id = ?', ['whoop', 'w1']);
  assert.ok(record, 'the real workout record from the mocked WHOOP response must be persisted');
  const conn = await db.q1('SELECT * FROM health_provider_connections WHERE id = ?', [connId]);
  assert.ok(conn.last_synced_at, 'last_synced_at must be updated by the webhook-triggered sync, same as a manual sync would');
});

test('WHOOP webhook: an invalid signature is rejected with 401 and never syncs', async (t) => {
  const originalSecret = config.whoopClientSecret;
  config.whoopClientSecret = WEBHOOK_SECRET;
  t.after(() => { config.whoopClientSecret = originalSecret; });

  const db = await memDb();
  await seedConnectedWhoop(db);
  const { port, close } = await startApp(db);
  t.after(() => close());
  const calls = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { calls.push(String(url)); return realFetch(url, opts); });

  const rawBody = JSON.stringify({ user_id: 999, id: 'evt1', type: 'workout.updated', trace_id: 'trace1' });
  const timestamp = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${port}/api/health/providers/whoop/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WHOOP-Signature': 'not-a-real-signature', 'X-WHOOP-Signature-Timestamp': timestamp },
    body: rawBody,
  });
  assert.equal(res.status, 401);
  assert.equal(calls.filter((u) => u.includes('api.prod.whoop.com')).length, 0, 'an unverified webhook must never trigger a real provider sync call');
});

test('WHOOP webhook: unknown external_account_id acks 200 without syncing (not an error WHOOP should retry)', async (t) => {
  const originalSecret = config.whoopClientSecret;
  config.whoopClientSecret = WEBHOOK_SECRET;
  t.after(() => { config.whoopClientSecret = originalSecret; });

  const db = await memDb();
  await seedConnectedWhoop(db, { externalAccountId: '111' }); // different from the payload's user_id below
  const { port, close } = await startApp(db);
  t.after(() => close());
  mockWhoopApi(t);

  const rawBody = JSON.stringify({ user_id: 999, id: 'evt1', type: 'workout.updated', trace_id: 'trace1' });
  const timestamp = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${port}/api/health/providers/whoop/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WHOOP-Signature': sign(rawBody, timestamp), 'X-WHOOP-Signature-Timestamp': timestamp },
    body: rawBody,
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.synced, false);
});

test('WHOOP webhook: a .deleted event is acked as a no-op, not silently treated as .updated', async (t) => {
  const originalSecret = config.whoopClientSecret;
  config.whoopClientSecret = WEBHOOK_SECRET;
  t.after(() => { config.whoopClientSecret = originalSecret; });

  const db = await memDb();
  await seedConnectedWhoop(db);
  const { port, close } = await startApp(db);
  t.after(() => close());
  const calls = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => { calls.push(String(url)); return realFetch(url, opts); });

  const rawBody = JSON.stringify({ user_id: 999, id: 'evt1', type: 'workout.deleted', trace_id: 'trace1' });
  const timestamp = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${port}/api/health/providers/whoop/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WHOOP-Signature': sign(rawBody, timestamp), 'X-WHOOP-Signature-Timestamp': timestamp },
    body: rawBody,
  });
  assert.equal(res.status, 200);
  assert.equal(calls.filter((u) => u.includes('api.prod.whoop.com')).length, 0, 'a .deleted event must not trigger a sync call');
});
