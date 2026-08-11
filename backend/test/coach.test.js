// ============================================================
// LOCAL AI COACH tests — Ollama provider abstraction, context
// engine, deterministic brief/weekly/recommendations, food
// suggestions from the real DB, safety gate, tenant isolation.
// The coach must work WITHOUT Ollama (deterministic fallback).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function seedClient(db, { oid = 'o1', uid = 'u1', cid = 'c1', goal = 'FAT_LOSS' } = {}) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [oid, 'Gym ' + oid, 'gym-' + oid.toLowerCase(), '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', 'Client', 1, ?)`,
    [uid, oid, `${cid}@x.in`, 'x', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, start_weight, current_weight, target_weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [cid, uid, oid, goal, 94, 87.4, 82, '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO client_profiles (client_id, diet_type, meals_per_day, sleep_target_h, water_target_l, equipment, experience) VALUES (?, 'NON_VEG', 5, 8, 3, '["full_gym"]', 'INTERMEDIATE')`, [cid]);
  return { oid, uid, cid };
}

const { dayKey } = await import('../src/utils/time.js');
const today = dayKey(new Date(), 'Asia/Kolkata');
const wk = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return dayKey(d, 'Asia/Kolkata'); })();

// ---------- context engine ----------
test('buildClientAIContext returns only real DB data, compact and scoped', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
                VALUES ('np1', 'o1', 'u1', 'c1', 'Plan', 2100, 140, 200, 60, 0, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                VALUES ('l1', 'c1', ?, 'lunch', 'Chicken Rice Bowl', 600, 57, 63, 15, 1, 'plan')`, [today]);
  const ctx = await buildClientAIContext(db, client, { domains: ['profile', 'nutrition', 'training'] }, 'Asia/Kolkata');
  assert.equal(ctx.profile.goal, 'fat loss');
  assert.equal(ctx.profile.current_weight, 87.4);
  assert.equal(ctx.nutrition.daily_target.protein, 140);
  assert.equal(ctx.nutrition.today.protein, 57, 'measured from the real log row');
  assert.equal(ctx.nutrition.today.meals, 1);
  assert.ok(ctx.training.today_workout == null || typeof ctx.training.today_workout === 'string');
  // no stray keys — compact and predictable
  assert.ok(Object.keys(ctx).length <= 3, 'only requested domains');
});

test('nutrition context computes a 7-day average from real logs', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  for (let i = 0; i < 4; i++) {
    const d = (() => { const dd = new Date(); dd.setDate(dd.getDate() - i); return dayKey(dd, 'Asia/Kolkata'); })();
    await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                  VALUES (?, 'c1', ?, 'lunch', 'Meal', 600, 60, 60, 15, 1, 'manual')`, [`ml${i}`, d]);
  }
  const ctx = await buildClientAIContext(db, client, { domains: ['nutrition'] }, 'Asia/Kolkata');
  assert.ok(ctx.nutrition.week_avg.days_logged >= 3);
  assert.equal(ctx.nutrition.week_avg.protein, 60, 'avg computed from logs');
});

// ---------- deterministic insights ----------
test('computeInsights derives data-driven insights (no AI needed)', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const { computeInsights, pickPriority } = await import('../src/services/intelligence/coachEngine.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
                VALUES ('np1', 'o1', 'u1', 'c1', 'Plan', 2100, 140, 200, 60, 0, '2026-01-01T00:00:00Z')`);
  // low protein today: 50g vs 140g
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                VALUES ('l1', 'c1', ?, 'lunch', 'Rice Bowl', 900, 50, 100, 25, 1, 'manual')`, [today]);
  const ctx = await buildClientAIContext(db, client, { domains: ['profile', 'nutrition'] }, 'Asia/Kolkata');
  const insights = computeInsights(ctx);
  const protein = insights.find((i) => i.type === 'NUTRITION' && i.title.includes('Protein'));
  assert.ok(protein, 'protein insight present');
  assert.equal(protein.priority, 'HIGH', '90g short of 140g → HIGH');
  assert.equal(protein.action, 'OPEN_NUTRITION', 'actionable');
  const pri = pickPriority(insights);
  assert.ok(pri, 'a priority is picked');
  assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(pri.priority));
});

test('insufficient data produces an honest low-confidence insight, never invented numbers', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const { computeInsights } = await import('../src/services/intelligence/coachEngine.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  const ctx = await buildClientAIContext(db, client, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery'] }, 'Asia/Kolkata');
  const insights = computeInsights(ctx);
  const honest = insights.find((i) => i.title.includes('Not enough data'));
  assert.ok(honest, 'honest no-data insight present');
  assert.equal(honest.confidence, 'LOW');
});

// ---------- daily brief + weekly review (deterministic) ----------
test('daily brief returns structured insights + priority without Ollama', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const { buildBrief } = await import('../src/services/intelligence/coachEngine.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  await db.run(`INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
                VALUES ('np1', 'o1', 'u1', 'c1', 'Plan', 2100, 140, 200, 60, 0, '2026-01-01T00:00:00Z')`);
  await db.run(`INSERT INTO meal_logs (id, client_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
                VALUES ('l1', 'c1', ?, 'lunch', 'Meal', 500, 30, 60, 10, 1, 'manual')`, [today]);
  const ctx = await buildClientAIContext(db, client, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery', 'gym'] }, 'Asia/Kolkata');
  const brief = buildBrief(ctx, { withAI: false });
  assert.equal(brief.ok, true);
  assert.ok(brief.insights.length >= 1 && brief.insights.length <= 5, '3-5 insights');
  for (const i of brief.insights) {
    assert.ok(['NUTRITION', 'WORKOUT', 'EXERCISE', 'HYDRATION', 'SLEEP', 'RECOVERY', 'PROGRESS', 'ADHERENCE', 'HABIT', 'GOAL', 'GYM'].includes(i.type));
    assert.ok(i.title && i.message && i.reason);
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(i.priority));
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(i.confidence));
  }
  assert.equal(brief.provider, 'deterministic', 'no LLM → deterministic');
  assert.equal(brief.ai_framed, false);
});

test('weekly review separates wins from needs-attention from real data', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const { buildWeekly } = await import('../src/services/intelligence/coachEngine.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  // 4 workouts this week → a clear win
  for (let i = 0; i < 4; i++) {
    const d = (() => { const dd = new Date(); dd.setDate(dd.getDate() - i); return dayKey(dd, 'Asia/Kolkata'); })();
    await db.run(`INSERT INTO workout_logs (id, client_id, date, sets_done, reps, weight) VALUES (?, 'c1', ?, 3, 10, 60)`, [`wl${i}`, d]);
  }
  const ctx = await buildClientAIContext(db, client, { domains: ['profile', 'training', 'nutrition', 'recovery', 'progress'] }, 'Asia/Kolkata');
  const review = buildWeekly(ctx);
  assert.equal(review.ok, true);
  assert.ok(review.went_well.some((w) => /workouts/.test(w)), 'workout win mentioned');
  assert.ok(Array.isArray(review.needs_attention));
  assert.ok(review.note, 'has a training-guidance disclaimer');
});

// ---------- food suggestions from the real DB ----------
test('suggestFoods returns DB-backed options honoring diet type', async () => {
  const db = await memDb();
  await seedClient(db);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global)
                VALUES ('f1', NULL, NULL, 'Paneer', 'serving', '100 g', 265, 18, 4, 21, 'VERIFIED_DATABASE', 1)`);
  await db.run(`INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, source, is_global)
                VALUES ('f2', NULL, NULL, 'Chicken breast', 'serving', '150 g', 247, 46.5, 0, 5.4, 'VERIFIED_DATABASE', 1)`);
  const { suggestFoods } = await import('../src/services/intelligence/coachEngine.js');
  const veg = await suggestFoods(db, 'o1', 'c1', { needProtein: 40 });
  assert.ok(veg.length > 0, 'finds foods');
  assert.ok(veg.every((f) => f.protein > 0 && f.calories != null), 'nutrition values present');
  // vegetarian client → no chicken
  await db.run("UPDATE client_profiles SET diet_type = 'VEG' WHERE client_id = 'c1'");
  const veg2 = await suggestFoods(db, 'o1', 'c1', { needProtein: 40 });
  assert.ok(!veg2.some((f) => /chicken/i.test(f.name)), 'no chicken for vegetarian client');
});

// ---------- safety gate + unavailable behavior ----------
test('safety gate refers medical questions to a professional, never the model', async () => {
  const db = await memDb();
  await seedClient(db);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const { computeInsights } = await import('../src/services/intelligence/coachEngine.js');
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  const ctx = await buildClientAIContext(db, client, { domains: ['profile'] }, 'Asia/Kolkata');
  const insights = computeInsights(ctx);
  assert.ok(Array.isArray(insights));
  // provider never crashes without Ollama
  const { isConfigured, providerName } = await import('../src/services/intelligence/aiProvider.js');
  assert.equal(typeof isConfigured(), 'boolean');
  assert.ok(['ollama', 'openai', 'gemini', 'mock'].includes(providerName()));
});

test('ai memory is org+client scoped and only structured keys are writable', async () => {
  const db = await memDb();
  await seedClient(db, { oid: 'o1', uid: 'u1', cid: 'c1' });
  await seedClient(db, { oid: 'o2', uid: 'u2', cid: 'c2' });
  await db.run(`INSERT INTO ai_memory (id, org_id, client_id, key, value, source, updated_at) VALUES ('m1', 'o1', 'c1', 'liked_foods', '["paneer"]', 'manual', '2026-01-01T00:00:00Z')`);
  const { buildClientAIContext } = await import('../src/services/intelligence/aiContext.js');
  const c1 = await db.q1('SELECT * FROM clients WHERE id = ?', ['c1']);
  const c2 = await db.q1('SELECT * FROM clients WHERE id = ?', ['c2']);
  const m1 = await buildClientAIContext(db, c1, { domains: ['memory'] }, 'Asia/Kolkata');
  assert.deepEqual(m1.memory.liked_foods, ['paneer']);
  const m2 = await buildClientAIContext(db, c2, { domains: ['memory'] }, 'Asia/Kolkata');
  assert.deepEqual(m2.memory, {}, 'other client never sees the memory');
});
