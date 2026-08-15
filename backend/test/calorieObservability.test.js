// ============================================================
// Phase 3A Step 3 — calorie failure observability tests.
// Phase 3B Step 1 — ML async/timeout boundary tests (G/H/I).
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
//   G. ml timeout (hanging provider) -> console.warn, category
//                          ml_timeout, provider ml, workout_id present,
//                          fallback still baseline
//   H. ml timeout        -> captured log lines exclude payload/user/
//                          credential data (same guarantee as E)
//   I. route-level: a hanging ML provider never stalls
//                          POST /:id/complete — completes fast, calorie
//                          persisted with provider='baseline'
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
  const out = await cal.estimateWorkoutCalories(${JSON.stringify(INPUT)});
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

// ---------------- G: ml timeout (hanging provider) ----------------

test('G. ml timeout -> warn with category ml_timeout, provider ml, workout_id, falls back to baseline', () => {
  // Provider hangs forever; a short test-only timeout budget keeps this
  // deterministic and fast instead of waiting out the real production
  // ML_TIMEOUT_MS. Production code never calls __setMlTimeoutForTests.
  const setup = `
    cal.__setMlTimeoutForTests(30);
    cal.__setMlEstimateForTests(() => new Promise(() => {})); // never resolves
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: WARN_SNIPPET(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { warns, result } = parse(r);
  assert.equal(result.provider, 'baseline', 'timeout still falls back to baseline');
  assert.ok(result.note && result.note.includes('fallback') && result.note.includes('timed out'), 'fallback note names the timeout');
  assert.equal(warns.length, 1, 'exactly one warning logged');
  const w = warns[0];
  assert.match(w, /ml_timeout/);
  assert.match(w, /"provider":"ml"/);
  assert.match(w, /"workout_id":"wko_abc"/);
});

// ---------------- H: sensitive-data protection on timeout ----------------

test('H. ml timeout -> captured log lines exclude payload, user data, credentials, tokens', () => {
  const setup = `
    cal.__setMlTimeoutForTests(30);
    cal.__setMlEstimateForTests(() => new Promise(() => {}));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: WARN_SNIPPET(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { warns } = parse(r);
  const joined = warns.join('\n');
  assert.match(joined, /category|provider|workout_id/);
  for (const banned of ['body_weight', 'bodyWeight', 'actual_weight', 'actual_reps', 'height_cm', '"male"', 'Bearer', 'testpass', 'authorization', 'password']) {
    assert.ok(!joined.includes(banned), `log line must not contain ${banned}`);
  }
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

// ---------------- I: route-level — a hanging ML provider never stalls completion ----------------

test('I. workout completion succeeds fast when ML times out; calorie persisted with provider=baseline', () => {
  // Real (non-poisoned) in-memory DB + real route, provider=ml, and a
  // provider stub that hangs forever. A short test-only timeout budget
  // proves the request returns well before it, not just eventually.
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
      async run(sql, params = []) { const stmt = dbRaw.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
      exec(sql) { dbRaw.exec(sql); },
      async tx(fn) {
        dbRaw.exec('BEGIN');
        try { const out = await fn(adapter); dbRaw.exec('COMMIT'); return out; }
        catch (e) { try { dbRaw.exec('ROLLBACK'); } catch {} throw e; }
      },
      raw: dbRaw
    };
    const warnLines = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => { errors.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
    const express = (await import('express')).default;
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('${MODULES.config}');
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlTimeoutForTests(30);
    cal.__setMlEstimateForTests(() => new Promise(() => {})); // hangs forever — must never block the route
    const workoutRoutes = (await import('${MODULES.workouts}')).default;
    const app = express();
    app.use(express.json());
    app.use('/workouts', workoutRoutes(adapter));
    const server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'C' }, config.jwtSecret, { expiresIn: '1h' });
    const t0 = Date.now();
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/workouts/wko_1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60 }] }] })
    });
    const elapsedMs = Date.now() - t0;
    const json = await res.json();
    console.warn = origWarn; console.error = origErr;
    server.closeAllConnections(); server.close();
    const w = await adapter.q1("SELECT status, estimated_active_kcal, calorie_provider FROM workouts WHERE id = 'wko_1'");
    console.log('HTTP:' + res.status + ':MS:' + elapsedMs + ':CAL:' + JSON.stringify(json.calorie ?? null) + ':WORKOUT:' + JSON.stringify(w) + ':WARNS:' + JSON.stringify(warnLines) + ':ERRORS:' + JSON.stringify(errors));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/HTTP:(\d+):MS:(\d+):CAL:(\{.*\}|null):WORKOUT:(\{.*\}):WARNS:(\[.*\]):ERRORS:(\[.*\])/);
  assert.ok(m, 'harness output parsed: ' + r.stdout);
  const [, status, ms, cal, workout, warnsRaw, errorsRaw] = m;
  assert.equal(Number(status), 200, 'completion succeeds despite a hanging ML provider');
  // Well under the real production ML_TIMEOUT_MS (3000ms) — proves the
  // request is bounded by the (test-overridden) timeout, not by luck.
  assert.ok(Number(ms) < 2500, `completion must not stall on a hanging provider (took ${ms}ms)`);
  assert.equal(JSON.parse(workout).status, 'completed', 'workout still completes');
  assert.ok(JSON.parse(workout).estimated_active_kcal > 0, 'baseline fallback estimate is persisted');
  assert.equal(JSON.parse(workout).calorie_provider, 'baseline', 'fallback truthfully persisted as baseline, never ml');
  const calJson = JSON.parse(cal);
  assert.equal(calJson.provider, 'baseline');
  assert.ok(calJson.note && calJson.note.includes('timed out'));
  // (Node may asynchronously flush its own SQLite ExperimentalWarning through
  // this same override — same environmental artifact test F tolerates — so
  // assert no *application* error was logged rather than an exact count.)
  const errs = JSON.parse(errorsRaw);
  assert.ok(!errs.some((e) => /calorie estimate failed/.test(e)), 'a timeout is expected, not an unexpected route-level error: ' + JSON.stringify(errs));
  const warns = JSON.parse(warnsRaw);
  assert.equal(warns.length, 1, 'exactly one fallback warning logged');
  assert.match(warns[0], /ml_timeout/);
  assert.match(warns[0], /"workout_id":"wko_1"/);
  const joined = warns.join('\n');
  for (const banned of ['Bearer', 'testpass', 'actual_weight', 'actual_reps', 'password', 'body_weight']) {
    assert.ok(!joined.includes(banned), `fallback warning must not contain ${banned}`);
  }
});
