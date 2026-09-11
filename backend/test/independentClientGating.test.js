// ============================================================
// Independent clients (Google sign-in, no gym) must not be offered
// gym-only features: there is no physical gym to have a live crowd, and
// no gym community to join.
//
// Reported live: independent clients were seeing both. crowd_enabled=0
// was set on the shared independent org, but community_enabled never
// was -- it fell back to the schema's DEFAULT 1. And because that row is
// created with ON CONFLICT DO NOTHING, fixing the INSERT does not repair
// orgs that already exist. So the gate is STRUCTURAL (organizations.type)
// rather than settings-based; these tests pin that down, including for an
// org whose settings row still says community_enabled = 1.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import { invalidateOrgKindCache } from '../src/services/orgKind.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const JWT_SECRET = 'test-secret-independent-gating';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const st = db.prepare(sql); return params.length ? st.all(...params) : st.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const st = db.prepare(sql); const r = params.length ? st.run(...params) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { db.exec('BEGIN'); try { const out = await fn(mk()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } },
    raw: db,
  });
  return mk();
}

/** Seeds one org of the given type with a client in it. Deliberately
 *  writes community_enabled = 1 for BOTH, mirroring the real independent
 *  org whose settings row predates the fix. */
async function seedOrg(db, { orgId, type, userId, clientId }) {
  const ts = '2026-01-01T00:00:00Z';
  await db.run('INSERT INTO organizations (id, name, slug, type, created_at) VALUES (?,?,?,?,?)',
    [orgId, `Org ${orgId}`, orgId, type, ts]);
  await db.run('INSERT INTO gym_settings (org_id, brand_name, crowd_capacity, crowd_enabled, community_enabled, updated_at) VALUES (?,?,?,?,?,?)',
    [orgId, 'SK OS', 150, 1, 1, ts]);
  await db.run('INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
    [userId, orgId, `${userId}@test.com`, 'x', 'CLIENT', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)',
    [clientId, userId, orgId, 'GENERAL', ts]);
  // The community feature is behind a platform flag that init-db.js seeds;
  // a raw schema.sql test DB has no flags, so seed it here (idempotently)
  // or every org would look community-disabled for flag reasons rather
  // than for the org-type reason under test.
  const existingFlag = await db.q1("SELECT id FROM feature_flags WHERE key = 'community'");
  if (!existingFlag) {
    await db.run("INSERT INTO feature_flags (id, key, name, enabled, rollout_percentage, created_at, updated_at) VALUES ('ff_comm','community','Community',1,100,?,?)", [ts, ts]);
  }
}

async function startApp(db) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const communityRoutes = (await import('../src/routes/community.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  app.use('/api/community', communityRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (p, userId, orgId) => {
    const token = jwt.sign({ sub: userId, role: 'CLIENT', org: orgId, name: 'Client', email: `${userId}@test.com` }, JWT_SECRET);
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

function withJwt(t) {
  const original = config.jwtSecret;
  config.jwtSecret = JWT_SECRET;
  t.after(() => { config.jwtSecret = original; invalidateOrgKindCache(); });
}

test('an independent client is not offered the gym crowd, even though the settings row says crowd_enabled = 1', async (t) => {
  withJwt(t);
  const db = await memDb();
  await seedOrg(db, { orgId: 'independent', type: 'independent', userId: 'u_ind', clientId: 'c_ind' });
  const { call, close } = await startApp(db);
  t.after(() => close());

  const res = await call('/api/me/crowd', 'u_ind', 'independent');
  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, false, 'no gym means no crowd -- the Home card hides on this flag');
  assert.equal(res.json.reason, 'no_gym');
});

test('an independent client is not offered a gym community to join, even with community_enabled = 1 in settings', async (t) => {
  withJwt(t);
  const db = await memDb();
  await seedOrg(db, { orgId: 'independent', type: 'independent', userId: 'u_ind', clientId: 'c_ind' });
  const { call, close } = await startApp(db);
  t.after(() => close());

  const res = await call('/api/community/membership', 'u_ind', 'independent');
  assert.equal(res.status, 200);
  assert.equal(res.json.available, false);
  assert.equal(res.json.settings.community_enabled, false, 'the Home card hides on this flag');
  assert.equal(res.json.settings.leaderboard_enabled, false);
});

test('a real gym client still gets both features -- the gate is narrow, not a blanket removal', async (t) => {
  withJwt(t);
  const db = await memDb();
  await seedOrg(db, { orgId: 'gym1', type: 'gym', userId: 'u_gym', clientId: 'c_gym' });
  const { call, close } = await startApp(db);
  t.after(() => close());

  const crowd = await call('/api/me/crowd', 'u_gym', 'gym1');
  assert.equal(crowd.status, 200);
  assert.notEqual(crowd.json.enabled, false, 'a real gym still reports its crowd');

  const community = await call('/api/community/membership', 'u_gym', 'gym1');
  assert.equal(community.status, 200);
  assert.equal(community.json.available, true);
  assert.equal(community.json.settings.community_enabled, true);
});
