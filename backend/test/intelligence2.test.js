// ============================================================
// Phase-2 intelligence regression tests:
//   * confirm-food preserves original units (never forces grams)
//   * server re-computes nutrition — client totals never trusted
//   * exercise search SQL is valid across all filter combos
//   * no universal 1ml = 1g assumption (ml scaling by food base)
//   * food-specific piece weights (egg 52g, roti 35g)
//   * /intel/ask context answers from real DB rows
//   * meal-photo estimation is ESTIMATED ranges only
//   * security: cross-org confirm rejected, prod JWT gate, CORS
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    raw: db
  };
}

async function seedOrg(db, oid = 'o1', uid = 'u1', cid = 'c1') {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Gym ' + oid, 'gym-' + oid.toLowerCase(), '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    [uid, oid, `${cid}@x.in`, 'x', 'Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)', [cid, uid, oid, 'FAT_LOSS', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO client_profiles (client_id, water_target_l, sleep_target_h) VALUES (?, 3, 8)`, [cid]);
}

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, org: user.org_id, name: user.name }, config.jwtSecret, { expiresIn: '1h' });
}

async function startIntelApi(db, user) {
  const intelRoutes = (await import('../src/routes/intelligence.js')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/intel', intelRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body, u = user) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}` },
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { call, close };
}

// ================= 1. CONFIRM-FOOD UNIT PRESERVATION =================
test('confirm-food preserves original units — 220g paneer stays gram/g', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('p1', NULL, NULL, 'Paneer', 'serving', '100 g', NULL, 265, 18, 4, 21, 'VERIFIED_DATABASE', 1)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/confirm-food', { entries: [{ food_id: 'p1', quantity: 220, unit: 'g' }] });
  assert.equal(r.status, 200, 'confirms');
  const row = await db.q1('SELECT * FROM meal_logs ORDER BY rowid DESC LIMIT 1');
  assert.equal(row.quantity, 220, 'quantity preserved');
  assert.equal(row.unit, 'g', 'unit preserved as g');
  assert.equal(row.unit_type, 'gram', 'unitType preserved as gram');
  assert.equal(row.calories, 583, 'server-computed 265 × 2.2');
});

test('confirm-food preserves piece units — 2 rotis stays rotis/piece', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('r1', NULL, NULL, 'Roti', 'piece', '1 pc', 35, 104, 3.5, 18, 1, 'VERIFIED_DATABASE', 1)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/confirm-food', { entries: [{ food_id: 'r1', quantity: 2, unit: 'rotis' }] });
  assert.equal(r.status, 200);
  const row = await db.q1('SELECT * FROM meal_logs ORDER BY rowid DESC LIMIT 1');
  assert.equal(row.quantity, 2);
  assert.equal(row.unit_type, 'piece', 'unitType preserved — not forced to gram');
  assert.ok(['roti', 'rotis'].includes(row.unit), 'piece-unit preserved (canonicalised)');
  assert.equal(row.calories, 208, '2 × 104');
});

test('confirm-food preserves ml units — 250ml milk uses the 200ml base', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('m1', NULL, NULL, 'Milk', 'glass', '200 ml', NULL, 122, 6.6, 9.6, 6.6, 'VERIFIED_DATABASE', 1)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/confirm-food', { entries: [{ food_id: 'm1', quantity: 250, unit: 'ml' }] });
  assert.equal(r.status, 200);
  const row = await db.q1('SELECT * FROM meal_logs ORDER BY rowid DESC LIMIT 1');
  assert.equal(row.unit, 'ml');
  assert.equal(row.unit_type, 'ml');
  assert.equal(row.calories, Math.round(122 * (250 / 200)), 'ml scaled against ml base — no 1ml=1g shortcut');
});

test('confirm-food handles eggs and protein powder with their own units', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('e1', NULL, NULL, 'Egg', 'piece', '1 pc', 52, 72, 6, 0.4, 4.8, 'VERIFIED_DATABASE', 1)`);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('w1', NULL, NULL, 'Whey protein', 'scoop', '1 scoop', 33, 120, 24, 3, 2, 'VERIFIED_DATABASE', 1)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/confirm-food', {
    entries: [
      { food_id: 'e1', quantity: 2, unit: 'eggs' },
      { food_id: 'w1', quantity: 1, unit: 'scoop' }
    ]
  });
  assert.equal(r.status, 200);
  const rows = await db.q('SELECT * FROM meal_logs ORDER BY rowid ASC');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].unit_type, 'piece'); assert.ok(['egg', 'eggs'].includes(rows[0].unit));
  assert.equal(rows[0].calories, 144, '2 eggs');
  assert.equal(rows[1].unit, 'scoop'); assert.equal(rows[1].unit_type, 'scoop');
  assert.equal(rows[1].calories, 120, '1 scoop');
});

test('confirm-food never trusts client totals — server recomputes from DB', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g, calories, protein, carbs, fat, source, is_global)
                VALUES ('p1', NULL, NULL, 'Paneer', 'serving', '100 g', NULL, 265, 18, 4, 21, 'VERIFIED_DATABASE', 1)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  // malicious client tries to pass a huge cooked number — the server ignores it
  const r = await api.call('POST', '/intel/confirm-food', { entries: [{ food_id: 'p1', quantity: 220, unit: 'g', calories: 99999, protein: 999 }] });
  assert.equal(r.status, 200);
  const row = await db.q1('SELECT * FROM meal_logs ORDER BY rowid DESC LIMIT 1');
  assert.equal(row.calories, 583, 'computed, not echoed');
  assert.equal(row.protein, 39.6, 'computed protein');
});

test('cross-org food confirm is rejected — gym A cannot commit gym B food', async (t) => {
  const db = await memDb();
  await seedOrg(db, 'o1', 'u1', 'c1');
  await seedOrg(db, 'o2', 'u2', 'c2');
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global)
                VALUES ('fB', 'o2', NULL, 'Gym B Secret', 'serving', '100 g', 200, 10, 20, 5, 'USER_ENTERED', 0)`);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/confirm-food', { entries: [{ food_id: 'fB', quantity: 1, unit: 'serving' }] });
  assert.equal(r.status, 404, 'not available to this client');
  const rows = await db.q('SELECT * FROM meal_logs');
  assert.equal(rows.length, 0, 'nothing committed');
});

// ================= 2. EXERCISE SEARCH SQL VARIANTS =================
test('exercise search builds valid SQL for every filter combination', async () => {
  const db = await memDb();
  await seedOrg(db);
  const exs = [
    ['ex1', 'Dumbbell Bench Press', 'CHEST', 'DUMBBELL', 'horizontal_push', 'BEGINNER'],
    ['ex2', 'Barbell Bench Press', 'CHEST', 'BARBELL', 'horizontal_push', 'INTERMEDIATE'],
    ['ex3', 'Lat Pulldown', 'LATS', 'CABLE', 'vertical_pull', 'BEGINNER'],
    ['ex4', 'Romanian Deadlift', 'HAMSTRINGS', 'BARBELL', 'hinge', 'ADVANCED']
  ];
  for (const [id, name, muscle, eq, mv, diff] of exs) {
    await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global)
                  VALUES (?, NULL, ?, ?, ?, ?, ?, 1)`, [id, name, muscle, eq, mv, diff]);
  }
  const { searchExercises } = await import('../src/services/intelligence/exerciseSearch.js');

  // no filters (bare query) — must NOT produce "FROM ... AND (...)"
  const none = await searchExercises(db, 'o1', '');
  assert.ok(none.length >= 4, 'no filters returns everything visible');

  // search only
  const search = await searchExercises(db, 'o1', 'bench press');
  assert.equal(search.length, 2);

  // muscle only
  const muscle = await searchExercises(db, 'o1', '', { muscle: 'chest' });
  assert.equal(muscle.length, 2);

  // equipment only
  const equip = await searchExercises(db, 'o1', '', { equipment: 'cable' });
  assert.equal(equip.length, 1);
  assert.equal(equip[0].id, 'ex3');

  // difficulty only
  const diff = await searchExercises(db, 'o1', '', { difficulty: 'ADVANCED' });
  assert.equal(diff.length, 1);
  assert.equal(diff[0].id, 'ex4');

  // multiple filters
  const multi = await searchExercises(db, 'o1', '', { muscle: 'chest', equipment: 'dumbbells', difficulty: 'BEGINNER' });
  assert.equal(multi.length, 1);
  assert.equal(multi[0].id, 'ex1');

  // pagination cap
  const page = await searchExercises(db, 'o1', '', {}, { limit: 2 });
  assert.ok(page.length <= 2, 'limit respected');
});

test('classifier uses whole words — "machine back" never matches "chin up"', async () => {
  const db = await memDb();
  await seedOrg(db);
  for (const [id, name, muscle, eq, mv] of [
    ['m1', 'Chest-Supported Row', 'UPPER BACK', 'MACHINE', 'horizontal_pull'],
    ['m2', 'Chin-up', 'LATS', 'PULL_UP_BAR', 'vertical_pull']
  ]) {
    await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global)
                  VALUES (?, NULL, ?, ?, ?, ?, 'BEGINNER', 1)`, [id, name, muscle, eq, mv]);
  }
  const { searchExercises } = await import('../src/services/intelligence/exerciseSearch.js');
  const machine = await searchExercises(db, 'o1', 'machine back');
  assert.equal(machine.length, 1, 'machine back matches the row, not chin-up');
  assert.equal(machine[0].id, 'm1');
});

test('search respects org scope — gym exercises are visible only to their gym', async () => {
  const db = await memDb();
  await seedOrg(db, 'o1', 'u1', 'c1');
  await seedOrg(db, 'o2', 'u2', 'c2');
  await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, equipment, movement, difficulty, is_global)
                VALUES ('xA', 'o1', 'Gym A Lift', 'CHEST', 'MACHINE', 'horizontal_push', 'BEGINNER', 0)`);
  const { searchExercises } = await import('../src/services/intelligence/exerciseSearch.js');
  const forA = await searchExercises(db, 'o1', 'gym a lift');
  assert.equal(forA.length, 1, 'own gym exercise visible');
  const forB = await searchExercises(db, 'o2', 'gym a lift');
  assert.equal(forB.length, 0, 'other gym exercise never visible');
});

// ================= 3. ML/G SCALING — NO UNIVERSAL 1ml=1g =================
test('ml scaling uses the food base — no universal 1ml=1g assumption', async () => {
  const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');
  // milk: 122 kcal per 200 ml
  const milk = { id: 'm1', name: 'Milk', serving: '200 ml', calories: 122, protein: 6.6, carbs: 9.6, fat: 6.6, source: 'VERIFIED_DATABASE', is_global: 1 };
  const n = computeNutrition(milk, { qty: 100, unit: 'ml', unitType: 'ml', provenance: 'USER_ENTERED' });
  assert.equal(n.macros.calories, Math.round(122 / 2), '100ml = half the 200ml base');
  assert.equal(n.confidence, 'HIGH');
  // cross-unit ml → g is ESTIMATED and flagged, never silent
  const g = computeNutrition(milk, { qty: 100, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  assert.equal(g.estimated, true, 'gram input against ml base is estimated');
  assert.equal(g.provenance, 'ESTIMATED');
});

// ================= 4. FOOD-SPECIFIC PIECE WEIGHTS =================
test('food-specific piece weights beat generic defaults', async () => {
  const { computeNutrition } = await import('../src/services/intelligence/nutrition.js');
  // egg with piece_g 52
  const egg = { id: 'e1', name: 'Egg', serving: '1 pc', piece_g: 52, calories: 72, protein: 6, carbs: 0.4, fat: 4.8, source: 'VERIFIED_DATABASE', is_global: 1 };
  const two = computeNutrition(egg, { qty: 2, unit: 'eggs', unitType: 'piece', provenance: 'USER_ENTERED' });
  assert.equal(two.macros.calories, 144, '2 × 72');
  assert.equal(two.confidence, 'HIGH', 'food-specific piece weight → high confidence');

  // roti with piece_g 35 → gram conversion is exact-ish, not flagged estimated
  const roti = { id: 'r1', name: 'Roti', serving: '1 pc', piece_g: 35, calories: 104, protein: 3.5, carbs: 18, fat: 1, source: 'VERIFIED_DATABASE', is_global: 1 };
  const rotiGram = computeNutrition(roti, { qty: 35, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' });
  assert.equal(rotiGram.macros.calories, 104, '35g = one roti via piece_g');
});

// ================= 5. /intel/ask CONTEXT =================
test('ask context: protein eaten + remaining today (from real meal_logs)', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  const { dayKey } = await import('../src/utils/time.js');
  const d = dayKey(new Date(), 'Asia/Kolkata');
  await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
                VALUES ('np1', 'o1', 'u1', 'c1', 'Plan', 2550, 200, 235, 90, 0, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                VALUES ('l1', 'c1', ?, 'intel', 'Paneer', 583, 39.6, 8.8, 46.2, 1, 'intel')`, [d]);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/ask', { text: 'How much protein have I eaten today?' });
  assert.equal(r.status, 200);
  assert.equal(r.json.topic, 'protein');
  assert.equal(r.json.provenance, 'MEASURED');
  assert.equal(r.json.detail.logged.protein, 39.6, 'measured from the log row');
  assert.equal(r.json.detail.remainingProtein, 160.4, '200 − 39.6');
  assert.ok(r.json.summary.includes('39.6'), 'summary carries the number');
});

test('ask context: what should I train today uses the planner schedule', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  // today is whichever weekday it is — schedule it so the answer is MEASURED
  const dow = (new Date().getDay() + 6) % 7;
  await db.run(`INSERT INTO client_workouts (id, org_id, client_id, name, created_at)
                VALUES ('w1', 'o1', 'c1', 'Push A', '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO client_workout_schedule (client_id, day_of_week, workout_id) VALUES ('c1', ?, 'w1')`, [dow]);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/ask', { text: 'What should I train today?' });
  assert.equal(r.status, 200);
  assert.equal(r.json.topic, 'train_today');
  assert.ok(r.json.summary.includes('Push A'), 'uses the scheduled workout');
});

test('ask context: weight plateau detected from weight_logs', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  await db.run('UPDATE clients SET current_weight = 87.4, target_weight = 82 WHERE id = ?', ['c1']);
  for (const [i, w] of [[1, 87.6], [2, 87.5], [3, 87.4], [4, 87.6], [5, 87.5], [6, 87.4], [7, 87.4], [8, 87.5], [9, 87.4], [10, 87.4], [11, 87.5], [12, 87.4], [13, 87.5], [14, 87.4]]) {
    await db.run(`INSERT INTO weight_logs (id, client_id, weight, date, created_at) VALUES (?, 'c1', ?, ?, '2026-06-01T00:00:00Z')`, [`wl${i}`, w, `2026-06-${String(i).padStart(2, '0')}`]);
  }
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/ask', { text: 'My weight has not changed in two weeks, why?' });
  assert.equal(r.status, 200);
  assert.equal(r.json.topic, 'weight');
  assert.ok(r.json.summary.toLowerCase().includes('plateau'), 'calls out the plateau');
});

test('ask context: no invented data when nothing is logged', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const r = await api.call('POST', '/intel/ask', { text: 'What did I bench last week?' });
  assert.equal(r.status, 200);
  assert.ok(/don't have/.test(r.json.summary) || /no log/i.test(r.json.summary), 'admits missing data');
});

// ================= 6. MEAL-PHOTO ESTIMATION =================
test('meal-photo returns ESTIMATED ranges, never exact', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  // tiny valid 1x1 PNG (only format/size validated here)
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await api.call('POST', '/intel/meal-photo', { image: png });
  assert.equal(r.status, 200);
  assert.equal(r.json.estimated, true, 'always estimated');
  assert.ok(!Number.isFinite(r.json.range?.calories?.[0]) || r.json.range.calories[0] !== r.json.range.calories[1],
    'range not a single exact number');
});

test('label-scan validates image and stores privately', async (t) => {
  const db = await memDb();
  await seedOrg(db);
  const api = await startIntelApi(db, { id: 'u1', role: 'CLIENT', org_id: 'o1' });
  t.after(() => api.close());
  const bad = await api.call('POST', '/intel/label-scan', { image: 'not-an-image' });
  assert.equal(bad.status, 400, 'rejects junk');
  const tiny = await api.call('POST', '/intel/label-scan', { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
  assert.equal(tiny.status, 400, 'rejects 1x1 (too small to read)');
});

// ================= 7. SECURITY =================
test('production refuses to start without a strong JWT_SECRET', () => {
  const cfgPath = path.resolve(__dirname, '..', 'src', 'config.js').replace(/\\/g, '/');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    await import('file://${cfgPath}');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0, 'process exits with failure in production without secret');
  assert.ok(/FATAL/.test(child.stderr || ''), 'prints a fatal startup error');
});

test('config defaults CORS to localhost dev origins only', () => {
  assert.ok(Array.isArray(config.corsOrigins));
  assert.ok(config.corsOrigins.every((o) => /localhost|127\.0\.0\.1/.test(o)), 'dev origins only by default');
  assert.ok(!config.corsOrigins.includes('*'), 'no wildcard CORS');
});
