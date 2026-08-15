// ============================================================
// Phase 3A Step 3 — calorie failure observability tests.
//   A. ml unavailable   -> console.warn, category ml_unavailable,
//                          provider ml, workout_id present
//   B. invalid ML output -> console.warn, category invalid_output,
//                           provider ml, model_version, issues
//   C. baseline         -> NO fallback warning
//   D. mock             -> NO fallback warning
//   E. sensitive data   -> captured log lines exclude payload/user/
//                          credential data
//   F. route-level unexpected calorie error -> logged with request +
//                          workout correlation; completion unchanged
//
// Provider-dependent cases run in isolated subprocesses
// (helpers/providerRunner.js) — config resolves the provider once at
// startup, so the env must be set before any import.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { runWithProvider, MODULES } from './helpers/providerRunner.js';

const INPUT = { user: { age: 30, sex: 'male', height_cm: 175, body_weight_kg: 70 }, session: { workout_id: 'wko_abc', duration_minutes: 30, intensity_rating: 'moderate' }, exercises: [] };

// Captures console.warn in the child, prints warnings + result as JSON.
const WARN_SNIPPET = (setup) => `
  const cal = await import('${MODULES.calorieModel}');
  ${setup || ''}
  const lines = [];
  const origWarn = console.warn;
  console.warn = (...args) => { lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
  const out = cal.estimateWorkoutCalories(${JSON.stringify(INPUT)});
  console.warn = origWarn;
  console.log('WARNS:' + JSON.stringify(lines) + ':RESULT:' + JSON.stringify({ provider: out.provider, model_version: out.model_version, note: out.note || null }));
`;

function parse(r) {
  const m = r.stdout.match(/WARNS:(\[.*\]):RESULT:(\{.*\})/);
  return { warns: JSON.parse(m[1]), result: JSON.parse(m[2]) };
}

// ---------------- A: ml unavailable ----------------

test('A. ml unavailable -> warn with category ml_unavailable, provider ml, workout_id', () => {
  // default stub mlEstimate() throws -> ml_unavailable fallback
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: WARN_SNIPPET('') });
  assert.equal(r.status, 0, r.stderr);
  const { warns, result } = parse(r);
  assert.equal(result.provider, 'baseline', 'fallback still baseline');
  assert.ok(result.note && result.note.includes('fallback'));
  assert.equal(warns.length, 1, 'exactly one warning logged');
  const w = warns[0];
  assert.match(w, /ml_unavailable/);
  assert.match(w, /"provider":"ml"/);
  assert.match(w, /"workout_id":"wko_abc"/);
});

// ---------------- B: invalid ML output ----------------

test('B. invalid ML output -> warn with category invalid_output, provider ml, model_version, issues', () => {
  const setup = `cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: NaN, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-mlv1' }));`;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: WARN_SNIPPET(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { warns, result } = parse(r);
  assert.equal(result.provider, 'baseline', 'fallback still baseline');
  assert.equal(warns.length, 1);
  const w = warns[0];
  assert.match(w, /invalid_output/);
  assert.match(w, /"provider":"ml"/);
  assert.match(w, /"workout_id":"wko_abc"/);
  assert.match(w, /skos-cal-mlv1/, 'model_version logged when known');
  assert.match(w, /estimated_active_kcal/, 'validation issues logged');
});

// ---------------- C/D: no warnings for baseline/mock ----------------

test('C. baseline provider -> no fallback warning', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'baseline', snippet: WARN_SNIPPET('') });
  assert.equal(r.status, 0, r.stderr);
  const { warns, result } = parse(r);
  assert.equal(result.provider, 'baseline');
  assert.deepEqual(warns, [], 'baseline must not log fallback warnings');
});

test('D. mock provider -> no fallback warning', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'mock', snippet: WARN_SNIPPET('') });
  assert.equal(r.status, 0, r.stderr);
  const { warns, result } = parse(r);
  assert.equal(result.provider, 'mock');
  assert.deepEqual(warns, [], 'mock must not log fallback warnings');
});

// ---------------- E: sensitive-data protection ----------------

test('E. captured log lines exclude payload, user data, credentials, tokens', () => {
  const setup = `cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: NaN, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-mlv1' }));`;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: WARN_SNIPPET(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { warns } = parse(r);
  const joined = warns.join('\n');
  // whitelisted fields appear...
  assert.match(joined, /category|provider|workout_id|model_version|issues/);
  // ...and nothing sensitive does
  for (const banned of ['body_weight', 'bodyWeight', 'actual_weight', 'actual_reps', 'height_cm', '"male"', 'Bearer', 'testpass', 'authorization', 'password']) {
    assert.ok(!joined.includes(banned), `log line must not contain ${banned}`);
  }
});

// ---------------- F: route-level unexpected calorie error ----------------

test('F. route-level calorie error is logged with correlation; completion unchanged', () => {
  // Subprocess: in-memory DB + real route; the calorie persist UPDATE throws
  // (simulated DB failure). Workout must still complete; error must be logged
  // with request + workout id and nothing sensitive.
  const snippet = `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    dbRaw.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'c@a.in', 'x', 'CLIENT', 'C', 1, '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES ('c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78, '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, is_global) VALUES ('libA', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound', 1)");
    dbRaw.exec("INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, created_at) VALUES ('wko_1', 'o1', 'c1', 'Push Day', '2026-08-15', 'assigned', '2026-08-15T00:00:00Z')");
    dbRaw.exec("INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES ('wxeA', 'wko_1', 'libA', 0, 'Bench Press', 3, '10', '60', 90)");
    const adapter = {
      async q(sql, params = []) { const stmt = dbRaw.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
      async q1(sql, params = []) { const rows = await adapter.q(sql, params); return rows[0] || null; },
      async run(sql, params = []) {
        if (String(sql).includes('estimated_active_kcal')) throw new Error('simulated persist failure');
        const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) };
      },
      exec(sql) { dbRaw.exec(sql); },
      async tx(fn) {
        dbRaw.exec('BEGIN');
        try { const out = await fn(adapter); dbRaw.exec('COMMIT'); return out; }
        catch (e) { try { dbRaw.exec('ROLLBACK'); } catch {} throw e; }
      },
      raw: dbRaw
    };
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => { errors.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
    const express = (await import('express')).default;
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('${MODULES.config}');
    const workoutRoutes = (await import('${MODULES.workouts}')).default;
    const app = express();
    app.use(express.json());
    app.use('/workouts', workoutRoutes(adapter));
    const server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'C' }, config.jwtSecret, { expiresIn: '1h' });
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/workouts/wko_1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }] })
    });
    const json = await res.json();
    console.error = origErr;
    server.closeAllConnections(); server.close();
    const w = await adapter.q1("SELECT status, estimated_active_kcal, calorie_provider FROM workouts WHERE id = 'wko_1'");
    console.log('HTTP:' + res.status + ':CAL:' + JSON.stringify(json.calorie ?? null) + ':WORKOUT:' + JSON.stringify(w) + ':ERRORS:' + JSON.stringify(errors));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'baseline', snippet });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/HTTP:(\d+):CAL:(\{.*\}|null):WORKOUT:(\{.*\}):ERRORS:(\[.*\])/);
  assert.ok(m, 'harness output parsed: ' + r.stdout);
  const [, status, cal, workout, errors] = m;
  assert.equal(Number(status), 200, 'completion succeeds despite calorie persist failure');
  assert.equal(JSON.parse(workout).status, 'completed', 'workout still completes');
  assert.equal(JSON.parse(workout).estimated_active_kcal, null, 'no calorie persisted');
  assert.equal(JSON.parse(workout).calorie_provider, null);
  const errs = JSON.parse(errors);
  assert.ok(errs.length >= 1, 'error logged');
  const joined = errs.join('\n');
  assert.match(joined, /calorie estimate failed/);
  assert.match(joined, /"workout":"wko_1"/, 'workout id correlated');
  assert.match(joined, /simulated persist failure/, 'error message logged');
  for (const banned of ['Bearer', 'testpass', 'actual_weight', 'actual_reps', 'password']) {
    assert.ok(!joined.includes(banned), `route error log must not contain ${banned}`);
  }
});
