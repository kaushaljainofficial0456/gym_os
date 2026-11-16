// ============================================================
// DIET AND FOODS TO AVOID — applied to what the plate proposes.
// (Nutrition overhaul, Phase 2.)
//
// client_profiles.diet_type and food_exclusions existed but nothing in the
// food engine read them. Two narrow uses, both visible on the item:
//
//   DIET DEFAULT   an UMBRELLA word ("biryani") that the catalogue resolves
//                  to a non-vegetarian dish by default is resolved to the
//                  vegetarian version for a VEG / VEGAN / EGGETARIAN profile.
//                  A food NAMED explicitly ("chicken biryani") is never
//                  changed: the person said what they ate.
//   AVOID FLAG     an item whose name, catalogue title, everyday names or --
//                  for a computed recipe -- ingredients match a food the
//                  person listed to avoid is flagged, with the words that
//                  matched. It is NOT removed or changed: they may have eaten
//                  it, and the log should be true. For a database dish the
//                  full ingredient list is unknown, which the flag says.
//
// This is a convenience and a prompt, not an allergy guarantee: the flag can
// only see what the catalogue names. The UI words it that way.
// ============================================================
'use strict';

import { plateItemFor, getFoodSearch } from '../foodEstimator.js';
import { stapleByKey, normStaple } from '../food/staples.js';
import { phraseOf } from './corrections.js';

export const DIET_TYPES = Object.freeze(['VEG', 'NON_VEG', 'VEGAN', 'EGGETARIAN']);

const MEAT_FISH = /\b(chicken|mutton|lamb|goat|beef|pork|fish|prawn|prawns|shrimp|crab|meat|keema|tandoori chicken)\b/i;
const EGG = /\b(egg|eggs|omelette|anda)\b/i;

/** Is a staple (by key and name) unsuitable for this diet? */
function unsuitable(st, dietType) {
  if (!st || !dietType || dietType === 'NON_VEG') return false;
  const text = `${st.key.replace(/_/g, ' ')} ${st.name}`;
  if (MEAT_FISH.test(text)) return true;
  if ((dietType === 'VEG' || dietType === 'VEGAN') && EGG.test(text)) return true;
  return false;
}

/* What a listed word also means. "dairy" is a category, not a food name;
   "groundnut" is the Indian name for peanut. Kept short and literal --
   every entry is a word that appears in catalogue titles or staple names. */
const AVOID_SYNONYMS = {
  peanut: ['peanut', 'groundnut', 'ground nut', 'moongphali', 'mungfali'],
  egg: ['egg', 'omelette', 'anda'],
  milk: ['milk', 'dairy'],
  dairy: ['milk', 'curd', 'dahi', 'paneer', 'ghee', 'butter', 'cheese', 'cream', 'yogurt', 'yoghurt', 'lassi', 'chaas', 'raita', 'kheer', 'khoa', 'khoya', 'malai'],
  lactose: ['milk', 'curd', 'dahi', 'paneer', 'cheese', 'cream', 'yogurt', 'lassi', 'kheer', 'khoa', 'malai'],
  gluten: ['wheat', 'atta', 'maida', 'roti', 'chapati', 'paratha', 'naan', 'bread', 'toast', 'semolina', 'suji', 'rava', 'pasta', 'biscuit', 'barley', 'pav', 'kulcha', 'bhatura', 'puri'],
  wheat: ['wheat', 'atta', 'maida', 'roti', 'chapati', 'paratha', 'naan', 'bread', 'semolina', 'suji', 'rava', 'pav'],
  nut: ['almond', 'cashew', 'walnut', 'pistachio', 'pista', 'kaju', 'badam', 'peanut', 'groundnut'],
  nuts: ['almond', 'cashew', 'walnut', 'pistachio', 'pista', 'kaju', 'badam', 'peanut', 'groundnut'],
  shellfish: ['prawn', 'shrimp', 'crab', 'lobster'],
  soy: ['soya', 'soy', 'tofu', 'nutrela'],
  soya: ['soya', 'soy', 'tofu', 'nutrela'],
  sesame: ['sesame', 'til', 'gingelly'],
  meat: ['chicken', 'mutton', 'lamb', 'goat', 'beef', 'pork', 'keema'],
};

const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The words to look for, from the profile's free-text list. */
export function avoidTerms(exclusions) {
  const listed = String(exclusions || '').split(/[,;\n]/).map((x) => normStaple(x)).filter(Boolean).slice(0, 20);
  return listed.map((w) => {
    const key = singular(w);
    const also = AVOID_SYNONYMS[w] || AVOID_SYNONYMS[key] || [];
    return { listed: w, words: [...new Set([w, key, ...also])] };
  });
}

/** Everything an item is known to be or contain, as one lower-case string. */
function knownContents(item) {
  const parts = [item.name, item.source_name];
  const st = item.staple_key ? stapleByKey(item.staple_key) : null;
  if (st) parts.push(st.name, ...(st.aliases || []));
  // A computed recipe's ingredients are known exactly (food/recipes.js).
  const row = item.staple_key ? getFoodSearch()?.stapleRowByKey?.(item.staple_key) : null;
  for (const c of row?.recipe?.components || []) parts.push(c.food_name);
  return ` ${normStaple(parts.filter(Boolean).join(' '))} `;
}

const has = (text, word) => text.includes(` ${word} `) || text.includes(` ${word}s `);

/**
 * @param {object} described  a describeMeal() result (plate items)
 * @param {{dietType?:string|null, exclusions?:string|null}} profile
 */
export function applyDietAndExclusions(described, { dietType = null, exclusions = null } = {}) {
  const diet = dietType ? String(dietType).toUpperCase() : null;
  const terms = avoidTerms(exclusions);
  if (!described?.items?.length || ((!diet || diet === 'NON_VEG') && !terms.length)) return described;

  const items = described.items.map((item) => {
    let out = item;
    // DIET DEFAULT -- only for an umbrella word the person did not qualify.
    const st = item.staple_key ? stapleByKey(item.staple_key) : null;
    const said = phraseOf(item.matched_from || '');
    const umbrella = !!said && (st?.vague || []).map(normStaple).includes(said);
    if (st && umbrella && unsuitable(st, diet)) {
      const vegKey = (st.alts || []).find((k) => !unsuitable(stapleByKey(k), diet));
      const veg = vegKey ? plateFor(vegKey) : null;
      if (veg) {
        const unit = veg.units.find((u) => u.label === (item.units || []).find((x) => x.key === item.unit_key)?.label);
        const next = unit ? { ...veg, unit_key: unit.key, qty: item.qty } : veg;
        const grams = Math.round((unit ? unit.grams * item.qty : veg.grams) * 10) / 10;
        const f = grams / 100;
        out = {
          ...next,
          grams,
          calories: Math.round((next.per100.calories || 0) * f),
          protein: Math.round((next.per100.protein || 0) * f * 10) / 10,
          carbs: Math.round((next.per100.carbs || 0) * f * 10) / 10,
          fat: Math.round((next.per100.fat || 0) * f * 10) / 10,
          matched_from: item.matched_from,
          assumed: item.assumed,
          alternatives: [{ source_id: item.source_id, staple_key: item.staple_key, name: item.name }, ...(veg.alternatives || [])].slice(0, 3),
          personalized: [...(item.personalized || []), { kind: 'diet', scope: 'personal', note: `Your diet is ${diet.toLowerCase().replace('_', '-')}: ${veg.name}` }],
        };
      }
    }
    // AVOID FLAG.
    if (terms.length) {
      const text = knownContents(out);
      const hits = terms.filter((t) => t.words.some((w) => has(text, normStaple(w)))).map((t) => t.listed);
      const fullyKnown = out.source === 'SKOS_RECIPE' || ['IFCT2017', 'USDA_FDC', 'CNF_CANADA'].includes(out.source);
      if (hits.length) {
        out = {
          ...out,
          avoid: {
            terms: hits,
            note: `You listed “${hits.join('”, “')}” to avoid${fullyKnown ? '' : ' — this dish’s full ingredients are not known, so check'}.`,
          },
        };
      } else if (!fullyKnown) {
        // A database dish whose recipe is not known (INDB, a packaged
        // label): no match is NOT a clean bill -- say it was not checked.
        out = { ...out, avoid_unchecked: true };
      }
    }
    return out;
  });
  return { ...described, items };
}

/** plateItemFor by staple key (the staple's own row id). */
function plateFor(key) {
  const st = stapleByKey(key);
  if (!st) return null;
  const sid = st.recipe ? `recipe:${st.recipe}` : st.ref || `staple:${st.key}`;
  return plateItemFor(sid, { stapleKey: key });
}
