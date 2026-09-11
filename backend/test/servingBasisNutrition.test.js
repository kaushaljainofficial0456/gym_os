// ============================================================
// SERVING-BASIS FOODS — a food whose nutrition is stated per BOWL, per
// PIECE or per SLICE rather than per 100 g.
//
// This app stores a food's nutrition against a `serving` STRING, and
// everything downstream scales by the number that string starts with:
// "100 g" x2 is 200 g, "1 bowl" x2 is 2 bowls. That works for any unit --
// as long as nothing in the chain re-reads the field with Number(), which
// yields NaN for "1 bowl" and then quietly falls back to a 100 g basis.
// A 2 that means "two bowls" becomes 2/100 of one, and the log lands at
// ~2% of the real food.
//
// The rule these tests defend (spec Part 13): DO NOT convert a serving
// food into grams unless a verified gram equivalent exists. Inventing one
// ("a bowl is probably 250 g") bakes a fabricated number into the food's
// stored definition and into every future log of it, where nothing
// afterwards can tell it from a measured value.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
  });
  return mk();
}

const ts = '2026-01-01T00:00:00Z';

async function seed(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?,?,?,?,'CLIENT',?,1,?)`,
    ['u1', 'o1', 'c@a.in', 'x', 'Client', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, age, sex, height_cm, current_weight, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['c1', 'u1', 'o1', 'GENERAL', 30, 'M', 175, 78, ts]);
}

async function startApi(db) {
  const meRoutes = (await import('../src/routes/me.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/me', meRoutes(db));
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Client' }, config.jwtSecret, { expiresIn: '1h' });
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('a countable-serving food is stored as typed, never converted to a guessed per-100g basis', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  // The spec's own worked example: a burrito bowl described per bowl.
  const r = await api.call('POST', '/me/foods', {
    name: 'Chicken Burrito Bowl', serving: '1 bowl', unit: 'bowl',
    calories: 522, protein: 35, carbs: 55, fat: 18,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const food = await db.q1('SELECT * FROM foods WHERE id = ?', [r.json.id]);
  assert.equal(food.serving, '1 bowl', 'the basis is kept in the unit the user actually used');
  assert.equal(food.unit, 'bowl');
  // Per-100g conversion here would have required inventing a bowl weight.
  // The macros must be exactly what was typed, for exactly one bowl.
  assert.equal(food.protein, 35);
  assert.equal(food.carbs, 55);
  assert.equal(food.fat, 18);
  assert.equal(food.calories, 522, 'protein*4 + carbs*4 + fat*9 -- the app\'s one calorie formula');
});

test('macro grams are NOT required to fit inside the serving weight', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  // 35 + 55 + 18 = 108 g of macros in "1 bowl". Any validation that
  // compares macro grams against a 100-unit basis rejects this, and would
  // reject most real countable servings. See foodValidation.js's own note
  // on why that check was removed and must not return.
  const r = await api.call('POST', '/me/foods', {
    name: 'Dense Bowl', serving: '1 bowl', unit: 'bowl',
    calories: 522, protein: 35, carbs: 55, fat: 18,
  });
  assert.equal(r.status, 200, 'a countable serving is not rejected for "impossible" macro totals');
});

test('a serving-basis food scales by COUNT, the way a gram food scales by weight', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  await api.call('POST', '/me/foods', {
    name: 'Burrito Bowl', serving: '1 bowl', unit: 'bowl',
    calories: 522, protein: 35, carbs: 55, fat: 18,
  });
  const food = await db.q1('SELECT * FROM foods WHERE name = ?', ['Burrito Bowl']);

  // The scaling the client performs, stated here as the contract it must
  // meet -- 1.5 bowls of a per-bowl food, the spec's acceptance case.
  const baseAmount = Number(String(food.serving).match(/^([\d.]+)/)[1]);
  assert.equal(baseAmount, 1, 'the leading number of `serving` is the basis, whatever the unit');

  const eaten = 1.5;
  const factor = eaten / baseAmount;
  assert.equal(food.protein * factor, 52.5);
  assert.equal(food.carbs * factor, 82.5);
  assert.equal(food.fat * factor, 27);

  // The failure mode this guards: reading the basis with Number("1 bowl")
  // gives NaN, and the fallback basis everywhere in this app is 100.
  assert.ok(Number.isNaN(Number(food.serving)), 'Number() on a unit-bearing serving is NaN -- never use it to read the basis');
  const wrongFactor = eaten / (Number(food.serving) || 100);
  assert.ok(food.protein * wrongFactor < 1, 'the 100g fallback logs ~2% of the real food -- silently');
});

test('editing a serving-basis food rescales it and keeps its unit', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  const created = await api.call('POST', '/me/foods', {
    name: 'Protein Shake', serving: '1 scoop', unit: 'scoop',
    calories: 120, protein: 24, carbs: 3, fat: 1.5,
  });

  // "Actually I always have two scoops" -- the saved template becomes two
  // scoops' worth, and stays expressed in scoops.
  const r = await api.call('PUT', `/me/foods/${created.json.id}`, {
    serving: '2 scoop', calories: 240, protein: 48, carbs: 6, fat: 3,
  });
  assert.equal(r.status, 200);

  const food = await db.q1('SELECT * FROM foods WHERE id = ?', [created.json.id]);
  assert.equal(food.serving, '2 scoop');
  assert.equal(food.protein, 48);
  assert.equal(food.unit, 'scoop', 'the unit is untouched by a quantity edit');
});

test('a gram-basis food still behaves exactly as before', async (t) => {
  const db = await memDb();
  await seed(db);
  const api = await startApi(db);
  t.after(() => api.close());

  // The regression guard for everything that existed before serving units:
  // weighed foods are still stored per 100 g and still scale by weight.
  const r = await api.call('POST', '/me/foods', {
    name: 'Rolled Oats', serving: '100 g', unit: 'g',
    calories: 389, protein: 16.9, carbs: 66.3, fat: 6.9,
  });
  const food = await db.q1('SELECT * FROM foods WHERE id = ?', [r.json.id]);
  assert.equal(food.serving, '100 g');

  const baseAmount = Number(String(food.serving).match(/^([\d.]+)/)[1]);
  assert.equal(baseAmount, 100);
  const factor = 40 / baseAmount; // a 40 g portion
  assert.equal(Math.round(food.protein * factor * 10) / 10, 6.8);
});
