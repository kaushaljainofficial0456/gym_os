// ============================================================
// PostgreSQL LIVE validation — production-readiness smoke test.
//
//   DATABASE_URL=postgres://user:pass@host/db node scripts/pg-validate.js
//
// Uses a REAL PostgreSQL instance (the intended production target is
// Neon). It runs the actual init-db.js code path (schema + guarded
// migrations + RLS), then exercises the critical behaviors:
//   - row shapes (REAL/TEXT columns)
//   - transactions (commit + rollback)
//   - ON CONFLICT upserts (personal_records via evaluatePRs)
//   - RLS + SET LOCAL app.org_id tenant isolation (and its documented
//     non-transactional caveat)
//   - workout start → complete (duration + calorie persistence)
//   - legacy synthesized set tagging
//   - nutrition + tracking smoke
//
// SAFETY: this script CREATES tables (schema.sql) and seeds rows in
// whatever database DATABASE_URL points at. Use a DISPOSABLE Neon
// branch/database — never a database you care about.
// Pass --clean to DROP every table after the run.
// Exits non-zero when any check fails.
// ============================================================
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set — this script requires a real PostgreSQL instance.');
  process.exit(1);
}
// Admin/migration capabilities live on a SEPARATE role (PG_ADMIN_URL) from the
// runtime application role (DATABASE_URL). init-db.js performs DDL (schema,
// migrations, RLS policies) that a least-privilege app role must not have;
// the checks below run as the app role so its real privileges + RLS posture
// are what get validated. PG_ADMIN_URL falls back to DATABASE_URL for setups
// that use a single privileged role.
const adminUrl = process.env.PG_ADMIN_URL || config.databaseUrl;
console.log(`Validating runtime role against PostgreSQL: ${String(config.databaseUrl).replace(/:[^:@/]+@/, ':***@')}`);
console.log(`init-db.js will run as admin role: ${String(adminUrl).replace(/:[^:@/]+@/, ':***@')}`);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.error(`  ✗ ${name}\n    ${e?.message || e}`);
  }
}

// ---- 1. apply the REAL init path (schema + migrations + RLS) ----
console.log('\n[init] applying schema.sql + guarded migrations + RLS (real init-db.js) as admin role…');
execFileSync(process.execPath, [path.join(__dirname, 'init-db.js')], { cwd: root, env: { ...process.env, DATABASE_URL: adminUrl }, stdio: 'inherit' });

const { getDb } = await import('../src/db.js');
const db = await getDb();

// ---- 2. fixture ----
const idp = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const o1 = 'org_valid_a', o2 = 'org_valid_b';
const u1 = 'usr_valid_1', u2 = 'usr_valid_2';
const c1 = 'cli_valid_1', c2 = 'cli_valid_2';
const libA = 'lib_valid_a', libB = 'lib_valid_b';

// Fixture uses fixed ids — ON CONFLICT (id) DO NOTHING keeps re-runs against the
// same database idempotent (rows already present are skipped, same values).
await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', [o1, 'Org A', 'org-a-valid', '2026-01-01T00:00:00Z']);
await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', [o2, 'Org B', 'org-b-valid', '2026-01-01T00:00:00Z']);
await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?) ON CONFLICT (id) DO NOTHING`, [u1, o1, 'valid-a@x.in', 'x', 'A', '2026-01-01T00:00:00Z']);
await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?) ON CONFLICT (id) DO NOTHING`, [u2, o2, 'valid-b@x.in', 'x', 'B', '2026-01-01T00:00:00Z']);
await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
  [c1, u1, o1, 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z']);
await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
  [c2, u2, o2, 'MUSCLE_GAIN', '2026-01-01T00:00:00Z']);
await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (id) DO NOTHING`, [libA, 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound']);
await db.run(`INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (id) DO NOTHING`, [libB, 'Lat Pulldown', 'LATS', 'CABLE', 'vertical_pull', 'compound']);

// ---- 3. checks ----
console.log('\n[checks]');

await check('row shapes: REAL/TEXT columns round-trip', async () => {
  const r = await db.q1('SELECT start_weight, height_cm, created_at FROM clients WHERE id = ?', [c1]);
  if (typeof r.start_weight !== 'number' || typeof r.height_cm !== 'number') throw new Error(`REAL columns came back as ${typeof r.start_weight}`);
  if (typeof r.created_at !== 'string') throw new Error('TEXT timestamp came back as non-string');
});

await check('transaction commits atomically', async () => {
  const wid = idp('wtx');
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [wid, o1, c1, 'TX', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z']);
  });
  const w = await db.q1('SELECT id FROM workouts WHERE id = ?', [wid]);
  if (!w) throw new Error('row missing after commit');
});

await check('transaction rolls back on failure', async () => {
  const wid = idp('wfail');
  let threw = false;
  try {
    await db.tx(async (tx) => {
      await tx.run('INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [wid, o1, c1, 'FAIL', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z']);
      throw new Error('boom');
    });
  } catch { threw = true; }
  if (!threw) throw new Error('tx did not throw');
  const w = await db.q1('SELECT id FROM workouts WHERE id = ?', [wid]);
  if (w) throw new Error('row survived rollback');
});

await check('ON CONFLICT upsert (personal_records via evaluatePRs)', async () => {
  // Re-runs against the same DB: clear any leftover PR rows from a previous run.
  await db.run('DELETE FROM personal_records WHERE client_id = ? AND exercise_id = ?', [c1, libA]);
  const { evaluatePRs } = await import('../src/services/personalRecords.js');
  await evaluatePRs(db, c1, libA, [{ actual_weight: 60, actual_reps: 8, completed: 1 }], '2026-08-10');
  const first = await db.q1(`SELECT value FROM personal_records WHERE client_id = ? AND exercise_id = ? AND type = 'heaviest_weight'`, [c1, libA]);
  if (!first || first.value !== 60) throw new Error(`upsert insert failed (${JSON.stringify(first)})`);
  await evaluatePRs(db, c1, libA, [{ actual_weight: 62.5, actual_reps: 8, completed: 1 }], '2026-08-12');
  const second = await db.q1(`SELECT value FROM personal_records WHERE client_id = ? AND exercise_id = ? AND type = 'heaviest_weight'`, [c1, libA]);
  if (!second || second.value !== 62.5) throw new Error(`ON CONFLICT update failed (${JSON.stringify(second)})`);
  const n = await db.q1(`SELECT COUNT(*) AS n FROM personal_records WHERE client_id = ? AND exercise_id = ? AND type = 'heaviest_weight'`, [c1, libA]);
  // COUNT(*) is bigint on PG — node-postgres returns it as a STRING ('1'), so coerce before comparing.
  if (Number(n.n) !== 1) throw new Error('upsert created duplicate rows');
});

await check('RLS + SET LOCAL app.org_id isolates orgs inside a transaction', async () => {
  // Detect whether the app connection role bypasses RLS entirely (superuser or
  // BYPASSRLS). Neon's default `neondb_owner` role is created WITH BYPASSRLS,
  // which makes RLS a no-op for the whole app connection — a production-readiness
  // failure even when the policy SQL and SET LOCAL wiring are correct.
  const role = await db.q1(`SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  const bypasses = !!(role?.rolsuper || role?.rolbypassrls);

  const direct = await db.tx(async (tx) => tx.q('SELECT id FROM clients ORDER BY id'), { orgId: o1 });
  const idsInA = direct.map((r) => r.id);
  if (!idsInA.includes(c1)) throw new Error(`org A cannot see its own client (${JSON.stringify(idsInA)})`);

  if (bypasses) {
    // Prove the POLICY SQL + SET LOCAL wiring itself is correct by re-checking
    // under a NOBYPASSRLS probe role (membership lets the app role SET ROLE).
    // Unique per-run role name: re-runs never collide even if cleanup is skipped.
    let probeOk = false;
    const probeRole = 'rls_probe_' + Math.random().toString(36).slice(2, 8);
    const probeConn = await db.raw.connect();
    try {
      await db.run(`CREATE ROLE ${probeRole} LOGIN NOSUPERUSER NOBYPASSRLS`);
      await db.run(`GRANT ${probeRole} TO ${role.u}`);
      await db.run('GRANT USAGE ON SCHEMA public TO ' + probeRole);
      await db.run('GRANT SELECT ON clients TO ' + probeRole);
      await probeConn.query('BEGIN');
      await probeConn.query(`SET LOCAL app.org_id = '${o1}'`);
      await probeConn.query(`SET ROLE ${probeRole}`);
      const rows = await probeConn.query('SELECT id FROM clients ORDER BY id');
      const ids = rows.rows.map((r) => r.id);
      await probeConn.query('COMMIT');
      if (!ids.includes(c1) || ids.includes(c2)) throw new Error(`probe saw ${JSON.stringify(ids)}`);
      probeOk = true;
    } catch (e) {
      throw new Error(`RLS policy probe failed: ${e.message}`);
    } finally {
      try { await probeConn.query('SET ROLE NONE'); } catch {}
      probeConn.release();
      // best-effort cleanup: REVOKE the grants we made (ACL deps block DROP ROLE)
      try { await db.run(`REVOKE SELECT ON clients FROM ${probeRole}`); } catch {}
      try { await db.run(`REVOKE USAGE ON SCHEMA public FROM ${probeRole}`); } catch {}
      try { await db.run(`DROP ROLE IF EXISTS ${probeRole}`); } catch {}
    }
    if (probeOk) {
      throw new Error(`app role '${role.u}' has BYPASSRLS — RLS does not protect the app connection (policies verified correct via NOBYPASSRLS probe). Create/use a NOBYPASSRLS role for production (e.g. a dedicated app role on Neon) and point DATABASE_URL at it.`);
    }
  }
  if (idsInA.includes(c2)) throw new Error(`org A can see org B client via RLS (${JSON.stringify(idsInA)})`);
  // the documented caveat: OUTSIDE a transaction RLS is not engaged (no SET LOCAL)
  const all = await db.q('SELECT id FROM clients ORDER BY id');
  if (!all.some((r) => r.id === c2)) throw new Error('expected non-tx reads to bypass RLS (documented app-level filtering is the control)');
});

await check('workout start + complete: duration and calorie persisted (route-level)', async () => {
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: u1, role: 'CLIENT', org: o1, name: 'A' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  try {
    const wid = idp('wko');
    await db.run('INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [wid, o1, c1, 'Push', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z']);
    await db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [idp('wx'), wid, libA, 0, 'Bench Press', 3, '10', '60', 90]);
    const start = await call('POST', `/workouts/${wid}/start`);
    if (start.status !== 200 || !start.json.started_at) throw new Error(`start failed (${start.status})`);
    const wx = await db.q1('SELECT id FROM workout_exercises WHERE workout_id = ?', [wid]);
    if (!wx) throw new Error('workout exercise not found');
    const complete = await call('POST', `/workouts/${wid}/complete`, {
      logs: [{ exercise_id: wx.id, sets: [{ actual_reps: 10, actual_weight: 60 }, { actual_reps: 8, actual_weight: 60 }] }]
    });
    if (complete.status !== 200) throw new Error(`complete failed (${complete.status}): ${JSON.stringify(complete.json)}`);
    const w = await db.q1('SELECT status, started_at, completed_at, duration_min, estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider FROM workouts WHERE id = ?', [wid]);
    if (w.status !== 'completed') throw new Error('status not completed');
    if (!w.started_at || !w.completed_at) throw new Error('timestamps missing');
    if (w.duration_min === null || w.duration_min === undefined) throw new Error('duration not persisted');
    if (w.estimated_active_kcal === null || w.estimated_active_kcal <= 0) throw new Error('calorie not persisted');
    if (w.lower_kcal > w.estimated_active_kcal || w.estimated_active_kcal > w.upper_kcal) throw new Error('calorie range invalid');
    if (!w.model_version || !w.schema_version || !w.calorie_provider) throw new Error('model metadata missing');
    const sets = await db.q('SELECT is_synthesized FROM exercise_set_logs es JOIN workout_logs wl ON wl.id = es.workout_log_id WHERE wl.workout_id = ?', [wid]);
    if (!sets.length || sets.some((s) => s.is_synthesized !== 0)) throw new Error('per-set payload rows not marked real (is_synthesized=0)');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

await check('legacy aggregate payload marks set rows is_synthesized=1', async () => {
  const workoutRoutes = (await import('../src/routes/workouts.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/workouts', workoutRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const token = jwt.sign({ sub: u1, role: 'CLIENT', org: o1, name: 'A' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  try {
    const wid = idp('wleg');
    await db.run('INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [wid, o1, c1, 'Legacy', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z']);
    await db.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [idp('wx'), wid, libA, 0, 'Bench Press', 3, '10', '60', 90]);
    const wx = await db.q1('SELECT id FROM workout_exercises WHERE workout_id = ?', [wid]);
    const r = await call('POST', `/workouts/${wid}/complete`, {
      logs: [{ exercise_id: wx.id, sets_done: 2, reps: 10, weight: 60 }]
    });
    if (r.status !== 200) throw new Error(`complete failed (${r.status})`);
    const sets = await db.q('SELECT is_synthesized FROM exercise_set_logs es JOIN workout_logs wl ON wl.id = es.workout_log_id WHERE wl.workout_id = ?', [wid]);
    if (!sets.length || sets.some((s) => s.is_synthesized !== 1)) throw new Error('legacy rows not flagged synthesized');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

await check('nutrition + tracking smoke (foods, meal log, water upsert)', async () => {
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED_DATABASE', 0)`,
    [idp('f'), o1, null, 'Paneer', 'g', '100 g', 265, 18, 4, 21]);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual')`,
    [idp('ml'), c1, '2026-08-15', 'Lunch', 'Paneer', 265, 18, 4, 21]);
  const m = await db.q1('SELECT calories, protein FROM meal_logs WHERE client_id = ? AND date = ?', [c1, '2026-08-15']);
  if (!m || m.calories !== 265) throw new Error('meal log row shape wrong');
  // water upsert (INSERT then UPDATE same day)
  await db.run('INSERT INTO water_logs (id, client_id, date, litres) VALUES (?, ?, ?, ?)', [idp('w'), c1, '2026-08-15', 1.5]);
  const existing = await db.q1('SELECT id FROM water_logs WHERE client_id = ? AND date = ?', [c1, '2026-08-15']);
  await db.run('UPDATE water_logs SET litres = ? WHERE id = ?', [2.5, existing.id]);
  const w2 = await db.q1('SELECT litres FROM water_logs WHERE id = ?', [existing.id]);
  if (w2.litres !== 2.5) throw new Error('water upsert failed');
});

// ---- cleanup ----
if (process.argv.includes('--clean')) {
  console.log('\n[cleanup] dropping all tables…');
  const rows = await db.q("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const r of rows) {
    await db.run(`DROP TABLE IF EXISTS ${r.tablename} CASCADE`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== PostgreSQL validation: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.error('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
console.log('All PostgreSQL checks passed.');
process.exit(0);
