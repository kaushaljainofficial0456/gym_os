// ============================================================
// Phase 3B Step 3 — Sambhav ML integration tests (skos-cal-v1).
//   A. exercise-ID canonicalization (unit-level): the 6 confirmed safe
//      global animation_key mappings; custom exercises and the 2
//      intentionally-unmapped tokens (INCLINE_BENCH_PRESS,
//      TRICEPS_EXTENSION) never guess
//   B. mapping engages end-to-end using a REALISTIC opaque exercise_id
//      (not a literal canonical token) — closes the exact gap the
//      pre-implementation integration audit found
//   C. gross -> net-of-resting conversion: correct math, interval
//      ordering preserved, a legitimately small result clamps to 0
//      (never negative), an already-invalid (garbage negative) gross
//      value is never "fixed" by the conversion, MAX_ACTIVE_KCAL still
//      enforced after conversion
//   D. full HTTP-level persistence correctness with a REAL
//      exercise_library row (opaque id, animation_key, is_global) —
//      success -> provider 'ml'; exception/timeout/invalid output all
//      -> provider 'baseline'; API response shape unchanged; no
//      sensitive data in fallback observability
//
// Provider-dependent behavior runs in isolated subprocesses
// (helpers/providerRunner.js) — config.js resolves the provider once at
// startup, so the env must be set before any import.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { mlCanonicalExerciseId } from '../src/services/intelligence/calorieModel.js';
import { runWithProvider, MODULES } from './helpers/providerRunner.js';

// ---------------- A: exercise-ID canonicalization (unit-level) ----------------

test('A1. global bench_press -> BENCH_PRESS', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'bench_press', isGlobal: 1 }), 'BENCH_PRESS');
});
test('A2. global squat -> BARBELL_SQUAT', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'squat', isGlobal: 1 }), 'BARBELL_SQUAT');
});
test('A3. global leg_press -> LEG_PRESS', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'leg_press', isGlobal: 1 }), 'LEG_PRESS');
});
test('A4. global leg_extension -> LEG_EXTENSION', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'leg_extension', isGlobal: 1 }), 'LEG_EXTENSION');
});
test('A5. global lat_pulldown -> LAT_PULLDOWN', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'lat_pulldown', isGlobal: 1 }), 'LAT_PULLDOWN');
});
test('A6. global bicep_curl -> BICEP_CURL', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'bicep_curl', isGlobal: 1 }), 'BICEP_CURL');
});
test('A7. custom (non-global) exercise with a matching animation_key NEVER maps', () => {
  for (const key of ['bench_press', 'squat', 'leg_press', 'leg_extension', 'lat_pulldown', 'bicep_curl']) {
    assert.equal(mlCanonicalExerciseId({ animationKey: key, isGlobal: 0 }), null, `custom exercise animation_key=${key} must never map`);
  }
});
test('A8. INCLINE_BENCH_PRESS remains unmapped — no candidate animation_key resolves to it', () => {
  for (const key of ['incline_db_press', 'incline_barbell_press']) {
    assert.equal(mlCanonicalExerciseId({ animationKey: key, isGlobal: 1 }), null);
  }
});
test('A9. TRICEPS_EXTENSION remains unmapped — no candidate animation_key resolves to it', () => {
  for (const key of ['triceps_pushdown', 'overhead_extension', 'skull_crusher']) {
    assert.equal(mlCanonicalExerciseId({ animationKey: key, isGlobal: 1 }), null);
  }
});
test('A10. unrecognized/missing animation_key never maps', () => {
  assert.equal(mlCanonicalExerciseId({ animationKey: 'burpee', isGlobal: 1 }), null);
  assert.equal(mlCanonicalExerciseId({ animationKey: '', isGlobal: 1 }), null);
  assert.equal(mlCanonicalExerciseId({ isGlobal: 1 }), null);
});

// ---------------- B: mapping engages end-to-end (real opaque exercise_id) ----------------

test('B1. real opaque exercise_id + global bench_press mapping engages BENCH_PRESS correction; unmapped falls to safe unknown-exercise behavior', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    const input = {
      user: { body_weight_kg: 78.67 },
      session: { duration_minutes: 10, intensity_rating: 'hard' },
      exercises: [{ exercise_id: 'exl_7f3k9s0a1x', sets: 3, total_volume_kg: 500, completed_sets: [1,2,3] }]
    };
    const withMapping = await cal.estimateWorkoutCalories(input, { mlExerciseCanonical: { exl_7f3k9s0a1x: 'BENCH_PRESS' } });
    const withoutMapping = await cal.estimateWorkoutCalories(input); // no map -> unknown-exercise path (item 10)
    console.log('OUT:' + JSON.stringify({ withMapping, withoutMapping }));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const { withMapping, withoutMapping } = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(withMapping.provider, 'ml');
  assert.equal(withoutMapping.provider, 'ml');
  // the trained BENCH_PRESS correction actually changes the estimate —
  // proves the mapping engaged (opaque id -> canonical token), not just
  // that both calls happened to succeed.
  assert.notEqual(withMapping.estimated_active_kcal, withoutMapping.estimated_active_kcal);
  assert.ok(!withMapping.note || !withMapping.note.includes('outside the trained set'), 'mapped exercise is not flagged as unknown');
  assert.ok(withoutMapping.note && withoutMapping.note.includes('outside the trained set'), 'unmapped opaque id correctly uses the safe unknown-exercise fallback, never guessed');
});

// ---------------- C: gross -> net-of-resting conversion ----------------

test('C1. gross ML result is converted to net-of-resting active calories', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: 200, lower_kcal: 150, upper_kcal: 250, model_version: 'skos-cal-v1' }));
    const out = await cal.estimateWorkoutCalories({ user: { body_weight_kg: 80 }, session: { duration_minutes: 40, intensity_rating: 'moderate' }, exercises: [] });
    console.log('OUT:' + JSON.stringify(out));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  // resting = 1 MET x 3.5 x 80 / 200 x 40 = 56 kcal exactly (existing
  // MET-based formula, reused — not a new BMR formula).
  assert.equal(out.estimated_active_kcal, 200 - 56);
  assert.equal(out.provider, 'ml');
});

test('C2. lower/upper interval bounds are converted with the SAME offset — ordering preserved', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: 200, lower_kcal: 150, upper_kcal: 250, model_version: 'skos-cal-v1' }));
    const out = await cal.estimateWorkoutCalories({ user: { body_weight_kg: 80 }, session: { duration_minutes: 40, intensity_rating: 'moderate' }, exercises: [] });
    console.log('OUT:' + JSON.stringify(out));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.lower_kcal, 150 - 56);
  assert.equal(out.upper_kcal, 250 - 56);
  assert.ok(out.lower_kcal <= out.estimated_active_kcal && out.estimated_active_kcal <= out.upper_kcal);
});

test('C3. a legitimately small gross estimate converts to a net result that clamps to 0, never negative', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: 10, lower_kcal: 5, upper_kcal: 15, model_version: 'skos-cal-v1' }));
    const out = await cal.estimateWorkoutCalories({ user: { body_weight_kg: 90 }, session: { duration_minutes: 60, intensity_rating: 'moderate' }, exercises: [] });
    console.log('OUT:' + JSON.stringify(out));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  // resting here (1*3.5*90/200*60 = 94.5) far exceeds the tiny gross 10/5/15
  assert.equal(out.estimated_active_kcal, 0);
  assert.equal(out.lower_kcal, 0);
  assert.equal(out.upper_kcal, 0);
  assert.equal(out.provider, 'ml', 'a legitimately tiny (not garbage) gross estimate still passes validation, clamped to 0 net');
});

test('C3b. an already-invalid (negative) gross estimate is never "fixed" by the conversion — still rejected as invalid_output', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: -50, lower_kcal: -80, upper_kcal: -20, model_version: 'skos-cal-v1' }));
    const out = await cal.estimateWorkoutCalories({ user: { body_weight_kg: 70 }, session: { duration_minutes: 30, intensity_rating: 'moderate' }, exercises: [] });
    console.log('OUT:' + JSON.stringify(out));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  assert.equal(out.provider, 'baseline', 'garbage negative gross output must never be silently laundered into a valid-looking 0 by the resting subtraction — the gate must still catch it');
  assert.ok(out.note && out.note.includes('invalid'));
});

test('C4. validation still rejects an excessive final (post-conversion) result — MAX_ACTIVE_KCAL enforced', () => {
  const snippet = `
    const cal = await import('${MODULES.calorieModel}');
    cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: 2000, lower_kcal: 1900, upper_kcal: 2100, model_version: 'skos-cal-v1' }));
    const out = await cal.estimateWorkoutCalories({ user: { body_weight_kg: 70 }, session: { duration_minutes: 5, intensity_rating: 'moderate' }, exercises: [] });
    console.log('OUT:' + JSON.stringify(out));
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.match(/OUT:(\{.*\})/)[1]);
  // resting for 5 min is tiny (~6 kcal): 2000-6=1994, still way over MAX_ACTIVE_KCAL (1500)
  assert.equal(out.provider, 'baseline', 'excessive post-conversion result is still rejected, falls back to baseline');
  assert.ok(out.note && out.note.includes('sane maximum'));
});

// ---------------- D: full HTTP-level persistence, real exercise_library rows ----------------
// Real (non-poisoned) in-memory DB + real workoutRoutes, seeding an
// exercise_library row exactly as seed.js would (opaque id, a global
// animation_key, is_global=1) — proves the mapping and net-of-resting
// conversion work through the ACTUAL route/persistence path, not just in
// isolation (items 15, 19, 20, 21, 22, 23, 25, 26).

function seedSnippet(setupMl) {
  return `
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const dbRaw = new DatabaseSync(':memory:');
    dbRaw.exec('PRAGMA foreign_keys = ON;');
    dbRaw.exec(fs.readFileSync('${MODULES.schema}', 'utf8'));
    dbRaw.exec("INSERT INTO organizations (id, name, slug, created_at) VALUES ('o1', 'Gym A', 'gym-a', '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('u1', 'o1', 'c@a.in', 'x', 'CLIENT', 'C', 1, '2026-01-01T00:00:00Z')");
    dbRaw.exec("INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, start_weight, current_weight, created_at) VALUES ('c1', 'u1', 'o1', 'FAT_LOSS', 30, 'M', 175, 80, 78.67, '2026-01-01T00:00:00Z')");
    // Real global exercise_library row — opaque id (nanoid-style, exactly
    // as backend/scripts/seed.js generates), animation_key='bench_press',
    // is_global=1 — NOT a literal canonical token like 'BENCH_PRESS'.
    dbRaw.exec("INSERT INTO exercise_library (id, name, primary_muscle, equipment, movement, ex_type, animation_key, is_global) VALUES ('exl_k3n9d0p2qz', 'Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'compound', 'bench_press', 1)");
    // started_at set (10 real minutes ago) so /complete computes a REAL
    // measured duration — Sambhav's model requires duration_minutes and
    // correctly throws (falls back to baseline) without one; without this
    // the success case below could never actually engage the ml provider.
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    dbRaw.exec("INSERT INTO workouts (id, org_id, client_id, name, scheduled_date, status, started_at, created_at) VALUES ('wko_1', 'o1', 'c1', 'Push Day', '2026-08-15', 'assigned', '" + startedAt + "', '2026-08-15T00:00:00Z')");
    dbRaw.exec("INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec) VALUES ('wxeA', 'wko_1', 'exl_k3n9d0p2qz', 0, 'Bench Press', 3, '10', '60', 90)");
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
    const errorLines = [];
    const origErr = console.error;
    console.error = (...args) => { errorLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
    const express = (await import('express')).default;
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('${MODULES.config}');
    const cal = await import('${MODULES.calorieModel}');
    ${setupMl || ''}
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
      body: JSON.stringify({ logs: [{ exercise_id: 'wxeA', sets: [{ actual_reps: 10, actual_weight: 60, rir: 2 }] }] })
    });
    const json = await res.json();
    console.warn = origWarn; console.error = origErr;
    server.closeAllConnections(); server.close();
    const w = await adapter.q1("SELECT status, estimated_active_kcal, lower_kcal, upper_kcal, model_version, schema_version, calorie_provider FROM workouts WHERE id = 'wko_1'");
    console.log('HTTP:' + res.status + ':CAL:' + JSON.stringify(json.calorie ?? null) + ':WORKOUT:' + JSON.stringify(w) + ':WARNS:' + JSON.stringify(warnLines) + ':ERRORS:' + JSON.stringify(errorLines.filter(e => !/ExperimentalWarning/.test(e))));
  `;
}

function parseHttp(r) {
  const m = r.stdout.match(/HTTP:(\d+):CAL:(\{.*\}|null):WORKOUT:(\{.*\}):WARNS:(\[.*\]):ERRORS:(\[.*\])/);
  assert.ok(m, 'harness output parsed: ' + r.stdout);
  const [, status, cal, workout, warns, errors] = m;
  return { status: Number(status), cal: JSON.parse(cal), workout: JSON.parse(workout), warns: JSON.parse(warns), errors: JSON.parse(errors) };
}

test('D1. success: real exercise_library row maps + net-of-resting -> persisted provider=ml, model_version=skos-cal-v1, schema_version=0.2, API shape unchanged', () => {
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: seedSnippet('') });
  assert.equal(r.status, 0, r.stderr);
  const { status, cal, workout, errors } = parseHttp(r);
  assert.equal(status, 200);
  assert.equal(workout.status, 'completed');
  assert.equal(workout.calorie_provider, 'ml', 'persisted provider is ml only after a successful validated ML result (item 20)');
  assert.equal(workout.model_version, 'skos-cal-v1', 'item 21');
  assert.equal(workout.schema_version, '0.2', 'item 22');
  assert.ok(workout.estimated_active_kcal > 0);
  assert.ok(workout.lower_kcal <= workout.estimated_active_kcal && workout.estimated_active_kcal <= workout.upper_kcal);
  // API response shape unchanged (item 23) — same keys todaySession/complete have always returned.
  assert.deepEqual(
    Object.keys(cal).sort(),
    ['estimated_active_kcal', 'lower_kcal', 'model_version', 'note', 'provider', 'schema_version', 'upper_kcal'].sort()
  );
  assert.equal(cal.provider, 'ml');
  assert.equal(errors.length, 0, 'no unexpected route-level error');
});

test('D2. ML exception -> persisted provider=baseline (item 16, 19)', () => {
  const setup = `cal.__setMlEstimateForTests(() => { throw new Error('simulated ml provider failure'); });`;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: seedSnippet(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { status, workout, warns } = parseHttp(r);
  assert.equal(status, 200, 'workout completion still succeeds despite the ML exception');
  assert.equal(workout.status, 'completed');
  assert.equal(workout.calorie_provider, 'baseline');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /ml_unavailable/);
});

test('D3. ML timeout -> persisted provider=baseline (item 17)', () => {
  const setup = `
    cal.__setMlTimeoutForTests(30);
    cal.__setMlEstimateForTests(() => new Promise(() => {})); // hangs forever
  `;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: seedSnippet(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { status, workout, warns } = parseHttp(r);
  assert.equal(status, 200, 'workout completion still succeeds despite the ML timeout');
  assert.equal(workout.status, 'completed');
  assert.equal(workout.calorie_provider, 'baseline');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /ml_timeout/);
});

test('D4. invalid ML output -> persisted provider=baseline, never raw (item 18)', () => {
  const setup = `cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: NaN, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-v1' }));`;
  const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet: seedSnippet(setup) });
  assert.equal(r.status, 0, r.stderr);
  const { status, workout, warns } = parseHttp(r);
  assert.equal(status, 200);
  assert.equal(workout.status, 'completed');
  assert.equal(workout.calorie_provider, 'baseline');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /invalid_output/);
});

test('D5. no sensitive data in any fallback observability across the failure modes above (item 25)', () => {
  const cases = [
    seedSnippet(`cal.__setMlEstimateForTests(() => { throw new Error('simulated ml provider failure'); });`),
    seedSnippet(`cal.__setMlTimeoutForTests(30); cal.__setMlEstimateForTests(() => new Promise(() => {}));`),
    seedSnippet(`cal.__setMlEstimateForTests(() => ({ estimated_active_kcal: NaN, lower_kcal: 0, upper_kcal: 0, model_version: 'skos-cal-v1' }));`)
  ];
  for (const snippet of cases) {
    const r = runWithProvider({ nodeEnv: 'development', provider: 'ml', snippet });
    assert.equal(r.status, 0, r.stderr);
    const { warns, errors } = parseHttp(r);
    const joined = [...warns, ...errors].join('\n');
    for (const banned of [
      'body_weight', 'bodyWeight', '78.67', 'actual_weight', 'actual_reps', 'height_cm',
      'Bearer', 'testpass', 'authorization', 'password',
      'exl_k3n9d0p2qz', 'wxeA' // raw exercise/set payload identifiers should not leak into fallback logs
      // NOTE: model_version (e.g. 'skos-cal-v1') is a legitimate, documented
      // whitelist field for the invalid_output category — not banned here.
    ]) {
      assert.ok(!joined.includes(banned), `fallback log must not contain ${banned}: ${joined}`);
    }
  }
});
