// ============================================================
// DIET AND FOODS TO AVOID (services/nutrition/personalization.js) and the
// profile fields behind them (PUT /me/profile). Phase 2.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import express from 'express';
import { config } from '../src/config.js';
import { resetRateLimits } from '../src/rateLimit.js';
import { describeMeal, modelAvailable } from '../src/services/foodEstimator.js';
import { applyDietAndExclusions, avoidTerms } from '../src/services/nutrition/personalization.js';

const live = modelAvailable();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';
const first = (text, profile) => applyDietAndExclusions(describeMeal(text), profile).items;

test('the avoid list understands categories and Indian names', () => {
  const t = avoidTerms('Peanuts, dairy ,  , gluten');
  assert.deepEqual(t.map((x) => x.listed), ['peanuts', 'dairy', 'gluten']);
  assert.ok(t[0].words.includes('groundnut'));
  assert.ok(t[1].words.includes('paneer') && t[1].words.includes('ghee'));
  assert.ok(t[2].words.includes('atta') && t[2].words.includes('roti'));
});

test('a vegetarian\'s "biryani" is veg biryani; a named "chicken biryani" is never changed', { skip: !live }, () => {
  const [veg] = first('1 plate biryani', { dietType: 'VEG' });
  assert.equal(veg.staple_key, 'veg_biryani');
  assert.equal(veg.qty, 1, 'the amount said is kept');
  assert.equal(veg.alternatives[0].staple_key, 'chicken_biryani', 'one tap back');
  assert.match(veg.personalized.at(-1).note, /diet/);
  assert.equal(first('chicken biryani', { dietType: 'VEG' })[0].staple_key, 'chicken_biryani');
  assert.equal(first('1 plate biryani', { dietType: 'NON_VEG' })[0].staple_key, 'chicken_biryani');
  assert.equal(first('1 plate biryani', {})[0].staple_key, 'chicken_biryani', 'no diet set: no change');
});

test('a food on the avoid list is flagged, never removed or changed', { skip: !live }, () => {
  const items = first('poha with peanuts', { exclusions: 'peanuts' });
  const pea = items.find((i) => i.staple_key === 'peanuts');
  assert.deepEqual(pea.avoid.terms, ['peanuts']);
  assert.equal(items.length, 2, 'still logged as eaten');
  // A computed recipe is checked by its INGREDIENTS (kadhi is curd + besan).
  assert.deepEqual(first('1 bowl kadhi', { exclusions: 'dairy' })[0].avoid.terms, ['dairy']);
  // A database dish is flagged by name with a caveat; one with no match is
  // marked unchecked rather than declared safe.
  const roti = first('2 roti', { exclusions: 'gluten' })[0];
  assert.match(roti.avoid.note, /not known/);
  const rajma = first('1 katori rajma', { exclusions: 'peanuts' })[0];
  assert.equal(rajma.avoid, undefined);
  assert.equal(rajma.avoid_unchecked, true);
  // A fully known food with no match is simply clean.
  const egg = first('2 boiled eggs', { exclusions: 'peanuts' })[0];
  assert.equal(egg.avoid, undefined);
  assert.notEqual(egg.avoid_unchecked, true);
});

async function startApp() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  const api = (h) => ({
    driver: 'sqlite',
    async q(sql, p = []) { const s = h.prepare(sql); return p.length ? s.all(...p) : s.all(); },
    async q1(sql, p = []) { const s = h.prepare(sql); return (p.length ? s.all(...p) : s.all())[0] || null; },
    async run(sql, p = []) { const s = h.prepare(sql); const r = p.length ? s.run(...p) : s.run(); return { changes: Number(r.changes) }; },
    exec(sql) { h.exec(sql); },
  });
  const db = api(sdb);
  db.tx = async (fn) => { sdb.exec('BEGIN'); try { const o = await fn(api(sdb)); sdb.exec('COMMIT'); return o; } catch (e) { sdb.exec('ROLLBACK'); throw e; } };
  await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)', ['o1', 'Gym', 'gym-o1', TZ, '2026-01-01T00:00:00Z']);
  for (const [u, c] of [['u1', 'c1'], ['u2', 'c2']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?, 'CLIENT', ?, 1, ?)`, [u, 'o1', `${u}@t.com`, 'x', u, '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at, current_weight, height_cm, age, sex) VALUES (?,?,?,?,?,?,?,?,?)', [c, u, 'o1', 'GENERAL', '2026-01-01T00:00:00Z', 70, 175, 30, 'MALE']);
    await db.run('INSERT INTO client_profiles (client_id, day_start_hour, experience) VALUES (?, 0, ?)', [c, 'BEGINNER']);
  }
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tz = TZ; next(); });
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tok = { u1: jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1' }, config.jwtSecret), u2: jwt.sign({ sub: 'u2', role: 'CLIENT', org: 'o1' }, config.jwtSecret) };
  const call = async (u, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[u]}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { db, call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test.beforeEach(() => resetRateLimits());

test('profile: activity level, diet and foods to avoid are validated, stored, and used — for that person only', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  assert.equal((await call('u1', 'PUT', '/api/me/profile', { activity_level: 'LAZY' })).status, 400);
  assert.equal((await call('u1', 'PUT', '/api/me/profile', { diet_type: 'CARNIVORE' })).status, 400);
  assert.equal((await call('u1', 'PUT', '/api/me/profile', { food_exclusions: 'x'.repeat(301) })).status, 400);
  const before = (await call('u1', 'GET', '/api/me/nutrition/targets')).json;
  assert.equal(before.meta.activitySource, 'experience');
  const ok = await call('u1', 'PUT', '/api/me/profile', { activity_level: 'sedentary', diet_type: 'veg', food_exclusions: ' peanuts ,, dairy ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = await db.q1("SELECT activity_level, diet_type, food_exclusions FROM client_profiles WHERE client_id = 'c1'");
  assert.deepEqual({ ...row }, { activity_level: 'SEDENTARY', diet_type: 'VEG', food_exclusions: 'peanuts, dairy' });
  const after = (await call('u1', 'GET', '/api/me/nutrition/targets')).json;
  assert.equal(after.meta.activityMultiplier, 1.2);
  assert.ok(after.targets.calories < before.targets.calories);
  const d1 = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'biryani and raita' })).json.items;
  assert.equal(d1[0].staple_key, 'veg_biryani');
  assert.deepEqual(d1[1].avoid.terms, ['dairy']);
  // Someone else in the same gym: none of it.
  const d2 = (await call('u2', 'POST', '/api/me/nutrition/describe', { text: 'biryani and raita' })).json.items;
  assert.equal(d2[0].staple_key, 'chicken_biryani');
  assert.equal(d2[1].avoid, undefined);
  // Cleared: back to defaults.
  await call('u1', 'PUT', '/api/me/profile', { activity_level: null, diet_type: '', food_exclusions: '' });
  const cleared = await db.q1("SELECT activity_level, diet_type, food_exclusions FROM client_profiles WHERE client_id = 'c1'");
  assert.deepEqual({ ...cleared }, { activity_level: null, diet_type: null, food_exclusions: null });
});
