// ============================================================
// TENANT ISOLATION -- adversarial tests for the fail-closed RLS model.
//
// Two parts:
//   1. Always run: static guards on database/rls.sql and the migration,
//      and the AsyncLocalStorage context model through real Express +
//      requireAuth (no database needed).
//   2. TEST_DATABASE_URL set: the REAL backend/src/db.js adapter, on a
//      LOGIN role WITHOUT BYPASSRLS (like production's skos_app), against a
//      schema built by the real init path (scripts/init-db.js). Pools of
//      size ONE force every request through the same connection.
//
//   TEST_DATABASE_URL=postgres://<superuser>@host/db node --test backend/test/rlsTenantIsolation.test.js
//
// Everything lives in its own schema + role, both dropped at the end.
// Never point TEST_DATABASE_URL at a database you care about.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import {
  runWithOrg, runAsPlatform, platformScope, currentOrg, currentScope, resolveContext, assertOrgId, createPgDb,
} from '../src/db.js';
import { requireAuth } from '../src/auth.js';
import { RLS_EXEMPT_TABLES, RLS_GLOBAL_TABLES, verifyRls } from '../scripts/rls-verify.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const rlsSql = read('database/rls.sql');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 1. STATIC + CONTEXT MODEL (always run)
// ------------------------------------------------------------
test('rls.sql has no fail-open "app.org_id unset => every row" branch', () => {
  assert.ok(!/NULLIF\(current_setting\('app\.org_id', true\), ''\) IS NULL/i.test(rlsSql),
    'the old escape that made every plain query bypass RLS must be gone');
  assert.ok(rlsSql.includes("current_setting('app.platform', true) = 'on'"), 'cross-tenant access is an explicit platform flag');
  assert.ok(!/set_config\([^)]*false\)/i.test(rlsSql), 'no session-level settings');
});

test('the versioned migration is rls.sql verbatim, with a self-check, and has a rollback', () => {
  const up = read('database/migrations/2026-11-16_rls_fail_closed/up.sql');
  const down = read('database/migrations/2026-11-16_rls_fail_closed/down.sql');
  const body = up.slice(up.indexOf('-- >>> database/rls.sql\n') + '-- >>> database/rls.sql\n'.length, up.indexOf('-- <<< database/rls.sql'));
  assert.equal(body, rlsSql, 'up.sql must embed the current database/rls.sql exactly -- regenerate it');
  assert.match(up, /BEGIN;[\s\S]*DO \$verify\$[\s\S]*COMMIT;/, 'atomic, with the fail-closed self-check before COMMIT');
  assert.match(down, /DROP POLICY %I ON %I/, 'down drops every new policy before restoring the old file');
});

test('every table with an org/client id column (incl. sender_org_id, host_org_id, ...) is protected or deliberately exempt', () => {
  const src = read('database/schema.sql') + '\n' + read('backend/scripts/init-db.js');
  const enabled = new Set([...rlsSql.matchAll(/^ALTER TABLE (\w+)\s+ENABLE ROW LEVEL SECURITY/gm)].map((m) => m[1]));
  const missing = [];
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
    const [, table, body] = m;
    if (/^\s*(\w+_)?(org|client)_id\s/m.test(body) && !enabled.has(table) && !RLS_EXEMPT_TABLES.has(table)) missing.push(table);
  }
  assert.deepEqual([...new Set(missing)], [], 'unprotected tenant tables');
  for (const t of RLS_EXEMPT_TABLES) assert.ok(rlsSql.includes(t), `${t} is exempt in code but not documented in rls.sql`);
});

test('context resolution: tenant, platform, none, and refusals', async () => {
  assert.deepEqual(resolveContext(), { org: null, platform: false }, 'no context -> neither setting (fail closed)');
  await runWithOrg('org_a', async () => {
    assert.deepEqual(resolveContext(), { org: 'org_a', platform: false });
    assert.deepEqual(resolveContext({ txOrgId: 'org_a', inTx: true }), { org: 'org_a', platform: false });
    assert.throws(() => resolveContext({ txOrgId: 'org_b', inTx: true }), /tenant context mismatch/, 'a tenant cannot open a tx in another gym');
    assert.deepEqual(resolveContext({ mode: 'off' }), { org: null, platform: true }, 'kill switch: plain statements as platform');
    assert.deepEqual(resolveContext({ mode: 'off', inTx: true }), { org: 'org_a', platform: false }, 'kill switch keeps tx tenant-scoped');
  });
  await runAsPlatform('test', async () => {
    assert.deepEqual(resolveContext(), { org: null, platform: true });
    assert.deepEqual(resolveContext({ txOrgId: 'org_b', inTx: true }), { org: 'org_b', platform: false }, 'platform may narrow to one gym');
  });
  // A signed-in user with no gym is RESTRICTED, never platform: being
  // org-less used to mean RLS-bypassed. Platform is runAsPlatform only.
  await runWithOrg(null, async () => {
    assert.equal(currentScope(), 'restricted', 'org-less user is restricted, not platform');
    assert.deepEqual(resolveContext(), { org: null, platform: false, restricted: true });
  });
  for (const bad of ["x' OR '1'='1", '', 'a b', 'org;DROP', 'x'.repeat(129), "o\\'", null]) {
    assert.throws(() => assertOrgId(bad), /invalid tenant context/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(currentOrg(), null, 'nothing leaks out of the contexts above');
});

test('context is per async chain: 300 interleaved "requests" never see each other\'s org', async () => {
  const seen = await Promise.all(Array.from({ length: 300 }, (_, i) => {
    const org = `org_${i % 7}`;
    return runWithOrg(org, async () => {
      await sleep(Math.random() * 5);
      const a = currentOrg();
      await Promise.resolve();
      await sleep(Math.random() * 5);
      return a === org && currentOrg() === org;
    });
  }));
  assert.ok(seen.every(Boolean));
});

/** An Express app wired like index.js: body parsers, then the request-wide
 *  platform scope, then routes that use requireAuth. */
function contextApp(db) {
  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use(platformScope('http-request'));
  const report = (req, res) => res.json({ scope: currentScope(), org: currentOrg() });
  app.post('/public', report);
  app.post('/tenant', requireAuth, async (req, res) => { await sleep(Math.random() * 10); report(req, res); });
  app.post('/widened', requireAuth, platformScope('test-cross-gym'), report);
  return app;
}
// Users the auth gate can look up: 'sa' is a real SUPER_ADMIN; 'demoted' still
// carries a SUPER_ADMIN token but the row says otherwise.
const FAKE_USERS = { sa: { role: 'SUPER_ADMIN', org_id: null, active: 1 }, demoted: { role: 'CLIENT', org_id: null, active: 1 } };
const fakeDb = {
  driver: 'sqlite',
  q1: async (sql, params = []) => (/SELECT role, org_id, active FROM users/.test(sql) ? FAKE_USERS[params[0]] || null : null),
  q: async () => [],
  run: async () => ({ changes: 0 }),
};
const tokenFor = (claims, secret = config.jwtSecret) => jwt.sign({ name: 'x', email: 'x@test.invalid', ...claims }, secret, { algorithm: 'HS256', expiresIn: '1h' });

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const post = async (base, p, { token, body = {}, headers = {} } = {}) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('HTTP: context survives the body parser and requireAuth; the request cannot choose its org', async () => {
  await withServer(contextApp(fakeDb), async (base) => {
    assert.deepEqual((await post(base, '/public', { body: { org_id: 'org_b' } })).json, { scope: 'platform', org: null });
    const a = tokenFor({ sub: 'u_a', role: 'GYM_OWNER', org: 'org_a' });
    const r = await post(base, '/tenant', { token: a, body: { org_id: 'org_b', orgId: 'org_b' }, headers: { 'x-org-id': 'org_b' } });
    assert.deepEqual(r.json, { scope: 'tenant', org: 'org_a' }, 'org comes from the signed token only');
    assert.equal((await post(base, '/tenant', { token: tokenFor({ sub: 'u', role: 'GYM_OWNER', org: 'org_b' }, 'wrong-secret-wrong-secret') })).status, 401);
    assert.deepEqual((await post(base, '/widened', { token: a })).json, { scope: 'platform', org: null });
    assert.deepEqual((await post(base, '/tenant', { token: tokenFor({ sub: 'sa', role: 'SUPER_ADMIN', org: null }) })).json, { scope: 'platform', org: null });
    // Privilege escalation: being signed in WITHOUT a gym is not platform.
    assert.deepEqual((await post(base, '/tenant', { token: tokenFor({ sub: 'pending', role: 'CLIENT', org: null }) })).json, { scope: 'restricted', org: null },
      'a member who has not joined a gym gets no tenant rows, not every gym');
    assert.deepEqual((await post(base, '/tenant', { token: tokenFor({ sub: 'pending_t', role: 'TRAINER', org: null }) })).json, { scope: 'restricted', org: null });
    // A SUPER_ADMIN claim is checked against the users row on every request.
    assert.deepEqual((await post(base, '/tenant', { token: tokenFor({ sub: 'demoted', role: 'SUPER_ADMIN', org: null }) })).json, { scope: 'restricted', org: null },
      'a demoted admin token loses platform scope');
    assert.deepEqual((await post(base, '/tenant', { token: tokenFor({ sub: 'ghost', role: 'SUPER_ADMIN', org: null }) })).json, { scope: 'restricted', org: null },
      'a SUPER_ADMIN claim with no users row is not platform');
    // Concurrency across real sockets.
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => {
      const org = i % 2 ? 'org_a' : 'org_b';
      return post(base, '/tenant', { token: tokenFor({ sub: `u${i}`, role: 'CLIENT', org }) }).then((x) => x.json.org === org);
    }));
    assert.ok(results.every(Boolean), 'no request ever observed another request\'s org');
  });
});

// ------------------------------------------------------------
// 2. POSTGRESQL (TEST_DATABASE_URL)
// ------------------------------------------------------------
const PG_URL = process.env.TEST_DATABASE_URL || '';
const skip = PG_URL ? false : 'set TEST_DATABASE_URL to run the PostgreSQL tenant-isolation suite';

test('PostgreSQL: cross-gym attacks against the real adapter on a NOBYPASSRLS role', { skip, concurrency: false }, async (t) => {
  const { default: pg } = await import('pg');
  const tag = `rls${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  const S = `${tag}_s`;
  const ROLE = `${tag}_app`;
  const PW = `pw_${Math.random().toString(36).slice(2)}`;
  const opt = `-c search_path=${S}`;
  const urlWith = (user, pass) => { const u = new URL(PG_URL); if (user) { u.username = user; u.password = pass; } u.searchParams.set('options', opt); return u.toString(); };

  const boot = new pg.Client({ connectionString: PG_URL });
  await boot.connect();
  await boot.query(`CREATE SCHEMA ${S}`);
  await boot.end();
  const admin = new pg.Pool({ connectionString: PG_URL, options: opt, max: 3 });
  let db1; let db4;
  t.after(async () => {
    await db1?.raw.end().catch(() => {});
    await db4?.raw.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
    await admin.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await admin.end().catch(() => {});
  });

  await t.test('the real init path (schema + migrations + rls.sql) builds the schema', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
      { env: { ...process.env, DATABASE_URL: urlWith(), NODE_ENV: 'development' }, cwd: root });
    assert.match(stdout, /RLS policies applied/);
  });

  await t.test('upgrade path: old policies -> down.sql -> up.sql leaves exactly the fail-closed set', async () => {
    const c = await admin.connect();
    try {
      const policies = async () => (await c.query(`SELECT count(*)::int n FROM pg_policy p JOIN pg_class k ON k.oid = p.polrelid JOIN pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = $1`, [S])).rows[0].n;
      const fresh = await policies();
      await c.query(read('database/migrations/2026-11-16_rls_fail_closed/down.sql'));
      // Rollback must not leave any table locked: RLS on with no policy is
      // deny-all (the tables this change newly protected, e.g. communities).
      const locked = (await c.query(`SELECT k.relname FROM pg_class k JOIN pg_namespace s ON s.oid = k.relnamespace
         WHERE s.nspname = $1 AND k.relkind = 'r' AND k.relrowsecurity
           AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = k.oid)`, [S])).rows.map((r) => r.relname);
      assert.deepEqual(locked, [], 'after down.sql no table is RLS-enabled with no policy');
      const up = read('database/migrations/2026-11-16_rls_fail_closed/up.sql');
      const verify = up.slice(up.indexOf('DO $verify$'), up.indexOf('END $verify$;') + 'END $verify$;'.length);
      await assert.rejects(c.query(verify), /fail-open policy still present/, 'the self-check refuses the old policies');
      await c.query(up);
      await c.query(up); // idempotent
      assert.equal(await policies(), fresh, 'no policy from the old file survives the upgrade');
    } finally { c.release(); }
  });

  // ---- fixture (as the superuser, which bypasses RLS) ----
  const colCache = new Map();
  async function ins(table, row) {
    if (!colCache.has(table)) {
      colCache.set(table, (await admin.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [S, table])).rows);
    }
    const full = { ...row };
    for (const c of colCache.get(table)) {
      if (c.column_name in full || c.is_nullable === 'YES' || c.column_default !== null) continue;
      full[c.column_name] = /int|numeric|real|double/.test(c.data_type) ? 1 : /bool/.test(c.data_type) ? false : `${row.id || table}_${c.column_name}`;
    }
    const keys = Object.keys(full);
    await admin.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => full[k]));
  }
  const now = new Date().toISOString();
  const A = `${tag}_A`; const B = `${tag}_B`; const I = `${tag}_I`;
  const id = (org, x) => `${org}_${x}`;

  await t.test('fixture: gyms A and B with financial, attendance, AI Communication and training rows; one independent member', async () => {
    for (const [org, type] of [[A, 'gym'], [B, 'gym'], [I, 'independent']]) {
      await ins('organizations', { id: org, name: org, slug: `${org}-slug`, type, created_at: now });
      await ins('users', { id: id(org, 'owner'), org_id: org, email: `${org}o@test.invalid`, password_hash: 'x', role: 'GYM_OWNER', name: 'o', active: 1, created_at: now });
      await ins('users', { id: id(org, 'u'), org_id: org, email: `${org}u@test.invalid`, password_hash: 'x', role: 'CLIENT', name: 'm', active: 1, created_at: now });
      await ins('clients', { id: id(org, 'c'), user_id: id(org, 'u'), org_id: org, goal: 'GENERAL', created_at: now });
      await ins('workouts', { id: id(org, 'w'), org_id: org, client_id: id(org, 'c'), name: 'W', created_at: now });
      await ins('workout_exercises', { id: id(org, 'wx'), workout_id: id(org, 'w'), name: 'Bench' });
      await ins('weight_logs', { id: id(org, 'wt'), client_id: id(org, 'c'), date: '2026-11-01', weight: 70, created_at: now });
      if (org === I) continue;
      await ins('payments', { id: id(org, 'pay'), org_id: org, client_id: id(org, 'c'), amount: 1000 });
      await ins('subscriptions', { id: id(org, 'sub'), org_id: org, client_id: id(org, 'c'), plan_name: 'P', amount: 1000, start_date: now, end_date: now });
      await ins('payment_orders', { id: id(org, 'pord'), subject_type: 'CLIENT_MEMBERSHIP', subject_id: id(org, 'tok'), org_id: org, client_id: id(org, 'c'), amount: 100, currency: 'INR', provider: 'mock', status: 'SUCCESS', created_at: now, updated_at: now });
      await ins('payment_transactions', { id: id(org, 'ptxn'), order_id: id(org, 'pord'), provider: 'mock', amount: 100, currency: 'INR', status: 'SUCCESS', created_at: now });
      await ins('invoices', { id: id(org, 'inv'), invoice_number: id(org, 'n'), order_id: id(org, 'pord'), org_id: org, subject_type: 'CLIENT_MEMBERSHIP', amount: 100, currency: 'INR', status: 'ISSUED', issued_at: now, created_at: now });
      await ins('refunds', { id: id(org, 'ref'), payment_order_id: id(org, 'pord'), org_id: org, client_id: id(org, 'c'), type: 'FULL', amount: 100, currency: 'INR', status: 'REQUESTED', created_at: now, updated_at: now });
      await ins('support_tickets', { id: id(org, 'tkt'), org_id: org, created_by: id(org, 'owner'), category: 'BILLING', priority: 'MEDIUM', status: 'OPEN', subject: 's', created_at: now, updated_at: now });
      await ins('support_messages', { id: id(org, 'tmsg'), ticket_id: id(org, 'tkt'), author_id: id(org, 'owner'), body: 'b', internal: 0, created_at: now });
      await ins('attendance', { id: id(org, 'att'), org_id: org, client_id: id(org, 'c'), date: '2026-11-01' });
      await ins('attendance_events', { id: id(org, 'ae'), org_id: org, client_id: id(org, 'c'), ts: now, direction: 'entry' });
      await ins('followup_jobs', { id: id(org, 'job'), org_id: org, client_id: id(org, 'c'), channel: 'sms', dedupe_key: id(org, 'dk'), day_key: '2026-11-01', created_at: now, updated_at: now });
      await ins('followup_consent_log', { id: id(org, 'cl'), org_id: org, client_id: id(org, 'c'), channel: 'sms', action: 'granted', source: 'owner', created_at: now });
      await ins('health_records', { id: id(org, 'hr'), user_id: id(org, 'u'), org_id: org, provider: 'skos', data_type: 'steps', start_time: now, synced_at: now, created_at: now, updated_at: now });
      await ins('foods', { id: id(org, 'food'), org_id: org, client_id: id(org, 'c'), name: 'F', is_global: 0 });
      // AI Communication configuration: the gym's calling numbers and settings.
      await ins('followup_settings', { org_id: org, updated_at: now });
      await ins('followup_numbers', { id: id(org, 'num'), org_id: org, number: `+9100000${org.length}`, created_at: now, updated_at: now });
    }
    // Cross-gym-by-design rows: a friend community and a tournament with
    // members from A and B, and in-app shares A->B and B->independent.
    await ins('communities', { id: `${tag}_comm`, name: 'Friends', created_by: id(A, 'c'), created_at: now, updated_at: now });
    for (const org of [A, B]) await ins('community_memberships', { id: id(org, 'cm'), community_id: `${tag}_comm`, client_id: id(org, 'c'), joined_at: now, updated_at: now });
    await ins('tournaments', { id: `${tag}_tour`, host_org_id: A, created_by: id(A, 'owner'), name: 'Gym Wars', code: `${tag}_code`, created_at: now, updated_at: now });
    for (const org of [A, B]) await ins('tournament_entrants', { id: id(org, 'te'), tournament_id: `${tag}_tour`, user_id: id(org, 'u'), name: 'm', created_at: now, updated_at: now });
    await ins('app_shares', { id: `${tag}_share_ab`, kind: 'workout', snapshot_id: 's1', title: 't', sender_client_id: id(A, 'c'), sender_org_id: A, recipient_client_id: id(B, 'c'), recipient_org_id: B, created_at: now });
    await ins('app_shares', { id: `${tag}_share_bi`, kind: 'workout', snapshot_id: 's2', title: 't', sender_client_id: id(B, 'c'), sender_org_id: B, recipient_client_id: id(I, 'c'), recipient_org_id: I, created_at: now });
    await ins('exercise_library', { id: `${tag}_global_ex`, org_id: null, name: 'Squat', primary_muscle: 'quads', equipment: 'barbell' });
    await ins('foods', { id: `${tag}_global_food`, org_id: null, client_id: null, name: 'Rice', is_global: 1 });

    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await admin.query(`GRANT USAGE ON SCHEMA ${S} TO ${ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${S} TO ${ROLE}`);
    db1 = await createPgDb({ connectionString: urlWith(ROLE, PW), max: 1, options: opt, mode: 'enforce' });
    db4 = await createPgDb({ connectionString: urlWith(ROLE, PW), max: 4, options: opt, mode: 'enforce' });
    const me = await runAsPlatform('t', () => db1.q1('SELECT current_user AS u, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user'));
    assert.equal(me.u, ROLE);
    assert.equal(me.rolbypassrls, false);
    assert.equal(me.rolsuper, false);
  });

  const B_ROWS = [
    ['users', 'u'], ['clients', 'c'], ['payments', 'pay'], ['subscriptions', 'sub'], ['payment_orders', 'pord'],
    ['payment_transactions', 'ptxn'], ['invoices', 'inv'], ['refunds', 'ref'], ['support_tickets', 'tkt'],
    ['support_messages', 'tmsg'], ['attendance', 'att'], ['attendance_events', 'ae'], ['followup_jobs', 'job'],
    ['followup_consent_log', 'cl'], ['workouts', 'w'], ['workout_exercises', 'wx'], ['weight_logs', 'wt'],
    ['health_records', 'hr'], ['foods', 'food'], ['followup_numbers', 'num'],
  ];

  await t.test('1/4/5. Gym A cannot SELECT any of Gym B\'s rows (financial, attendance, AI Communication, training)', async () => {
    await runWithOrg(A, async () => {
      for (const [table, x] of B_ROWS) {
        assert.equal((await db1.q(`SELECT id FROM ${table} WHERE id = ?`, [id(B, x)])).length, 0, `${table}: B's row is invisible by id`);
        assert.equal((await db1.q(`SELECT id FROM ${table} WHERE id = ?`, [id(A, x)])).length, 1, `${table}: A's own row is visible`);
      }
      // The IDOR case RLS exists for: a query that FORGOT its org filter.
      const orgs = await db1.q('SELECT DISTINCT org_id FROM payments');
      assert.deepEqual(orgs.map((r) => r.org_id), [A], 'an unfiltered query returns only the caller\'s gym');
      const clients = await db1.q('SELECT c.id FROM clients c JOIN users u ON u.id = c.user_id');
      assert.ok(clients.every((r) => r.id.startsWith(A)), 'joins too');
    });
  });

  await t.test('2. Gym A cannot UPDATE or DELETE Gym B\'s rows', async () => {
    await runWithOrg(A, async () => {
      assert.equal((await db1.run('UPDATE payments SET amount = 0 WHERE id = ?', [id(B, 'pay')])).changes, 0);
      assert.equal((await db1.run("UPDATE invoices SET status = 'VOID' WHERE id = ?", [id(B, 'inv')])).changes, 0);
      assert.equal((await db1.run('UPDATE workouts SET name = ? WHERE id = ?', ['pwned', id(B, 'w')])).changes, 0);
      assert.equal((await db1.run('DELETE FROM followup_jobs WHERE id = ?', [id(B, 'job')])).changes, 0);
      assert.equal((await db1.run('DELETE FROM weight_logs WHERE client_id = ?', [id(B, 'c')])).changes, 0);
      assert.equal((await db1.run('DELETE FROM support_messages WHERE id = ?', [id(B, 'tmsg')])).changes, 0);
      assert.equal((await db1.run('DELETE FROM payments')).changes, 1, 'a blanket DELETE reaches only A\'s own row');
    });
    const b = (await admin.query('SELECT amount FROM payments WHERE id = $1', [id(B, 'pay')])).rows[0];
    assert.equal(b.amount, 1000, 'B\'s payment untouched');
    assert.equal((await admin.query('SELECT count(*)::int n FROM weight_logs WHERE client_id = $1', [id(B, 'c')])).rows[0].n, 1);
    await ins('payments', { id: id(A, 'pay'), org_id: A, client_id: id(A, 'c'), amount: 1000 }); // restore A's
  });

  await t.test('3. Gym A cannot INSERT rows into Gym B or referencing Gym B\'s entities', async () => {
    const RLS = /row-level security/;
    await runWithOrg(A, async () => {
      await assert.rejects(db1.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['x1', B, id(B, 'c'), 1]), RLS, 'stamped with B');
      await assert.rejects(db1.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['x2', A, id(B, 'c'), 1]), RLS, 'A\'s org but B\'s client');
      await assert.rejects(db1.run('INSERT INTO workouts (id, org_id, client_id, name, created_at) VALUES (?,?,?,?,?)', ['x3', A, id(B, 'c'), 'n', now]), RLS, 'history planted on B\'s member');
      await assert.rejects(db1.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?,?,?,?,?)', ['x4', id(B, 'c'), 'd', 1, now]), RLS, 'client-scoped');
      await assert.rejects(db1.run('INSERT INTO workout_exercises (id, workout_id, name) VALUES (?,?,?)', ['x5', id(B, 'w'), 'n']), RLS, 'child of B\'s workout');
      await assert.rejects(db1.run('INSERT INTO support_messages (id, ticket_id, author_id, body, internal, created_at) VALUES (?,?,?,?,0,?)', ['x6', id(B, 'tkt'), id(A, 'owner'), 'b', now]), RLS, 'reply on B\'s ticket');
      await assert.rejects(db1.run("INSERT INTO payment_transactions (id, order_id, provider, amount, currency, status, created_at) VALUES (?,?,'mock',1,'INR','SUCCESS',?)", ['x7', id(B, 'pord'), now]), RLS, 'transaction on B\'s order');
      await assert.rejects(db1.run('UPDATE payments SET org_id = ? WHERE id = ?', [B, id(A, 'pay')]), RLS, 'cannot move its own row into B');
      await assert.rejects(db1.run('UPDATE payments SET client_id = ? WHERE id = ?', [id(B, 'c'), id(A, 'pay')]), RLS, 'cannot re-point its row at B\'s member');
      // Shared library rows: everyone reads, no gym writes.
      assert.equal((await db1.q('SELECT id FROM foods WHERE id = ?', [`${tag}_global_food`])).length, 1, 'global food readable');
      await assert.rejects(db1.run('INSERT INTO foods (id, org_id, name, is_global) VALUES (?, NULL, ?, 1)', ['x8', 'Planted']), RLS, 'cannot plant a global food');
      assert.equal((await db1.run('UPDATE foods SET calories = 9999 WHERE id = ?', [`${tag}_global_food`])).changes, 0, 'cannot edit a global food');
      assert.equal((await db1.run('DELETE FROM foods WHERE id = ?', [`${tag}_global_food`])).changes, 0, 'cannot delete a global food');
    });
    assert.equal((await admin.query(`SELECT count(*)::int n FROM payments WHERE id IN ('x1','x2')`)).rows[0].n, 0, 'nothing was written');
  });

  await t.test('6. missing tenant context fails closed on EVERY protected table', async () => {
    const tables = (await admin.query(`SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relrowsecurity`, [S])).rows.map((r) => r.t);
    assert.ok(tables.length >= 120, `${tables.length} protected tables`);
    const leaks = [];
    for (const tbl of tables) { // no runWithOrg / runAsPlatform: no context at all
      const where = RLS_GLOBAL_TABLES.has(tbl) ? 'WHERE org_id IS NOT NULL' : '';
      const r = await db1.q1(`SELECT count(*)::int AS n FROM ${tbl} ${where}`);
      if (r.n) leaks.push(`${tbl}=${r.n}`);
    }
    assert.deepEqual(leaks, [], 'no context, no tenant rows');
    await assert.rejects(db1.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['x9', A, id(A, 'c'), 1]), /row-level security/, 'and no writes');
    // A raw connection as the app role, bypassing db.js entirely: same answer.
    const raw = new pg.Client({ connectionString: urlWith(ROLE, PW) });
    await raw.connect();
    try { assert.equal((await raw.query('SELECT count(*)::int n FROM clients')).rows[0].n, 0); } finally { await raw.end(); }
    // Platform sees both gyms (the explicit, reviewed escape hatch).
    const both = await runAsPlatform('test', () => db1.q('SELECT DISTINCT org_id FROM payments ORDER BY 1'));
    assert.deepEqual(both.map((r) => r.org_id), [A, B]);
  });

  const stateOf = (db) => db.raw.query(`SELECT pg_backend_pid() AS pid, current_setting('app.org_id', true) AS org, current_setting('app.platform', true) AS platform`).then((r) => r.rows[0]);

  await t.test('7. a reused pooled connection never carries the previous tenant (pool size 1)', async () => {
    const first = await runWithOrg(A, () => db1.q1(`SELECT pg_backend_pid() AS pid, current_setting('app.org_id', true) AS org`));
    assert.equal(first.org, A);
    const after = await stateOf(db1);
    assert.equal(after.pid, first.pid, 'same physical connection');
    assert.ok(!after.org && !after.platform, `nothing left on it (org=${JSON.stringify(after.org)})`);
    for (let i = 0; i < 40; i++) {
      const org = i % 2 ? A : B;
      const rows = await runWithOrg(org, () => db1.q('SELECT DISTINCT org_id FROM clients'));
      assert.deepEqual(rows.map((r) => r.org_id), [org], `turn ${i}`);
      await runAsPlatform('t', () => db1.q('SELECT 1'));
    }
    const pids = new Set();
    for (let i = 0; i < 5; i++) pids.add((await runWithOrg(A, () => db1.q1('SELECT pg_backend_pid() AS pid'))).pid);
    assert.equal(pids.size, 1, 'every statement above really did reuse one connection');
    // Even a session-level value planted on the connection is overridden.
    await db1.raw.query(`SELECT set_config('app.org_id', '${B}', false)`);
    assert.deepEqual((await runWithOrg(A, () => db1.q('SELECT DISTINCT org_id FROM clients'))).map((r) => r.org_id), [A]);
    assert.equal((await db1.q1('SELECT count(*)::int AS n FROM clients')).n, 0, 'and "no context" stays no context');
    await db1.raw.query(`RESET app.org_id`);
  });

  await t.test('8. concurrent Gym A / Gym B requests never cross-contaminate (pool 4 and pool 1)', async () => {
    for (const db of [db4, db1]) {
      const ok = await Promise.all(Array.from({ length: 120 }, (_, i) => {
        const org = i % 2 ? A : B;
        return runWithOrg(org, async () => {
          const s = await db.q1(`SELECT current_setting('app.org_id', true) AS org, pg_sleep(${(Math.random() * 0.01).toFixed(3)}) AS z`);
          await sleep(Math.random() * 3);
          const pays = await db.q('SELECT DISTINCT org_id FROM payments');
          const txOrgs = await db.tx(async (tx) => {
            await tx.q('SELECT pg_sleep(0.002)');
            return tx.q('SELECT DISTINCT org_id FROM invoices');
          });
          return s.org === org && pays.every((r) => r.org_id === org) && txOrgs.every((r) => r.org_id === org) && currentOrg() === org;
        });
      }));
      assert.ok(ok.every(Boolean), `every concurrent request saw only its own gym (pool max ${db === db1 ? 1 : 4})`);
    }
  });

  await t.test('9. errors, rollbacks and a killed connection do not leak context', async () => {
    await assert.rejects(runWithOrg(A, () => db1.tx(async (tx) => {
      await tx.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?,?,?,?,?)', ['rb1', id(A, 'c'), 'd', 1, now]);
      throw new Error('boom');
    })), /boom/);
    assert.equal((await admin.query(`SELECT count(*)::int n FROM weight_logs WHERE id = 'rb1'`)).rows[0].n, 0, 'rolled back');
    let s = await stateOf(db1);
    assert.ok(!s.org && !s.platform, 'context gone after rollback');

    await assert.rejects(runWithOrg(A, () => db1.q('SELECT * FROM no_such_table')));
    await assert.rejects(runWithOrg(A, () => db1.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['x10', B, id(B, 'c'), 1])), /row-level security/);
    s = await stateOf(db1);
    assert.ok(!s.org && !s.platform, 'context gone after a failed statement');
    assert.deepEqual((await runWithOrg(B, () => db1.q('SELECT DISTINCT org_id FROM clients'))).map((r) => r.org_id), [B]);

    // The connection dies mid-transaction: ROLLBACK fails, the client must be
    // destroyed rather than returned to the pool.
    const before = (await stateOf(db1)).pid;
    await assert.rejects(runWithOrg(A, () => db1.tx(async (tx) => {
      await admin.query('SELECT pg_terminate_backend($1)', [before]);
      await tx.q('SELECT 1');
    })));
    const next = await runWithOrg(B, () => db1.q1(`SELECT pg_backend_pid() AS pid, current_setting('app.org_id', true) AS org`));
    assert.notEqual(next.pid, before, 'broken connection was replaced');
    assert.equal(next.org, B);
  });

  await t.test('10. webhooks / background jobs cannot forge tenant ownership', async () => {
    const RLS = /row-level security/;
    // A webhook runs as platform but scopes its write to the order's own gym:
    // a payload naming another gym cannot land there.
    await assert.rejects(runAsPlatform('webhook', () => db1.tx(
      (tx) => tx.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['wh1', B, id(B, 'c'), 1]), { orgId: A })), RLS);
    // A tenant request cannot open a transaction in another gym.
    await assert.rejects(runWithOrg(A, () => db1.tx(async () => 'ran', { orgId: B })), /tenant context mismatch/);
    // Hostile org ids never reach SQL.
    for (const bad of [`${A}' OR '1'='1`, `${A}'); SELECT set_config('app.platform','on',true); --`]) {
      await assert.rejects(runWithOrg(bad, () => db1.q('SELECT 1')), /invalid tenant context/);
    }
    // End to end through Express + requireAuth on PostgreSQL, with a route
    // whose SQL forgot its org filter, and a request claiming gym B.
    const app = express();
    app.set('db', db1);
    app.use(express.json());
    app.use(platformScope('http-request'));
    app.post('/leaky', requireAuth, async (_req, res) => res.json(await db1.q('SELECT id, org_id FROM clients')));
    await withServer(app, async (base) => {
      const r = await post(base, '/leaky', { token: tokenFor({ sub: id(A, 'owner'), role: 'GYM_OWNER', org: A }), body: { org_id: B }, headers: { 'x-org-id': B } });
      assert.equal(r.status, 200);
      assert.deepEqual([...new Set(r.json.map((x) => x.org_id))], [A], 'the database itself kept B\'s clients out');
    });
  });

  await t.test('11. AI Communication: a gym sees only its own calling numbers and settings', async () => {
    await runWithOrg(A, async () => {
      assert.deepEqual((await db1.q('SELECT org_id FROM followup_settings')).map((r) => r.org_id), [A], 'settings: own gym only');
      assert.deepEqual([...new Set((await db1.q('SELECT org_id FROM followup_numbers')).map((r) => r.org_id))], [A], 'numbers: own gym only');
      assert.equal((await db1.run('UPDATE followup_settings SET enabled = 1 WHERE org_id = ?', [B])).changes, 0, 'cannot switch on B\'s calling');
      await assert.rejects(db1.run('INSERT INTO followup_numbers (id, org_id, number, created_at, updated_at) VALUES (?,?,?,?,?)', ['xn', B, '+1', now, now]), /row-level security/, 'cannot add a number to B');
    });
    // A worker draining jobs for several gyms: each job runs in its own gym.
    const seen = [];
    for (const org of [A, B, A, B]) {
      seen.push(await runWithOrg(org, async () => (await db1.q('SELECT DISTINCT org_id FROM followup_jobs')).map((r) => r.org_id).join()));
    }
    assert.deepEqual(seen, [A, B, A, B], 'one pooled connection, alternating gyms, never mixed');
  });

  await t.test('12. friend communities and tournaments are platform-only: no gym context can read or write them', async () => {
    const RLS = /row-level security/;
    for (const org of [A, B]) {
      await runWithOrg(org, async () => {
        for (const tbl of ['communities', 'community_memberships', 'tournaments', 'tournament_entrants']) {
          assert.equal((await db1.q(`SELECT 1 FROM ${tbl}`)).length, 0, `${tbl}: invisible to a gym context`);
        }
        await assert.rejects(db1.run('INSERT INTO communities (id, name, created_at, updated_at) VALUES (?,?,?,?)', [`x_${org}`, 'n', now, now]), RLS);
        assert.equal((await db1.run('DELETE FROM tournament_entrants')).changes, 0, 'a blanket DELETE from a gym context touches nothing');
      });
    }
    // The explicit platform workflow (routes/communities.js, routes/tournaments.js) still works.
    await runAsPlatform('friend-communities', async () => {
      assert.equal((await db1.q('SELECT id FROM community_memberships WHERE community_id = ?', [`${tag}_comm`])).length, 2);
      assert.equal((await db1.q('SELECT id FROM tournament_entrants WHERE tournament_id = ?', [`${tag}_tour`])).length, 2);
    });
  });

  await t.test('13. in-app shares: each gym sees only shares it sent or received, and can only send as itself', async () => {
    const RLS = /row-level security/;
    await runWithOrg(A, async () => {
      assert.deepEqual((await db1.q('SELECT id FROM app_shares')).map((r) => r.id), [`${tag}_share_ab`], 'A sees its outgoing share, not B->independent');
      await assert.rejects(db1.run(`INSERT INTO app_shares (id, kind, snapshot_id, title, sender_client_id, sender_org_id, recipient_client_id, recipient_org_id, created_at)
        VALUES (?, 'workout', 's', 't', ?, ?, ?, ?, ?)`, ['xs1', id(B, 'c'), B, id(A, 'c'), A, now]), RLS, 'cannot forge a share from B');
      await assert.rejects(db1.run(`INSERT INTO app_shares (id, kind, snapshot_id, title, sender_client_id, sender_org_id, recipient_client_id, recipient_org_id, created_at)
        VALUES (?, 'workout', 's', 't', ?, ?, ?, ?, ?)`, ['xs2', id(B, 'c'), A, id(B, 'c'), B, now]), RLS, 'cannot send as B\'s member under its own org');
      assert.equal((await db1.run("UPDATE app_shares SET status = 'dismissed' WHERE id = ?", [`${tag}_share_bi`])).changes, 0);
    });
    await runWithOrg(B, async () => {
      assert.deepEqual((await db1.q('SELECT id FROM app_shares ORDER BY id')).map((r) => r.id), [`${tag}_share_ab`, `${tag}_share_bi`], 'B sees what it received and sent');
      assert.equal((await db1.run("UPDATE app_shares SET status = 'accepted' WHERE id = ?", [`${tag}_share_ab`])).changes, 1, 'the recipient can act on it');
    });
  });

  await t.test('14. privilege escalation: a signed-in user with no gym gets nothing (restricted), not platform', async () => {
    await runWithOrg(null, async () => {
      const leaks = [];
      // Shared (NULL-org) library rows are public reference data; count gym rows only.
      for (const [table] of B_ROWS) if ((await db1.q1(`SELECT count(*)::int AS n FROM ${table} ${RLS_GLOBAL_TABLES.has(table) ? 'WHERE org_id IS NOT NULL' : ''}`)).n) leaks.push(table);
      for (const tbl of ['communities', 'tournaments', 'app_shares', 'followup_settings']) if ((await db1.q1(`SELECT count(*)::int AS n FROM ${tbl}`)).n) leaks.push(tbl);
      assert.deepEqual(leaks, [], 'no tenant rows of any gym');
      await assert.rejects(db1.run('INSERT INTO payments (id, org_id, client_id, amount) VALUES (?,?,?,?)', ['xr', A, id(A, 'c'), 1]), /row-level security/);
      assert.equal((await db1.run("UPDATE users SET role = 'SUPER_ADMIN'")).changes, 0, 'cannot promote anyone');
    });
    // The request cannot widen itself: a tenant context cannot set app.platform.
    await runWithOrg(A, async () => {
      await db1.q("SELECT set_config('app.platform', 'on', true)");
      assert.deepEqual([...new Set((await db1.q('SELECT org_id FROM payments')).map((r) => r.org_id))], [A],
        'a set_config in one statement dies with that statement\'s own transaction');
    });
  });

  await t.test('15. global exercise library: every gym reads it, no gym edits it', async () => {
    await runWithOrg(A, async () => {
      assert.equal((await db1.q('SELECT id FROM exercise_library WHERE id = ?', [`${tag}_global_ex`])).length, 1);
      assert.equal((await db1.run("UPDATE exercise_library SET name = 'pwned' WHERE id = ?", [`${tag}_global_ex`])).changes, 0);
      assert.equal((await db1.run('DELETE FROM exercise_library WHERE id = ?', [`${tag}_global_ex`])).changes, 0);
      await assert.rejects(db1.run("INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment) VALUES ('xe', NULL, 'x', 'x', 'x')"), /row-level security/);
    });
  });

  await t.test('history follows a member who changes gym; the old gym\'s books do not', async () => {
    // B's member leaves for the independent org (gymExit runs as platform).
    await runAsPlatform('gym-exit', async () => {
      await db1.run('UPDATE clients SET org_id = ? WHERE id = ?', [I, id(B, 'c')]);
      await db1.run('UPDATE users SET org_id = ? WHERE id = ?', [I, id(B, 'u')]);
    });
    // A tenant cannot perform that move itself.
    await assert.rejects(runWithOrg(A, () => db1.run('UPDATE clients SET org_id = ? WHERE id = ?', [I, id(A, 'c')])), /row-level security/);
    await runWithOrg(I, async () => {
      assert.equal((await db1.q('SELECT id FROM workouts WHERE id = ?', [id(B, 'w')])).length, 1, 'their workouts at B come with them');
      assert.equal((await db1.q('SELECT id FROM workout_exercises WHERE id = ?', [id(B, 'wx')])).length, 1, 'and the exercises in them');
      assert.equal((await db1.q('SELECT id FROM health_records WHERE id = ?', [id(B, 'hr')])).length, 1, 'and their wearable data');
      assert.equal((await db1.q('SELECT id FROM payments WHERE id = ?', [id(B, 'pay')])).length, 0, 'but not gym B\'s payment records');
      assert.equal((await db1.q('SELECT id FROM attendance WHERE id = ?', [id(B, 'att')])).length, 0, 'or gym B\'s attendance');
    });
    await runWithOrg(B, async () => {
      assert.equal((await db1.q('SELECT id FROM payments WHERE id = ?', [id(B, 'pay')])).length, 1, 'B keeps its books');
      assert.equal((await db1.q('SELECT id FROM clients WHERE id = ?', [id(B, 'c')])).length, 0, 'but no longer sees the member');
    });
    await runWithOrg(A, async () => {
      assert.equal((await db1.q('SELECT id FROM workouts WHERE id = ?', [id(B, 'w')])).length, 0, 'an unrelated gym sees none of it');
    });
  });

  await t.test('runtime-role posture check passes for the app role and fails for a BYPASSRLS role', async () => {
    const quiet = () => {};
    const good = await verifyRls({ connectionString: urlWith(ROLE, PW), schema: S, log: quiet });
    assert.deepEqual(good.results.filter((r) => !r.ok), [], 'all posture checks pass');
    const BAD = `${tag}_bad`;
    await admin.query(`CREATE ROLE ${BAD} LOGIN PASSWORD '${PW}' BYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${S} TO ${BAD}; GRANT SELECT, TRUNCATE ON ALL TABLES IN SCHEMA ${S} TO ${BAD}`);
    try {
      const bad = await verifyRls({ connectionString: urlWith(BAD, PW), schema: S, log: quiet, probe: true });
      const failed = bad.results.filter((r) => !r.ok).map((r) => r.name).join(' | ');
      assert.match(failed, /BYPASSRLS/);
      assert.match(failed, /TRUNCATE/);
      assert.match(failed, /no context sees no tenant rows/);
    } finally {
      await admin.query(`DROP OWNED BY ${BAD}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${BAD}`).catch(() => {});
    }
  });
});
