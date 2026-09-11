// ============================================================
// Regression test for an audit-session fix: SUPER_ADMIN's "Suspend gym"
// (POST /console/gyms/:id/suspend) updated org_billing_state.status but
// nothing in the actual request path ever read it back -- a suspended
// gym's owner/trainers/clients could keep using every route completely
// normally. Confirmed live: suspending a freshly-onboarded test gym, then
// logging in as its owner, returned a normal 200 from GET /admin/overview.
//
// requireAuth now enforces it via getOrgBillingStatusCached /
// invalidateOrgBillingCache (auth.js). Both are exported and tested
// directly here with an isolated in-memory db, rather than through a full
// HTTP round trip: requireAuth calls the process-wide getDb() singleton
// internally (see db.js), not a db handle threaded through per request,
// so an HTTP-level test can't substitute an isolated database for it
// without either touching the real dev database or monkey-patching a
// module singleton -- exactly the kind of fragile test this codebase's
// other memDb()-based tests avoid. Unit-testing the actual cache/lookup
// function requireAuth calls is the correct level of isolation for this
// specific piece, and is what actually executes in production.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgBillingStatusCached, invalidateOrgBillingCache } from '../src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db,
  });
  return mk();
}

test('getOrgBillingStatusCached reflects a SUSPENDED status, and reactivation after invalidation', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['org_susp', 'Suspendable Gym', 'susp-gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO org_billing_state (org_id, status, updated_at) VALUES ('org_susp', 'ACTIVE', ?)`, ['2026-01-01T00:00:00Z']);
  invalidateOrgBillingCache('org_susp'); // clean slate -- another test file/run may have cached this id

  assert.equal(await getOrgBillingStatusCached(db, 'org_susp'), 'ACTIVE');

  // Mirrors what console.js's real /suspend route does: update the row,
  // then invalidate so the next read reflects it instead of the cached one.
  await db.run(`UPDATE org_billing_state SET status = 'SUSPENDED' WHERE org_id = 'org_susp'`);
  assert.equal(await getOrgBillingStatusCached(db, 'org_susp'), 'ACTIVE', 'still cached -- the TTL has not been invalidated yet');
  invalidateOrgBillingCache('org_susp');
  assert.equal(await getOrgBillingStatusCached(db, 'org_susp'), 'SUSPENDED', 'reflects the update once invalidated, exactly as requireAuth will see it on the org\'s next request');

  await db.run(`UPDATE org_billing_state SET status = 'ACTIVE' WHERE org_id = 'org_susp'`);
  invalidateOrgBillingCache('org_susp');
  assert.equal(await getOrgBillingStatusCached(db, 'org_susp'), 'ACTIVE', 'reactivation is picked up the same way');
});

test('an org with no org_billing_state row resolves to null (fail open) -- legacy/seed orgs are never gated', async () => {
  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['org_legacy', 'Legacy Gym', 'legacy-gym', '2026-01-01T00:00:00Z']);
  // deliberately no org_billing_state row for org_legacy
  invalidateOrgBillingCache('org_legacy');
  const status = await getOrgBillingStatusCached(db, 'org_legacy');
  assert.equal(status, null, 'a missing row must resolve to null, not be mistaken for a blocking status');
  // requireAuth's own gate is `billingStatus === 'SUSPENDED'` -- null never matches it.
  assert.notEqual(status, 'SUSPENDED');
});

test('a falsy orgId (SUPER_ADMIN\'s platform-wide token) short-circuits to null without querying', async () => {
  const db = await memDb();
  // A db whose q1() throws if ever called -- proves the null/undefined
  // orgId guard returns before any query, matching requireAuth's own
  // `if (req.user.org && db)` guard (SUPER_ADMIN's token carries org:
  // null, so the billing check is skipped for that role entirely).
  const poisoned = { q1: () => { throw new Error('must not query for a falsy orgId'); } };
  assert.equal(await getOrgBillingStatusCached(poisoned, null), null);
  assert.equal(await getOrgBillingStatusCached(poisoned, undefined), null);
});
