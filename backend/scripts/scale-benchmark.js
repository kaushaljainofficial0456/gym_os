// ============================================================
// SCALE TEST — 10 gyms × 250 clients (~2,500 total)
// Measures the client-list / evaluation path (the historical N+1)
// and an AI-context build, reporting query counts + wall time.
//
//   node scripts/scale-test.js
//
// Uses a throwaway temp database (never the dev DB) and never touches
// the network. All timings are reported, not assumed.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');

const GYMS = 10;
const CLIENTS_PER_GYM = 250;

async function makeDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = MEMORY;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  let queries = 0;
  const api = {
    driver: 'sqlite',
    async q(sql, params = []) { queries++; const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await api.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) { db.exec('BEGIN'); try { const out = await fn(api); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    raw: db,
    _queries: () => queries,
    _reset: () => { queries = 0; }
  };
  return api;
}

const now = '2026-08-01T00:00:00Z';
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const DATES = Array.from({ length: 30 }, (_, i) => {
  const d = new Date('2026-07-03T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

async function seed(db) {
  console.log(`Seeding ${GYMS} gyms × ${CLIENTS_PER_GYM} clients = ${GYMS * CLIENTS_PER_GYM} clients …`);
  const foods = ['Paneer', 'Rice', 'Chicken breast', 'Roti', 'Eggs', 'Milk', 'Oats', 'Banana', 'Whey'];
  const exs = ['Bench Press', 'Squat', 'Lat Pulldown', 'Curl', 'Overhead Press', 'Row', 'Deadlift', 'Plank'];
  const t0 = Date.now();
  for (let g = 0; g < GYMS; g++) {
    const oid = `org_${g}`;
    await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, `Gym ${g}`, `gym-${g}`, now]);
    for (let c = 0; c < CLIENTS_PER_GYM; c++) {
      const cid = `cli_${g}_${c}`;
      const uid = `usr_${g}_${c}`;
      await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                     VALUES (?, ?, ?, 'x', 'CLIENT', ?, 1, ?)`, [uid, oid, `${cid}@x.in`, `Client ${g}-${c}`, now]);
      await db.run(`INSERT INTO clients (id, user_id, org_id, status, goal, current_weight, created_at)
                     VALUES (?, ?, ?, 'ON_TRACK', 'FAT_LOSS', ?, ?)`, [cid, uid, oid, 70 + rand(400) / 10, now]);
      await db.run(`INSERT INTO client_profiles (client_id, meals_per_day, sleep_target_h, water_target_l) VALUES (?, 5, 8, 3)`, [cid]);
      // 8 workout logs
      for (let w = 0; w < 8; w++) {
        await db.run(`INSERT INTO workout_logs (id, client_id, date, sets_done, reps, weight, created_at)
                       VALUES (?, ?, ?, 3, ?, ?, ?)`, [`wlg_${g}_${c}_${w}`, cid, pick(DATES), 8 + rand(4), 40 + rand(600) / 10, now]);
      }
      // 6 weight logs
      for (let w = 0; w < 6; w++) {
        await db.run(`INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, 'manual', ?)`,
          [`wt_${g}_${c}_${w}`, cid, pick(DATES), 70 + rand(400) / 10, now]);
      }
      // 10 meal logs
      for (let m = 0; m < 10; m++) {
        await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                       VALUES (?, ?, ?, 'lunch', ?, ?, ?, ?, ?, 1, 'manual')`,
          [`ml_${g}_${c}_${m}`, cid, pick(DATES), pick(foods), 300 + rand(600), 20 + rand(300) / 10, 30 + rand(400) / 10, 10 + rand(200) / 10]);
      }
      // water + sleep
      await db.run(`INSERT INTO water_logs (id, client_id, date, litres) VALUES (?, ?, ?, ?)`, [`wtr_${g}_${c}`, cid, pick(DATES), 1 + rand(30) / 10]);
      await db.run(`INSERT INTO sleep_logs (id, client_id, date, duration_h, target_h) VALUES (?, ?, ?, ?, 8)`, [`slp_${g}_${c}`, cid, pick(DATES), 5 + rand(40) / 10]);
      // 3 exercises in the library for the org (so muscle lookups have data)
      if (c === 0) {
        for (const e of exs) {
          await db.run(`INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, movement, is_global)
                         VALUES (?, ?, ?, 'CHEST', 'TRICEPS', 'BARBELL', 'horizontal_push', 0)`, [`ex_${g}_${e.replace(/\W/g, '')}`, oid, e]);
        }
      }
    }
  }
  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main() {
  const file = path.join(os.tmpdir(), `skos-scale-${Date.now()}.db`);
  const db = await makeDb(file);
  try {
    await seed(db);

    // ---- 1. Bulk evaluation (new path) — one org (250 clients) ----
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', ['org_0']);
    const { evaluateClients } = await import('../src/services/atRisk.js');
    db._reset();
    let t = Date.now();
    const evs = await evaluateClients(db, clients);
    const bulkTime = Date.now() - t;
    const bulkQueries = db._queries();

    // ---- 2. Per-client loop (old path) — same org ----
    const { evaluateClient } = await import('../src/services/atRisk.js');
    db._reset();
    t = Date.now();
    for (const c of clients) await evaluateClient(db, c);
    const loopTime = Date.now() - t;
    const loopQueries = db._queries();

    // ---- 3. AI context build for one client ----
    const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
    const one = clients[0];
    db._reset();
    t = Date.now();
    const ctx = await buildClientAIContext(db, one, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery', 'gym'] }, 'Asia/Kolkata');
    const ctxTime = Date.now() - t;
    const ctxQueries = db._queries();

    // ---- 4. Owner client-list meta (users join + last workout + 7d weight) ----
    db._reset();
    t = Date.now();
    const ids = clients.map((c) => c.id);
    const inClause = ids.map(() => '?').join(',');
    const [users, lastWos, w7s] = await Promise.all([
      db.q(`SELECT id, name FROM users WHERE id IN (${inClause})`, clients.map((c) => c.user_id)),
      db.q(`SELECT client_id, MAX(scheduled_date) AS d FROM workouts WHERE client_id IN (${inClause}) AND status = 'completed' GROUP BY client_id`, ids),
      db.q(`SELECT client_id, date, weight FROM weight_logs WHERE client_id IN (${inClause}) AND date >= ? ORDER BY client_id, date`, [...ids, '2026-07-25'])
    ]);
    const listMetaTime = Date.now() - t;

    const totalPerGym = bulkQueries + db._queries();
    console.log('\n===== RESULTS (per gym of 250 clients) =====');
    console.log(`Bulk evaluation : ${bulkQueries} queries in ${bulkTime}ms`);
    console.log(`Per-client loop : ${loopQueries} queries in ${loopTime}ms  (${(loopQueries / bulkQueries).toFixed(1)}× fewer queries)`);
    console.log(`List meta       : 3 queries in ${listMetaTime}ms (users + last workout + 7d weight)`);
    console.log(`Total list path : ~${bulkQueries + 3} queries for 250 clients`);
    console.log(`AI context      : ${ctxQueries} queries in ${ctxTime}ms`);
    console.log(`\nStatus sample   : ${evs.get(clients[0].id).status}, ${evs.get(clients[100].id).status}, ${evs.get(clients[249].id).status}`);
    console.log(`Adherence sample: ${evs.get(clients[0].id).adherence.score}`);
    console.log(`Context keys    : ${Object.keys(ctx).join(', ')}`);
    console.log(`\nTotal clients   : ${GYMS * CLIENTS_PER_GYM}`);
  } finally {
    db.raw.close();
    try { fs.unlinkSync(file); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
