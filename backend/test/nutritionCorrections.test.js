// ============================================================
// USER CORRECTIONS (services/nutrition/corrections.js) — Phase 2 / F9.
//
//   - a swap or an assumed-amount change on the plate is recorded with the
//     original and corrected values, who, when, source, confidence, status
//   - a person's REPEATED correction becomes THEIR default; nobody else's
//   - switching back ends the default
//   - a stated amount changed later is not a "correction"
//   - a quantity edit is recorded (audit) and never learned from
//   - a shared mapping needs >= 3 different people AND an operator's
//     approval; it can be revoked
// Rows are read back from the database, never trusted from the response.
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
import { modelAvailable } from '../src/services/foodEstimator.js';
import {
  detectCorrections, phraseOf, correctionCandidates, approveMapping, revokeMapping, MIN_DISTINCT_CLIENTS,
} from '../src/services/nutrition/corrections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const TZ = 'Asia/Kolkata';
const PEOPLE = [['o1', 'u1', 'c1'], ['o2', 'u2', 'c2'], ['o1', 'u3', 'c3'], ['o3', 'u4', 'c4'], ['o3', 'u5', 'c5']];

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec(schema);
  for (const ddl of ['ai_provider TEXT', 'ai_model TEXT', 'ai_confidence TEXT']) sdb.exec(`ALTER TABLE meal_logs ADD COLUMN ${ddl}`);
  const api = (handle) => ({
    driver: 'sqlite',
    async q(sql, params = []) { const s = handle.prepare(sql); return params.length ? s.all(...params) : s.all(); },
    async q1(sql, params = []) { const s = handle.prepare(sql); return (params.length ? s.all(...params) : s.all())[0] || null; },
    async run(sql, params = []) { const s = handle.prepare(sql); const r = params.length ? s.run(...params) : s.run(); return { changes: Number(r.changes) }; },
    exec(sql) { handle.exec(sql); },
    raw: handle,
  });
  const db = api(sdb);
  db.tx = async (fn) => {
    sdb.exec('BEGIN');
    try { const out = await fn(api(sdb)); sdb.exec('COMMIT'); return out; }
    catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* rolled back */ } throw e; }
  };
  for (const o of ['o1', 'o2', 'o3']) {
    await db.run('INSERT INTO organizations (id, name, slug, timezone, created_at) VALUES (?,?,?,?,?)', [o, `Gym ${o}`, `gym-${o}`, TZ, '2026-01-01T00:00:00Z']);
  }
  for (const [o, u, c] of PEOPLE) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?, 'CLIENT', ?, 1, ?)`,
      [u, o, `${u}@test.com`, 'x', `Client ${u}`, '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?,?,?,?,?)', [c, u, o, 'GENERAL', '2026-01-01T00:00:00Z']);
    await db.run('INSERT INTO client_profiles (client_id, day_start_hour) VALUES (?, 0)', [c]);
  }
  return db;
}

async function startApp() {
  const db = await memDb();
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tz = TZ; next(); });
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tokens = Object.fromEntries(PEOPLE.map(([o, u]) => [u, jwt.sign({ sub: u, role: 'CLIENT', org: o, name: u }, config.jwtSecret, { expiresIn: '1h' })]));
  const call = async (u, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[u]}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test.beforeEach(() => { resetRateLimits(); });
const live = modelAvailable();

/** What the plate sends for an item: the shown snapshot as `proposed`. */
const snapshot = (it) => ({
  source_id: it.source_id, staple_key: it.staple_key ?? null, name: it.name, grams: it.grams, qty: it.qty,
  unit: (it.units || []).find((u) => u.key === it.unit_key)?.label ?? null, calories: it.calories,
  confidence: it.confidence ?? null, assumed: !!it.assumed, matched_from: it.matched_from ?? null,
});
const logItem = (it, extra = {}) => ({
  name: it.name, calories: it.calories, protein: it.protein ?? 0, carbs: it.carbs ?? 0, fat: it.fat ?? 0,
  quantity: it.qty, unit: (it.units || []).find((u) => u.key === it.unit_key)?.label || 'serving', source: 'manual',
  source_id: it.source_id, grams: it.grams, ...(it.staple_key ? { staple_key: it.staple_key } : {}), ...extra,
});

/** Describe `text`, swap its first item to the dal makhani alternative, log it. */
async function swapDalToMakhani(call, u) {
  const d = await call(u, 'POST', '/api/me/nutrition/describe', { text: 'dal' });
  const shown = d.json.items[0];
  // The person picks dal makhani instead (from the alternatives or search).
  const makhani = (await call(u, 'POST', '/api/me/nutrition/describe', { text: 'dal makhani' })).json.items[0];
  assert.equal(makhani.staple_key, 'dal_makhani');
  const item = (await call(u, 'POST', '/api/me/nutrition/item', { source_id: makhani.source_id, staple_key: 'dal_makhani' })).json.item;
  const r = await call(u, 'POST', '/api/me/nutrition/log-batch', { slot: 'lunch', items: [logItem(item, { proposed: snapshot(shown) })] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { shown, item };
}

/* ---------------- pure rules ---------------- */

test('the phrase is the food words that were typed', () => {
  assert.equal(phraseOf('2 katori dal'), 'dal');
  assert.equal(phraseOf('with peanuts'), 'peanuts');
  assert.equal(phraseOf(''), null);
});

test('a swap, or an assumed amount changed by 10%+, is a correction; a stated amount changed is not', () => {
  const proposed = { source_id: 'recipe:dal_home', name: 'Dal', grams: 150, qty: 1, unit: 'katori', calories: 131, assumed: true, matched_from: 'dal', confidence: 'medium' };
  const swap = detectCorrections({ name: 'Dal makhani', source_id: 'indb:X', proposed }, { grams: 150, calories: 200 });
  assert.equal(swap[0].kind, 'food_swap');
  assert.equal(swap[0].phrase, 'dal');
  assert.equal(swap[0].original.source_id, 'recipe:dal_home');
  assert.equal(swap[0].corrected.source_id, 'indb:X');
  assert.equal(swap[0].confidence, 'medium');
  assert.equal(detectCorrections({ name: 'Dal', source_id: 'recipe:dal_home', proposed }, { grams: 300 })[0].kind, 'amount');
  assert.deepEqual(detectCorrections({ name: 'Dal', source_id: 'recipe:dal_home', proposed }, { grams: 155 }), [], 'under 10%: noise');
  assert.deepEqual(detectCorrections({ name: 'Dal', source_id: 'recipe:dal_home', proposed: { ...proposed, assumed: false } }, { grams: 300 }), [],
    'the person said "1 katori" and then ate 2: not a correction of the engine');
  assert.deepEqual(detectCorrections({ name: 'Dal', source_id: 'recipe:dal_home' }, { grams: 300 }), []);
});

/* ---------------- recorded, personal, isolated ---------------- */

test('a plate swap is recorded with original, corrected, who, when, source, confidence and status', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const { shown, item } = await swapDalToMakhani(call, 'u1');
  const rows = await db.q("SELECT * FROM nutrition_corrections WHERE client_id = 'c1'");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.org_id, 'o1');
  assert.equal(r.user_id, 'u1');
  assert.equal(r.kind, 'food_swap');
  assert.equal(r.phrase, 'dal');
  assert.equal(r.source, 'plate');
  assert.equal(r.scope, 'personal');
  assert.equal(r.review_status, 'unreviewed');
  assert.equal(r.confidence, shown.confidence);
  assert.ok(r.meal_log_id && r.created_at);
  assert.equal(JSON.parse(r.original_json).source_id, shown.source_id);
  assert.equal(JSON.parse(r.corrected_json).source_id, item.source_id);
});

test('a repeated swap becomes that person\'s default — and only theirs', { skip: !live }, async (t) => {
  const { call, close } = await startApp(); t.after(close);
  await swapDalToMakhani(call, 'u1');
  // Once is not a habit.
  let mine = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
  assert.equal(mine.staple_key, 'dal');
  await swapDalToMakhani(call, 'u1');
  mine = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: '1 katori dal' })).json.items[0];
  assert.equal(mine.staple_key, 'dal_makhani', 'twice is their default');
  assert.equal(mine.personalized[0].scope, 'personal');
  assert.match(mine.personalized[0].note, /usually log/);
  assert.equal(mine.alternatives[0].staple_key, 'dal', 'the standard answer is one tap away');
  assert.equal(mine.qty, 1, 'the amount said is kept');
  // Another person -- same gym and a different gym -- is untouched.
  for (const u of ['u3', 'u2']) {
    const theirs = (await call(u, 'POST', '/api/me/nutrition/describe', { text: '1 katori dal' })).json.items[0];
    assert.equal(theirs.staple_key, 'dal', `${u} must not see u1's preference`);
    assert.ok(!theirs.personalized?.length);
  }
});

test('switching back to the standard food ends the default', { skip: !live }, async (t) => {
  const { call, close } = await startApp(); t.after(close);
  await swapDalToMakhani(call, 'u1');
  await swapDalToMakhani(call, 'u1');
  const shown = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
  assert.equal(shown.staple_key, 'dal_makhani');
  const back = (await call('u1', 'POST', '/api/me/nutrition/item', { source_id: shown.alternatives[0].source_id, staple_key: 'dal' })).json.item;
  await call('u1', 'POST', '/api/me/nutrition/log-batch', { slot: 'dinner', items: [logItem(back, { proposed: snapshot(shown) })] });
  const now = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
  assert.equal(now.staple_key, 'dal');
});

test('an assumed amount the person keeps changing becomes their usual amount', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  for (let i = 0; i < 2; i++) {
    const shown = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
    assert.equal(shown.assumed, true);
    const twice = { ...shown, qty: 2, grams: shown.grams * 2, calories: shown.calories * 2 };
    await call('u1', 'POST', '/api/me/nutrition/log-batch', { slot: 'lunch', items: [logItem(twice, { proposed: snapshot(shown) })] });
  }
  const kinds = (await db.q("SELECT kind FROM nutrition_corrections WHERE client_id = 'c1'")).map((r) => r.kind);
  assert.deepEqual(kinds, ['amount', 'amount']);
  const mine = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
  assert.equal(mine.qty, 2);
  assert.equal(mine.assumed, false);
  assert.ok(mine.personalized.some((p) => p.kind === 'amount'));
  // A stated amount is always what was said.
  assert.equal((await call('u1', 'POST', '/api/me/nutrition/describe', { text: '1 katori dal' })).json.items[0].qty, 1);
  // Someone else still gets the standard katori.
  assert.equal((await call('u2', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0].qty, 1);
});

test('a quantity edit is recorded as a correction and is not learned from', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  const shown = (await call('u1', 'POST', '/api/me/nutrition/describe', { text: '1 katori dal' })).json.items[0];
  const r = await call('u1', 'POST', '/api/me/nutrition/log-batch', { slot: 'lunch', items: [logItem(shown, { proposed: snapshot(shown) })] });
  const logId = r.json.ids[0];
  assert.equal((await db.q("SELECT * FROM nutrition_corrections WHERE client_id = 'c1'")).length, 0, 'accepted as shown: nothing to record');
  const e = await call('u1', 'PUT', `/api/me/meal-logs/${logId}`, { quantity: 3, unit: 'katori' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  await new Promise((res) => setTimeout(res, 20));   // recorded best-effort after the response
  const rows = await db.q("SELECT * FROM nutrition_corrections WHERE client_id = 'c1'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'quantity_edit');
  assert.equal(rows[0].source, 'meal_log_edit');
  assert.equal(rows[0].meal_log_id, logId);
  assert.equal(JSON.parse(rows[0].original_json).qty, 1);
  assert.equal(JSON.parse(rows[0].corrected_json).qty, 3);
  assert.equal((await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0].qty, 1);
});

/* ---------------- shared mappings: >= 3 people AND an operator ---------------- */

test('a shared mapping needs three different people and an approval, and can be revoked', { skip: !live }, async (t) => {
  const { db, call, close } = await startApp(); t.after(close);
  assert.equal(MIN_DISTINCT_CLIENTS, 3);
  // One person repeating a swap many times is still one person.
  for (let i = 0; i < 4; i++) await swapDalToMakhani(call, 'u1');
  await swapDalToMakhani(call, 'u2');
  assert.equal((await correctionCandidates(db)).length, 0, 'two people are not enough');
  await swapDalToMakhani(call, 'u3');
  const [cand] = await correctionCandidates(db);
  assert.equal(cand.phrase, 'dal');
  assert.equal(cand.distinct_clients, 3);
  assert.equal(cand.approved, false);
  assert.ok(!('clients' in cand) && !JSON.stringify(cand).includes('c1'), 'counts only, never who');
  // Not applied to anyone else until approved.
  assert.equal((await call('u4', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0].staple_key, 'dal');
  const ok = await approveMapping(db, { phrase: 'dal', sourceId: cand.source_id, reviewerId: 'admin1' });
  assert.equal(ok.ok, true);
  const global = (await call('u4', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0];
  assert.equal(global.source_id, cand.source_id);
  assert.equal(global.personalized[0].scope, 'global');
  assert.match(global.personalized[0].note, /reviewed/);
  const row = await db.q1("SELECT * FROM food_correction_approvals WHERE phrase = 'dal' AND status = 'approved'");
  assert.equal(row.approved_by, 'admin1');
  assert.equal(row.distinct_clients, 3);
  // An unsupported mapping cannot be approved.
  assert.equal((await approveMapping(db, { phrase: 'roti', sourceId: 'indb:ASC096', reviewerId: 'admin1' })).ok, false);
  // Revoked: back to the standard answer for everyone without a habit of their own.
  assert.equal((await revokeMapping(db, { phrase: 'dal', reviewerId: 'admin1' })).ok, true);
  assert.equal((await call('u4', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0].staple_key, 'dal');
  // ...while u1's own repeated habit is still theirs.
  assert.equal((await call('u1', 'POST', '/api/me/nutrition/describe', { text: 'dal' })).json.items[0].staple_key, 'dal_makhani');
});
