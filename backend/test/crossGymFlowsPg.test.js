// ============================================================
// CROSS-GYM PRODUCT FLOWS, END TO END, ON POSTGRESQL WITH RLS ENFORCED
//
// The isolation suite (rlsTenantIsolation.test.js) proves gyms cannot see
// each other. This proves the features that are SUPPOSED to cross gyms
// still work once they can't: the real app (buildApp, every middleware and
// router in production order) over HTTP, on a NOBYPASSRLS runtime role,
// with the fail-closed policies applied.
//
//   1. sign up with no gym -> restricted: own identity and terms work,
//      nobody else's rows are reachable
//   2. go independent, log history, then join gym A by QR (free plan):
//      the history comes along, gym A sees the member
//   3. a friend community spanning gym A and gym B
//   4. an in-app share from a gym-A member to a gym-B friend
//   5. a gym-wars tournament hosted by A, entered from B
//   6. the gym-branding logo route stays public
//
// Runs only with TEST_DATABASE_URL (a superuser on a THROWAWAY database);
// builds its own schema and role and drops both.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PG_URL = process.env.TEST_DATABASE_URL || '';
const skip = PG_URL ? false : 'set TEST_DATABASE_URL to run the cross-gym flow suite on PostgreSQL';

test('PostgreSQL: cross-gym product flows still work under fail-closed RLS', { skip, concurrency: false }, async (t) => {
  const { default: pg } = await import('pg');
  const tag = `xg${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  const S = `${tag}_s`;
  const ROLE = `${tag}_app`;
  const PW = `pw_${Math.random().toString(36).slice(2)}`;
  const opt = `-c search_path=${S}`;
  const urlWith = (user, pass) => { const u = new URL(PG_URL); if (user) { u.username = user; u.password = pass; } u.searchParams.set('options', opt); return u.toString(); };

  const boot = new pg.Client({ connectionString: PG_URL });
  await boot.connect();
  await boot.query(`CREATE SCHEMA ${S}`);
  await boot.end();
  const admin = new pg.Pool({ connectionString: PG_URL, options: opt, max: 2 });
  let server; let appDb;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    await appDb?.raw?.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
    await admin.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await admin.end().catch(() => {});
  });

  // Schema + migrations + rls.sql through the real init path, as admin.
  await execFileAsync(process.execPath, [path.join(root, 'backend', 'scripts', 'init-db.js')],
    { env: { ...process.env, DATABASE_URL: urlWith(), NODE_ENV: 'development' }, cwd: root });
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await admin.query(`GRANT USAGE ON SCHEMA ${S} TO ${ROLE}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${S} TO ${ROLE}`);

  // ---- fixture, as admin: gyms A and B (active), one member in each ----
  const now = new Date().toISOString();
  const ins = async (table, row) => {
    const keys = Object.keys(row);
    await admin.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => row[k]));
  };
  const A = `${tag}_A`; const B = `${tag}_B`;
  for (const org of [A, B]) {
    await ins('organizations', { id: org, name: `Gym ${org.slice(-1)}`, slug: `${org.toLowerCase()}-slug`, type: 'gym', created_at: now });
    await ins('users', { id: `${org}_owner`, org_id: org, email: `${org}o@test.invalid`.toLowerCase(), password_hash: 'x', role: 'GYM_OWNER', name: `Owner ${org.slice(-1)}`, active: 1, terms_accepted_at: now, terms_version: '1.0', created_at: now });
    await ins('users', { id: `${org}_u`, org_id: org, email: `${org}u@test.invalid`.toLowerCase(), password_hash: 'x', role: 'CLIENT', name: `Member ${org.slice(-1)}`, active: 1, terms_accepted_at: now, terms_version: '1.0', created_at: now });
    await ins('clients', { id: `${org}_c`, user_id: `${org}_u`, org_id: org, status: 'ON_TRACK', goal: 'GENERAL', created_at: now });
  }
  // Active Barbell subscriptions, so gym A can take a member by QR.
  await ins('sk_packages', { id: `${tag}_pkg`, name: '100 Clients', client_capacity: 100, price: 1, effective_from: now, created_at: now });
  for (const org of [A, B]) {
    await ins('org_billing_state', { org_id: org, status: 'ACTIVE', updated_at: now });
    await ins('org_subscriptions', { id: `${org}_sub`, org_id: org, package_id: `${tag}_pkg`, client_capacity: 100, price: 1, status: 'ACTIVE', created_at: now, updated_at: now });
  }
  await ins('packages', { id: `${A}_free`, org_id: A, name: 'Free trial', amount: 0, period_days: 30 });
  await ins('client_workouts', { id: `${A}_cw`, org_id: A, client_id: `${A}_c`, name: 'Push Pull', created_at: now });
  await ins('client_workout_exercises', { id: `${A}_cwe`, workout_id: `${A}_cw`, exercise_id: null, position: 0, name: 'Bench Press', sets: 3, reps: '10', weight: '40' });

  // ---- the real app, on the runtime role ----
  process.env.DATABASE_URL = urlWith(ROLE, PW);
  const { buildApp } = await import('../src/index.js');
  const { getDb, runAsPlatform } = await import('../src/db.js');
  const { signToken } = await import('../src/auth.js');
  const { issueEnrollmentToken } = await import('../src/services/enterprise/enrollmentToken.js');
  const app = await buildApp();
  appDb = await getDb();
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
  const ok = (r, what, codes = [200, 201]) => assert.ok(codes.includes(r.status), `${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  const tok = (u) => signToken(u);
  const memberA = tok({ id: `${A}_u`, role: 'CLIENT', org_id: A, name: 'Member A', email: 'a@test.invalid' });
  const memberB = tok({ id: `${B}_u`, role: 'CLIENT', org_id: B, name: 'Member B', email: 'b@test.invalid' });
  const ownerA = tok({ id: `${A}_owner`, role: 'GYM_OWNER', org_id: A, name: 'Owner A', email: 'oa@test.invalid' });
  const ownerB = tok({ id: `${B}_owner`, role: 'GYM_OWNER', org_id: B, name: 'Owner B', email: 'ob@test.invalid' });

  let newcomer; let newcomerId;
  await t.test('1. sign up with no gym: restricted, yet own identity and terms work', async () => {
    const r = await call('POST', '/auth/register', { name: 'New Person', email: `${tag}new@test.invalid`, password: 'correct-horse-9' });
    ok(r, 'register without a gym code');
    assert.equal(r.json.user.orgId, null);
    newcomer = r.json.token; newcomerId = r.json.user.id;
    ok(await call('GET', '/auth/me', undefined, newcomer), '/auth/me for a gym-less user');
    ok(await call('POST', '/auth/terms/accept', { version: '1.0' }, newcomer), 'accept terms');
    const row = (await admin.query('SELECT terms_version FROM users WHERE id = $1', [newcomerId])).rows[0];
    assert.equal(row.terms_version, '1.0', 'the acceptance really reached the database (own-identity scope)');
    const status = await call('GET', '/auth/terms/status', undefined, newcomer);
    ok(status, 'terms status');
    assert.equal(status.json.accepted, true);
  });

  let independent;
  await t.test('2. go independent, log weight, then join gym A by QR: history comes along', async () => {
    const r = await call('POST', '/auth/independent', {}, newcomer);
    ok(r, 'go independent');
    independent = r.json.token;
    assert.ok(independent, 'a fresh session for the independent org');
    const cid = (await admin.query('SELECT id FROM clients WHERE user_id = $1', [newcomerId])).rows[0].id;
    await admin.query(`INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES ($1, $2, '2026-11-01', 80, $3)`, [`${tag}_wl`, cid, now]);

    const issued = await runAsPlatform('test-issue-qr', () => issueEnrollmentToken(appDb, { orgId: A, createdBy: `${A}_owner`, purpose: 'CLIENT', membershipPlanId: `${A}_free` }));
    const joined = await call('POST', '/enrollment/client/join', { payload: issued.payload }, independent);
    ok(joined, 'join gym A (free plan)');
    const after = (await admin.query('SELECT org_id FROM clients WHERE id = $1', [cid])).rows[0];
    assert.equal(after.org_id, A, 'the member is now in gym A');
    // Gym A's owner (tenant scope, RLS on) now sees the member and the
    // history they brought with them; gym B's owner sees neither.
    const asA = await call('GET', `/clients/${cid}/weights`, undefined, ownerA);
    ok(asA, 'owner A opens the new member weight history');
    assert.ok(JSON.stringify(asA.json).includes('2026-11-01'), `the weight logged before joining is there: ${JSON.stringify(asA.json).slice(0, 200)}`);
    const list = await call('GET', '/clients', undefined, ownerA);
    ok(list, 'owner A lists members');
    assert.ok(JSON.stringify(list.json).includes(cid), 'the new member is on the gym A list');
    assert.ok(!JSON.stringify(list.json).includes(`${B}_c`), 'the gym B member is not');
    const asB = await call('GET', `/clients/${cid}/weights`, undefined, ownerB);
    assert.ok([403, 404].includes(asB.status), `owner B cannot open gym A's member (got ${asB.status})`);
    const seen = await runAsPlatform('t', () => appDb.q('SELECT 1 FROM weight_logs WHERE id = ?', [`${tag}_wl`]));
    assert.equal(seen.length, 1);
    const { runWithOrg } = await import('../src/db.js');
    assert.equal((await runWithOrg(A, () => appDb.q('SELECT id FROM weight_logs WHERE id = ?', [`${tag}_wl`]))).length, 1, 'gym A sees the history logged before joining');
    assert.equal((await runWithOrg(B, () => appDb.q('SELECT id FROM weight_logs WHERE id = ?', [`${tag}_wl`]))).length, 0, 'gym B does not');
  });

  let communityId;
  await t.test('3. a friend community across gym A and gym B', async () => {
    const made = await call('POST', '/communities', { name: 'Morning crew' }, memberA);
    ok(made, 'member A creates a community');
    communityId = made.json.id || made.json.community?.id;
    assert.ok(communityId, JSON.stringify(made.json).slice(0, 200));
    const code = await call('POST', `/communities/${communityId}/codes`, { expires_in_days: 7, max_uses: 5 }, memberA);
    ok(code, 'invite code');
    ok(await call('POST', '/communities/join', { code: code.json.code }, memberB), 'member B (another gym) joins');
    const listB = await call('GET', '/communities', undefined, memberB);
    ok(listB, 'B lists communities');
    assert.ok(JSON.stringify(listB.json).includes(communityId), 'B sees the community');
    ok(await call('GET', `/communities/${communityId}/overview`, undefined, memberB), 'B opens the overview');
    ok(await call('GET', `/communities/${communityId}/leaderboards`, undefined, memberA), 'A opens the leaderboards');
  });

  await t.test('4. an in-app share from gym A to a friend in gym B', async () => {
    const sent = await call('POST', '/app-shares', { kind: 'workout', workout_id: `${A}_cw`, recipients: [`${B}_c`], message: 'Try this' }, memberA);
    ok(sent, 'A shares a workout with B');
    const inbox = await call('GET', '/app-shares/inbox', undefined, memberB);
    ok(inbox, 'B opens the inbox');
    assert.equal(inbox.json.shares.length, 1, 'B received it');
    assert.equal(inbox.json.shares[0].workout.exercises[0].name, 'Bench Press', 'with gym A\'s workout content');
    ok(await call('POST', `/app-shares/${inbox.json.shares[0].id}/dismiss`, {}, memberB), 'B acts on it');
  });

  await t.test('5. a tournament hosted by gym A, entered from gym B', async () => {
    const made = await call('POST', '/tournaments', { name: 'Gym Wars', reach: 'everyone', events: [{ kind: 'squats' }] }, ownerA);
    ok(made, 'owner A hosts');
    const d = await call('GET', `/tournaments/${made.json.id}`, undefined, memberB);
    ok(d, 'member B opens it');
    const joined = await call('POST', `/tournaments/${made.json.id}/join`, { event_ids: [d.json.events[0].id] }, memberB);
    ok(joined, 'member B enters');
    const host = await call('GET', `/tournaments/${made.json.id}`, undefined, ownerA);
    ok(host, 'host reloads');
    assert.ok(JSON.stringify(host.json).includes('Member B'), 'the host sees the entrant from gym B');
  });

  await t.test('7. owner A removes the member: they keep their history, gym A keeps its books', async () => {
    const cid = (await admin.query('SELECT id FROM clients WHERE user_id = $1', [newcomerId])).rows[0].id;
    const subsBefore = (await admin.query('SELECT count(*)::int n FROM subscriptions WHERE client_id = $1 AND org_id = $2', [cid, A])).rows[0].n;
    ok(await call('POST', `/admin/members/${cid}/revoke`, { reason: 'test' }, ownerA), 'owner A revokes the membership');
    const now2 = (await admin.query('SELECT c.org_id, o.slug FROM clients c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1', [cid])).rows[0];
    assert.equal(now2.slug, 'independent', 'back to independent');
    const { runWithOrg } = await import('../src/db.js');
    assert.equal((await runWithOrg(now2.org_id, () => appDb.q('SELECT id FROM weight_logs WHERE id = ?', [`${tag}_wl`]))).length, 1, 'the member keeps their history');
    assert.equal((await runWithOrg(A, () => appDb.q('SELECT id FROM weight_logs WHERE id = ?', [`${tag}_wl`]))).length, 0, 'gym A no longer sees it');
    assert.equal((await admin.query('SELECT count(*)::int n FROM subscriptions WHERE client_id = $1 AND org_id = $2', [cid, A])).rows[0].n, subsBefore, 'gym A keeps its subscription records');
    const asA = await call('GET', `/clients/${cid}/weights`, undefined, ownerA);
    assert.ok([403, 404].includes(asA.status), `owner A can no longer open the member (got ${asA.status})`);
  });

  await t.test('8. a member in gym B exports and deletes their account, including cross-gym rows', async () => {
    const exp = await call('GET', '/me/export', undefined, memberB);
    ok(exp, 'export');
    assert.ok(JSON.stringify(exp.json.data?.tournaments || []).includes('Gym Wars'), 'the export includes their tournament entry (platform-only table)');
    const email = (await admin.query('SELECT email FROM users WHERE id = $1', [`${B}_u`])).rows[0].email;
    ok(await call('POST', '/me/delete-account', { confirm: email }, memberB), 'delete account');
    assert.equal((await admin.query('SELECT count(*)::int n FROM community_memberships WHERE client_id = $1', [`${B}_c`])).rows[0].n, 0, 'community membership erased');
    const ent = (await admin.query('SELECT name FROM tournament_entrants WHERE user_id = $1', [`${B}_u`])).rows;
    assert.ok(ent.length > 0 && ent.every((r) => r.name === 'Deleted member'), 'tournament entry anonymised');
  });

  await t.test('9. gym branding: the public logo route still answers without a login', async () => {
    const r = await call('GET', `/branding/logo/${A.toLowerCase()}-slug`);
    assert.ok([200, 204, 404].includes(r.status), `public logo route answered ${r.status}`);
    assert.notEqual(r.status, 500);
  });
});
