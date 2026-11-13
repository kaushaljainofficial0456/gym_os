// ============================================================
// SKOS FOOD ENGINE — CONFIDENCE BY DIMENSION
//
// One label used to stand for everything: the matched ROW's own confidence.
// "2 roti" and "200 g chicken breast" both came back `high`, though only one
// of them names its weight. The benchmark showed the cost: items labelled
// `high` were right 73% of the time against a nominal 90%.
//
// An estimate can be wrong in three independent ways, so it is scored on
// three independent dimensions, each from EVIDENCE the engine actually has:
//
//   identification  did we find the food that was named?
//                   curated exact name / exact title -> high; a vague word
//                   ("sabzi") or a partial-word match -> medium; a match the
//                   search reached by dropping words or correcting spelling,
//                   or one with words left unaccounted for -> low
//   portion         how sure is the amount?
//                   weighed/measured grams or a pack label -> high; a stated
//                   count or household unit (2 roti, 1 katori) -> medium; no
//                   amount said, a default serving or an assumed 100 g -> low
//   composition     how well do these per-100 g values describe THIS plate?
//                   a lab-measured single ingredient or a printed label ->
//                   high; a cooked dish (recipes vary between kitchens), a
//                   recipe calculation, a crowd-sourced label -> medium; an
//                   AI or similar-food estimate, or a restaurant dish (oil
//                   unknown) -> low
//
//   overall = the WEAKEST of the three. An exact weight of an unknown dish
//   is not a confident estimate, and neither is a perfectly identified food
//   of unknown size.
//
// Every dimension carries the reasons that produced it, so the UI can say
// WHY ("we assumed one katori") and ask the right question.
// ============================================================
'use strict';

const RANK = { high: 0, medium: 1, low: 2, unreliable: 3 };
const BY_RANK = ['high', 'medium', 'low', 'unreliable'];
export const weakest = (...levels) => BY_RANK[Math.max(...levels.map((l) => RANK[l] ?? 2))];

const LAB_SOURCES = new Set(['IFCT2017', 'USDA_FDC', 'CNF_CANADA']);
// A MIXED dish varies between kitchens; a plain cooked ingredient (boiled
// rice, grilled chicken breast, a boiled egg) does not, in any way that
// matters here. Variability comes from being a dish, not from being cooked.
const MIXED_DISH = /indian_dish|dish|meal|curry|recipe|sabzi|snack|sweet/i;

/**
 * @param {object} ev   evidence gathered while resolving one item:
 *   match_kind, staple_match ('exact'|'tokens'|...), vague, query_relaxed,
 *   fuzzy_corrected, unmatched_terms[], grams_basis, grams_assumed,
 *   qty_stated, unit_stated, source, category, cooking_state, basis,
 *   context[], sizes[], estimate_kind ('ai'|'knn'|null)
 * @returns {{identification:string, portion:string, composition:string,
 *            overall:string, reasons:{identification:string[], portion:string[], composition:string[]}}}
 */
export function confidenceBreakdown(ev = {}) {
  const reasons = { identification: [], portion: [], composition: [] };

  /* ---- identification ---- */
  let id;
  if (ev.estimate_kind) {
    id = 'low'; reasons.identification.push('estimated from similar foods, not a direct match');
  } else if (ev.unmatched_terms?.length) {
    id = 'low'; reasons.identification.push(`“${ev.unmatched_terms.join('”, “')}” not reflected in the match`);
  } else if (ev.fuzzy_corrected) {
    id = 'low'; reasons.identification.push('matched after correcting the spelling');
  } else if (ev.query_relaxed) {
    id = 'low'; reasons.identification.push('matched on part of the name only');
  } else if (ev.staple_match === 'exact' && !ev.vague) {
    id = 'high'; reasons.identification.push('exact everyday name');
  } else if (ev.staple_match) {
    id = 'medium'; reasons.identification.push('a general name — a specific variant may differ');
  } else if (ev.match_kind === 'exact_name' || ev.match_kind === 'alias_exact') {
    id = 'high'; reasons.identification.push('exact database name');
  } else if (ev.match_kind === 'all_tokens' || ev.match_kind === 'name_prefix' || ev.match_kind === 'head_noun' || ev.match_kind === 'composite_dish') {
    id = 'medium'; reasons.identification.push('closest database name, not an exact one');
  } else {
    id = 'low'; reasons.identification.push('weak name match');
  }

  /* ---- portion ---- */
  let por;
  const basis = ev.grams_basis;
  if (basis === 'measured' || basis === 'grams') {
    por = 'high'; reasons.portion.push('amount given by weight or volume');
  } else if (ev.grams_assumed || basis === 'assumed_100g' || basis === 'estimated') {
    por = 'low'; reasons.portion.push(basis === 'assumed_100g' ? 'no amount given — 100 g assumed' : 'no amount given — a typical serving assumed');
  } else if (ev.qty_stated || ev.unit_stated) {
    por = 'medium'; reasons.portion.push('household amount (pieces, katori, cup) — sizes vary');
  } else {
    por = 'low'; reasons.portion.push('a typical serving assumed');
  }
  if (ev.sizes?.length && por !== 'high') {
    por = 'low'; reasons.portion.push(`“${ev.sizes.join('”, “')}” noted but a standard size was used`);
  }

  /* ---- composition ---- */
  let comp;
  const dish = ev.source === 'INDB' || MIXED_DISH.test(String(ev.category || ''));
  if (ev.estimate_kind === 'ai' || ev.estimate_kind === 'knn') {
    comp = 'low'; reasons.composition.push(ev.estimate_kind === 'ai' ? 'AI estimate' : 'estimated from similar foods');
  } else if (ev.source === 'SKOS_RECIPE' || ev.basis === 'recipe') {
    comp = 'medium'; reasons.composition.push('standard recipe — your recipe may differ');
  } else if (ev.source === 'OPEN_FOOD_FACTS') {
    comp = 'medium'; reasons.composition.push('product label (crowd-sourced transcription)');
  } else if (ev.basis === 'label') {
    comp = 'high'; reasons.composition.push('printed nutrition label');
  } else if (dish) {
    comp = 'medium'; reasons.composition.push('cooked dish — recipes vary between kitchens');
  } else if (LAB_SOURCES.has(ev.source) || ev.basis === 'usda') {
    comp = 'high'; reasons.composition.push('measured food-composition data');
  } else {
    comp = 'medium'; reasons.composition.push('curated value');
  }
  if (ev.context?.includes('restaurant') && (dish || ev.cooking_state === 'cooked') && comp !== 'low') {
    comp = 'low'; reasons.composition.push('restaurant preparation — oil and portions often higher');
  }

  return {
    identification: id,
    portion: por,
    composition: comp,
    overall: weakest(id, por, comp),
    reasons,
  };
}
