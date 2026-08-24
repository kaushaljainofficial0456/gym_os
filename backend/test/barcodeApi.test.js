// ============================================================
// Integration tests for barcode scan -> nutrition lookup:
//   GET  /api/intel/foods/barcode/:code
//   POST /api/intel/foods/barcode/:code/manual
//
// Covers:
//   1.  valid barcode found locally (ml/ static snapshot)
//   2.  valid barcode found via the external API
//   3.  DB cache takes priority over the external API (and the external
//       API is never called when the cache already has it)
//   4.  external API failure -> 404, not a 500
//   5.  product genuinely not found anywhere -> 404
//   6.  invalid barcode -> 400
//   7.  duplicate barcode (manual save twice) -> no duplicate row
//   8.  serving-size / quantity scaling is correct
//   9.  manual product creation
//   10. cached product returned on second lookup (external API called once)
//   11. unauthorized request -> 401
//   12. the external API key is never present in any response body
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

// A real barcode from ml/data/processed/off_barcode_index.json, used to
// exercise the "found in the local snapshot" path without any network call.
const LOCAL_BARCODE = '10822926'; // "Skyr High Protein Plain Yoghurt", 100 kcal/100g basis, serving_grams: 100

// ---- in-memory SQLite helper (same pattern as nutrition-api.test.js) ----
async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  // schema.sql only carries foods' ORIGINAL columns + this feature's new
  // ones (barcode/ingredients_text/image_url); everything else barcodeLookup.js
  // reads/writes (source_id, cooking_state, serving_description,
  // serving_grams, calcium_mg, iron_mg) only exists via scripts/init-db.js's
  // guarded migrations, which this lightweight in-memory DB doesn't run.
  // Mirrors those exact column definitions (same pattern as
  // nutrition-api.test.js's memDb, extended for this feature).
  for (const ddl of [
    'source_id TEXT', 'cooking_state TEXT', 'serving_description TEXT',
    'serving_grams REAL', 'calcium_mg REAL', 'iron_mg REAL',
  ]) db.exec(`ALTER TABLE foods ADD COLUMN ${ddl}`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_barcode ON foods(barcode) WHERE barcode IS NOT NULL`);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await mk().q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    exec(sql) { db.exec(sql); },
    async tx(fn) {
      db.exec('BEGIN');
      try { const out = await fn(mk()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    raw: db
  });
  return mk();
}

async function seedFixtures(db) {
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', ['o1', 'Test Gym', 'test-gym', '2026-01-01T00:00:00Z']);
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
    ['u1', 'o1', 'client@test.com', 'x', 'Test Client', '2026-01-01T00:00:00Z']);
  await db.run('INSERT INTO clients (id, user_id, org_id, goal, created_at) VALUES (?, ?, ?, ?, ?)',
    ['c1', 'u1', 'o1', 'GENERAL', '2026-01-01T00:00:00Z']);
}

async function startBarcodeApi() {
  const db = await memDb();
  await seedFixtures(db);
  const intelligenceRoutes = (await import('../src/routes/intelligence.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/intel', intelligenceRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const token = jwt.sign({ sub: 'u1', role: 'CLIENT', org: 'o1', name: 'Test Client' }, config.jwtSecret, { expiresIn: '1h' });
  const call = async (method, p, body, extraHeaders = {}) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders };
    const res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

/** Mocks global fetch so only requests to config.foodDatabaseApiUrl are
 *  intercepted -- everything else (the test's own calls to the local
 *  Express server) goes through to the real fetch. Returns the mock's
 *  call-count array for assertions. */
function mockExternalApi(t, handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes(new URL(config.foodDatabaseApiUrl).host)) {
      return realFetch(url, opts);
    }
    calls.push(String(url));
    return handler(String(url), opts);
  });
  return calls;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('1. valid barcode found locally (static snapshot), no network call', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const calls = mockExternalApi(t, () => { throw new Error('external API must not be called for a local hit'); });

  const r = await call('GET', `/api/intel/foods/barcode/${LOCAL_BARCODE}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.food.food_name, 'Skyr High Protein Plain Yoghurt');
  assert.equal(r.json.tier, 'barcode');
  assert.equal(r.json.confidence, 'high');
  assert.equal(calls.length, 0);
});

test('2. valid barcode found via the external API', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776661';
  mockExternalApi(t, () => jsonResponse(200, {
    status: 1,
    product: {
      product_name: 'Test Protein Bar',
      brands: 'TestBrand',
      serving_size: '40 g',
      serving_quantity: 40,
      nutriments: {
        'energy-kcal_100g': 450, proteins_100g: 30, fat_100g: 15,
        carbohydrates_100g: 40, sugars_100g: 10, sodium_100g: 0.2,
      },
    },
  }));

  const r = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.food.food_name, 'Test Protein Bar');
  assert.equal(r.json.food.brand, 'TestBrand');
  assert.equal(r.json.food.source, 'OPEN_FOOD_FACTS');
  assert.equal(r.json.food.sodium_mg, 200); // 0.2g -> 200mg
});

test('3. DB cache takes priority over the external API', async (t) => {
  const { db, call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776662';
  await db.run(
    `INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, brand, source, is_global, barcode, serving_grams)
     VALUES ('food_cached', NULL, NULL, 'Cached Product', 'g', '50 g', 200, 10, 20, 8, 'CachedBrand', 'PACKAGING_LABEL', 1, ?, 50)`,
    [code]);
  const calls = mockExternalApi(t, () => { throw new Error('external API must not be called when the DB cache already has this barcode'); });

  const r = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.food.food_name, 'Cached Product');
  assert.equal(r.json.food.brand, 'CachedBrand');
  assert.equal(calls.length, 0);
});

test('4. external API failure -> 404, not a 500', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  mockExternalApi(t, () => { throw new Error('simulated network failure'); });

  const r = await call('GET', '/api/intel/foods/barcode/9998887776663');
  assert.equal(r.status, 404);
  assert.equal(r.json.fallback, 'manual_entry');
  assert.equal(r.json.reason, 'network_error');
});

test('5. product genuinely not found anywhere -> 404', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  mockExternalApi(t, () => jsonResponse(200, { status: 0 }));

  const r = await call('GET', '/api/intel/foods/barcode/9998887776664');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Barcode not recognised');
  assert.equal(r.json.reason, 'not_found');
  assert.equal(r.json.fallback, 'manual_entry');
});

test('6. invalid barcode -> 400', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  mockExternalApi(t, () => { throw new Error('external API must not be called for an invalid code'); });

  const r = await call('GET', '/api/intel/foods/barcode/abc');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Invalid barcode');
});

test('7. duplicate barcode: manual save twice does not create a second row', async (t) => {
  const { db, call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776665';
  const body = {
    name: 'Manual Product', brand: 'MyBrand', serving_grams: 30, serving_label: '1 bar (30g)',
    calories: 120, protein: 5, carbs: 15, fat: 4, fiber: 2, sugar: 6, sodium: 90,
  };

  const first = await call('POST', `/api/intel/foods/barcode/${code}/manual`, body);
  assert.equal(first.status, 201);
  const second = await call('POST', `/api/intel/foods/barcode/${code}/manual`, body);
  assert.equal(second.status, 201);
  assert.equal(second.json.food.food_name, first.json.food.food_name);

  const rows = await db.q('SELECT * FROM foods WHERE barcode = ?', [code]);
  assert.equal(rows.length, 1, 'a second manual save of the same barcode must not create a duplicate row');
});

test('8. serving-size / quantity scaling is correct', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  // Skyr: energy_kcal 95 / protein_g 11 per 100g, serving_grams 100.
  const r1 = await call('GET', `/api/intel/foods/barcode/${LOCAL_BARCODE}?servings=1`);
  assert.equal(r1.json.quantity.grams, 100);
  assert.equal(r1.json.totals.energy_kcal, 95);

  const r2 = await call('GET', `/api/intel/foods/barcode/${LOCAL_BARCODE}?servings=2.5`);
  assert.equal(r2.json.quantity.grams, 250);
  assert.equal(r2.json.totals.energy_kcal, 237.5);
  assert.equal(r2.json.totals.protein_g, 27.5);
});

test('9. manual product creation returns a ready-to-confirm envelope', async (t) => {
  const { db, call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776666';
  const r = await call('POST', `/api/intel/foods/barcode/${code}/manual`, {
    name: 'Haldiram Bhujia (test)', brand: "Haldiram's", serving_grams: 100,
    calories: 540, protein: 16, carbs: 45, fat: 35, fiber: 4, sugar: 3, sodium: 800,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.food.food_name, 'Haldiram Bhujia (test)');
  assert.equal(r.json.food.brand, "Haldiram's");
  assert.equal(r.json.totals.energy_kcal, 540);
  assert.equal(r.json.food.serving_grams, 100);

  const row = await db.q1('SELECT * FROM foods WHERE barcode = ?', [code]);
  assert.ok(row, 'manually-added product must be persisted');
  assert.equal(row.source, 'PACKAGING_LABEL');
  assert.equal(row.is_global, 1);
});

test('10. cached product returned on second lookup -- external API called exactly once', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776667';
  const calls = mockExternalApi(t, () => jsonResponse(200, {
    status: 1,
    product: {
      product_name: 'Repeat Scan Product', brands: 'RepeatBrand',
      serving_quantity: 25,
      nutriments: { 'energy-kcal_100g': 300, proteins_100g: 8, fat_100g: 10, carbohydrates_100g: 35 },
    },
  }));

  const r1 = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r1.status, 200);
  assert.equal(calls.length, 1);

  const r2 = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.food.food_name, 'Repeat Scan Product');
  assert.equal(calls.length, 1, 'the external API must not be called again once the result is cached');
});

test('11. unauthorized request -> 401', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const r = await call('GET', `/api/intel/foods/barcode/${LOCAL_BARCODE}`, undefined, { Authorization: '' });
  assert.equal(r.status, 401);
});

test('13. product found (has a name) but no nutrition data -> treated as not found, never cached, never logs a silent zero', async (t) => {
  const { db, call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776669';
  const calls = mockExternalApi(t, () => jsonResponse(200, {
    status: 1,
    product: {
      // Real-world case: someone added the product (name + maybe a photo)
      // but never filled in the nutrition facts panel.
      product_name: 'Mystery Snack With No Nutrition Panel',
      brands: 'SomeBrand',
      nutriments: {}, // no energy-kcal_100g at all
    },
  }));

  const r = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r.status, 404, 'a product with no verified energy value must not be presented as a found product');
  assert.equal(r.json.reason, 'incomplete_data');
  assert.equal(r.json.fallback, 'manual_entry');
  assert.equal(calls.length, 1, 'the external API should still have been tried exactly once');

  const cached = await db.q1('SELECT * FROM foods WHERE barcode = ?', [code]);
  assert.equal(cached, null, 'an incomplete product must never be written to the cache');
});

test('14. a manually-saved product is never mislabeled as Open Food Facts data', async (t) => {
  const { call, close } = await startBarcodeApi();
  t.after(() => close());
  resetRateLimits();
  const code = '9998887776670';
  const r = await call('POST', `/api/intel/foods/barcode/${code}/manual`, {
    name: 'Provenance Check Snack', serving_grams: 50,
    calories: 100, protein: 5, carbs: 10, fat: 3,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.food.source, 'PACKAGING_LABEL', 'a user-typed product must not claim OPEN_FOOD_FACTS provenance');
  assert.equal(r.json.food.source_id, null, 'a manual save must not carry a fabricated off: source id');

  // A subsequent lookup (served from the DB cache) must report the same,
  // correct provenance -- not just the save response.
  const r2 = await call('GET', `/api/intel/foods/barcode/${code}`);
  assert.equal(r2.json.food.source, 'PACKAGING_LABEL');
  assert.equal(r2.json.food.source_id, null);
});

test('12. the external API key is never present in any response body', async (t) => {
  const originalKey = config.foodDatabaseApiKey;
  config.foodDatabaseApiKey = 'super-secret-test-key-should-never-leak';
  const { call, close } = await startBarcodeApi();
  t.after(() => { close(); config.foodDatabaseApiKey = originalKey; });
  resetRateLimits();
  mockExternalApi(t, (url, opts) => {
    // The key must travel as an outbound header, never in the URL/query.
    assert.ok(!url.includes('super-secret-test-key'));
    assert.equal(opts.headers.Authorization, 'Bearer super-secret-test-key-should-never-leak');
    return jsonResponse(200, {
      status: 1,
      product: { product_name: 'Key Leak Check', nutriments: { 'energy-kcal_100g': 100 } },
    });
  });

  const r = await call('GET', '/api/intel/foods/barcode/9998887776668');
  const raw = JSON.stringify(r.json);
  assert.ok(!raw.includes('super-secret-test-key'), 'API key must never appear in the response body');
});
