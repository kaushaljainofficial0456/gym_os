// ============================================================
// ZERO SILENT FOOD DROPS — coverage accounting (food/coverage.js) and the
// meal-parser fixes that rely on it (foodEstimator.js).
//
// The invariant test at the bottom is the one that matters: for a broad set
// of real meal descriptions, EVERY food word the person wrote must end up in
// exactly one of three places -- a logged item that names it, the
// `unresolved` list, or `needs_clarification`. Nothing may simply vanish.
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize, stem, contentTokens, uncoveredRuns, sharesFoodWord, isExplained,
  explainedStems, isPreparationRun, stripContextWords,
} from '../src/services/food/coverage.js';
import { estimateFood, parseFragment, modelAvailable } from '../src/services/foodEstimator.js';
import { stapleByKey, matchStaples } from '../src/services/food/staples.js';

/* ---------------- pure coverage helpers ---------------- */

test('stem treats plural and Hindi vowel endings as the same word', () => {
  assert.equal(stem('parathas'), stem('paratha'));
  assert.equal(stem('bhature'), stem('bhatura'));
  assert.equal(stem('rotis'), 'roti');
  assert.equal(stem('dal'), 'dal');
  assert.equal(stem('egg'), 'egg');
});

test('contentTokens drops quantities, units, narration and context words, and records context', () => {
  const r = contentTokens('I ate 2 homemade aloo parathas with 1 katori curd');
  assert.deepEqual(r.tokens, ['aloo', 'parathas', 'curd']);
  assert.deepEqual(r.context, ['homemade']);
  assert.deepEqual(contentTokens('150g paneer').tokens, ['paneer']);
  assert.deepEqual(contentTokens('a large restaurant style biryani').sizes, ['large']);
  assert.deepEqual(contentTokens('a large restaurant style biryani').context, ['restaurant']);
});

test('names that look like context are NOT stripped (cold coffee, plain dosa, hot chocolate)', () => {
  assert.deepEqual(contentTokens('cold coffee').tokens, ['cold', 'coffee']);
  assert.deepEqual(contentTokens('plain dosa').tokens, ['plain', 'dosa']);
  assert.deepEqual(contentTokens('hot chocolate').tokens, ['hot', 'chocolate']);
  assert.equal(stripContextWords('homemade aloo paratha'), 'aloo paratha');
  assert.equal(stripContextWords('homemade'), 'homemade', 'never strips a name to nothing');
});

test('synonyms across languages explain each other (chawal = rice, dahi = curd)', () => {
  const stems = explainedStems(['Rice (cooked)', 'Curd / Dahi']);
  assert.ok(isExplained('chawal', stems));
  assert.ok(isExplained('dahi', stems));
  assert.ok(!isExplained('sambar', stems));
});

test('uncoveredRuns finds the food a match left out, in order', () => {
  assert.deepEqual(uncoveredRuns('masala dosa with sambar', ['Masala dosa']), [['sambar']]);
  assert.deepEqual(uncoveredRuns('2 idli sambar', ['Idli', 'Sambar']), []);
  assert.deepEqual(uncoveredRuns('rice with rajma', ['Rajmah, red (Phaseolus vulgaris)']), [['rice']]);
  assert.deepEqual(uncoveredRuns('Curd rice', ['Curd rice (Dahi bhaat/Dahi chawal)']), []);
});

test('sharesFoodWord refuses a lexical accident (puran poli vs Polish sausage)', () => {
  assert.equal(sharesFoodWord('puran poli', ['Polish sausage']), false);
  assert.equal(sharesFoodWord('misal pav', ['Pav bhaji']), true, 'shares pav -- coverage, not this check, catches misal');
  assert.equal(sharesFoodWord('dahi', ['Curd / Dahi']), true);
});

test('preparation words are recognised so they are flagged, never added as a second food', () => {
  assert.ok(isPreparationRun(['bhurji']));
  assert.ok(isPreparationRun(['curry']));
  assert.ok(!isPreparationRun(['sambar']));
  assert.ok(!isPreparationRun(['vada']), 'vada is a food in "idli vada"');
  assert.ok(!isPreparationRun(['butter']), 'butter is a food in "bread butter"');
  assert.deepEqual(tokenize('Aloo-Gobi!'), ['aloo', 'gobi']);
});

test('curated staples match plurals of their names', () => {
  assert.equal(matchStaples('aloo parathas', { allowPrefix: false })[0]?.staple.key, 'aloo_paratha');
  assert.equal(matchStaples('samosas', { allowPrefix: false })[0]?.staple.key, 'samosa');
});

/* ---------------- parser behaviour (needs the food model) ---------------- */

const live = modelAvailable();
const names = (r) => r.items.map((i) => i.name.toLowerCase());

test('parseFragment records context words and keeps them out of the name', { skip: !live }, () => {
  const p = parseFragment('2 homemade aloo parathas');
  assert.equal(p.name, 'aloo parathas');
  assert.equal(p.qty, 2);
  assert.deepEqual(p.context, ['homemade']);
});

test('"2 homemade aloo parathas with curd and chai" -> aloo paratha, curd, chai (not potato pancake)', { skip: !live }, () => {
  const r = estimateFood('2 homemade aloo parathas with curd and chai');
  const n = names(r);
  assert.ok(n.some((x) => /aloo paratha/.test(x)), n.join(', '));
  assert.ok(!n.some((x) => /pancake/.test(x)), 'never USDA potato pancake');
  assert.ok(n.some((x) => /curd|dahi/.test(x)));
  assert.ok(n.some((x) => /chai|tea/.test(x)));
  const par = r.items.find((i) => /aloo paratha/i.test(i.name));
  assert.equal(par.qty, 2);
  assert.deepEqual(par.context, ['homemade']);
});

test('"masala dosa with sambar" keeps the sambar', { skip: !live }, () => {
  const n = names(estimateFood('masala dosa with sambar'));
  assert.ok(n.some((x) => /masala dosa/.test(x)));
  assert.ok(n.some((x) => /sambar/.test(x)), n.join(', '));
});

test('"rice with rajma and a side salad" keeps the rice and prices cooked rajma, not raw beans', { skip: !live }, () => {
  const r = estimateFood('rice with rajma and a side salad');
  const n = names(r);
  assert.ok(n.some((x) => /rice/.test(x)), n.join(', '));
  assert.ok(n.some((x) => /rajma/.test(x)));
  assert.ok(!r.items.some((i) => /phaseolus/i.test(i.source_name || i.name)), 'not raw dried kidney beans');
  assert.ok(n.some((x) => /salad/.test(x)) && !n.some((x) => /potato salad/.test(x)));
});

test('two everyday foods side by side are two items ("bread butter", "tea biscuit")', { skip: !live }, () => {
  assert.equal(estimateFood('bread butter').items.length, 2);
  assert.equal(estimateFood('tea biscuit').items.length, 2);
});

test('real dishes are NOT split (curd rice, egg curry, aloo gobi, masala chai, poha with curd)', { skip: !live }, () => {
  for (const t of ['curd rice', 'egg curry', 'aloo gobi', 'masala chai', 'poha with curd', 'jeera rice']) {
    const r = estimateFood(t);
    assert.equal(r.items.length, 1, `${t} -> ${names(r).join(', ')}`);
  }
});

test('a preparation word is flagged on the item, not added as another food', { skip: !live }, () => {
  // Uses a deliberately unlikely dish so later recipe additions cannot turn
  // this into a direct match and silently stop testing the mechanism.
  const r = estimateFood('paneer jalfrezi');
  assert.ok(!r.items.some((i) => /egg/i.test(i.name)));
  if (r.items.length && !/jalfrezi/i.test(r.items[0].name)) {
    assert.ok(r.needs_clarification.length >= 1, 'unmatched "jalfrezi" must be reported');
    assert.equal(r.items[0].confidence, 'low');
    assert.deepEqual(r.items[0].unmatched_terms, ['jalfrezi']);
  }
});

test('a lexical accident is never summed ("puran poli" is never Polish sausage)', { skip: !live }, () => {
  const r = estimateFood('puran poli');
  assert.ok(!r.items.some((i) => /sausage/i.test(`${i.name} ${i.source_name}`)));
});

/* ---------------- THE INVARIANT ---------------- */

const MEALS = [
  '2 roti, dal and curd', 'paneer bhurji with 2 rotis', 'rice with rajma and a side salad',
  '2 homemade aloo parathas with curd and chai', 'I ate 2 rotis, one bowl of dal, 100 grams of rice and some aloo sabzi',
  'masala dosa with sambar', 'chole bhature', '1 plate misal pav', 'idli vada sambar', 'poha and chai',
  'vada pav', 'pav bhaji', 'rajma chawal', 'dal chawal', 'curd rice with pickle', 'egg curry rice',
  '2 eggs and toast', 'bread butter jam', 'oats with milk and banana', 'chicken biryani with raita',
  'protein shake and a banana', 'coffee with milk and 2 biscuits', 'sabudana khichdi', 'upma with coconut chutney',
  'thepla with curd', 'dhokla', 'samosa and tea', 'paneer tikka', 'aloo tikki', 'chicken curry with rice',
  'fish curry and rice', 'mutton biryani', 'kadhi chawal', 'palak paneer with naan', 'dal makhani and jeera rice',
  'puran poli', 'thalipeeth', 'kachori', 'restaurant butter chicken with 2 naan', 'xyzzy blorf',
];

/** Every phrase the response gives for where a word went. */
function accountedStems(r) {
  const phrases = [];
  for (const it of r.items) {
    phrases.push(it.name, it.source_name, it.recovered_from);
    const st = it.staple_key ? stapleByKey(it.staple_key) : null;
    if (st) phrases.push(st.name, ...(st.aliases || []));
    for (const t of it.unmatched_terms || []) phrases.push(t);
  }
  for (const u of r.unresolved) phrases.push(u.fragment);
  for (const n of r.needs_clarification || []) phrases.push(n.fragment, ...(n.terms || []));
  return explainedStems(phrases.filter(Boolean));
}

test('INVARIANT: no food word is ever silently dropped', { skip: !live }, () => {
  const failures = [];
  for (const meal of MEALS) {
    const r = estimateFood(meal);
    const stems = accountedStems(r);
    const missing = contentTokens(meal).tokens.filter((t) => !isExplained(t, stems));
    if (missing.length) failures.push(`${meal} -> lost: ${missing.join(', ')} (items: ${names(r).join(' | ')})`);
  }
  assert.deepEqual(failures, []);
});

test('totals equal the sum of the items (no hidden adjustments)', { skip: !live }, () => {
  for (const meal of MEALS) {
    const r = estimateFood(meal);
    const sum = r.items.reduce((s, i) => s + (i.calories || 0), 0);
    // Items are rounded individually; the total is rounded once.
    assert.ok(Math.abs(sum - r.total.calories) <= r.items.length, `${meal}: items ${sum} vs total ${r.total.calories}`);
  }
});
