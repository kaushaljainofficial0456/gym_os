// ============================================================
// SKOS FOOD ENGINE — COVERAGE ACCOUNTING ("zero silent food drops")
//
// The meal parser turns a sentence into items. Every way it has ever lost
// food did so the same way: a fragment resolved to SOMETHING, so nothing was
// reported unresolved, and part of what the person wrote simply vanished.
//
//   "masala dosa with sambar"      -> Masala dosa              (sambar gone)
//   "rice with rajma"              -> Rajmah, raw dried        (rice gone)
//   "chole bhature"                -> Chickpeas curry          (bhature gone)
//   "paneer bhurji"                -> Paneer                   (bhurji gone)
//   "puran poli"                   -> Polish sausage           (nothing shared)
//
// This module makes that failure detectable. It answers two questions about
// a fragment and the items it produced, using nothing but words:
//
//   1. Which words in the fragment NAME FOOD? (contentTokens) -- quantities,
//      units, narration ("i ate"), and context words ("homemade") are not.
//   2. Which of those words does an item EXPLAIN? (explainedBy) -- its own
//      name, the measured row's title (INDB titles carry regional names in
//      brackets), and, for a curated staple, every alias the staple answers to.
//
// Anything left over is an unaccounted word. The parser (foodEstimator.js)
// then either recovers it as a food in its own right or reports it -- it may
// never be dropped quietly. This file contains no I/O and no search; it is
// pure and unit-tested.
// ============================================================
'use strict';

/** Narration and filler: never part of a food name. Superset of the
 *  parser's NOISE list, plus words that only ever describe the eating. */
const FILLER = new Set([
  'of', 'with', 'and', 'plus', 'some', 'my', 'the', 'a', 'an', 'had', 'have', 'ate', 'eat',
  'eaten', 'for', 'breakfast', 'lunch', 'dinner', 'snack', 'snacks', 'today', 'i', 'also',
  'then', 'about', 'approx', 'approximately', 'around', 'just', 'little', 'bit', 'few',
  'along', 'together', 'in', 'on', 'at', 'to', 'from', 'as', 'it', 'its', 'was', 'were',
  'is', 'some', 'like', 'more', 'less', 'extra', 'side', 'sides', 'yesterday', 'tonight',
  'morning', 'evening', 'night', 'afternoon', 'post', 'pre', 'workout', 'meal',
]);

/**
 * Context words: they say WHERE or HOW the food was made, not WHAT it is.
 * They are stripped from the search name (left in, "homemade" made "2
 * homemade aloo parathas" match USDA "Potato pancake, homemade") but they
 * are recorded, because "restaurant" is real information about oil.
 *
 * Deliberately excluded: hot / cold / fresh / plain -- "cold coffee", "hot
 * chocolate", "fresh lime soda" and "plain dosa" are names, not context.
 */
export const CONTEXT_WORDS = new Map([
  ['homemade', 'homemade'], ['home', 'homemade'], ['ghar', 'homemade'], ['gharka', 'homemade'],
  ['restaurant', 'restaurant'], ['hotel', 'restaurant'], ['dhaba', 'restaurant'],
  ['takeaway', 'restaurant'], ['takeout', 'restaurant'], ['outside', 'restaurant'],
  ['street', 'street'], ['stall', 'street'], ['thela', 'street'],
  ['canteen', 'canteen'], ['mess', 'canteen'], ['tiffin', 'homemade'],
  ['leftover', null], ['leftovers', null], ['desi', null], ['simple', null], ['normal', null],
  ['regular', null], ['usual', null], ['typical', null], ['style', null], ['made', null],
  ['moms', 'homemade'], ['mom', 'homemade'], ['mummy', 'homemade'], ['maa', 'homemade'],
  ['tasty', null], ['yummy', null], ['delicious', null], ['spicy', null], ['mild', null],
  // "a side salad", "side of fries": how it was served, not what it is.
  ['side', null],
]);

/**
 * Words that name a WAY OF PREPARING something, not a separate food:
 * "paneer BHURJI", "aloo TIKKI", "chicken CURRY", "gobi MANCHURIAN". When a
 * dish of this form has no row of its own, the leftover word describes the
 * food that WAS matched -- it must be flagged on that item, never recovered
 * as a second food ("bhurji" alone is a curated alias of egg bhurji, and
 * adding it to "paneer bhurji" counted an egg nobody ate).
 */
// Standalone foods that are also eaten as sides (dosa, vada, paratha,
// butter, biryani, raita when after a curry...) are deliberately NOT here:
// "idli vada" and "bread butter" are two foods. A word on this list is
// flagged rather than recovered -- a false flag costs the person one tap; a
// false recovery is a double count.
export const PREPARATION_FORMS = new Set([
  'bhurji', 'curry', 'masala', 'fry', 'fried', 'tikka', 'tikki', 'kebab', 'kabab', 'kabob',
  'sabzi', 'sabji', 'subzi', 'bhaji', 'pakora', 'pakoda', 'bhajiya', 'bajji', 'halwa', 'kheer',
  'korma', 'kadhai', 'kadai', 'karahi', 'makhani', 'tadka', 'tarka', 'roast', 'gravy', 'dry',
  'manchurian', 'chilli', 'chili', 'kofta', 'kurma', 'stew', 'soup', 'salad', 'chaat', 'cutlet',
  'bhuna', 'pyaza', 'dopiaza', 'jalfrezi', 'vindaloo', 'saag', 'thoran',
  'poriyal', 'usal', 'amti', 'jhol', 'kalia', 'bharta', 'bharwa', 'shahi', 'lababdar', 'stuffed',
  'steamed', 'grilled', 'baked', 'boiled', 'scrambled', 'poached', 'tandoori', 'achari',
]);

/** True when every word of a run is a preparation form. */
export function isPreparationRun(run) {
  return Array.isArray(run) && run.length > 0 && run.every((t) => PREPARATION_FORMS.has(String(t).toLowerCase()));
}

/** Size words. Recorded, not silently applied: a "large" roti is an
 *  observation the portion estimate should show it did not use. */
export const SIZE_WORDS = new Set(['small', 'medium', 'large', 'big', 'huge', 'mini', 'jumbo', 'full', 'regular-size']);

/** Measurement and container words (singular and plural). */
const UNIT_WORDS = new Set([
  'g', 'gm', 'gms', 'gram', 'grams', 'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms',
  'ml', 'millilitre', 'milliliter', 'millilitres', 'milliliters', 'l', 'litre', 'liter', 'litres', 'liters',
  'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'tsp', 'teaspoon', 'teaspoons',
  'tbsp', 'tablespoon', 'tablespoons', 'cup', 'cups', 'bowl', 'bowls', 'katori', 'katoris',
  'plate', 'plates', 'glass', 'glasses', 'mug', 'mugs', 'piece', 'pieces', 'pc', 'pcs',
  'slice', 'slices', 'serving', 'servings', 'portion', 'portions', 'handful', 'handfuls',
  'spoon', 'spoons', 'ladle', 'ladles', 'scoop', 'scoops', 'pack', 'packs', 'packet', 'packets',
  'can', 'cans', 'bottle', 'bottles', 'half', 'quarter', 'dozen', 'couple', 'pair', 'nos', 'no',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'x',
]);

/** Lowercase, strip accents and punctuation, split on whitespace. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A crude, deterministic stem good enough to say two spellings are the same
 * word: plural s/es off, then one trailing vowel off. "parathas" ~
 * "paratha", "bhature" ~ "bhatura", "rotis" ~ "roti", "chole" ~ "chola".
 * Short words are left alone so "dal" and "egg" stay themselves.
 */
export function stem(tok) {
  let t = String(tok || '');
  if (t.length > 4 && t.endsWith('es') && !t.endsWith('ies')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 4 && /[aeiou]$/.test(t)) t = t.slice(0, -1);
  return t;
}

const isNumberish = (t) => /^\d+(\.\d+)?$/.test(t) || /^\d+(\.\d+)?[a-z]+$/.test(t) || /^\d+\/\d+$/.test(t);

/**
 * The words in `text` that name food, in order, with the context and size
 * words that were set aside. Pure.
 */
export function contentTokens(text) {
  const out = [];
  const context = [];
  const sizes = [];
  for (const t of tokenize(text)) {
    if (isNumberish(t)) continue;
    if (FILLER.has(t) || UNIT_WORDS.has(t)) continue;
    if (CONTEXT_WORDS.has(t)) { const c = CONTEXT_WORDS.get(t); if (c && !context.includes(c)) context.push(c); continue; }
    if (SIZE_WORDS.has(t)) { if (!sizes.includes(t)) sizes.push(t); continue; }
    if (t.length < 2) continue;
    out.push(t);
  }
  return { tokens: out, context, sizes };
}

/** Remove context words from a food name ("homemade aloo parathas" ->
 *  "aloo parathas"). Leaves everything else exactly as it was. */
export function stripContextWords(name) {
  const toks = String(name || '').split(/\s+/).filter(Boolean);
  const kept = toks.filter((t) => !CONTEXT_WORDS.has(t.toLowerCase().replace(/[^a-z]/g, '')));
  return kept.length ? kept.join(' ') : String(name || '');
}

/** Words that are synonyms across the languages people log in. Each group
 *  is one food word; seeing any member explains the others. Kept to pairs
 *  where the two words are interchangeable in a food name. */
const SYNONYM_GROUPS = [
  ['rice', 'chawal', 'chaawal', 'bhaat', 'bhat', 'annam', 'saadam', 'sadam'],
  ['roti', 'chapati', 'chapatti', 'chapathi', 'phulka', 'fulka'],
  ['curd', 'dahi', 'yogurt', 'yoghurt', 'thayir', 'mosaru'],
  ['dal', 'daal', 'dhal', 'lentil', 'lentils', 'paruppu', 'pappu', 'varan'],
  ['potato', 'aloo', 'alu', 'batata', 'urulai'],
  ['chickpea', 'chickpeas', 'chole', 'chhole', 'chana', 'channa', 'kabuli'],
  ['kidney', 'rajma', 'rajmah'],
  ['spinach', 'palak'],
  ['cauliflower', 'gobi', 'gobhi', 'phoolgobhi'],
  ['egg', 'eggs', 'anda', 'ande', 'omelette', 'omelet'],
  ['milk', 'doodh', 'paal'],
  ['tea', 'chai', 'chaha'],
  ['buttermilk', 'chaas', 'chhachh', 'mattha', 'majjige'],
  ['flattened', 'poha', 'pohe', 'aval', 'avalakki', 'chivda', 'chirwa'],
  ['semolina', 'rava', 'rawa', 'suji', 'sooji'],
  ['sago', 'sabudana', 'sabudhana'],
  ['gram', 'besan'],
  ['cottage', 'paneer'],
  ['okra', 'bhindi'],
  ['brinjal', 'eggplant', 'baingan', 'vangi'],
  ['peas', 'matar', 'mutter'],
  ['bread', 'pav', 'pao', 'bun'],
  ['sorghum', 'jowar', 'jwari'],
  ['millet', 'bajra', 'bajri', 'ragi', 'nachni'],
  ['fenugreek', 'methi'],
  ['banana', 'kela'],
  ['mutton', 'goat', 'lamb'],
  ['chicken', 'murgh', 'murg', 'kozhi'],
  ['fish', 'machli', 'macchi', 'meen'],
  ['prawn', 'prawns', 'shrimp', 'jhinga'],
  ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'shengdana', 'moongphali'],
  ['vegetable', 'vegetables', 'veg', 'sabzi', 'sabji', 'subzi', 'bhaji', 'shaak', 'poriyal', 'palya'],
  ['juice', 'ras'],
  ['sugar', 'cheeni', 'shakkar'],
  ['jaggery', 'gur', 'gud', 'bellam', 'vellam'],
  ['ghee', 'clarified'],
  ['coffee', 'kaapi', 'kapi'],
];
const SYN = new Map();
for (const group of SYNONYM_GROUPS) {
  const stems = group.map(stem);
  for (const s of stems) {
    const set = SYN.get(s) || new Set();
    stems.forEach((x) => set.add(x));
    SYN.set(s, set);
  }
}

/** All the stems a word stands for (itself plus its synonyms). */
function expand(tok) {
  const s = stem(tok);
  return SYN.get(s) || new Set([s]);
}

/**
 * Build the set of stems an item can account for. `phrases` is every
 * string the item answers to: its display name, the measured row's title,
 * and a staple's aliases. Titles like "Curd rice (Dahi bhaat/Dahi chawal/
 * Perugu annam)" carry their regional names, and every one counts.
 */
export function explainedStems(phrases) {
  const out = new Set();
  for (const p of phrases || []) {
    for (const t of tokenize(p)) {
      for (const s of expand(t)) out.add(s);
    }
  }
  return out;
}

/** Is `tok` accounted for by `stems`? Exact stem or synonym, or a near-
 *  spelling of a long word (one-letter difference at the end). */
export function isExplained(tok, stems) {
  for (const s of expand(tok)) {
    if (stems.has(s)) return true;
  }
  const s = stem(tok);
  if (s.length >= 5) {
    for (const e of stems) {
      if (e.length >= 5 && (e.startsWith(s) || s.startsWith(e)) && Math.abs(e.length - s.length) <= 1) return true;
    }
  }
  return false;
}

/**
 * The content words of `fragment` that none of `phrases` explains, grouped
 * into contiguous runs in the order they were written.
 *   ("masala dosa with sambar", ["Masala dosa"]) -> [["sambar"]]
 *   ("2 idli sambar", ["Idli", "Sambar"])        -> []
 */
export function uncoveredRuns(fragment, phrases) {
  const stems = explainedStems(phrases);
  const runs = [];
  let cur = [];
  // Walk the RAW token stream so a run is broken by anything in between
  // ("dal and rice" never becomes the run "dal rice").
  const content = new Set(contentTokens(fragment).tokens);
  for (const t of tokenize(fragment)) {
    if (!content.has(t)) { if (cur.length) { runs.push(cur); cur = []; } continue; }
    if (isExplained(t, stems)) { if (cur.length) { runs.push(cur); cur = []; } continue; }
    cur.push(t);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Does a candidate match share at least one food word with the query?
 * Used to refuse a lexical accident ("puran poli" -> "Polish sausage",
 * which shares no word, only the letters "poli"). An alias match is vouched
 * for by the alias table and is not checked here.
 */
export function sharesFoodWord(query, phrases) {
  const { tokens } = contentTokens(query);
  if (!tokens.length) return true; // nothing to compare: not this check's call
  const stems = explainedStems(phrases);
  return tokens.some((t) => isExplained(t, stems));
}
