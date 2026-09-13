// ============================================================
// "MY WORKOUTS DON'T SYNC AUTOMATICALLY" — with nothing in the logs.
//
// The webhook matches an incoming delivery to a connection by
// external_account_id. That column was written exactly once, at OAuth
// callback time, by a best-effort profile fetch — and exchangeCode's own
// comment said "the next successful sync retries it". Nothing ever did.
//
// So a single transient failure during connect left a connection that
// syncs perfectly when asked and can NEVER receive a webhook: the lookup
// finds no row, acks 200, and nothing anywhere looks broken. On-demand
// sync keeps working, which is why it presents as "some workouts show up
// and some don't" rather than as an outage.
//
// These tests make the promised retry real, and hold the two properties
// that make it safe: it only runs when the id is missing, and a failure
// to fetch it never fails the sync.
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

async function seedConnection(db, { externalId = null } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('u1','o1','a@x.in','x','CLIENT','C',1,?)`, [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', ['c1', 'u1', 'o1', ts]);
  await db.run(
    `INSERT INTO health_provider_connections
       (id, user_id, org_id, provider, status, access_token, refresh_token, token_expires_at, external_account_id, sync_status, created_at, updated_at)
     VALUES ('hc1','u1','o1','whoop','connected','tok','ref',?,?,'idle',?,?)`,
    [new Date(Date.now() + 3600_000).toISOString(), externalId, ts, ts]);
  return 'hc1';
}

/** A provider stub: real enough to drive syncOneConnection, with the one
 *  method under test observable. */
function stubProvider({ externalId = '5551212', throws = false } = {}) {
  let calls = 0;
  return {
    key: 'whoop',
    supportsWebhook: true,
    refreshAccessToken: null,     // token still valid; no refresh path needed
    async fetchExternalAccountId() {
      calls += 1;
      if (throws) throw new Error('profile fetch failed');
      return externalId;
    },
    async incrementalSync() { return { records: [], nextCursor: 'cur-1' }; },
    get calls() { return calls; },
  };
}

async function syncOnce(db, provider, connId) {
  const { __testables } = await import('../src/routes/health.js');
  const conn = await db.q1('SELECT * FROM health_provider_connections WHERE id = ?', [connId]);
  return __testables.syncOneConnection(db, provider, conn);
}

test('a sync backfills the provider user id when it is missing', async () => {
  const db = await memDb();
  await seedConnection(db, { externalId: null });
  const provider = stubProvider({ externalId: '5551212' });

  const res = await syncOnce(db, provider, 'hc1');
  assert.equal(res.ok, true);

  const conn = await db.q1('SELECT external_account_id FROM health_provider_connections WHERE id = ?', ['hc1']);
  assert.equal(conn.external_account_id, '5551212',
    'without this the webhook can never match this connection again');
});

test('it does not re-fetch when the id is already known', async () => {
  // One extra API call on every sync, forever, for nothing.
  const db = await memDb();
  await seedConnection(db, { externalId: '999' });
  const provider = stubProvider({ externalId: '5551212' });

  await syncOnce(db, provider, 'hc1');
  assert.equal(provider.calls, 0);
  const conn = await db.q1('SELECT external_account_id FROM health_provider_connections WHERE id = ?', ['hc1']);
  assert.equal(conn.external_account_id, '999', 'an existing id is never overwritten');
});

test('a failed lookup never fails the sync', async () => {
  // The records are the point; the id is a nicety for next time.
  const db = await memDb();
  await seedConnection(db, { externalId: null });
  const provider = stubProvider({ throws: true });

  const res = await syncOnce(db, provider, 'hc1');
  assert.equal(res.ok, true, 'the sync still succeeded');
  const conn = await db.q1('SELECT external_account_id, sync_status FROM health_provider_connections WHERE id = ?', ['hc1']);
  assert.equal(conn.external_account_id, null);
  assert.equal(conn.sync_status, 'idle', 'and the connection is not left in an error state');
});

test('a provider with no such method is simply skipped', async () => {
  // Apple Health and Health Connect are push-based and have no OAuth
  // profile endpoint to ask.
  const db = await memDb();
  await seedConnection(db, { externalId: null });
  const provider = { key: 'whoop', refreshAccessToken: null, async incrementalSync() { return { records: [], nextCursor: null }; } };

  const res = await syncOnce(db, provider, 'hc1');
  assert.equal(res.ok, true);
});
