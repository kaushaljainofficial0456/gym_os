// ============================================================
// FOOD AI CACHE — canonicalization + the GLOBAL_TEMPLATE cache table.
//
// Purpose: "Chettinad chicken biryani" costs one AI call once, ever
// (per canonical concept) — not once per user, per session. This is the
// "SK OS food knowledge" layer the food-AI spec calls a major requirement.
//
// WHAT IS CACHED: only GLOBAL, reusable dish templates — never a specific
// user's data. A canonical key is a normalized, sorted set of significant
// words, so "Chettinad Chicken Biryani" / "chicken chettinad biryani" /
// "chettinad biryani chicken" collide (same words, different order) but
// "chicken biryani" and "chicken fried rice" never do (different words).
// This is deliberately word-set canonicalization, not fuzzy/semantic
// matching -- a global cache is exactly the place where a false collision
// (two different dishes sharing one cached answer) is the expensive
// mistake, so the bar for "same concept" is literal, not approximate.
//
// WHAT IS NEVER CACHED GLOBALLY: personal-possessive queries ("MY mom's
// chicken curry", "grandma's dal"). These describe one person's specific
// recipe, not a reusable concept -- caching one user's "my mom's curry"
// answer and silently serving it to every other user who types the same
// phrase would be quietly wrong for all of them. isPersonalQuery() below
// detects this and the caller skips both cache read and cache write.
// ============================================================

import { id, now } from '../../ids.js';

// Filler/descriptor words that don't change WHAT the dish is, only how
// it's phrased. Stripped before canonicalization so word-order and style
// synonyms collide correctly. Deliberately small: over-stripping risks
// merging genuinely different foods (see the module comment above).
const NOISE_WORDS = new Set([
  'a', 'an', 'the', 'style', 'styled', 'homemade', 'home', 'restaurant',
  'restaurant-style', 'random', 'local', 'typical', 'traditional',
  'authentic', 'special', 'famous', 'original', 'classic', 'fresh',
  'made', 'like', 'type', 'from', 'of', 'with', 'and', 'plate', 'bowl',
  'serving',
]);

// Possessive/personal markers -- presence of ANY of these means "this is
// one person's specific recipe", not a generalizable dish concept.
const PERSONAL_MARKERS = /\b(my|mine|our|his|her|their)\b|'s\b|\bmom'?s\b|\bmum'?s\b|\bgrandma'?s\b|\bgrandmother'?s\b|\bdad'?s\b|\bnani'?s\b|\bdadi'?s\b|\bmaa'?s\b/i;

export function isPersonalQuery(query) {
  return PERSONAL_MARKERS.test(String(query || ''));
}

/**
 * Turn a free-text food query (+ optional brand/restaurant) into a stable
 * canonical cache key and a clean display name.
 *
 * Brand/restaurant are folded INTO the key deliberately: "McChicken" and
 * a generic "chicken burger" must not collide just because both reduce to
 * {chicken, burger} after stripping noise words -- the branded query is a
 * materially different estimation target (see BRANDED FOOD HANDLING in
 * the spec: exact restaurant/product nutrition is never claimed, but the
 * QUERY identity still matters for which estimate gets reused).
 */
export function canonicalizeFoodQuery(query, { brand, restaurant } = {}) {
  const raw = String(query || '').trim();
  const isPersonal = isPersonalQuery(raw) || isPersonalQuery(restaurant || '');

  const clean = (s) => String(s || '')
    .toLowerCase()
    .replace(/'s\b/g, '')          // possessive suffix, not just the marker words above
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !NOISE_WORDS.has(w));

  const words = clean(raw);
  const brandWords = brand ? clean(brand).map((w) => `brand:${w}`) : [];
  const restWords = restaurant ? clean(restaurant).map((w) => `rest:${w}`) : [];

  const allWords = [...words, ...brandWords, ...restWords].sort();
  const key = allWords.join('_') || 'unknown';
  const displayName = raw.replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return { key, isPersonal, displayName, words: allWords };
}

/** Read a cached GLOBAL_TEMPLATE estimate, if one exists. Never returns a
 *  personal/user-specific row -- there are none in this table by design. */
export async function getCachedEstimate(db, key) {
  if (!key) return null;
  try {
    const row = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [key]);
    if (!row) return null;
    return {
      ...row,
      component_template: safeParse(row.component_template_json, []),
      nutrition: safeParse(row.nutrition_json, null),
      uncertainty: safeParse(row.uncertainty_json, null),
      assumptions: safeParse(row.assumptions_json, []),
    };
  } catch {
    return null; // cache is an optimization, never a hard dependency
  }
}

export async function saveCachedEstimate(db, key, displayName, { nutrition, uncertainty, componentTemplate, assumptions, source, aiProvider, aiModel, confidence, cuisine }) {
  if (!key) return;
  const nowIso = now();
  try {
    await db.run(
      `INSERT INTO ai_food_estimates
         (id, canonical_key, canonical_name, cuisine, component_template_json, nutrition_json,
          uncertainty_json, assumptions_json, source, ai_provider, ai_model, confidence,
          times_used, user_confirmation_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
       ON CONFLICT (canonical_key) DO UPDATE SET
         nutrition_json = excluded.nutrition_json,
         uncertainty_json = excluded.uncertainty_json,
         component_template_json = excluded.component_template_json,
         assumptions_json = excluded.assumptions_json,
         confidence = excluded.confidence,
         ai_provider = excluded.ai_provider,
         ai_model = excluded.ai_model,
         updated_at = excluded.updated_at`,
      [id('afe'), key, displayName, cuisine || null,
       JSON.stringify(componentTemplate || []), JSON.stringify(nutrition || {}),
       JSON.stringify(uncertainty || {}), JSON.stringify(assumptions || []),
       source || 'ai_estimated', aiProvider || null, aiModel || null, confidence || 'low',
       nowIso, nowIso]);
  } catch {
    // Cache write failure must never fail the food estimate itself.
  }
}

export async function bumpCacheUsage(db, key, { userConfirmed = false } = {}) {
  if (!key) return;
  try {
    await db.run(
      `UPDATE ai_food_estimates SET times_used = times_used + 1,
         user_confirmation_count = user_confirmation_count + ?, updated_at = ?
       WHERE canonical_key = ?`,
      [userConfirmed ? 1 : 0, now(), key]);
  } catch { /* best-effort */ }
}

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
