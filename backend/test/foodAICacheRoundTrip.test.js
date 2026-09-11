// ============================================================
// AI FOOD ESTIMATE CACHE — a cached estimate must be the SAME SHAPE as a
// fresh one.
//
// The cache is transparent by design: the second person to look up
// "chicken biryani" is served a stored row instead of a new AI call, and
// nothing in the UI or the recompute path is supposed to be able to tell.
// That only holds if every field on the fresh response survives the round
// trip. Two did not:
//
//   serving                    {description, estimated_weight_g}, e.g.
//                              "1 plate" / 400. The AI review screen
//                              labels its "how many did you eat" control
//                              with it, so a cached estimate left the
//                              control with nothing to name.
//
//   is_branded_or_restaurant   sent back to /ai-estimate/adjust, where it
//                              selects how a user's edit is recomputed.
//                              Cached rows always said false, so a
//                              restaurant dish silently recomputed down
//                              the home-cooked branch.
//
// Both are additive columns, so rows written before they existed still
// read back as null/false -- the same values callers already handled.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCachedEstimate, getCachedEstimate } from '../src/services/intelligence/foodAICache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, p = []) { const st = db.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const st = db.prepare(sql); const rows = p.length ? st.all(...p) : st.all(); return rows[0] || null; },
    async run(sql, p = []) { const st = db.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    raw: db,
  };
}

const payload = (over = {}) => ({
  nutrition: { calories: 845, protein: 32, carbs: 60.4, fat: 51.3 },
  uncertainty: { calories_low: 676, calories_high: 1056 },
  componentTemplate: [{ name: 'cooked basmati rice', estimated_weight_g: 240 }],
  assumptions: ['cooked in oil'],
  source: 'ai_estimated',
  aiProvider: 'ollama',
  aiModel: 'test-model',
  confidence: 'low',
  cuisine: 'INDIAN',
  serving: { description: '1 plate', estimated_weight_g: 400 },
  isBrandedOrRestaurant: false,
  ...over,
});

test('serving survives the cache round trip', async () => {
  const db = await memDb();
  await saveCachedEstimate(db, 'biryani_chicken', 'Chicken Biryani', payload());

  const cached = await getCachedEstimate(db, 'biryani_chicken');
  assert.deepEqual(cached.serving, { description: '1 plate', estimated_weight_g: 400 },
    'the serving the estimate describes comes back intact, not dropped');
});

test('is_branded_or_restaurant survives, and is a real boolean either way', async () => {
  const db = await memDb();
  await saveCachedEstimate(db, 'bbq_paneer', 'Paneer Tikka', payload({ isBrandedOrRestaurant: true }));
  await saveCachedEstimate(db, 'home_dal', 'Dal', payload({ isBrandedOrRestaurant: false }));

  const branded = await getCachedEstimate(db, 'bbq_paneer');
  const home = await getCachedEstimate(db, 'home_dal');

  // SQLite hands back 1/0 here; the caller passes this straight into the
  // recompute request, so it has to be a boolean, not a truthy integer.
  assert.equal(branded.is_branded_or_restaurant, true);
  assert.equal(home.is_branded_or_restaurant, false);
});

test('re-saving the same dish updates both fields rather than keeping the first values', async () => {
  const db = await memDb();
  await saveCachedEstimate(db, 'same_key', 'Dish', payload());
  // A later estimate of the same canonical key -- e.g. the dish is now
  // recognised as a restaurant item, with a heavier plate. The ON CONFLICT
  // branch has to carry these two across or the row keeps stale values
  // forever while every other field updates around them.
  await saveCachedEstimate(db, 'same_key', 'Dish', payload({
    serving: { description: '1 large plate', estimated_weight_g: 550 },
    isBrandedOrRestaurant: true,
  }));

  const cached = await getCachedEstimate(db, 'same_key');
  assert.equal(cached.serving.estimated_weight_g, 550);
  assert.equal(cached.serving.description, '1 large plate');
  assert.equal(cached.is_branded_or_restaurant, true);
});

test('a row written before these columns existed reads back as unknown, not as a zero-weight serving', async () => {
  const db = await memDb();
  await saveCachedEstimate(db, 'legacy', 'Legacy Dish', payload());
  // Simulate the pre-migration row: the columns exist but were never set.
  db.raw.prepare('UPDATE ai_food_estimates SET serving_json = NULL, is_branded_or_restaurant = 0 WHERE canonical_key = ?').run('legacy');

  const cached = await getCachedEstimate(db, 'legacy');
  assert.equal(cached.serving, null, 'null means "unknown" -- never {estimated_weight_g: 0}, which would scale everything to nothing');
  assert.equal(cached.is_branded_or_restaurant, false);
  // Everything that always worked still works -- this is additive.
  assert.equal(cached.nutrition.calories, 845);
  assert.equal(cached.component_template[0].estimated_weight_g, 240);
});
