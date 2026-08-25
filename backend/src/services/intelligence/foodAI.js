// ============================================================
// FOOD AI ESTIMATOR — Tier 4 of skos-food-v1's estimation hierarchy.
//
// HIERARCHY (must never be reordered without evidence):
//   Tier 1  exact/alias/fuzzy database match   (foodEstimator.js -> FoodSearch)
//   Tier 2  compositional (user-supplied ingredients) -- NOT wired into the
//           live backend today; exists only as Python (ml/src/inference/
//           compositional.py). See the audit note in the report this
//           shipped with. Not touched by this file.
//   Tier 3  trained similarity/kNN fallback -- SAME gap: measured and
//           documented (ml/models/skos-food-v1/fallback_v4_metrics.json)
//           but never ported to JS/backend (contract doc: "Tier 3 is
//           intentionally not ported"). Not touched by this file.
//   Tier 4  THIS FILE. Reached today whenever Tier 1 finds no acceptable
//           match -- the only tier that is actually live upstream of it.
//
// This is a coverage layer, not a new ground truth. It NEVER overwrites a
// measured database value, NEVER gets called for a query Tier 1 already
// resolved, and every result it returns is visibly labelled an estimate
// with an uncertainty range -- never presented with the confidence of a
// lab value.
//
// ARCHITECTURE (spec: "AI: what's probably in the dish? / Backend: what
// are those worth?"): the AI's job is composition (which ingredients, how
// much of each) -- NOT final arithmetic. Every component the AI proposes
// gets looked up against the REAL measured database (the exact same
// FoodSearch + scaleNutrition every other tier uses); only a component
// that has no real database match falls back to the AI's own guessed
// macros for THAT ingredient. This is "prefer deterministic calculation
// over trusting AI arithmetic" applied at the component level, not just
// the total level -- a biryani where AI got rice/chicken/oil all matched
// to real rows is far more grounded than one where none of them were,
// even though both come back labelled "AI estimate".
// ============================================================

import { callProviderRaw, isProviderConfigured, parseJSON } from './aiProvider.js';
import { getFoodSearch, getCompositionalCalculator, scaleNutrition } from '../foodEstimator.js';
import { canonicalizeFoodQuery, getCachedEstimate, saveCachedEstimate, bumpCacheUsage } from './foodAICache.js';
import { track } from '../events.js';

// ------------------------------------------------------------------
// PROVIDER SELECTION / FAILOVER CHAIN — independent of the app-wide
// AI_PROVIDER (food estimation may reasonably want a different model/
// vendor than chat coaching does).
//
// TARGET HIERARCHY (production, all three cloud keys configured):
//   Groq (primary) -> Gemini (secondary) -> OpenRouter (tertiary) ->
//   Ollama (optional local) -> graceful unresolved.
// Each step is tried ONLY if the previous one genuinely FAILED -- a
// successful call never triggers the next provider (cost safety). A
// provider that isn't configured (no key, or a paid provider blocked by
// the zero-cost ALLOW_PAID_AI gate) is skipped without counting as a
// "failure", exactly like today.
//
// BACKWARD COMPATIBILITY / ESCAPE HATCH: if FOOD_AI_PROVIDER (or the
// app-wide AI_PROVIDER) is explicitly set, that exact single-provider (+
// optional FOOD_AI_FALLBACK_PROVIDER) behaviour from before this change is
// preserved UNCHANGED -- the full 4-provider chain does not get silently
// appended on top of someone's deliberate single-provider configuration.
// The full chain is what happens when NEITHER is set, which is also
// exactly the zero-cost dev default (nothing configured -> only Ollama is
// actually attempted, everything else is skipped as unconfigured) and the
// natural production case (set the cloud keys, leave FOOD_AI_PROVIDER
// unset, get the full ordered chain).
// ------------------------------------------------------------------
const DEFAULT_CHAIN = ['groq', 'gemini', 'openrouter', 'ollama'];

const EXPLICIT_PROVIDER = (process.env.FOOD_AI_PROVIDER || process.env.AI_PROVIDER || '').toLowerCase() || null;
const EXPLICIT_FALLBACK = (process.env.FOOD_AI_FALLBACK_PROVIDER || '').toLowerCase() || null;

const PROVIDER_CHAIN = EXPLICIT_PROVIDER
  ? [EXPLICIT_PROVIDER, EXPLICIT_FALLBACK].filter(Boolean)
  : DEFAULT_CHAIN;

// Kept for compatibility with anything reading the old two-slot shape.
const PRIMARY_PROVIDER = PROVIDER_CHAIN[0] || 'ollama';
const FALLBACK_PROVIDER = PROVIDER_CHAIN[1] || null;

const FOOD_AI_MODEL = process.env.FOOD_AI_MODEL || null;
const FOOD_AI_TIMEOUT_MS = Number(process.env.FOOD_AI_TIMEOUT_MS) || 15_000;

export function isFoodAIAvailable() {
  return PROVIDER_CHAIN.some((p) => isProviderConfigured(p));
}

export function foodAIConfigSummary() {
  return {
    // New: the full ordered chain and which entries are actually usable.
    chain: PROVIDER_CHAIN,
    chainAvailability: Object.fromEntries(PROVIDER_CHAIN.map((p) => [p, isProviderConfigured(p)])),
    // Kept for compatibility with any existing caller of the old shape.
    primaryProvider: PRIMARY_PROVIDER,
    primaryAvailable: isProviderConfigured(PRIMARY_PROVIDER),
    fallbackProvider: FALLBACK_PROVIDER,
    fallbackAvailable: FALLBACK_PROVIDER ? isProviderConfigured(FALLBACK_PROVIDER) : false,
    model: FOOD_AI_MODEL,
    dailyLimits: DAILY_LIMITS,
    dailyUsage: Object.fromEntries(PROVIDER_CHAIN.map((p) => [p, _dailyCount.get(p) || 0])),
  };
}

/* ------------------------------------------------------------------ */
/*  Cost safety beyond the zero-cost provider gate                     */
/*                                                                      */
/*  A free-tier account with NO payment method attached already cannot */
/*  be billed by hitting its quota -- Groq/Gemini just return 429 and   */
/*  the chain below already falls through to the next provider, never  */
/*  throwing or blocking food logging. That protection lives entirely  */
/*  on the vendor's own account settings, though, which this codebase  */
/*  cannot see or control -- if a payment method IS attached to either  */
/*  account, an over-quota call succeeds and bills, and looks identical */
/*  to a normal free response from here. These two mechanisms are the   */
/*  app's OWN, account-independent backstop:                            */
/*                                                                      */
/*  1. RATE-LIMIT COOLDOWN -- once a provider returns 429, skip it (no  */
/*     network call at all) for a cooldown window instead of hammering  */
/*     it again on every subsequent request while its quota is still    */
/*     exhausted. Purely a latency/politeness improvement, not a money  */
/*     control by itself (a skipped 429 was never going to bill either  */
/*     way) -- but it's what makes "the app noticed the limit and       */
/*     backed off" true rather than aspirational.                       */
/*  2. DAILY CALL BUDGET (optional, unset by default -- no behaviour     */
/*     change unless configured) -- a hard ceiling THIS APP enforces on  */
/*     how many real calls it will ever send a given provider per UTC   */
/*     day, independent of whatever the vendor's own dashboard would     */
/*     otherwise allow through. Once hit, that provider is skipped for   */
/*     the rest of the day exactly like an unconfigured one -- the      */
/*     chain falls through to the next provider, and if every cloud      */
/*     provider is capped/unavailable, Tier 4 returns 'unresolved'       */
/*     exactly as it always has. Tier 1-3 (measured DB, compositional,   */
/*     kNN) are entirely local and free and are unaffected -- and the    */
/*     UI already shows the Tier-3 estimate BEFORE offering "Estimate    */
/*     with AI" at all, so a capped-out AI layer still leaves a usable,  */
/*     zero-cost estimate on screen, not a dead end.                     */
/*                                                                      */
/*  HONEST LIMITATION: both trackers are in-process memory, not a DB or */
/*  shared store -- correct for this single-process deployment, but a   */
/*  restart resets them and a multi-instance deployment would need a    */
/*  shared counter (Redis, a DB row) to enforce one TRUE daily ceiling   */
/*  across instances rather than one per process.                       */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_COOLDOWN_MS = Number(process.env.FOOD_AI_RATE_LIMIT_COOLDOWN_MS) || 5 * 60_000; // 5 min
const _cooldownUntil = new Map(); // provider -> epoch ms

function isOnCooldown(provider) {
  const until = _cooldownUntil.get(provider);
  return !!until && Date.now() < until;
}
function markRateLimitCooldown(provider) {
  _cooldownUntil.set(provider, Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const DAILY_LIMITS = {
  groq: numOrNull(process.env.FOOD_AI_DAILY_LIMIT_GROQ),
  gemini: numOrNull(process.env.FOOD_AI_DAILY_LIMIT_GEMINI),
  openrouter: numOrNull(process.env.FOOD_AI_DAILY_LIMIT_OPENROUTER),
};
let _dayKey = null;
const _dailyCount = new Map(); // provider -> count so far today (UTC)

function todayKeyUTC() { return new Date().toISOString().slice(0, 10); }
function resetDailyCountIfNewDay() {
  const key = todayKeyUTC();
  if (_dayKey !== key) { _dayKey = key; _dailyCount.clear(); }
}
function withinDailyBudget(provider) {
  const limit = DAILY_LIMITS[provider];
  if (!limit) return true; // no configured ceiling -- existing behaviour
  resetDailyCountIfNewDay();
  return (_dailyCount.get(provider) || 0) < limit;
}
function bumpDailyCount(provider) {
  resetDailyCountIfNewDay();
  _dailyCount.set(provider, (_dailyCount.get(provider) || 0) + 1);
}

/* ------------------------------------------------------------------ */
/*  System prompt — the model's ONLY job description                  */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are a food nutrition ESTIMATION assistant for a fitness app. You are NOT a laboratory measurement device and you do not have access to any restaurant's actual recipe, any brand's actual nutrition panel, or any specific person's actual cooking. Never claim certainty when recipe or portion information is unknown to you -- you are reasoning from typical preparation, not looking anything up.

Your job: given a food name (and optional brand/restaurant/cuisine/portion/known ingredients), estimate:
- what the dish probably contains (its likely components: a base like rice/bread/noodles, a protein, fats/oils/ghee, sauces/gravy, vegetables, etc.)
- a realistic weight in grams for each component, for ONE typical serving
- your own best per-component macro estimate (this is a fallback only -- the backend will replace it with real measured data wherever it can find a match, so do not agonize over exact numbers here; focus on getting the COMPOSITION and QUANTITIES right)
- a realistic total serving weight
- a conservative uncertainty range for total calories and each macro (never a single confident number)
- the assumptions you made, in plain language
- which of those assumptions the user should probably be asked to confirm (e.g. portion size, oil quantity)

Rules:
- If measured ingredient references are supplied below, PREFER them as anchors for what a component's macros probably look like -- do not contradict them without reason.
- If the food is branded or from a specific named restaurant, you do NOT know their actual recipe. Estimate from what that CATEGORY of food typically contains, and say so plainly in your assumptions (e.g. "estimated from typical fast-food chicken burger preparation, not an exact match to any brand's published nutrition").
- If the food name is ambiguous, pick the single most common interpretation and note the ambiguity in assumptions rather than refusing to answer.
- Ranges should be WIDE ENOUGH to be honest, not narrow enough to look precise. A dish you're unsure about deserves a wider range than one that's a simple, well-known preparation.
- Return ONLY a single JSON object. No prose before or after it. No markdown code fences.

Return exactly this JSON shape:
{
  "food_name": "string, the dish as you understood it",
  "food_type": "single_food | composite_dish | branded_product",
  "cuisine": "string or null",
  "is_branded_or_restaurant": true or false,
  "serving": { "description": "e.g. 1 plate, 1 burger", "estimated_weight_g": number },
  "components": [
    { "name": "string, a specific searchable ingredient name (e.g. \\"cooked basmati rice\\", not \\"rice dish\\")",
      "estimated_weight_g": number,
      "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number,
      "assumption": "short string" }
  ],
  "totals": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number },
  "uncertainty": {
    "calories_low": number, "calories_high": number,
    "protein_low": number, "protein_high": number,
    "carbs_low": number, "carbs_high": number,
    "fat_low": number, "fat_high": number
  },
  "confidence": "high | medium | low",
  "assumptions": ["short strings"],
  "needs_user_confirmation": ["portion_size", "oil_quantity", or other short keys]
}`;

/* ------------------------------------------------------------------ */
/*  Measured-reference context — grounds the AI in real data           */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'with', 'and', 'style', 'from', 'my', 'restaurant']);

/** Pull a handful of plausibly-relevant measured foods from the REAL
 *  database, keyed off the significant words in the query, so the AI has
 *  real per-100g numbers to anchor to instead of estimating in a vacuum.
 *  Capped small (spec: keep prompts focused, not a database dump). */
function gatherMeasuredReferences(query, limit = 8) {
  const search = getFoodSearch();
  if (!search) return [];
  const words = String(query || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  const seen = new Set();
  const refs = [];
  for (const w of words) {
    if (refs.length >= limit) break;
    let hits = [];
    try { hits = search.search(w, { limit: 2 }) || []; } catch { hits = []; }
    for (const h of hits) {
      if (refs.length >= limit) break;
      if (!h || h.trustworthy === false || seen.has(h.source_id)) continue;
      seen.add(h.source_id);
      refs.push({
        name: h.food_name,
        energy_kcal_per_100g: h.energy_kcal ?? null,
        protein_g_per_100g: h.protein_g ?? null,
        carb_g_per_100g: h.carb_g ?? null,
        fat_g_per_100g: h.fat_g ?? null,
      });
    }
  }
  return refs;
}

function buildUserMessage({ query, brand, restaurant, cuisine, portion, ingredients, cookingMethod }, references) {
  const lines = [`USER FOOD: ${query}`];
  if (brand) lines.push(`BRAND: ${brand}`);
  if (restaurant) lines.push(`RESTAURANT: ${restaurant}`);
  if (cuisine) lines.push(`CUISINE: ${cuisine}`);
  if (portion) lines.push(`STATED PORTION: ${portion}`);
  if (cookingMethod) lines.push(`COOKING METHOD: ${cookingMethod}`);
  if (Array.isArray(ingredients) && ingredients.length) {
    lines.push(`KNOWN INGREDIENTS: ${ingredients.join(', ')}`);
  }
  if (references.length) {
    lines.push('', 'MEASURED REFERENCES (real database values, per 100 g -- use these as anchors where they apply):');
    for (const r of references) {
      lines.push(`- ${r.name}: ${r.energy_kcal_per_100g ?? '?'} kcal, P${r.protein_g_per_100g ?? '?'} C${r.carb_g_per_100g ?? '?'} F${r.fat_g_per_100g ?? '?'} (per 100g)`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Response validation — never trust raw LLM JSON                     */
/* ------------------------------------------------------------------ */

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v) => isFiniteNum(v) && v >= 0;

/** Atwater plausibility: kcal should roughly equal 4P + 4C + 9F. Wide
 *  tolerance (spec: "allowing for fiber/alcohol/rounding and food-specific
 *  deviations") -- this REJECTS obviously broken arithmetic, not merely
 *  imprecise arithmetic. */
function atwaterConsistent(calories, protein, carbs, fat) {
  const expected = protein * 4 + carbs * 4 + fat * 9;
  if (expected <= 0) return calories <= 50; // near-zero macros should mean near-zero calories
  const ratio = calories / expected;
  return ratio >= 0.5 && ratio <= 1.8; // generous on purpose -- see MAX_PLAUSIBLE_KCAL note below
}

const MAX_PLAUSIBLE_KCAL_PER_SERVING = 4000; // a single logged serving above this is almost certainly a unit error, not a real food
const MAX_PLAUSIBLE_WEIGHT_G = 3000;

/**
 * Validate a parsed AI response against the schema + physical plausibility
 * rules. Returns { ok: true, value } or { ok: false, reason }. NOTHING
 * downstream trusts a response that hasn't passed this.
 */
export function validateAIFoodResponse(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'response is not a JSON object' };
  if (typeof raw.food_name !== 'string' || !raw.food_name.trim()) return { ok: false, reason: 'missing food_name' };

  const serving = raw.serving;
  if (!serving || !isFiniteNum(serving.estimated_weight_g) || serving.estimated_weight_g <= 0) {
    return { ok: false, reason: 'missing or invalid serving.estimated_weight_g' };
  }
  if (serving.estimated_weight_g > MAX_PLAUSIBLE_WEIGHT_G) {
    return { ok: false, reason: `serving weight ${serving.estimated_weight_g}g exceeds plausible bound` };
  }

  if (!Array.isArray(raw.components) || raw.components.length === 0) {
    return { ok: false, reason: 'missing or empty components array' };
  }
  for (const c of raw.components) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return { ok: false, reason: 'a component is missing a name' };
    if (!nonNeg(c.estimated_weight_g)) return { ok: false, reason: `component "${c.name}" has an invalid weight` };
    if (![c.calories, c.protein_g, c.carbs_g, c.fat_g].every((v) => v == null || nonNeg(v))) {
      return { ok: false, reason: `component "${c.name}" has a negative or non-finite macro` };
    }
  }

  const t = raw.totals;
  if (!t || !nonNeg(t.calories) || !nonNeg(t.protein_g) || !nonNeg(t.carbs_g) || !nonNeg(t.fat_g)) {
    return { ok: false, reason: 'totals missing or contains a negative/non-finite value' };
  }
  if (t.calories > MAX_PLAUSIBLE_KCAL_PER_SERVING) {
    return { ok: false, reason: `total calories ${t.calories} exceeds plausible bound for one serving` };
  }
  // Reject the exact "impossible output" example the spec calls out:
  // large calories with all-zero macros (or vice versa) with no basis.
  if (t.calories > 200 && t.protein_g === 0 && t.carbs_g === 0 && t.fat_g === 0) {
    return { ok: false, reason: 'calories present but all macros are zero -- physically inconsistent' };
  }
  if (!atwaterConsistent(t.calories, t.protein_g, t.carbs_g, t.fat_g)) {
    return { ok: false, reason: 'totals fail Atwater plausibility check (calories inconsistent with macros)' };
  }

  const conf = String(raw.confidence || '').toLowerCase();
  if (!['high', 'medium', 'low'].includes(conf)) {
    // Not fatal -- the backend derives its own confidence anyway (see
    // deriveConfidence below) and never trusts the AI's self-rating blindly.
    raw.confidence = 'low';
  }

  return { ok: true, value: raw };
}

/** Uncertainty must satisfy low <= estimate <= high and low >= 0 for
 *  every metric. If the AI's own interval is missing or invalid, generate
 *  a conservative one instead of trusting a broken interval or showing
 *  none at all -- every Tier-4 result must carry a valid range. */
export function resolveUncertainty(rawUncertainty, totals) {
  const out = {};
  const pairs = [
    ['calories', 'calories_low', 'calories_high', 0.25],
    ['protein_g', 'protein_low', 'protein_high', 0.35],
    ['carbs_g', 'carbs_low', 'carbs_high', 0.35],
    ['fat_g', 'fat_low', 'fat_high', 0.4],
  ];
  for (const [totalKey, lowKey, highKey, defaultSpread] of pairs) {
    const estimate = totals[totalKey] ?? 0;
    let low = rawUncertainty?.[lowKey];
    let high = rawUncertainty?.[highKey];
    const valid = nonNeg(low) && nonNeg(high) && low <= estimate && high >= estimate;
    if (!valid) {
      // Conservative application-side fallback -- wider than the measured
      // Tier-3 kNN error bands (see MODEL_CARD/fallback_v4_metrics.json:
      // ~15-25% median APE when the food family is known) because Tier 4
      // is reached for foods that are LESS validated than a kNN neighbour
      // match, not more.
      low = Math.max(0, estimate * (1 - defaultSpread));
      high = estimate * (1 + defaultSpread);
    }
    out[lowKey] = round1(low);
    out[highKey] = round1(high);
  }
  return out;
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/* ------------------------------------------------------------------ */
/*  Component resolution — AI proposes, the measured database disposes */
/* ------------------------------------------------------------------ */

/**
 * Resolve one component name to a measured food row. Tries Tier 2's
 * curated ingredient-alias resolution first (the SAME resolution recipe
 * ingredients get: "mutton" -> goat round leg, not a plain-search
 * mismatch onto rendered fat or a composite dish) and falls back to a
 * plain Tier-1 search if the calculator itself isn't available. Returns
 * the matched row, or null.
 */
function resolveComponentFood(name) {
  const calc = getCompositionalCalculator();
  if (calc) {
    const { row, negligible } = calc.lookupIngredient(name);
    if (negligible) return null; // trace item -- no measured row, and correctly so
    if (row && row.energy_kcal != null) return row;
  }
  const search = getFoodSearch();
  if (!search) return null;
  try {
    const hits = search.search(name, { limit: 1 }) || [];
    if (hits.length && hits[0].trustworthy !== false) return hits[0];
  } catch { /* fall through to null */ }
  return null;
}

/**
 * For each AI-proposed component, try to ground it in a real measured
 * food row. A component that resolves gets ITS macros computed by
 * scaleNutrition() against the matched row -- the same deterministic math
 * every other tier uses -- not the AI's own guessed numbers. A component
 * with no acceptable match keeps the AI's own numbers, flagged
 * db_grounded: false, so the final result is honest about how much of it
 * is measured-derived vs. AI-guessed.
 */
export function resolveComponents(components) {
  const resolved = [];
  let groundedCount = 0;

  for (const c of components) {
    const grams = Number(c.estimated_weight_g) || 0;
    const hit = grams > 0 ? resolveComponentFood(c.name) : null;

    if (hit) {
      const scaled = scaleNutrition(hit, grams);
      if (scaled?.totals) {
        groundedCount++;
        resolved.push({
          name: c.name,
          matched_food: hit.food_name,
          matched_source_id: hit.source_id,
          estimated_weight_g: grams,
          calories: round1(scaled.totals.energy_kcal ?? 0),
          protein_g: round1(scaled.totals.protein_g ?? 0),
          carbs_g: round1(scaled.totals.carb_g ?? 0),
          fat_g: round1(scaled.totals.fat_g ?? 0),
          assumption: c.assumption || null,
          db_grounded: true,
        });
        continue;
      }
    }

    resolved.push({
      name: c.name,
      matched_food: null,
      matched_source_id: null,
      estimated_weight_g: grams,
      calories: round1(Number(c.calories) || 0),
      protein_g: round1(Number(c.protein_g) || 0),
      carbs_g: round1(Number(c.carbs_g) || 0),
      fat_g: round1(Number(c.fat_g) || 0),
      assumption: c.assumption || null,
      db_grounded: false,
    });
  }

  return { components: resolved, groundedCount, totalCount: components.length };
}

/* ------------------------------------------------------------------ */
/*  User adjustment — deterministic recompute, never a second AI call  */
/* ------------------------------------------------------------------ */

/**
 * Re-price a set of AI-estimate components after the user edits serving
 * quantity, an individual ingredient's grams, an ingredient NAME (e.g.
 * swapping "rice" for "brown rice", or adjusting "oil"), or removes a
 * component entirely -- WITHOUT calling the AI again. Spec: "do NOT
 * blindly trust the original AI total".
 *
 * originalComponents: the array resolveComponents() already produced
 *   (each has name/estimated_weight_g/calories/protein_g/carbs_g/fat_g/
 *   matched_source_id/db_grounded from the initial estimate).
 * edits: [{ name?, estimated_weight_g?, removed? }, ...] aligned by index
 *   to originalComponents -- omit a field to leave it unchanged, an
 *   explicit null/absent entry for an index means "no edit to this one".
 *
 * For each component:
 *   - grams-only change on an already db_grounded component: re-scale the
 *     SAME matched food row via scaleNutrition() -- exact, not approximated.
 *   - a name change: re-resolve via Tier 2's alias-aware lookup (same
 *     resolveComponentFood() every AI component already goes through). If
 *     the new name resolves, its real measured density is used. If it does
 *     NOT resolve, there is no second AI call to ask for new macros -- the
 *     ORIGINAL component's own implied per-gram density carries over to the
 *     new gram amount instead of fabricating a number, and the component is
 *     flagged accordingly so this is visible, not silent.
 *
 * Returns { components, totals, groundedCount, totalCount } where every
 * returned component carries `provenance: { name, estimated_weight_g }`
 * each one of 'ai_original' | 'user_adjusted', so the caller can render
 * exactly which values came from the AI and which the user changed.
 */
export function recomputeAdjustedComponents(originalComponents, edits = []) {
  const resolved = [];
  let groundedCount = 0;
  let totalCount = 0;

  originalComponents.forEach((orig, i) => {
    const edit = edits[i] || {};
    if (edit.removed) return; // user removed this component entirely -- drop it from totals

    totalCount++;
    const nameChanged = edit.name != null && String(edit.name).trim() && edit.name !== orig.name;
    const name = nameChanged ? String(edit.name).trim() : orig.name;
    const gramsProvided = edit.estimated_weight_g != null && Number.isFinite(Number(edit.estimated_weight_g));
    const grams = gramsProvided ? Number(edit.estimated_weight_g) : Number(orig.estimated_weight_g) || 0;
    const gramsChanged = gramsProvided && grams !== Number(orig.estimated_weight_g);

    const provenance = {
      name: nameChanged ? 'user_adjusted' : 'ai_original',
      estimated_weight_g: gramsChanged ? 'user_adjusted' : 'ai_original',
    };

    // Case 1: name unchanged, already grounded -- re-scale the SAME matched
    // row at the new grams. Exact, no approximation.
    if (!nameChanged && orig.db_grounded && orig.matched_source_id && grams > 0) {
      const search = getFoodSearch();
      const row = search?.foods?.find((f) => f.source_id === orig.matched_source_id);
      if (row) {
        const scaled = scaleNutrition(row, grams);
        if (scaled?.totals) {
          groundedCount++;
          resolved.push({
            name, matched_food: row.food_name, matched_source_id: row.source_id,
            estimated_weight_g: grams,
            calories: round1(scaled.totals.energy_kcal ?? 0),
            protein_g: round1(scaled.totals.protein_g ?? 0),
            carbs_g: round1(scaled.totals.carb_g ?? 0),
            fat_g: round1(scaled.totals.fat_g ?? 0),
            assumption: orig.assumption || null,
            db_grounded: true,
            provenance,
          });
          return;
        }
      }
    }

    // Case 2: name changed (or the original had no match to reuse) -- try a
    // fresh resolution against the real database via the same alias-aware
    // path every AI component goes through.
    if (grams > 0) {
      const hit = resolveComponentFood(name);
      if (hit) {
        const scaled = scaleNutrition(hit, grams);
        if (scaled?.totals) {
          groundedCount++;
          resolved.push({
            name, matched_food: hit.food_name, matched_source_id: hit.source_id,
            estimated_weight_g: grams,
            calories: round1(scaled.totals.energy_kcal ?? 0),
            protein_g: round1(scaled.totals.protein_g ?? 0),
            carbs_g: round1(scaled.totals.carb_g ?? 0),
            fat_g: round1(scaled.totals.fat_g ?? 0),
            assumption: orig.assumption || null,
            db_grounded: true,
            provenance,
          });
          return;
        }
      }
    }

    // Case 3: nothing resolves (an unrecognised swapped-in name, or a
    // grams-only edit on a component the AI never grounded). No second AI
    // call is made -- the ORIGINAL component's own implied per-gram
    // density is carried forward to the new gram amount rather than
    // inventing a number, and db_grounded stays false so this is visible.
    const origGrams = Number(orig.estimated_weight_g) || 0;
    const density = origGrams > 0 ? {
      calories: (orig.calories || 0) / origGrams,
      protein_g: (orig.protein_g || 0) / origGrams,
      carbs_g: (orig.carbs_g || 0) / origGrams,
      fat_g: (orig.fat_g || 0) / origGrams,
    } : { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    resolved.push({
      name, matched_food: null, matched_source_id: null,
      estimated_weight_g: grams,
      calories: round1(density.calories * grams),
      protein_g: round1(density.protein_g * grams),
      carbs_g: round1(density.carbs_g * grams),
      fat_g: round1(density.fat_g * grams),
      assumption: orig.assumption || null,
      db_grounded: false,
      provenance,
    });
  });

  const totals = sumComponentTotals(resolved);
  return { components: resolved, totals, groundedCount, totalCount };
}

export function sumComponentTotals(components) {
  return components.reduce((s, c) => ({
    calories: s.calories + (c.calories || 0),
    protein_g: s.protein_g + (c.protein_g || 0),
    carbs_g: s.carbs_g + (c.carbs_g || 0),
    fat_g: s.fat_g + (c.fat_g || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
}

/* ------------------------------------------------------------------ */
/*  Confidence — backend-derived, never AI-chosen                      */
/* ------------------------------------------------------------------ */

/**
 * The AI's own "confidence" field is a hint, not the answer. Final
 * confidence is derived server-side from things that actually predict
 * accuracy: how much of the total is database-grounded, how wide the
 * uncertainty band is relative to the estimate, and whether this is a
 * branded/restaurant item (where we explicitly do NOT have the real
 * recipe, however grounded the ingredient guesses are).
 */
export function deriveConfidence({ groundedCount, totalCount, uncertainty, totals, isBrandedOrRestaurant }) {
  const groundedFraction = totalCount > 0 ? groundedCount / totalCount : 0;
  const spread = totals.calories > 0
    ? (uncertainty.calories_high - uncertainty.calories_low) / totals.calories
    : 1;

  if (isBrandedOrRestaurant) return groundedFraction >= 0.6 && spread <= 0.3 ? 'medium' : 'low';
  if (groundedFraction >= 0.75 && spread <= 0.25) return 'high';
  if (groundedFraction >= 0.4 && spread <= 0.45) return 'medium';
  if (groundedFraction > 0) return 'low';
  return 'unreliable';
}

/* ------------------------------------------------------------------ */
/*  Provider call with fallback                                        */
/* ------------------------------------------------------------------ */

/**
 * Walks PROVIDER_CHAIN in order, calling each configured provider ONLY if
 * the previous one genuinely failed (timeout / rate-limited / 4xx-5xx /
 * malformed JSON / schema-validation failure / unavailable). Stops and
 * returns immediately on the first success -- a successful call NEVER
 * triggers the next provider, which is the whole point of a failover
 * chain rather than a fan-out. `attempts` in the return value is an
 * observability trail (provider name + outcome + reason + latency, NEVER
 * a key or auth header) a caller can log without needing to re-derive it.
 */
async function callWithFallback(system, user) {
  const attempts = [];
  let fallbackDepth = 0;

  for (const provider of PROVIDER_CHAIN) {
    if (!isProviderConfigured(provider)) {
      attempts.push({ provider, outcome: 'skipped_unconfigured' });
      continue;
    }
    if (isOnCooldown(provider)) {
      attempts.push({ provider, outcome: 'skipped_cooldown' });
      continue;
    }
    if (!withinDailyBudget(provider)) {
      attempts.push({ provider, outcome: 'skipped_daily_budget', limit: DAILY_LIMITS[provider] });
      continue;
    }
    const t0 = Date.now();
    try {
      const raw = await callProviderRaw(provider, system, user, {
        json: true, model: FOOD_AI_MODEL, timeoutMs: FOOD_AI_TIMEOUT_MS,
      });
      const latencyMs = Date.now() - t0;
      bumpDailyCount(provider); // a completed call, success or not -- it still spent one of the day's allotment
      const parsed = parseJSON(raw);
      if (!parsed) {
        attempts.push({ provider, outcome: 'failure', reason: 'invalid_json', latencyMs });
        fallbackDepth++;
        continue;
      }
      const validated = validateAIFoodResponse(parsed);
      if (!validated.ok) {
        attempts.push({ provider, outcome: 'failure', reason: 'validation_failed', detail: validated.reason, latencyMs });
        fallbackDepth++;
        continue;
      }
      attempts.push({ provider, outcome: 'success', latencyMs });
      return { ok: true, provider, value: validated.value, attempts, fallbackDepth };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const isRateLimit = /429|rate.?limit/i.test(String(e.message || ''));
      const isTimeout = /timed out/i.test(String(e.message || ''));
      const reason = isRateLimit ? 'rate_limited' : isTimeout ? 'timeout' : 'error';
      if (isRateLimit) markRateLimitCooldown(provider); // back off this provider for a while instead of re-hitting it next request
      else bumpDailyCount(provider); // a rate-limit never reached the vendor as a counted call in most APIs; other failures (timeout aside) generally did
      attempts.push({ provider, outcome: 'failure', reason, detail: e.message, latencyMs });
      fallbackDepth++;
      continue; // try the next provider in the chain
    }
  }

  const lastFailure = [...attempts].reverse().find((a) => a.outcome === 'failure');
  return {
    ok: false,
    error: lastFailure || { reason: attempts.length ? 'all_providers_failed' : 'no_provider_configured' },
    attempts,
    fallbackDepth,
  };
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tier 4: estimate a food SK OS could not resolve any other way.
 *
 * Caller contract: only call this after Tier 1 (and, when it exists in
 * the caller's flow, Tier 2/3) have genuinely failed to produce an
 * acceptable match. This function does not re-check that -- it trusts
 * the caller, per "do not call AI for every food query".
 *
 * Returns a food-v1-compatible result (schema_version kept, fields added
 * per the backward-compatibility rule) with tier: 4, source: 'ai_estimated',
 * a full `components` breakdown, a validated `uncertainty` range, and a
 * `provenance` block. Never throws -- a total failure returns
 * { ok: false, tier: 4, estimate_status: 'unresolved', reason }.
 */
export async function estimateFoodAI(db, params) {
  const { query, brand, restaurant, cuisine, orgId = null, userId = null } = params;
  const { key, isPersonal, displayName } = canonicalizeFoodQuery(query, { brand, restaurant });

  // --- cache check (skipped for personal-possessive queries) ---
  if (!isPersonal && db) {
    const cached = await getCachedEstimate(db, key);
    if (cached && cached.nutrition && Object.keys(cached.nutrition).length) {
      await bumpCacheUsage(db, key);
      track(db, { type: 'food_ai_cache_hit', orgId, userId, data: { key } }).catch(() => {});
      return shapeCachedResult(cached, displayName);
    }
    track(db, { type: 'food_ai_cache_miss', orgId, userId, data: { key } }).catch(() => {});
  }

  if (!isFoodAIAvailable()) {
    track(db, { type: 'food_ai_unavailable', orgId, userId, data: { key } }).catch(() => {});
    // `error` alongside `reason`: this response reaches the browser and
    // the frontend's api() helper reads response.error/.message for its
    // thrown Error -- without it, a genuinely useful reason ("no AI
    // provider configured") was replaced client-side by api.js's generic
    // 'Request failed' fallback. Found via a live check, not a test.
    return {
      ok: false, schema_version: 'food-v1', tier: 4, estimate_status: 'unresolved',
      reason: 'No AI provider is configured or available for food estimation.',
      error: 'No AI provider is configured or available for food estimation.',
      food_name: displayName,
    };
  }

  const references = gatherMeasuredReferences(query);
  const userMessage = buildUserMessage(params, references);

  track(db, { type: 'food_ai_tier4_call', orgId, userId, data: { key, chain: PROVIDER_CHAIN } }).catch(() => {});
  const t0 = Date.now();
  const result = await callWithFallback(SYSTEM_PROMPT, userMessage);
  const latencyMs = Date.now() - t0;
  // Observability trail -- provider names, outcomes, reasons and latency
  // ONLY. Never a key, an auth header, or a raw provider response body.
  const providersAttempted = result.attempts.filter((a) => a.outcome !== 'skipped_unconfigured').map((a) => a.provider);
  const providersFailed = result.attempts.filter((a) => a.outcome === 'failure').map((a) => ({ provider: a.provider, reason: a.reason }));

  if (!result.ok) {
    const reason = result.error?.reason || 'unknown_error';
    track(db, {
      type: `food_ai_failure_${reason}`, orgId, userId,
      data: { key, detail: result.error?.detail, latencyMs, provider_attempted: providersAttempted, provider_failure: providersFailed, fallback_depth: result.fallbackDepth },
    }).catch(() => {});
    track(db, {
      type: 'food_ai_tier4_failure', orgId, userId,
      data: { key, reason, provider_attempted: providersAttempted, failure_reason: reason, fallback_depth: result.fallbackDepth },
    }).catch(() => {});
    const message = `Could not produce an AI estimate (${reason}).`;
    return {
      ok: false, schema_version: 'food-v1', tier: 4, estimate_status: 'unresolved',
      reason: message, error: message,
      food_name: displayName,
    };
  }

  track(db, {
    type: 'food_ai_tier4_success', orgId, userId,
    data: {
      key, provider: result.provider, latencyMs,
      provider_attempted: providersAttempted, provider_success: result.provider,
      provider_failure: providersFailed, fallback_depth: result.fallbackDepth,
    },
  }).catch(() => {});

  const ai = result.value;
  const { components, groundedCount, totalCount } = resolveComponents(ai.components);
  const totals = sumComponentTotals(components);
  const uncertainty = resolveUncertainty(ai.uncertainty, totals);
  const isBrandedOrRestaurant = !!(ai.is_branded_or_restaurant || brand || restaurant);
  const confidence = deriveConfidence({ groundedCount, totalCount, uncertainty, totals, isBrandedOrRestaurant });

  const disclaimer = isBrandedOrRestaurant
    ? "We don't have verified exact nutrition for this brand/restaurant item. Estimated from typical preparation for this category — not the real recipe."
    : "We don't have a verified match for this food. We estimated it using the dish name and preparation assumptions.";

  const out = {
    ok: true,
    schema_version: 'food-v1',
    tier: 4,
    estimate: true,
    estimate_status: 'ai_estimated',
    food_name: ai.food_name || displayName,
    cuisine: ai.cuisine || cuisine || null,
    food_type: ai.food_type || 'composite_dish',
    is_branded_or_restaurant: isBrandedOrRestaurant,
    serving: ai.serving,
    components,
    totals: {
      calories: Math.round(totals.calories),
      protein: round1(totals.protein_g),
      carbs: round1(totals.carbs_g),
      fat: round1(totals.fat_g),
    },
    uncertainty,
    confidence,
    assumptions: Array.isArray(ai.assumptions) ? ai.assumptions.slice(0, 10) : [],
    needs_user_confirmation: Array.isArray(ai.needs_user_confirmation) ? ai.needs_user_confirmation.slice(0, 10) : [],
    disclaimer,
    source: 'ai_estimated',
    ai: { provider: result.provider, model: FOOD_AI_MODEL || null },
    // A brand-new estimate always starts here -- see foodFeedback.js for
    // how (and only how) it can move to COMMUNITY_VALIDATED_CANDIDATE.
    validation_status: 'AI_ESTIMATED',
    provenance: { tier: 4, source: 'ai_estimated', match_kind: 'ai_food_composition', grounded_components: groundedCount, total_components: totalCount },
    // Never write this result into the measured food DB or the ML
    // training set -- it is synthetic, not ground truth. See the
    // "no data leakage" rule this file's callers must honour.
    cache_key: isPersonal ? null : key,
  };

  if (!isPersonal && db) {
    await saveCachedEstimate(db, key, out.food_name, {
      nutrition: out.totals,
      uncertainty,
      componentTemplate: components,
      assumptions: out.assumptions,
      source: 'ai_estimated',
      aiProvider: result.provider,
      aiModel: FOOD_AI_MODEL,
      confidence,
      cuisine: out.cuisine,
    });
  }

  return out;
}

function shapeCachedResult(cached, displayName) {
  return {
    ok: true,
    schema_version: 'food-v1',
    tier: 4,
    estimate: true,
    estimate_status: 'ai_estimated',
    food_name: cached.canonical_name || displayName,
    cuisine: cached.cuisine || null,
    components: cached.component_template,
    totals: cached.nutrition,
    uncertainty: cached.uncertainty,
    confidence: cached.confidence,
    assumptions: cached.assumptions,
    needs_user_confirmation: [],
    disclaimer: "We don't have a verified match for this food. We estimated it using the dish name and preparation assumptions (from a previously confirmed estimate).",
    source: cached.source || 'ai_estimated',
    ai: { provider: cached.ai_provider, model: cached.ai_model },
    // AI_ESTIMATED | COMMUNITY_VALIDATED_CANDIDATE | VERIFIED_SHARED_FOOD --
    // see foodFeedback.js. Distinct from `confidence` (the AI's own
    // per-estimate confidence) -- this is about how much independent
    // community evidence backs the CACHED value, never conflated with a
    // Tier-1/3 search-match percentage (a completely different concept).
    validation_status: cached.validation_status || 'AI_ESTIMATED',
    provenance: { tier: 4, source: 'ai_estimated', match_kind: 'ai_food_composition_cached' },
    from_cache: true,
    cache_key: cached.canonical_key,
  };
}

// Exported for backend/scripts/food-ai-smoke.js -- the optional real-API
// smoke test reuses the EXACT prompt/reference-gathering logic production
// calls use (same food-v1 JSON contract, same measured-food anchoring)
// rather than a second, drifting copy of the prompt.
export { SYSTEM_PROMPT, buildUserMessage, gatherMeasuredReferences };
// Exported for foodFeedback.js -- an aggregated community correction must
// pass the SAME physical-plausibility bar a fresh AI response does before
// it's ever allowed to update the shared cache. One centralized check,
// not a second copy of the Atwater math.
export { atwaterConsistent };

// TEST-ONLY: clears the in-process rate-limit-cooldown and daily-call-count
// state. Without this, one test that deliberately triggers a 429 leaves a
// LATER test's supposedly-fresh scenario silently skipping that provider
// (skipped_cooldown) instead of genuinely exercising it -- module state
// persists for the whole test file's process, the same way PROVIDER_CHAIN
// itself does. Never used outside tests.
export function _resetCostSafetyStateForTests() {
  _cooldownUntil.clear();
  _dailyCount.clear();
  _dayKey = null;
}

export default {
  isFoodAIAvailable, foodAIConfigSummary, estimateFoodAI, validateAIFoodResponse,
  resolveUncertainty, resolveComponents, sumComponentTotals, deriveConfidence,
  recomputeAdjustedComponents,
};
