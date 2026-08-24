// ============================================================
// BARCODE LOOKUP — local cache -> local snapshot -> live external API.
//
// Three sources, checked in this order, matching CONTRACT_skos-food-v1.md
// §3.6 ("Local database/cache should always be checked BEFORE external
// APIs"):
//
//   1. `foods` table cache (foods.barcode, is_global=1) — every product a
//      previous scan already resolved (from either source below), plus
//      anything a user saved through "Add product manually". Checked first
//      because it is the freshest and cheapest: no network call, and it
//      grows every time step 3 finds something new.
//   2. ml/data/processed/off_barcode_index.json — the pre-baked local
//      snapshot the app already ships (see foodEstimator.js). Still "local"
//      in the sense that matters here: no network call.
//   3. A live external API (config.foodDatabaseApiUrl, default: Open Food
//      Facts' public v2 API — free, keyless). Only reached when neither
//      local source has the code. A hit here is normalized into the SAME
//      record shape as step 2 and written into the `foods` cache (step 1)
//      so the next scan of this barcode never needs the network again.
//
// All three sources feed the SAME resolveServing() (re-exported from
// foodEstimator.js, which itself re-exports the skos-food-v1 reference
// module) so grams/macro scaling is identical regardless of where the
// product data came from — see CONTRACT §3.6.
// ============================================================
import { id } from '../ids.js';
import { config } from '../config.js';
import { getBarcodeIndex, cleanCode, canonicalEan13, resolveServing } from './foodEstimator.js';

const EXTERNAL_TIMEOUT_MS = 5000;

// Open Food Facts asks integrations to identify themselves with a real
// app name/version and a way to reach the maintainer -- a generic or
// missing User-Agent is exactly what gets throttled hardest under load.
const USER_AGENT = 'SK-OS-Nutrition/1.0 (+https://github.com/kaushaljainofficial0456/gym_os)';

/**
 * Maps a `resolveBarcodeProduct`/`fetchFromExternalApi` failure `reason`
 * to the HTTP status the route should return. Centralized here so the
 * route is a thin translation of it, and so every failure mode has an
 * explicit, deliberate status instead of everything collapsing onto 404
 * or an uncaught exception becoming an unhandled 500:
 *   400 - the scanned/typed code itself isn't a plausible barcode
 *   404 - genuinely not found anywhere (or found with no usable nutrition
 *         data, which the frontend must treat identically -- see
 *         normalizeExternalProduct)
 *   429 - Open Food Facts itself rate-limited this request
 *   503 - the external lookup is unavailable right now (timeout, network
 *         error, a non-2xx/non-429/non-404 response, or an unparseable
 *         body) -- distinct from 404 because the product may well exist;
 *         retrying shortly is the right move, not "add manually"
 */
export const REASON_STATUS = {
  invalid_barcode: 400,
  not_found: 404,
  incomplete_data: 404,
  rate_limited: 429,
  timeout: 503,
  network_error: 503,
  bad_response: 503,
  not_configured: 503,
  service_unavailable: 503,
};
export function statusForReason(reason) {
  return REASON_STATUS[reason] || 404;
}

function toMg(gramsValue) {
  const n = Number(gramsValue);
  return Number.isFinite(n) ? Math.round(n * 1000 * 100) / 100 : null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A record is only presentable as a verified hit if it has an energy
 *  value -- see normalizeExternalProduct's header for why. */
function hasUsableNutrition(record) {
  return record != null && Number.isFinite(Number(record.energy_kcal));
}

/**
 * Normalize an Open Food Facts v2 `product` object into the same record
 * shape as an off_barcode_index.json entry (source, barcode, source_id,
 * food_name, brand, serving_*, energy_kcal/protein_g/fat_g/carb_g/fiber_g/
 * sugar_g/sodium_mg/calcium_mg/iron_mg — all PER 100 g), so resolveServing()
 * works on it unchanged. Returns null when the payload is too thin to be
 * USABLE -- no name, or no energy value -- rather than fabricating one.
 * Open Food Facts is crowd-sourced: a huge fraction of listings have a
 * name and a photo but nobody ever filled in the nutrition panel. Letting
 * one of those through as a "found" product would show a real-looking
 * confirm screen (name, brand, serving) with every macro silently
 * defaulting to 0 once logged -- indistinguishable from an accurate
 * zero-calorie product. Treating "no energy value" as the same kind of
 * miss as "no name at all" is what keeps that from happening: it falls
 * through to the caller's normal not-found path (manual entry / OCR),
 * never gets cached, and is never presented as verified data.
 */
export function normalizeExternalProduct(barcode, product) {
  if (!product) return null;
  const name = product.product_name || product.product_name_en || product.generic_name || null;
  if (!name || !String(name).trim()) return null;
  const n = product.nutriments || {};
  const energy = numOrNull(n['energy-kcal_100g']);
  if (energy == null) return null;
  const servingGrams = numOrNull(product.serving_quantity);
  return {
    source: 'OPEN_FOOD_FACTS',
    barcode,
    source_id: `off:${barcode}`,
    food_name: String(name).trim(),
    brand: product.brands ? String(product.brands).split(',')[0].trim() : null,
    quantity_label: product.quantity || null,
    category: (Array.isArray(product.categories_tags) && product.categories_tags[0]) || null,
    cuisine: 'PACKAGED',
    cooking_state: 'ready_to_eat',
    serving_size_label: product.serving_size || null,
    serving_grams: servingGrams,
    serving_grams_source: servingGrams != null ? 'off_serving_quantity' : null,
    // Open Food Facts publishes these per 100 g under the *_100g keys —
    // exactly the basis resolveServing() expects (matches the static
    // snapshot's own per-100g convention).
    energy_kcal: energy,
    protein_g: numOrNull(n.proteins_100g),
    fat_g: numOrNull(n.fat_100g),
    carb_g: numOrNull(n.carbohydrates_100g),
    fiber_g: numOrNull(n.fiber_100g),
    sugar_g: numOrNull(n.sugars_100g),
    // OFF reports sodium/calcium/iron in GRAMS per 100g; this app's
    // convention (matching the existing foods table + off_barcode_index.json)
    // is milligrams.
    sodium_mg: toMg(n.sodium_100g),
    calcium_mg: toMg(n.calcium_100g),
    iron_mg: toMg(n.iron_100g),
    ingredients_text: product.ingredients_text || product.ingredients_text_en || null,
    image_url: product.image_front_url || product.image_url || null,
  };
}

/**
 * Live external lookup. Never throws — every failure mode (not configured,
 * network error, timeout, rate limit, non-2xx, product not found, unusable
 * payload) comes back as `{ record: null, reason }` (see REASON_STATUS)
 * so the caller can return a controlled, correctly-coded response instead
 * of ever letting an external-API hiccup surface as an unhandled 500.
 */
export async function fetchFromExternalApi(barcode) {
  const base = config.foodDatabaseApiUrl;
  if (!base) return { record: null, reason: 'not_configured' };
  const fields = [
    'product_name', 'product_name_en', 'generic_name', 'brands', 'quantity',
    'serving_size', 'serving_quantity', 'nutriments', 'ingredients_text',
    'ingredients_text_en', 'image_front_url', 'image_url', 'categories_tags', 'status',
  ].join(',');
  const url = `${base}/${encodeURIComponent(barcode)}.json?fields=${fields}`;
  const headers = { 'User-Agent': USER_AGENT };
  if (config.foodDatabaseApiKey) headers.Authorization = `Bearer ${config.foodDatabaseApiKey}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
  } catch (e) {
    return { record: null, reason: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
  if (res.status === 429) return { record: null, reason: 'rate_limited' };
  // v3 returns a real HTTP 404 on a miss (v2 always answered 200 with a
  // status flag in the body — still handled below for anyone who points
  // FOOD_DATABASE_API_URL at a v2-shaped mirror).
  if (res.status === 404) return { record: null, reason: 'not_found' };
  if (!res.ok) return { record: null, reason: 'service_unavailable' };
  let data;
  try { data = await res.json(); } catch { return { record: null, reason: 'bad_response' }; }
  // v3: { status: 'success'|'failure', product: {...} }.
  // v2: { status: 1|0, product: {...} }.
  const found = data?.status === 'success' || data?.status === 1;
  if (!found || !data.product) return { record: null, reason: 'not_found' };
  const record = normalizeExternalProduct(barcode, data.product);
  if (!record) return { record: null, reason: 'incomplete_data' };
  return { record, reason: null };
}

/** Map a `foods` table row (barcode cache or manual save) back into the
 *  same record shape resolveServing() consumes. Passes `source`/`source_id`
 *  straight through rather than inferring them from the barcode's presence
 *  -- a manually-typed product is NOT Open Food Facts data, and claiming
 *  otherwise would misattribute a user's own entry to a third-party
 *  database, which is its own kind of "fabricated" provenance. */
export function foodRowToRecord(row) {
  return {
    source: row.source || 'PACKAGING_LABEL',
    barcode: row.barcode,
    source_id: row.source_id ?? null,
    food_name: row.name,
    brand: row.brand ?? null,
    quantity_label: null,
    category: row.category ?? null,
    cuisine: row.cuisine ?? null,
    cooking_state: row.cooking_state ?? 'ready_to_eat',
    serving_size_label: row.serving_description || row.serving || null,
    serving_grams: row.serving_grams ?? null,
    serving_grams_source: row.serving_grams != null ? 'cached' : null,
    energy_kcal: row.calories ?? null,
    protein_g: row.protein ?? null,
    fat_g: row.fat ?? null,
    carb_g: row.carbs ?? null,
    fiber_g: row.fiber ?? null,
    sugar_g: row.sugar ?? null,
    sodium_mg: row.sodium ?? null,
    calcium_mg: row.calcium_mg ?? null,
    iron_mg: row.iron_mg ?? null,
    ingredients_text: row.ingredients_text ?? null,
    image_url: row.image_url ?? null,
  };
}

/** DB cache lookup: a GLOBAL row (not any one client's private food) keyed
 *  by barcode. Global because a product's nutrition facts don't depend on
 *  who scanned it — see the module header. */
export async function lookupCachedProduct(db, barcode) {
  return db.q1(`SELECT * FROM foods WHERE barcode = ? AND is_global = 1 LIMIT 1`, [barcode]);
}

/**
 * Persist a normalized record (from the external API, or a manual save) as
 * a global `foods` cache row. Check-then-insert, same idempotency pattern
 * POST /me/foods/from-model already uses in this codebase — a genuine
 * concurrent double-insert of the exact same barcode is a narrow enough
 * race that a plain re-select on conflict (below) covers it, matching the
 * `idx_foods_barcode` unique index created by scripts/init-db.js.
 */
export async function cacheProduct(db, record) {
  // Guard the write side too, not just resolveBarcodeProduct's read side --
  // nothing without a verified energy value should ever enter the cache,
  // regardless of which caller reaches this function.
  if (!hasUsableNutrition(record)) {
    throw new Error('Refusing to cache a product with no energy value');
  }
  const existing = await lookupCachedProduct(db, record.barcode);
  if (existing) return existing;

  const fId = id('food');
  try {
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g,
                          calories, protein, carbs, fat, fiber, sugar, sodium,
                          brand, source, category, cuisine, is_global,
                          source_id, cooking_state, serving_description, serving_grams,
                          calcium_mg, iron_mg, barcode, ingredients_text, image_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
      [fId, null, null, String(record.food_name).slice(0, 80), 'g',
       record.serving_size_label ?? null, record.serving_grams ?? null,
       record.energy_kcal ?? null, record.protein_g ?? null, record.carb_g ?? null, record.fat_g ?? null,
       record.fiber_g ?? null, record.sugar_g ?? null, record.sodium_mg ?? null,
       record.brand ?? null, record.source || 'PACKAGING_LABEL', record.category ?? null, record.cuisine ?? null,
       record.source_id ?? null, record.cooking_state ?? null, record.serving_size_label ?? null, record.serving_grams ?? null,
       record.calcium_mg ?? null, record.iron_mg ?? null, record.barcode, record.ingredients_text ?? null, record.image_url ?? null]);
  } catch {
    // Lost the race to a concurrent insert of the same barcode (unique index
    // violation) -- the winning row is exactly what we would have written.
    const winner = await lookupCachedProduct(db, record.barcode);
    if (winner) return winner;
    throw new Error('Could not cache product and no existing row was found');
  }
  return db.q1('SELECT * FROM foods WHERE id = ?', [fId]);
}

/**
 * The full fallback chain for one scanned code: DB cache -> local snapshot
 * -> live external API (caching a hit). Returns `{ record, reason, cached,
 * fromExternal }` — record is null only when every source missed or the
 * code itself is invalid.
 */
export async function resolveBarcodeProduct(db, rawCode) {
  const barcode = cleanCode(rawCode);
  if (!barcode || barcode.length < 8 || barcode.length > 14) {
    return { record: null, reason: 'invalid_barcode', cached: false, fromExternal: false };
  }
  const canon = canonicalEan13(barcode);

  // Defense in depth: a "found" result with no energy value would let the
  // frontend show a real-looking confirm screen that logs silent zeros
  // (see normalizeExternalProduct's header). cacheProduct/the manual-save
  // route both require energy data, so this should never trigger for the
  // DB cache or local snapshot in practice -- but if it ever did, falling
  // through to the next source is strictly safer than handing out an
  // unusable "hit".
  //
  // The DB cache is an OPTIMIZATION on top of the local snapshot + external
  // API, not a hard dependency for either read or write below -- if the
  // `foods` table is ever missing barcode/ingredients_text/image_url (e.g.
  // a deploy whose migration, scripts/init-db.js, hasn't been run against
  // that database yet), every query against those columns throws a
  // "column does not exist" error. Catching that here and falling through
  // is the difference between "barcode lookup still works, just without
  // caching until the DB catches up" and every single scan 500ing.
  let cachedRow = null;
  try {
    cachedRow = (await lookupCachedProduct(db, barcode)) || (await lookupCachedProduct(db, canon));
  } catch (e) {
    console.error(`[barcode] DB cache read failed, continuing without it: ${e.message}`);
  }
  if (cachedRow) {
    const rec = foodRowToRecord(cachedRow);
    if (hasUsableNutrition(rec)) return { record: rec, reason: null, cached: true, fromExternal: false };
  }

  const localHit = getBarcodeIndex().lookup(barcode);
  if (localHit && hasUsableNutrition(localHit)) return { record: localHit, reason: null, cached: false, fromExternal: false };

  const { record, reason } = await fetchFromExternalApi(canon);
  if (record) {
    try {
      const saved = await cacheProduct(db, record);
      return { record: foodRowToRecord(saved), reason: null, cached: false, fromExternal: true };
    } catch (e) {
      // Caching failed (same possible cause as the read above). The user
      // still gets the product they just scanned -- it just won't be
      // cached for the next scan until the DB is migrated.
      console.error(`[barcode] Caching a resolved product failed, returning it uncached: ${e.message}`);
      return { record, reason: null, cached: false, fromExternal: true };
    }
  }
  return { record: null, reason: reason || 'not_found', cached: false, fromExternal: false };
}

/** Build the food-v1 barcode envelope (CONTRACT §3.6) for a resolved record
 *  + requested quantity. Shared by the GET lookup and the POST manual-save
 *  route so both return an identical, ready-to-confirm shape. */
export function buildBarcodeResponse(record, servings) {
  const resolved = resolveServing(record, servings);
  const notes = [];
  if (!resolved.serving_grams_known) {
    notes.push('Product does not publish a serving size; defaulted to 100 g. Confirm the actual amount before logging.');
  }
  return {
    schema_version: 'food-v1',
    tier: 'barcode',
    match_kind: 'barcode_exact',
    food: record,
    quantity: {
      servings: resolved.servings,
      grams: resolved.grams,
      serving_grams_each: resolved.serving_grams_each,
      serving_grams_known: resolved.serving_grams_known,
    },
    totals: resolved.totals,
    confidence: 'high',
    notes,
  };
}
