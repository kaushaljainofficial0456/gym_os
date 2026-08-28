// ============================================================
// SKOS FOOD BENCHMARK — CASE SPECS  (source of truth for authoring)
//
// This module is consumed by build.mjs, which expands it into the FROZEN
// dataset food_eval_set.v1.json. Do not point the harness at this file.
//
// Each case:
//   id         stable slug
//   input      the exact user text handed to the engine
//   primary    one PRIMARY_CATEGORY (see backend/src/eval/taxonomy.js)
//   tags       cross-cutting labels for the slice reports
//   difficulty easy | medium | hard
//   expect     { entity, food_class, prep_state, portion, nutrition?, confidence?, strategy, plausible?, is_nonfood?, items? }
//   gt         ground-truth method:
//     db(prefer[], /name/i, cookingState|null, grams, tol)  — build scans unified_food_db
//        with THESE criteria (independent of the engine's ranker), snapshots the
//        authoritative row, and fills nutrition = row × grams/100 ± tol.
//     authored({kcal,protein_g,carb_g,fat_g}, gramsRef, note) — literal wide ranges.
//     std(...)       — authored, flagged as a standard reference portion.
//     none()         — no nutrition scoring (identity / prep / portion / class only).
// ============================================================
'use strict';

const db = (prefer, name, cs, grams, tol = 0.18) => ({ m: 'db', prefer, name, cs: cs ?? null, grams, tol });
const authored = (nutrition, gramsRef, note) => ({ m: 'authored', nutrition, gramsRef, note });
const std = (nutrition, gramsRef, note) => ({ m: 'std', nutrition, gramsRef, note });
const published = (nutrition, gramsRef, note) => ({ m: 'published', nutrition, gramsRef, note });
const none = () => ({ m: 'none' });

const C = [];
const add = (id, input, primary, tags, difficulty, expect, gt) =>
  C.push({ id, input, primary, tags, difficulty, expect, gt: gt || none() });

// n(kcalLo,Hi, pLo,Hi, cLo,Hi, fLo,Hi) — pass null for a macro to skip it
const n = (kl, kh, pl, ph, cl, ch, fl, fh) => {
  const o = { kcal: [kl, kh] };
  if (pl != null) o.protein_g = [pl, ph];
  if (cl != null) o.carb_g = [cl, ch];
  if (fl != null) o.fat_g = [fl, fh];
  return o;
};

/* ==================================================================== *
 *  A. SINGLE INGREDIENTS  (raw + minimally processed, all cuisines)     *
 * ==================================================================== */

add('sng-001', '100g paneer', 'single_ingredient', ['indian', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'paneer', reject_name_matches: 'tofu|imitation|malai paneer.*masala' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, confidence: ['medium', 'high'], strategy: 'direct' },
  db(['IFCT2017', 'INDB'], /^paneer/i, 'raw', 100, 0.18));

add('sng-002', '150g chicken breast', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams', 'ambiguous'], 'medium',
  { entity: { name_matches: 'chicken.*breast', reject_name_matches: 'deli|luncheon|nugget|tender|patty|sausage|canned' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [147, 153] }, confidence: ['medium', 'high'], strategy: 'direct' },
  db(['IFCT2017'], /chicken.*breast/i, null, 150, 0.22));

add('sng-003', '30g almonds', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'almond', reject_name_matches: 'milk|butter|flour|cookie|chocolate|drink' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /^almond/i, 'raw', 30, 0.18));

add('sng-004', '1 medium apple', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: '\\bapple', reject_name_matches: 'juice|sauce|pie|cider|babyfood|crumble' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [140, 200] }, strategy: 'direct' },
  std(n(70, 120, 0, 1.2, 16, 28, 0, 0.8), 170, 'USDA: 1 medium apple ≈ 182 g; ICMR ≈ 150 g'));

add('sng-005', '1 banana', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'banana', reject_name_matches: 'chip|bread|shake|babyfood|pie|dried' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [100, 140] }, strategy: 'direct' },
  std(n(80, 135, 0.7, 1.8, 20, 32, 0, 0.6), 118, 'USDA: 1 medium banana 118 g'));

add('sng-006', '200 g raw rice', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'rice', reject_name_matches: 'cooked|fried|pudding|cake|noodle|milk|krispies|bran' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [196, 204] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /rice.*raw|raw.*rice|rice, white.*regular/i, 'raw', 200, 0.20));

add('sng-007', '100g cooked white rice', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'rice', reject_name_matches: 'raw|fried|pudding|cake|krispies' }, food_class: 'ingredient', prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /rice, white.*cooked|cooked.*rice/i, 'cooked', 100, 0.22));

add('sng-008', '250g potato', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'potato', reject_name_matches: 'chip|crisp|fries|babyfood|salad|bread|sweet potato' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [245, 255] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /potato.*raw|^potato,?\s*(nfs|white)?/i, 'raw', 250, 0.20));

add('sng-009', '2 eggs', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion', 'ambiguous'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|albumen|substitute|powder|noodle|plant' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [96, 110] }, strategy: 'direct' },
  std(n(130, 170, 11, 16, 0, 2, 9, 13), 100, '2 large eggs ≈ 100 g edible; USDA 143 kcal/100g'));

add('sng-010', '100g tofu', 'single_ingredient', ['east_asian', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'tofu|soybean curd', reject_name_matches: 'fried|smoked|dessert' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /^tofu|soybean curd/i, null, 100, 0.25));

add('sng-011', '150g salmon fillet', 'single_ingredient', ['european', 'raw', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'salmon', reject_name_matches: 'smoked|canned|cake|patty|spread' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['USDA_FDC'], /salmon.*raw|raw.*salmon|salmon, atlantic/i, null, 150, 0.25));

add('sng-012', '100g spinach', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'spinach', reject_name_matches: 'creamed|babyfood|curry|paneer|dip' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /spinach.*raw|^spinach/i, 'raw', 100, 0.30));

add('sng-013', '1 cup chickpeas', 'single_ingredient', ['global', 'boiled', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'chickpea|bengal gram|garbanzo|chana', reject_name_matches: 'flour|besan|curry|snack|fried|roasted' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [150, 200] }, strategy: 'direct' },
  std(n(200, 290, 9, 16, 30, 48, 2, 6), 164, 'USDA: 1 cup cooked chickpeas 164 g, 269 kcal'));

add('sng-014', '30g cashew nuts', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'cashew', reject_name_matches: 'butter|milk|masala|roasted.*salted|cookie' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /cashew.*(nut|kernel)|^cashewnut/i, 'raw', 30, 0.20));

add('sng-015', '200g full-fat milk', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: '\\bmilk', reject_name_matches: 'powder|condensed|shake|chocolate|almond|soy|oat|coconut|babyfood' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [196, 204] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /milk, whole|milk, cow|whole milk/i, null, 200, 0.20));

add('sng-016', '50g cheddar cheese', 'single_ingredient', ['european', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'cheddar', reject_name_matches: 'spread|sauce|dip|popcorn|cracker' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [48, 52] }, strategy: 'direct' },
  db(['USDA_FDC'], /cheese, cheddar/i, null, 50, 0.15));

add('sng-017', '100g avocado', 'single_ingredient', ['latin_american', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'avocado', reject_name_matches: 'guacamole|dip|oil|toast|spread' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /avocado.*raw|^avocado/i, 'raw', 100, 0.20));

add('sng-018', '80g dry rolled oats', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'oat', reject_name_matches: 'milk|cookie|bar|bread|porridge.*cooked|granola' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [78, 82] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /oats,?\s*(rolled|raw|dry)|^oats/i, null, 80, 0.18));

add('sng-019', '1 katori moong dal (uncooked)', 'single_ingredient', ['indian', 'raw', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'moong|mung|green gram', reject_name_matches: 'curry|cooked|snack|fried|halwa|sprout' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [90, 160] }, strategy: 'direct' },
  db(['IFCT2017'], /green gram.*whole|moong.*whole|mung.*bean.*raw/i, 'raw', 120, 0.22));

add('sng-020', '3 walnut halves', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'walnut', reject_name_matches: 'oil|cake|brownie|bread' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [8, 18] }, strategy: 'direct' },
  std(n(50, 130, 1, 4, 1, 4, 5, 13), 12, '1 walnut half ≈ 4 g'));

add('sng-021', '100g raw carrot', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'carrot', reject_name_matches: 'cake|juice|halwa|babyfood|soup|pickle' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /carrot.*raw|^carrot/i, 'raw', 100, 0.25));

add('sng-022', '120g paneer', 'single_ingredient', ['indian', 'raw', 'generic', 'explicit_grams', 'spelling_variant'], 'easy',
  { entity: { name_matches: 'paneer|cottage cheese', reject_name_matches: 'tikka|butter masala|bhurji|tofu' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [117, 123] }, strategy: 'direct' },
  db(['IFCT2017', 'INDB'], /^paneer/i, 'raw', 120, 0.18));

add('sng-023', '1 slice white bread', 'single_ingredient', ['global', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'bread', reject_name_matches: 'garlic|toast.*french|pudding|crumb' }, food_class: 'ingredient', prep_state: 'baked', portion: { grams: [22, 40] }, strategy: 'direct' },
  std(n(55, 95, 1.5, 4, 10, 18, 0.4, 2), 28, 'USDA: 1 slice commercial white bread ≈ 25–28 g'));

add('sng-024', '100g raw broccoli', 'single_ingredient', ['european', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'broccoli', reject_name_matches: 'cheese|soup|casserole|babyfood' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /broccoli.*raw|^broccoli/i, 'raw', 100, 0.30));

add('sng-025', '200g plain yogurt', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams', 'ambiguous'], 'medium',
  { entity: { name_matches: 'yogh?urt|curd|dahi', reject_name_matches: 'frozen|drink|smoothie|fruit|greek.*honey|parfait' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [196, 204] }, strategy: 'direct' },
  std(n(90, 170, 5, 14, 6, 18, 2, 10), 200, 'plain whole-milk yogurt ≈ 60–75 kcal/100g'));

add('sng-026', '150g cooked kidney beans', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'kidney bean|rajma|rajmah', reject_name_matches: 'curry|masala|chawal|canned.*sauce' }, food_class: 'ingredient', prep_state: 'boiled', portion: { grams: [146, 154] }, strategy: 'direct' },
  std(n(150, 230, 8, 15, 22, 40, 0.3, 3), 150, 'USDA cooked kidney beans ≈ 127 kcal/100g'));

add('sng-027', '100g tempeh', 'single_ingredient', ['east_asian', 'raw', 'generic', 'explicit_grams', 'ambiguous'], 'hard',
  { entity: { name_matches: 'tempeh', reject_name_matches: 'chips|bacon' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [98, 102] }, strategy: 'direct', plausible: true },
  db(['USDA_FDC'], /tempeh/i, null, 100, 0.30));

add('sng-028', '250 g watermelon', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'watermelon|tarbooj', reject_name_matches: 'juice|seed|rind|candy' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [245, 255] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /watermelon.*raw|^watermelon/i, 'raw', 250, 0.30));

add('sng-029', '20g peanut butter', 'single_ingredient', ['american', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'peanut butter', reject_name_matches: 'cup|cookie|sandwich|protein bar' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [19, 21] }, strategy: 'direct' },
  db(['USDA_FDC'], /peanut butter/i, null, 20, 0.18));

add('sng-030', '100g mango', 'single_ingredient', ['south_asian', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'mango', reject_name_matches: 'juice|pickle|lassi|shake|dried|chutney|aamras' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /mango.*raw|mango, ripe/i, 'raw', 100, 0.28));

/* ==================================================================== *
 *  B. PREPARED FOODS  (single-component, a specific cooking method)     *
 * ==================================================================== */

add('prp-001', '1 boiled egg', 'prepared_food', ['global', 'boiled', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|substitute|scrambled|omelet|curry' }, food_class: 'prepared', prep_state: 'boiled', portion: { grams: [44, 60] }, strategy: 'direct' },
  std(n(60, 90, 5, 8, 0, 1.5, 4, 7), 50, '1 large boiled egg ≈ 50 g, 78 kcal'));

add('prp-002', '150g grilled chicken breast', 'prepared_food', ['global', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken.*breast', reject_name_matches: 'deli|nugget|tender|fried|curry|kiev|parmesan' }, food_class: 'prepared', prep_state: 'grilled', portion: { grams: [147, 153] }, strategy: 'prep_variant' },
  std(n(220, 310, 38, 52, 0, 3, 4, 14), 150, 'skinless grilled breast ≈ 165 kcal/100g'));

add('prp-003', '100g boiled potato', 'prepared_food', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'potato', reject_name_matches: 'chip|crisp|fries|raw|salad|mashed.*butter|wedge' }, food_class: 'prepared', prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /potato.*boiled|boiled.*potato/i, 'cooked', 100, 0.22));

add('prp-004', '100g french fries', 'prepared_food', ['american', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'fries|french fried potato|potato.*fried', reject_name_matches: 'raw|boiled|sweet potato|wedge.*baked' }, food_class: 'prepared', prep_state: 'fried', portion: { grams: [98, 102] }, strategy: 'direct' },
  std(n(250, 380, 2.5, 6, 28, 45, 12, 22), 100, 'deep-fried fries ≈ 312 kcal/100g'));

add('prp-005', '100g scrambled eggs', 'prepared_food', ['european', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'egg.*scrambled|scrambled egg|omelet', reject_name_matches: 'boiled|raw|yolk|substitute' }, food_class: 'prepared', prep_state: 'any', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /egg.*scrambled|scrambled/i, null, 100, 0.30));

add('prp-006', '150g roasted sweet potato', 'prepared_food', ['american', 'roasted', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'sweet potato', reject_name_matches: 'raw|fries.*deep|pie|casserole.*marshmallow|chips' }, food_class: 'prepared', prep_state: 'roasted', portion: { grams: [146, 154] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /sweet potato.*(baked|roasted|cooked)/i, 'cooked', 150, 0.28));

add('prp-007', '200g steamed broccoli', 'prepared_food', ['european', 'steamed', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'broccoli', reject_name_matches: 'raw|cheese|casserole|soup|babyfood' }, food_class: 'prepared', prep_state: 'steamed', portion: { grams: [195, 205] }, strategy: 'prep_variant' },
  db(['USDA_FDC', 'IFCT2017'], /broccoli.*(cooked|boiled|steamed)/i, 'cooked', 200, 0.30));

add('prp-008', '2 idli', 'prepared_food', ['south_asian', 'steamed', 'generic', 'count_portion', 'transliteration'], 'easy',
  { entity: { name_matches: '\\bidli', reject_name_matches: 'instant|rava|fried|sambar|podi|batter|masala' }, food_class: 'dish', prep_state: 'steamed', portion: { grams: [70, 110] }, strategy: 'direct' },
  db(['INDB', 'USDA_FDC'], /^idli$/i, 'cooked', 90, 0.22));

add('prp-009', '1 plain dosa', 'prepared_food', ['south_asian', 'cooked_dry', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'dosa', reject_name_matches: 'masala|paneer|mysore|batter|rava|onion|filling' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [60, 120] }, strategy: 'direct' },
  db(['USDA_FDC', 'INDB'], /dosa,?\s*plain|plain dosa/i, 'cooked', 85, 0.25));

add('prp-010', '2 chapati', 'prepared_food', ['indian', 'cooked_dry', 'generic', 'count_portion', 'alias'], 'easy',
  { entity: { name_matches: 'chapati|roti|phulka', reject_name_matches: 'paratha|naan|puri|poori|kulcha|stuffed|frozen' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [70, 100] }, strategy: 'direct' },
  db(['INDB'], /^chapati\/roti$|^chapati$|^roti$/i, 'cooked', 80, 0.18));

add('prp-011', '150g grilled fish', 'prepared_food', ['global', 'grilled', 'generic', 'explicit_grams', 'ambiguous'], 'medium',
  { entity: { name_matches: 'fish', reject_name_matches: 'raw|fried|curry|finger|cake|stick|canned|oil' }, food_class: 'prepared', prep_state: 'grilled', portion: { grams: [146, 154] }, strategy: 'prep_variant' },
  std(n(150, 300, 25, 40, 0, 3, 3, 16), 150, 'lean grilled fish ≈ 120–180 kcal/100g'));

add('prp-012', '100g fried tofu', 'prepared_food', ['east_asian', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'tofu', reject_name_matches: 'raw|silken|dessert|scramble' }, food_class: 'prepared', prep_state: 'fried', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /tofu.*fried|fried.*tofu/i, null, 100, 0.30));

add('prp-013', '1 baked potato', 'prepared_food', ['american', 'baked', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'potato', reject_name_matches: 'raw|fries|chip|mashed|salad|skin only' }, food_class: 'prepared', prep_state: 'baked', portion: { grams: [130, 300] }, strategy: 'direct' },
  std(n(120, 300, 3, 8, 26, 60, 0, 4), 173, 'USDA: 1 medium baked potato flesh+skin ≈ 173 g'));

add('prp-014', '80g roasted peanuts', 'prepared_food', ['global', 'roasted', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'peanut|groundnut', reject_name_matches: 'butter|oil|raw|chikki|brittle|sauce|masala' }, food_class: 'prepared', prep_state: 'roasted', portion: { grams: [78, 82] }, strategy: 'prep_variant' },
  db(['USDA_FDC', 'IFCT2017'], /peanuts.*(roasted|dry roasted)/i, null, 80, 0.20));

add('prp-015', '150g pan-fried salmon', 'prepared_food', ['european', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'salmon', reject_name_matches: 'raw|smoked|canned|cake|spread' }, food_class: 'prepared', prep_state: 'fried', portion: { grams: [146, 154] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /salmon.*cooked|cooked.*salmon/i, 'cooked', 150, 0.28));

add('prp-016', '1 fried egg', 'prepared_food', ['global', 'fried', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'boiled|raw|yolk|scrambled.*plain|substitute' }, food_class: 'prepared', prep_state: 'fried', portion: { grams: [40, 60] }, strategy: 'direct' },
  std(n(70, 120, 5, 8, 0, 1.5, 5, 10), 46, 'USDA: 1 large fried egg 46 g, 90 kcal'));

add('prp-017', '200g mashed potato', 'prepared_food', ['european', 'boiled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'potato.*mashed|mashed potato', reject_name_matches: 'raw|fries|chip|flakes.*dry' }, food_class: 'prepared', prep_state: 'boiled', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['USDA_FDC'], /potato.*mashed|mashed/i, null, 200, 0.30));

add('prp-018', '100g tandoori chicken', 'prepared_food', ['indian', 'roasted', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'tandoori chicken|chicken.*tandoori', reject_name_matches: 'raw|curry|masala.*gravy|tikka masala|butter chicken' }, food_class: 'dish', prep_state: 'roasted', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['INDB'], /tandoori chicken/i, 'cooked', 100, 0.30));

add('prp-019', '100g grilled paneer tikka', 'prepared_food', ['indian', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'paneer tikka|tikka.*paneer', reject_name_matches: 'masala.*gravy|butter|kathi|roll|frankie' }, food_class: 'dish', prep_state: 'grilled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['INDB'], /paneer tikka/i, 'cooked', 100, 0.30));

add('prp-020', '1 slice toast', 'prepared_food', ['global', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'toast|bread', reject_name_matches: 'french toast|pudding|garlic bread|melba' }, food_class: 'prepared', prep_state: 'baked', portion: { grams: [20, 34] }, strategy: 'direct' },
  std(n(55, 100, 1.5, 4, 10, 18, 0.4, 2.5), 24, '1 slice toasted white bread ≈ 22–26 g'));

/* ==================================================================== *
 *  C. COMPOSITE DISHES  (multi-ingredient; curries, soups, stir-fries, *
 *     stuffed, topped, street food — every cuisine)                     *
 * ==================================================================== */

// -- Indian --
add('cmp-001', '1 katori dal', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion', 'ambiguous'], 'medium',
  { entity: { name_matches: '\\bdal|\\bdaal|lentil', reject_name_matches: 'raw|dry|fried|snack|namkeen|vada|pakora|halwa|burfi' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [120, 220] }, strategy: 'direct', plausible: true },
  published(n(90, 260, 4, 12, 10, 30, 2, 12), 160, 'tempered cooked dal ≈ 90–140 kcal/100g; 1 katori ≈ 150 g'));

add('cmp-002', '1 bowl rajma', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'rajma|rajmah|kidney bean.*curr', reject_name_matches: 'raw|dry|chawal|rice|salad' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [180, 320] }, strategy: 'direct' },
  db(['INDB'], /kidney bean curry|rajmah curry|^rajma$/i, 'cooked', 250, 0.30));

add('cmp-003', '200g chicken curry', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken.*curry|curry.*chicken|chicken.*gravy|butter chicken|chicken masala', reject_name_matches: 'raw|powder|soup.*clear|salad|dry roast' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [195, 205] }, strategy: 'direct' },
  published(n(200, 460, 18, 40, 4, 22, 8, 32), 200, 'home chicken curry ≈ 130–200 kcal/100g'));

add('cmp-004', '1 plate pav bhaji', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'count_portion', 'topped', 'street'], 'hard',
  { entity: { name_matches: 'pav bhaji', reject_name_matches: 'masala.*powder|pizza|frankie' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [300, 650] }, strategy: 'direct' },
  published(n(400, 900, 8, 24, 45, 100, 14, 44), 450, 'pav bhaji with 2 pav + butter ≈ 400–650 kcal/plate'));

add('cmp-005', '1 masala dosa', 'composite_dish', ['south_asian', 'cooked_dry', 'generic', 'count_portion', 'stuffed'], 'medium',
  { entity: { name_matches: 'masala dosa', reject_name_matches: 'plain dosa|batter|rava.*plain|mysore.*plain' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [150, 280] }, strategy: 'direct' },
  db(['INDB'], /^masala dosa$/i, 'cooked', 210, 0.28));

add('cmp-006', '206g papdi chaat', 'composite_dish', ['indian', 'cooked_dry', 'generic', 'explicit_grams', 'topped', 'street', 'ambiguous'], 'hard',
  { entity: { name_matches: 'papdi chaat|papri chaat|chaat', reject_name_matches: 'quinoa puffs|wafer|namkeen|soan papdi|gathiya|khakhra' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [200, 212] }, strategy: 'decompose' },
  published(n(230, 560, 5, 16, 26, 66, 8, 26), 206, 'papdi chaat with yogurt/chutney/sev ≈ 150–260 kcal/100g'));

add('cmp-007', '1 plate chole bhature', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'combo'], 'hard',
  { entity: { name_matches: 'chole bhatur|bhatur|chana.*bhatur|chole.*bhatur', reject_name_matches: 'chana masala only|chickpea curry$' }, food_class: 'meal', prep_state: 'fried', portion: { grams: [350, 700] }, strategy: 'decompose' },
  published(n(650, 1200, 16, 34, 70, 140, 26, 60), 450, '2 bhature (fried) + chole ≈ 650–1000 kcal/plate'));

add('cmp-008', 'rajma chawal', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'no_quantity', 'combo', 'transliteration'], 'hard',
  { entity: { name_matches: 'rajma|rajmah|kidney bean', reject_name_matches: 'raw|dry|salad' }, food_class: 'meal', prep_state: 'cooked_wet', portion: { grams: [250, 500] }, strategy: 'decompose' },
  published(n(350, 700, 12, 26, 55, 110, 6, 24), 400, 'rajma curry + rice one-plate ≈ 350–600 kcal'));

add('cmp-009', '1 bowl sambar', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'sambar|sambhar', reject_name_matches: 'powder|masala|rice.*sambar$|idli only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [180, 320] }, strategy: 'direct' },
  db(['INDB'], /^sambar$|^sambhar$|sambar,/i, 'cooked', 220, 0.32));

add('cmp-010', '150g palak paneer', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'palak paneer|paneer.*spinach|spinach.*paneer|saag paneer', reject_name_matches: 'raw|plain paneer|palak only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['INDB'], /palak paneer|spinach.*paneer|saag paneer/i, 'cooked', 150, 0.30));

add('cmp-011', '2 aloo paratha', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'stuffed'], 'medium',
  { entity: { name_matches: 'aloo parat|potato.*parat|parat.*potato|parat.*aloo', reject_name_matches: 'plain paratha|laccha|besan.*palak' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [140, 280] }, strategy: 'direct' },
  db(['INDB'], /potato stuffed parat|aloo.*parat/i, 'cooked', 200, 0.30));

add('cmp-012', '1 bowl chicken biryani', 'composite_dish', ['south_asian', 'cooked_dry', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'biryani|biriyani', reject_name_matches: 'raw|masala.*powder|mix.*packet|paste' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [200, 400] }, strategy: 'direct' },
  db(['INDB', 'USDA_FDC'], /biryani.*(chicken|mutton|meat)|(chicken|mutton).*biryani/i, 'cooked', 300, 0.32));

add('cmp-013', '1 bowl vegetable soup', 'composite_dish', ['global', 'cooked_wet', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'vegetable soup|soup.*vegetable|minestrone', reject_name_matches: 'cream of|cube|powder|instant.*dry' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [200, 350] }, strategy: 'direct' },
  std(n(40, 160, 1, 6, 5, 22, 0.5, 6), 245, 'clear vegetable soup ≈ 25–55 kcal/100g; 1 cup 245 g'));

// -- East Asian --
add('cmp-020', '1 bowl chicken fried rice', 'composite_dish', ['east_asian', 'fried', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'fried rice', reject_name_matches: 'raw|steamed rice$|plain rice' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [200, 400] }, strategy: 'direct' },
  std(n(280, 600, 8, 22, 35, 75, 8, 26), 250, 'chicken fried rice ≈ 150–210 kcal/100g'));

add('cmp-021', '1 bowl pho', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'volume_portion', 'transliteration'], 'hard',
  { entity: { name_matches: '\\bpho\\b|beef noodle soup|vietnamese.*soup', reject_name_matches: 'phon|phos|typo' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [400, 800] }, strategy: 'decompose', plausible: true },
  published(n(300, 650, 15, 40, 30, 75, 3, 18), 500, 'beef pho ≈ 350–500 kcal/large bowl'));

add('cmp-022', '150g chicken stir fry', 'composite_dish', ['east_asian', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'stir.?fry|stir.?fried', reject_name_matches: 'raw|sauce only' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(150, 340, 12, 26, 6, 22, 5, 20), 150, 'chicken-veg stir fry ≈ 120–180 kcal/100g'));

add('cmp-023', '4 pork dumplings', 'composite_dish', ['east_asian', 'steamed', 'generic', 'count_portion', 'stuffed'], 'medium',
  { entity: { name_matches: 'dumpling|gyoza|momo|potsticker|jiaozi', reject_name_matches: 'wrapper only|soup dumpling.*broth only' }, food_class: 'dish', prep_state: 'steamed', portion: { grams: [80, 180] }, strategy: 'direct' },
  std(n(120, 340, 5, 16, 14, 36, 3, 16), 120, '1 dumpling ≈ 25–35 g'));

add('cmp-024', '1 bowl ramen', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'ramen', reject_name_matches: 'dry.*brick|instant.*uncooked|seasoning packet' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [400, 800] }, strategy: 'decompose' },
  published(n(400, 900, 14, 40, 45, 100, 8, 34), 550, 'shoyu/tonkotsu ramen ≈ 450–700 kcal/bowl'));

add('cmp-025', '1 California roll (6 pieces)', 'composite_dish', ['east_asian', 'cooked_dry', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'sushi|california roll|maki', reject_name_matches: 'rice only|nori sheet' }, food_class: 'dish', prep_state: 'any', portion: { grams: [140, 220] }, strategy: 'direct' },
  std(n(200, 400, 5, 14, 30, 60, 4, 16), 170, 'California roll 6 pc ≈ 250–350 kcal'));

// -- Middle Eastern / Mediterranean --
add('cmp-030', '100g hummus', 'composite_dish', ['middle_eastern', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'hummus|hommus|houmous', reject_name_matches: 'chickpea.*plain|dry mix' }, food_class: 'dish', prep_state: 'any', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /hummus|hommus/i, null, 100, 0.25));

add('cmp-031', '1 falafel wrap', 'composite_dish', ['middle_eastern', 'fried', 'generic', 'count_portion', 'stuffed', 'combo'], 'hard',
  { entity: { name_matches: 'falafel', reject_name_matches: 'mix.*dry|powder' }, food_class: 'meal', prep_state: 'fried', portion: { grams: [250, 450] }, strategy: 'decompose' },
  published(n(450, 850, 12, 26, 50, 95, 16, 40), 320, 'falafel wrap w/ tahini ≈ 500–700 kcal'));

add('cmp-032', '250g shakshuka', 'composite_dish', ['middle_eastern', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'shakshuka|shakshouka|eggs.*tomato', reject_name_matches: 'raw|sauce only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [245, 255] }, strategy: 'direct', plausible: true },
  published(n(180, 420, 10, 24, 10, 28, 8, 26), 250, 'shakshuka ≈ 90–140 kcal/100g'));

add('cmp-033', '1 chicken shawarma plate', 'composite_dish', ['middle_eastern', 'grilled', 'generic', 'count_portion', 'combo'], 'hard',
  { entity: { name_matches: 'shawarma|shwarma|gyro|doner', reject_name_matches: 'spice mix|marinade only' }, food_class: 'meal', prep_state: 'grilled', portion: { grams: [300, 600] }, strategy: 'decompose' },
  published(n(500, 1000, 30, 60, 30, 80, 20, 55), 400, 'shawarma plate w/ rice+garlic sauce ≈ 600–850 kcal'));

add('cmp-034', '150g greek salad', 'composite_dish', ['mediterranean', 'raw', 'generic', 'explicit_grams', 'topped'], 'easy',
  { entity: { name_matches: 'greek salad|salad.*greek|horiatiki', reject_name_matches: 'dressing only|pasta salad' }, food_class: 'dish', prep_state: 'raw', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(90, 260, 2, 8, 4, 14, 6, 22), 150, 'greek salad w/ feta+olive oil ≈ 80–150 kcal/100g'));

add('cmp-035', '1 serving moussaka', 'composite_dish', ['mediterranean', 'baked', 'generic', 'no_quantity'], 'hard',
  { entity: { name_matches: 'moussaka', reject_name_matches: 'sauce only|mix' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [250, 450] }, strategy: 'decompose' },
  published(n(350, 750, 14, 30, 18, 45, 18, 45), 300, 'moussaka ≈ 130–200 kcal/100g'));

// -- European / American --
add('cmp-040', '250g spaghetti bolognese', 'composite_dish', ['european', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'spaghetti.*bolognese|bolognese|pasta.*meat sauce|spaghetti.*meat', reject_name_matches: 'dry pasta|sauce jar only|plain spaghetti' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [245, 255] }, strategy: 'direct' },
  published(n(280, 520, 12, 26, 30, 60, 6, 22), 250, 'spag bol ≈ 130–190 kcal/100g'));

add('cmp-041', '1 cheeseburger', 'composite_dish', ['american', 'grilled', 'generic', 'count_portion', 'combo', 'topped'], 'medium',
  { entity: { name_matches: 'cheeseburger|burger.*cheese|hamburger.*cheese', reject_name_matches: 'patty only|bun only|veggie|plant' }, food_class: 'meal', prep_state: 'grilled', portion: { grams: [150, 320] }, strategy: 'decompose' },
  std(n(280, 700, 14, 40, 25, 50, 12, 40), 170, 'fast-food single cheeseburger ≈ 300–450 kcal'));

add('cmp-042', '1 slice pepperoni pizza', 'composite_dish', ['american', 'baked', 'generic', 'count_portion', 'topped'], 'easy',
  { entity: { name_matches: 'pizza', reject_name_matches: 'dough only|sauce only|base' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [90, 160] }, strategy: 'direct' },
  std(n(200, 400, 8, 18, 20, 40, 8, 22), 110, '1 slice regular-crust pepperoni ≈ 280–330 kcal'));

add('cmp-043', '300g mac and cheese', 'composite_dish', ['american', 'baked', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'mac.*cheese|macaroni.*cheese|cheese.*macaroni', reject_name_matches: 'dry.*box|powder packet|plain macaroni' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [295, 305] }, strategy: 'direct' },
  std(n(350, 750, 12, 28, 35, 75, 12, 40), 300, 'mac & cheese ≈ 150–220 kcal/100g'));

add('cmp-044', '1 bowl chili con carne', 'composite_dish', ['american', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'chili con carne|chili.*beef|beef.*chili|chilli con carne', reject_name_matches: 'powder|seasoning|dry mix' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [220, 400] }, strategy: 'direct' },
  std(n(250, 550, 16, 36, 18, 45, 8, 28), 253, 'chili con carne ≈ 100–160 kcal/100g; 1 cup 253 g'));

add('cmp-045', '1 chicken caesar salad', 'composite_dish', ['american', 'raw', 'generic', 'no_quantity', 'topped'], 'medium',
  { entity: { name_matches: 'caesar salad|salad.*caesar', reject_name_matches: 'dressing only|croutons only' }, food_class: 'dish', prep_state: 'any', portion: { grams: [200, 400] }, strategy: 'direct' },
  published(n(250, 650, 18, 42, 6, 22, 14, 45), 280, 'chicken caesar ≈ 300–500 kcal'));

// -- Latin American / African --
add('cmp-050', '1 chicken burrito', 'composite_dish', ['latin_american', 'cooked_dry', 'generic', 'count_portion', 'stuffed', 'combo'], 'hard',
  { entity: { name_matches: 'burrito', reject_name_matches: 'tortilla only|bowl.*no rice|seasoning' }, food_class: 'meal', prep_state: 'any', portion: { grams: [300, 650] }, strategy: 'decompose' },
  published(n(500, 1100, 24, 55, 55, 130, 14, 45), 400, 'chicken burrito ≈ 600–900 kcal'));

add('cmp-051', '2 chicken tacos', 'composite_dish', ['latin_american', 'cooked_dry', 'generic', 'count_portion', 'topped'], 'medium',
  { entity: { name_matches: '\\btaco', reject_name_matches: 'shell only|seasoning|sauce only' }, food_class: 'dish', prep_state: 'any', portion: { grams: [150, 320] }, strategy: 'direct' },
  std(n(200, 500, 12, 30, 18, 45, 6, 24), 170, '2 street-style chicken tacos ≈ 300–420 kcal'));

add('cmp-052', '200g guacamole', 'composite_dish', ['latin_american', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'guacamole|guac', reject_name_matches: 'mix.*dry|seasoning|avocado.*plain' }, food_class: 'dish', prep_state: 'raw', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['USDA_FDC'], /guacamole/i, null, 200, 0.28));

add('cmp-053', '1 plate jollof rice', 'composite_dish', ['african', 'cooked_wet', 'generic', 'count_portion'], 'hard',
  { entity: { name_matches: 'jollof', reject_name_matches: 'plain rice|seasoning|paste only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [250, 450] }, strategy: 'direct', plausible: true },
  published(n(300, 650, 5, 16, 45, 100, 6, 22), 300, 'jollof rice ≈ 130–190 kcal/100g'));

add('cmp-054', '250g bobotie', 'composite_dish', ['african', 'baked', 'generic', 'explicit_grams'], 'hard',
  { entity: { name_matches: 'bobotie', reject_name_matches: 'spice mix|typo' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [245, 255] }, strategy: 'decompose', plausible: true },
  published(n(300, 620, 14, 30, 12, 34, 14, 38), 250, 'bobotie ≈ 150–220 kcal/100g'));

add('cmp-055', '1 bowl egusi soup', 'composite_dish', ['african', 'cooked_wet', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'egusi', reject_name_matches: 'seed only|powder' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [250, 450] }, strategy: 'decompose', plausible: true },
  published(n(300, 700, 12, 30, 8, 26, 18, 50), 300, 'egusi soup (melon seed + palm oil) ≈ 130–220 kcal/100g'));

// -- more Indian street food / snacks-as-dish --
add('cmp-060', '1 plate bhel puri', 'composite_dish', ['indian', 'raw', 'generic', 'count_portion', 'topped', 'street'], 'hard',
  { entity: { name_matches: 'bhel puri|bhelpuri|bhel', reject_name_matches: 'instant.*packet|namkeen only|sev only' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [120, 300] }, strategy: 'decompose' },
  published(n(180, 480, 4, 14, 24, 60, 4, 20), 150, 'bhel puri ≈ 120–200 kcal/100g'));

add('cmp-061', '4 pani puri', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'stuffed', 'street', 'transliteration'], 'hard',
  { entity: { name_matches: 'pani puri|golgappa|puchka|gol gappa|pani.?puri', reject_name_matches: 'puri only.*poori|papdi' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [80, 200] }, strategy: 'decompose' },
  published(n(120, 380, 2, 10, 18, 55, 3, 16), 120, '6 pani puri ≈ 150–250 kcal; ~20 g each'));

add('cmp-062', '2 samosa', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'stuffed', 'street'], 'medium',
  { entity: { name_matches: 'samosa|samoosa', reject_name_matches: 'sheet only|patti only|pizza samosa novelty' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [100, 200] }, strategy: 'direct' },
  db(['CNF_CANADA', 'INDB'], /samosa,?\s*veget|vegetable.*samosa|^samosa$/i, 'cooked', 120, 0.32));

add('cmp-063', '3 pakora', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'street'], 'medium',
  { entity: { name_matches: 'pakora|pakoda|bhaji|bhajji|fritter', reject_name_matches: 'batter only|besan.*plain' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [60, 180] }, strategy: 'direct' },
  published(n(180, 480, 4, 14, 12, 36, 10, 34), 90, 'onion pakora ≈ 250–350 kcal/100g'));

add('cmp-064', '1 vada pav', 'composite_dish', ['indian', 'fried', 'generic', 'count_portion', 'combo', 'street'], 'hard',
  { entity: { name_matches: 'vada pav|vada pao|wada pav', reject_name_matches: 'vada only|batata vada$|pav only' }, food_class: 'meal', prep_state: 'fried', portion: { grams: [120, 250] }, strategy: 'decompose' },
  published(n(250, 550, 5, 14, 30, 65, 8, 26), 150, 'vada pav ≈ 280–400 kcal each'));

add('cmp-065', '1 bowl poha', 'composite_dish', ['indian', 'cooked_dry', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: '\\bpoha\\b|pauwa|flattened rice.*cooked|aval upma', reject_name_matches: 'raw.*flattened|cutlet|chivda|namkeen|groundcherr' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [120, 280] }, strategy: 'direct' },
  published(n(150, 400, 3, 10, 22, 55, 3, 16), 180, 'poha ≈ 110–170 kcal/100g; 1 bowl ≈ 180 g'));

add('cmp-066', '1 bowl upma', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: '\\bupma\\b|uppama|uppittu', reject_name_matches: 'raw|rava.*plain dry|semolina.*raw' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [150, 300] }, strategy: 'direct' },
  db(['INDB', 'USDA_FDC'], /semolina upma|rava upma|suji.*upma|^upma$/i, 'cooked', 200, 0.30));

add('cmp-067', '150g chana masala', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chana masala|chole|chickpea.*curr|safed channa|chana.*curr', reject_name_matches: 'raw|dry|snack|chor|papad|bhatur' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['INDB'], /chickpeas curry|safed channa curry|chole$|chana masala/i, 'cooked', 150, 0.30));

add('cmp-068', '1 bowl khichdi', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'khichdi|khichri|khichuri|kitchari', reject_name_matches: 'raw|mix packet' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [200, 400] }, strategy: 'direct' },
  published(n(180, 480, 6, 16, 28, 65, 3, 16), 250, 'moong dal khichdi ≈ 90–140 kcal/100g'));

add('cmp-069', '150g butter chicken', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'butter chicken|murgh makhani|chicken.*makhani|chicken.*butter', reject_name_matches: 'raw|tandoori.*dry|tikka.*dry|paste only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(220, 480, 14, 30, 4, 16, 12, 34), 150, 'restaurant butter chicken ≈ 150–260 kcal/100g'));

add('cmp-070', '1 katori kadhi', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'kadhi|kadi|karhi', reject_name_matches: 'pakora only|besan.*plain' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [120, 260] }, strategy: 'direct', plausible: true },
  published(n(80, 260, 3, 10, 6, 20, 3, 14), 150, 'punjabi kadhi ≈ 70–130 kcal/100g'));

/* ==================================================================== *
 *  D. MEALS  (multi-food natural-language sentences)                     *
 * ==================================================================== */

add('mel-001', '2 roti, dal and curd', 'meal', ['indian', 'cooked', 'generic', 'multi_food', 'nl_quantity'], 'medium',
  { items: [
    { entity: { name_matches: 'chapati|roti|phulka' } },
    { entity: { name_matches: '\\bdal|\\bdaal|lentil' } },
    { entity: { name_matches: 'curd|yogh?urt|dahi' } },
  ], strategy: 'direct' },
  published(n(300, 620, 14, 30, 40, 85, 8, 26), null, '2 roti (~160) + 1 katori dal (~150) + 1 katori curd (~90)'));

add('mel-002', 'I had two rotis with dal and some curd', 'meal', ['indian', 'cooked', 'generic', 'multi_food', 'nl_quantity'], 'hard',
  { items: [
    { entity: { name_matches: 'chapati|roti|phulka' } },
    { entity: { name_matches: '\\bdal|\\bdaal|lentil' } },
    { entity: { name_matches: 'curd|yogh?urt|dahi' } },
  ], strategy: 'direct' },
  published(n(300, 640, 14, 32, 40, 88, 8, 28), null, 'natural-language variant of mel-001'));

add('mel-003', '3 eggs, 2 bananas and a glass of milk', 'meal', ['global', 'cooked', 'generic', 'multi_food', 'count_portion', 'volume_portion'], 'medium',
  { items: [
    { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|substitute' } },
    { entity: { name_matches: 'banana', reject_name_matches: 'chip|bread|shake' } },
    { entity: { name_matches: '\\bmilk', reject_name_matches: 'powder|shake|almond|soy' } },
  ], strategy: 'direct' },
  published(n(550, 900, 25, 42, 55, 90, 20, 40), null, '3 eggs ~230 + 2 bananas ~210 + 250ml milk ~150'));

add('mel-004', '150g grilled chicken with 100g rice and salad', 'meal', ['global', 'cooked', 'generic', 'multi_food', 'explicit_grams'], 'medium',
  { items: [
    { entity: { name_matches: 'chicken', reject_name_matches: 'nugget|deli|curry' } },
    { entity: { name_matches: 'rice', reject_name_matches: 'raw|pudding|krispies' } },
    { entity: { name_matches: 'salad|lettuce|greens' } },
  ], strategy: 'direct' },
  published(n(350, 620, 40, 62, 25, 55, 6, 22), null, '150g grilled breast ~250 + 100g cooked rice ~130 + salad ~30'));

add('mel-005', 'one bowl chicken curry with rice', 'meal', ['indian', 'cooked_wet', 'generic', 'multi_food', 'combo', 'volume_portion'], 'hard',
  { items: [
    { entity: { name_matches: 'chicken.*curry|curry.*chicken|butter chicken|chicken.*gravy' } },
    { entity: { name_matches: 'rice', reject_name_matches: 'raw|krispies' } },
  ], strategy: 'decompose' },
  published(n(400, 800, 22, 44, 45, 95, 10, 32), null, 'chicken curry (~250) + 1 cup rice (~200)'));

add('mel-006', 'oatmeal with banana and peanut butter', 'meal', ['american', 'cooked', 'generic', 'multi_food', 'no_quantity'], 'medium',
  { items: [
    { entity: { name_matches: 'oat|porridge|oatmeal' } },
    { entity: { name_matches: 'banana' } },
    { entity: { name_matches: 'peanut butter' } },
  ], strategy: 'direct' },
  published(n(300, 620, 8, 22, 40, 80, 8, 26), null, '40g oats + 1 banana + 1 tbsp PB'));

add('mel-007', '2 slices toast with butter and jam', 'meal', ['european', 'baked', 'generic', 'multi_food', 'count_portion'], 'easy',
  { items: [
    { entity: { name_matches: 'toast|bread' } },
    { entity: { name_matches: 'butter', reject_name_matches: 'peanut|almond|cocoa' } },
    { entity: { name_matches: 'jam|marmalade|preserve' } },
  ], strategy: 'direct' },
  published(n(200, 460, 4, 12, 30, 65, 5, 20), null, '2 toast + 10g butter + 15g jam'));

add('mel-008', 'paneer bhurji with 2 rotis', 'meal', ['indian', 'cooked', 'generic', 'multi_food', 'count_portion', 'transliteration'], 'medium',
  { items: [
    { entity: { name_matches: 'paneer bhurji|bhurji|scrambled paneer' } },
    { entity: { name_matches: 'chapati|roti|phulka' } },
  ], strategy: 'direct' },
  published(n(350, 700, 18, 36, 35, 75, 14, 38), null, 'paneer bhurji (~200) + 2 roti (~160)'));

add('mel-009', 'a plate of noodles with chicken', 'meal', ['east_asian', 'fried', 'generic', 'multi_food', 'combo', 'no_quantity'], 'hard',
  { items: [
    { entity: { name_matches: 'noodle|chow mein|hakka|lo mein' } },
    { entity: { name_matches: 'chicken' } },
  ], strategy: 'decompose' },
  published(n(400, 850, 16, 40, 45, 95, 10, 34), null, 'chicken hakka noodles ~1 plate'));

add('mel-010', 'coffee with milk and 2 biscuits', 'meal', ['global', 'cooked', 'generic', 'multi_food', 'count_portion'], 'easy',
  { items: [
    { entity: { name_matches: 'coffee', reject_name_matches: 'bean.*raw|creamer only' } },
    { entity: { name_matches: '\\bmilk' } },
    { entity: { name_matches: 'biscuit|cookie', reject_name_matches: 'gravy|dog' } },
  ], strategy: 'direct' },
  published(n(120, 340, 2, 10, 16, 42, 3, 16), null, 'coffee w/ 50ml milk + 2 marie biscuits'));

/* ==================================================================== *
 *  E. BEVERAGES                                                         *
 * ==================================================================== */

add('bev-001', '250ml orange juice', 'beverage', ['global', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'orange juice|juice.*orange', reject_name_matches: 'drink.*10%|squash|cordial|soda' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [240, 270] }, strategy: 'direct' },
  db(['USDA_FDC'], /orange juice/i, null, 250, 0.20));

add('bev-002', '1 glass milk', 'beverage', ['global', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: '\\bmilk', reject_name_matches: 'powder|condensed|shake|almond|soy|oat|coconut|chocolate' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 280] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /milk, whole|whole milk|milk, cow/i, null, 250, 0.22));

add('bev-003', '1 can cola', 'beverage', ['american', 'raw', 'branded', 'count_portion'], 'easy',
  { entity: { name_matches: 'cola|coke|pepsi|soft drink|soda', reject_name_matches: 'diet|zero|nut cola novelty' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [330, 360] }, strategy: 'direct' },
  std(n(120, 180, 0, 1, 30, 45, 0, 0.5), 355, '1 can (355 ml) regular cola ≈ 140 kcal'));

add('bev-004', 'black coffee', 'beverage', ['global', 'raw', 'generic', 'no_quantity'], 'easy',
  { entity: { name_matches: 'coffee', reject_name_matches: 'bean.*raw|latte|cappuccino|mocha|creamer|frappe' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [180, 260] }, strategy: 'direct' },
  std(n(0, 15, 0, 0.8, 0, 2, 0, 0.3), 240, 'brewed black coffee ≈ 2 kcal/100g'));

add('bev-005', '1 glass lassi', 'beverage', ['indian', 'raw', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'lassi', reject_name_matches: 'raw curd only|mango pulp only' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 320] }, strategy: 'direct' },
  published(n(120, 340, 3, 10, 15, 45, 2, 12), 250, 'sweet lassi ≈ 90–150 kcal/100g'));

add('bev-006', '1 scoop whey protein shake', 'beverage', ['global', 'raw', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'whey|protein.*shake|protein.*powder|protein drink', reject_name_matches: 'mass gainer|bar|cookie' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [28, 45] }, strategy: 'direct' },
  std(n(100, 170, 18, 28, 1, 10, 0.5, 5), 32, '1 scoop whey ≈ 30–35 g, ~120 kcal'));

add('bev-007', '330ml beer', 'beverage', ['european', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: '\\bbeer\\b|lager|ale', reject_name_matches: 'root beer|ginger beer|non.?alcoholic|bread' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [320, 350] }, strategy: 'direct', plausible: true },
  std(n(120, 190, 0.5, 3, 8, 16, 0, 0.5), 335, '330 ml regular beer ≈ 140–155 kcal'));

add('bev-008', '1 cup masala chai', 'beverage', ['indian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'tea|chai', reject_name_matches: 'leaves.*raw|green tea.*plain|iced tea.*sweet novelty|masala.*powder only' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [120, 200] }, strategy: 'direct' },
  published(n(40, 140, 1, 5, 6, 20, 1, 6), 150, 'milk tea w/ sugar ≈ 40–70 kcal/100g'));

add('bev-009', '400ml mango smoothie', 'beverage', ['global', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'smoothie|mango.*shake|mango.*drink|shake', reject_name_matches: 'pulp only|dry mix' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [380, 420] }, strategy: 'direct' },
  published(n(180, 480, 3, 14, 35, 90, 1, 14), 400, 'fruit+yogurt smoothie ≈ 50–100 kcal/100g'));

add('bev-010', '250ml coconut water', 'beverage', ['south_asian', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'coconut water|nariyal pani|tender coconut', reject_name_matches: 'milk|cream|oil|desiccated|flesh' }, food_class: 'beverage', prep_state: 'raw', portion: { grams: [240, 270] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /coconut water/i, null, 250, 0.30));

/* ==================================================================== *
 *  F. SNACKS                                                            *
 * ==================================================================== */

add('snk-001', '1 packet potato chips (52g)', 'snack', ['american', 'fried', 'branded', 'count_portion'], 'easy',
  { entity: { name_matches: 'potato chip|crisps|chips.*potato', reject_name_matches: 'baked.*low fat only|raw potato|tortilla|banana chip' }, food_class: 'branded_product', prep_state: 'fried', portion: { grams: [50, 56] }, strategy: 'direct' },
  std(n(240, 320, 2, 6, 24, 34, 14, 22), 52, '1 small bag (52 g) ≈ 280 kcal'));

add('snk-002', '30g trail mix', 'snack', ['american', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'trail mix|nut.*mix|mixed nuts.*fruit', reject_name_matches: 'granola bar' }, food_class: 'snack', prep_state: 'any', portion: { grams: [29, 31] }, strategy: 'direct' },
  std(n(120, 180, 2, 6, 8, 18, 6, 12), 30, 'trail mix ≈ 450–500 kcal/100g'));

add('snk-003', '2 digestive biscuits', 'snack', ['european', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'biscuit|digestive|cracker|cookie', reject_name_matches: 'gravy|dog|savoury cheese only' }, food_class: 'snack', prep_state: 'baked', portion: { grams: [24, 40] }, strategy: 'direct' },
  std(n(120, 200, 1.5, 4, 16, 28, 4, 10), 30, '2 digestives ≈ 140–150 kcal'));

add('snk-004', '50g namkeen', 'snack', ['indian', 'fried', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'namkeen|mixture|sev|bhujia|chivda|farsan', reject_name_matches: 'raw besan|plain gram flour' }, food_class: 'snack', prep_state: 'fried', portion: { grams: [48, 52] }, strategy: 'direct' },
  published(n(220, 320, 4, 14, 18, 32, 12, 24), 50, 'fried namkeen ≈ 480–560 kcal/100g'));

add('snk-005', '1 cup popcorn', 'snack', ['american', 'cooked_dry', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'popcorn', reject_name_matches: 'raw kernel|unpopped|caramel corn.*novelty' }, food_class: 'snack', prep_state: 'cooked_dry', portion: { grams: [6, 20] }, strategy: 'direct' },
  std(n(20, 90, 0.5, 3, 4, 14, 0.2, 6), 11, '1 cup air-popped ≈ 8 g, 31 kcal'));

add('snk-006', '40g dark chocolate', 'snack', ['european', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'dark chocolate|chocolate.*dark|chocolate.*70', reject_name_matches: 'milk chocolate|white chocolate|drink|cake|spread' }, food_class: 'snack', prep_state: 'any', portion: { grams: [38, 42] }, strategy: 'direct' },
  db(['USDA_FDC'], /chocolate, dark|dark chocolate/i, null, 40, 0.22));

add('snk-007', '1 granola bar', 'snack', ['american', 'baked', 'branded', 'count_portion'], 'easy',
  { entity: { name_matches: 'granola bar|cereal bar|muesli bar|snack bar', reject_name_matches: 'protein bar.*40g protein|loose granola' }, food_class: 'branded_product', prep_state: 'baked', portion: { grams: [30, 50] }, strategy: 'direct' },
  std(n(100, 220, 1.5, 8, 14, 30, 3, 10), 40, 'granola bar ≈ 120–180 kcal'));

add('snk-008', '25g roasted chana', 'snack', ['indian', 'roasted', 'generic', 'explicit_grams', 'transliteration'], 'easy',
  { entity: { name_matches: 'roasted.*chana|chana.*roasted|roasted.*gram|bengal gram.*roasted|chana chor', reject_name_matches: 'raw|curry|flour|besan' }, food_class: 'snack', prep_state: 'roasted', portion: { grams: [24, 26] }, strategy: 'direct' },
  published(n(80, 130, 4, 8, 12, 20, 1, 5), 25, 'roasted chana ≈ 360–400 kcal/100g'));

/* ==================================================================== *
 *  G. DESSERTS                                                          *
 * ==================================================================== */

add('des-001', '2 gulab jamun', 'dessert', ['indian', 'fried', 'generic', 'count_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'gulab jamun|gulab jamoon', reject_name_matches: 'mix.*dry|powder|khoya only' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [60, 140] }, strategy: 'direct' },
  published(n(200, 460, 2, 8, 28, 60, 8, 22), 80, '1 gulab jamun ≈ 35–45 g, 120–175 kcal'));

add('des-002', '1 scoop vanilla ice cream', 'dessert', ['global', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'ice cream', reject_name_matches: 'cone only|sandwich.*wafer only|sorbet|kulfi' }, food_class: 'dish', prep_state: 'any', portion: { grams: [55, 80] }, strategy: 'direct' },
  db(['USDA_FDC'], /ice cream, vanilla|vanilla ice cream/i, null, 66, 0.22));

add('des-003', '1 brownie', 'dessert', ['american', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'brownie', reject_name_matches: 'mix.*dry|batter|protein brownie novelty' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [40, 90] }, strategy: 'direct' },
  std(n(140, 380, 2, 6, 18, 45, 6, 22), 56, '1 brownie ≈ 50–65 g, ~230 kcal'));

add('des-004', '1 katori kheer', 'dessert', ['indian', 'cooked_wet', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'kheer|payasam|phirni|rice pudding', reject_name_matches: 'raw rice|mix packet' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [120, 260] }, strategy: 'direct' },
  db(['INDB'], /rice kheer|^kheer|payasam/i, 'cooked', 180, 0.30));

add('des-005', '1 slice cheesecake', 'dessert', ['american', 'baked', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'cheesecake', reject_name_matches: 'mix|no-bake filling only|protein' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [80, 170] }, strategy: 'direct' },
  std(n(250, 550, 5, 12, 20, 45, 15, 38), 125, '1 slice cheesecake ≈ 320–400 kcal'));

add('des-006', '2 pieces baklava', 'dessert', ['middle_eastern', 'baked', 'generic', 'count_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'baklava|baclava|baklawa', reject_name_matches: 'phyllo only|syrup only' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [50, 120] }, strategy: 'direct' },
  published(n(200, 520, 3, 10, 20, 50, 10, 32), 70, '1 piece baklava ≈ 30–45 g, 130–200 kcal'));

add('des-007', '100g rasgulla', 'dessert', ['indian', 'boiled', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'rasgulla|rasogolla|rossogolla|roshogolla', reject_name_matches: 'dry mix|chhena only' }, food_class: 'dish', prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  published(n(120, 220, 3, 7, 22, 42, 0.5, 5), 100, 'rasgulla ≈ 150–190 kcal/100g'));

add('des-008', '1 jalebi', 'dessert', ['indian', 'fried', 'generic', 'count_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'jalebi|jilebi|jilipi|imarti', reject_name_matches: 'batter only|syrup only' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [20, 60] }, strategy: 'direct' },
  published(n(80, 260, 0.3, 3, 12, 36, 3, 14), 30, '1 jalebi ≈ 20–35 g, 130–200 kcal'));

/* ==================================================================== *
 *  H. SAUCES / CONDIMENTS                                               *
 * ==================================================================== */

add('sce-001', '1 tablespoon tomato ketchup', 'sauce_condiment', ['global', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'ketchup|catsup|tomato sauce', reject_name_matches: 'tomato, raw|tomato puree.*plain|pasta sauce|curry' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [14, 20] }, strategy: 'direct' },
  db(['USDA_FDC'], /ketchup|catsup/i, null, 17, 0.20));

add('sce-002', '2 tbsp mayonnaise', 'sauce_condiment', ['european', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'mayonnaise|mayo', reject_name_matches: 'salad.*miracle only|aioli.*house|egg, raw' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [26, 34] }, strategy: 'direct' },
  db(['USDA_FDC'], /mayonnaise/i, null, 30, 0.20));

add('sce-003', '1 tbsp soy sauce', 'sauce_condiment', ['east_asian', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'soy sauce|soya sauce|shoyu|tamari', reject_name_matches: 'soybean.*raw|soy milk|edamame' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [14, 20] }, strategy: 'direct' },
  db(['USDA_FDC'], /soy sauce|soya sauce/i, null, 16, 0.25));

add('sce-004', '30g mint chutney', 'sauce_condiment', ['indian', 'raw', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'chutney', reject_name_matches: 'mint leaves.*raw|coriander leaves.*raw|powder|podi' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [28, 32] }, strategy: 'direct' },
  db(['INDB'], /chutney/i, null, 30, 0.35));

add('sce-005', '20g honey', 'sauce_condiment', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'honey', reject_name_matches: 'honey.*roasted nut|cake|glazed|mustard' }, food_class: 'condiment', prep_state: 'raw', portion: { grams: [19, 21] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /^honey$|honey,/i, null, 20, 0.15));

add('sce-006', '2 tbsp olive oil', 'sauce_condiment', ['mediterranean', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'olive oil', reject_name_matches: 'olive, raw|olive.*fruit|spread' }, food_class: 'condiment', prep_state: 'raw', portion: { grams: [24, 30] }, strategy: 'direct' },
  std(n(210, 265, 0, 0.2, 0, 0.2, 24, 30), 27, '1 tbsp olive oil ≈ 13.5 g, 120 kcal'));

add('sce-007', '1 tbsp peanut butter', 'sauce_condiment', ['american', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'peanut butter', reject_name_matches: 'cup|cookie|powder.*pb2 novelty|sandwich' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [14, 20] }, strategy: 'direct' },
  db(['USDA_FDC'], /peanut butter/i, null, 16, 0.18));

add('sce-008', '15g sriracha', 'sauce_condiment', ['east_asian', 'raw', 'branded', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'sriracha|chili sauce|hot sauce|chilli sauce', reject_name_matches: 'chilli, raw|chili powder|curry' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [14, 16] }, strategy: 'direct' },
  std(n(10, 30, 0, 1, 2, 6, 0, 1), 15, 'sriracha ≈ 100 kcal/100g'));

/* ==================================================================== *
 *  I. NON-FOOD / MALFORMED  (must NOT fabricate a confident estimate)   *
 * ==================================================================== */

add('non-001', 'quantum flux capacitor', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-002', 'asdfghjkl', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-003', '', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-004', '-500 g rice', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected', 'malformed'], 'medium',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-005', 'car tyre', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-006', 'the weather today', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-007', '99999999 kg water', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected', 'malformed'], 'hard',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-008', 'lorem ipsum dolor sit amet', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-009', 'plastic bag', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected'], 'easy',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

add('non-010', '<script>alert(1)</script>', 'nonfood_or_malformed', ['nonfood', 'unresolved_expected', 'malformed'], 'medium',
  { is_nonfood: true, strategy: 'unresolved', plausible: false }, none());

/* ==================================================================== *
 *  J. LOW-CONFIDENCE / INTENTIONALLY DIFFICULT (should resolve OR       *
 *     unresolve, but must NOT be delivered at high confidence)          *
 * ==================================================================== */

add('lcf-001', 'grandma special sunday dish', 'composite_dish', ['global', 'low_confidence_expected', 'ambiguous', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'semantic', plausible: false }, none());

add('lcf-002', 'that thing we ate at the wedding', 'composite_dish', ['global', 'low_confidence_expected', 'ambiguous', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'unresolved', plausible: false }, none());

add('lcf-003', 'homemade fusion bowl', 'composite_dish', ['global', 'low_confidence_expected', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'semantic', plausible: false }, none());

add('lcf-004', 'leftover curry from yesterday', 'composite_dish', ['indian', 'low_confidence_expected', 'cooked_wet', 'hard'], 'hard',
  { entity: { name_matches: 'curry', reject_name_matches: 'powder|paste' }, confidence: ['low', 'medium', 'unreliable'], portion: { grams: [100, 400] }, strategy: 'semantic' },
  published(n(80, 400, 3, 24, 4, 30, 3, 28), 200, 'unspecified curry — very wide band'));

add('lcf-005', 'some snacks', 'snack', ['global', 'low_confidence_expected', 'ambiguous', 'no_quantity', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'unresolved', plausible: false }, none());

add('lcf-006', 'a big meal', 'meal', ['global', 'low_confidence_expected', 'ambiguous', 'no_quantity', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'unresolved', plausible: false }, none());

add('lcf-007', 'protein stuff', 'single_ingredient', ['global', 'low_confidence_expected', 'ambiguous', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'semantic', plausible: false }, none());

add('lcf-008', 'aunty ji ka khaana', 'meal', ['indian', 'low_confidence_expected', 'transliteration', 'ambiguous', 'hard'], 'hard',
  { entity: { name_matches: '.*' }, confidence: ['low', 'unreliable'], strategy: 'unresolved', plausible: false }, none());

/* ==================================================================== *
 *  K. AMBIGUOUS NAMES / ALIASES / TRANSLITERATIONS / SPELLINGS          *
 *     (identity is the whole point of these)                            *
 * ==================================================================== */

add('amb-001', 'egg', 'single_ingredient', ['global', 'raw', 'generic', 'no_quantity', 'ambiguous'], 'medium',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|albumen|substitute|noodle|plant|nog|roll' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [40, 120] }, strategy: 'direct' },
  std(n(45, 120, 4, 9, 0, 2, 3, 10), 50, 'bare "egg" should be a whole egg, not a yolk-only row'));

add('amb-002', 'chicken', 'single_ingredient', ['global', 'raw', 'generic', 'no_quantity', 'ambiguous'], 'medium',
  { entity: { name_matches: 'chicken', reject_name_matches: 'feet|foot|skin only|giblet|gizzard|neck|liver|heart|nugget|deli|luncheon' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct' },
  std(n(80, 320, 12, 40, 0, 3, 1, 20), 100, 'bare "chicken" — a meat cut, not offal or a processed form'));

add('amb-003', 'dahi', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'medium',
  { entity: { name_matches: 'dahi|curd|yogh?urt', reject_name_matches: 'kadhi|bhalla|vada|frozen|drink' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct' },
  std(n(45, 160, 3, 12, 3, 14, 2, 10), 100, 'dahi → curd/yogurt'));

add('amb-004', 'chana', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'ambiguous'], 'hard',
  { entity: { name_matches: 'chana|chickpea|bengal gram|garbanzo', reject_name_matches: 'chor|papad|masala.*gravy|curry|snack|besan|flour' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct' },
  std(n(90, 380, 5, 22, 12, 60, 1, 8), 100, 'chana → chickpea (whole or cooked), not the curry or a namkeen'));

add('amb-005', 'poori', 'prepared_food', ['indian', 'fried', 'generic', 'no_quantity', 'alias', 'transliteration', 'spelling_variant'], 'hard',
  { entity: { name_matches: 'poori|puri|bhatura', reject_name_matches: 'quinoa puffs|bhel|pani puri|golgappa|kolhapuri|papdi' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [25, 130] }, strategy: 'rescue' },
  published(n(90, 460, 1, 8, 8, 30, 4, 30), 40, 'a fried wheat poori ≈ 300–380 kcal/100g; ~30–45 g each'));

add('amb-006', 'bhindi', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'medium',
  { entity: { name_matches: 'bhindi|okra|lady.?s? finger', reject_name_matches: 'masala.*gravy|fried.*snack|kurkuri.*novelty' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct' },
  std(n(20, 160, 1, 5, 3, 20, 0, 10), 100, 'bhindi → okra'));

add('amb-007', 'chapatti', 'prepared_food', ['indian', 'cooked_dry', 'generic', 'no_quantity', 'spelling_variant', 'alias'], 'medium',
  { entity: { name_matches: 'chapati|chapatti|chappat|roti|phulka', reject_name_matches: 'paratha|naan|puri' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [25, 60] }, strategy: 'direct' },
  db(['INDB'], /chapati\/roti|^chapati$|^roti$/i, 'cooked', 40, 0.20));

add('amb-008', 'curd rice', 'composite_dish', ['south_asian', 'cooked', 'generic', 'no_quantity', 'combo', 'alias'], 'hard',
  { entity: { name_matches: 'curd rice|thayir sadam|dahi.*chawal|yogh?urt rice|bagala bath', reject_name_matches: 'raw rice|plain curd only' }, food_class: 'dish', prep_state: 'cooked', portion: { grams: [150, 350] }, strategy: 'direct' },
  published(n(150, 420, 4, 14, 22, 60, 3, 16), 250, 'curd rice ≈ 90–150 kcal/100g'));

add('amb-009', 'aloo', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'easy',
  { entity: { name_matches: 'aloo|potato', reject_name_matches: 'chip|fries|tikki|paratha|gobi|matar|dum|chaat' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 250] }, strategy: 'direct' },
  std(n(60, 200, 1.3, 6, 12, 42, 0, 3), 120, 'aloo → potato'));

add('amb-010', 'cottage cheese', 'single_ingredient', ['global', 'raw', 'generic', 'no_quantity', 'alias', 'ambiguous'], 'hard',
  { entity: { name_matches: 'cottage cheese|paneer', reject_name_matches: 'cream cheese|cheddar|processed|spread' }, food_class: 'ingredient', prep_state: 'raw', portion: { grams: [80, 200] }, strategy: 'direct', plausible: true },
  std(n(70, 320, 10, 22, 1, 8, 1, 25), 100, 'cottage cheese (US ~98 kcal) OR paneer (~300) — wide band spans both readings'));

add('amb-011', 'thayir', 'single_ingredient', ['south_asian', 'raw', 'generic', 'no_quantity', 'transliteration', 'alias'], 'hard',
  { entity: { name_matches: 'thayir|curd|dahi|yogh?urt', reject_name_matches: 'sadam|rice|vadai' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct', plausible: true }, none());

add('amb-012', 'sabzi', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'no_quantity', 'alias', 'ambiguous', 'transliteration'], 'hard',
  { entity: { name_matches: 'sabzi|sabji|vegetable curry|mixed veg|bhaji', reject_name_matches: 'raw vegetable|salad|masala.*powder' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [100, 300] }, strategy: 'semantic', plausible: true },
  published(n(60, 300, 2, 10, 6, 26, 3, 22), 150, 'generic Indian dry/wet vegetable dish — wide band'));

/* ==================================================================== *
 *  L. PORTION-FOCUSED  (identity is easy; the grams are the test)       *
 * ==================================================================== */

add('por-001', '250g chicken breast', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'chicken.*breast', reject_name_matches: 'deli|nugget|tender' }, prep_state: 'any', portion: { grams_exact: 250 }, strategy: 'direct' },
  db(['IFCT2017'], /chicken.*breast/i, null, 250, 0.22));

add('por-002', '0.2 kg paneer', 'single_ingredient', ['indian', 'raw', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'paneer|cottage cheese' }, prep_state: 'raw', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['IFCT2017', 'INDB'], /^paneer/i, 'raw', 200, 0.18));

add('por-003', '1 egg', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|substitute' }, prep_state: 'any', portion: { grams: [44, 60] }, strategy: 'direct' },
  std(n(60, 95, 5, 8, 0, 1.5, 4, 8), 50, '1 large egg 50 g'));

add('por-004', '3 roti', 'prepared_food', ['indian', 'cooked_dry', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'chapati|roti|phulka', reject_name_matches: 'paratha|naan|puri' }, prep_state: 'cooked_dry', portion: { grams: [105, 150] }, strategy: 'direct' },
  db(['INDB'], /chapati\/roti|^roti$|^chapati$/i, 'cooked', 120, 0.20));

add('por-005', '1 tablespoon ghee', 'sauce_condiment', ['indian', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'ghee|clarified butter', reject_name_matches: 'ghee rice|dal.*tadka|halwa' }, prep_state: 'raw', portion: { grams: [11, 16] }, strategy: 'direct' },
  std(n(90, 140, 0, 0.2, 0, 0.2, 11, 15), 13, '1 tbsp ghee ≈ 13 g, ~112 kcal'));

add('por-006', '1 bowl dal', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: '\\bdal|\\bdaal|lentil', reject_name_matches: 'raw|dry|fried|vada|halwa' }, prep_state: 'cooked_wet', portion: { grams: [180, 320] }, strategy: 'direct', plausible: true },
  published(n(120, 400, 6, 20, 14, 45, 3, 18), 250, '1 bowl (~250 ml) cooked dal'));

add('por-007', '2 cups cooked rice', 'single_ingredient', ['global', 'boiled', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'rice', reject_name_matches: 'raw|fried|pudding|krispies' }, prep_state: 'boiled', portion: { grams: [280, 380] }, strategy: 'direct' },
  std(n(340, 520, 6, 12, 70, 105, 0.5, 4), 316, '1 cup cooked rice ≈ 158 g'));

add('por-008', 'half a cup of almonds', 'single_ingredient', ['global', 'raw', 'generic', 'volume_portion', 'nl_quantity'], 'hard',
  { entity: { name_matches: 'almond', reject_name_matches: 'milk|butter|flour' }, prep_state: 'raw', portion: { grams: [55, 90] }, strategy: 'direct' },
  std(n(300, 520, 11, 22, 8, 24, 26, 44), 72, '1/2 cup whole almonds ≈ 72 g'));

add('por-009', '500g chicken curry', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'chicken.*curry|curry.*chicken|butter chicken|chicken.*gravy' }, prep_state: 'cooked_wet', portion: { grams_exact: 500 }, strategy: 'direct' },
  published(n(500, 1100, 45, 100, 10, 55, 20, 80), 500, '500 g chicken curry'));

add('por-010', '1 katori rice', 'single_ingredient', ['indian', 'boiled', 'generic', 'volume_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'rice', reject_name_matches: 'raw|fried|pudding|kheer|krispies' }, prep_state: 'boiled', portion: { grams: [100, 200] }, strategy: 'direct' },
  std(n(130, 300, 2, 7, 28, 65, 0.2, 3), 150, '1 katori cooked rice ≈ 150 g'));

/* ==================================================================== *
 *  M. RAW/COOKED VARIANT PAIRS  (relative correctness is the test)      *
 * ==================================================================== */

add('rcv-001', '100g raw chicken breast', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken.*breast' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /chicken.*breast.*raw|raw.*chicken.*breast|chicken.*breast.*skinless/i, 'raw', 100, 0.22));

add('rcv-002', '100g cooked chicken breast', 'prepared_food', ['global', 'cooked', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken.*breast' }, prep_state: 'cooked', portion: { grams: [98, 102] }, strategy: 'prep_variant' },
  db(['USDA_FDC', 'IFCT2017'], /chicken.*breast.*(cooked|roasted|grilled)/i, 'cooked', 100, 0.25));

add('rcv-003', '100g raw oats', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'oat' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /oats.*(raw|dry|rolled)|^oats/i, null, 100, 0.18));

add('rcv-004', '100g cooked oatmeal porridge', 'prepared_food', ['global', 'boiled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'oat|porridge|oatmeal' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /oatmeal.*(cooked|prepared)|oats.*cooked|porridge/i, 'cooked', 100, 0.28));

add('rcv-005', '150g raw potato', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'potato' }, prep_state: 'raw', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /potato.*raw|^potato,?\s*(nfs|white)?/i, 'raw', 150, 0.20));

add('rcv-006', '150g deep fried potato', 'prepared_food', ['global', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'potato|fries', reject_name_matches: 'raw|boiled' }, prep_state: 'fried', portion: { grams: [147, 153] }, strategy: 'prep_variant' },
  std(n(300, 560, 3, 9, 40, 70, 12, 30), 150, 'fried potato ≈ 260–330 kcal/100g'));

/* ==================================================================== *
 *  N. BRANDED vs GENERIC  (namespace disambiguation is the test)        *
 * ==================================================================== */

add('bnd-001', 'Maggi 2-minute noodles', 'composite_dish', ['global', 'cooked', 'branded', 'no_quantity'], 'medium',
  { entity: { name_matches: 'maggi|2.?minute|instant noodle', reject_name_matches: 'homemade|hakka.*restaurant' }, food_class: 'branded_product', prep_state: 'cooked', portion: { grams: [70, 250] }, strategy: 'direct' },
  published(n(250, 520, 5, 12, 35, 70, 8, 24), 80, '1 cake Maggi (~70–75 g dry) ≈ 350–390 kcal'));

add('bnd-002', 'Amul butter', 'sauce_condiment', ['indian', 'raw', 'branded', 'no_quantity'], 'easy',
  { entity: { name_matches: 'amul|butter', reject_name_matches: 'peanut butter|garlic bread|cookie|ghee' }, food_class: 'branded_product', prep_state: 'raw', portion: { grams: [5, 20] }, strategy: 'direct' },
  std(n(35, 150, 0, 1, 0, 1, 4, 17), 10, 'butter ≈ 720 kcal/100g'));

add('bnd-003', 'Coca Cola 500ml', 'beverage', ['global', 'raw', 'branded', 'volume_portion'], 'easy',
  { entity: { name_matches: 'coca.?cola|coke|cola', reject_name_matches: 'diet|zero|cherry novelty' }, food_class: 'branded_product', prep_state: 'any', portion: { grams: [490, 520] }, strategy: 'direct' },
  std(n(180, 240, 0, 1, 45, 60, 0, 0.5), 500, '500 ml regular cola ≈ 210 kcal'));

add('bnd-004', 'Oreo cookies', 'snack', ['american', 'baked', 'branded', 'no_quantity'], 'easy',
  { entity: { name_matches: 'oreo|sandwich cookie|cream biscuit', reject_name_matches: 'cake|milkshake novelty' }, food_class: 'branded_product', prep_state: 'baked', portion: { grams: [20, 80] }, strategy: 'direct' },
  std(n(100, 400, 0.5, 4, 15, 60, 3, 18), 33, '3 Oreos ≈ 33 g, 160 kcal'));

add('bnd-005', 'plain milk', 'beverage', ['global', 'raw', 'generic', 'no_quantity'], 'easy',
  { entity: { name_matches: '\\bmilk', reject_name_matches: 'amul|nestle|almond|soy|oat|brand' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [150, 300] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /milk, whole|whole milk/i, null, 200, 0.22));

add('bnd-006', 'generic potato chips', 'snack', ['global', 'fried', 'generic', 'no_quantity'], 'easy',
  { entity: { name_matches: 'potato chip|crisps', reject_name_matches: 'lay|pringles|bingo|kurkure|brand' }, food_class: 'snack', prep_state: 'fried', portion: { grams: [25, 60] }, strategy: 'direct' },
  std(n(120, 320, 1, 6, 12, 34, 7, 22), 40, 'plain salted chips ≈ 530 kcal/100g'));

add('bnd-007', 'Nutella', 'sauce_condiment', ['european', 'raw', 'branded', 'no_quantity'], 'easy',
  { entity: { name_matches: 'nutella|hazelnut spread|chocolate spread', reject_name_matches: 'hazelnut, raw|cocoa powder' }, food_class: 'branded_product', prep_state: 'any', portion: { grams: [10, 40] }, strategy: 'direct' },
  std(n(50, 240, 0.4, 4, 6, 26, 3, 14), 20, 'Nutella ≈ 539 kcal/100g'));

add('bnd-008', 'homemade chapati', 'prepared_food', ['indian', 'cooked_dry', 'generic', 'no_quantity'], 'medium',
  { entity: { name_matches: 'chapati|roti|phulka', reject_name_matches: 'frozen|commercially prepared|brand|packaged' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [25, 60] }, strategy: 'direct' },
  db(['INDB'], /chapati\/roti|^roti$|^chapati$/i, 'cooked', 40, 0.20));

/* ==================================================================== *
 *  O. EXTRA COMPOSITE COVERAGE (fill cuisine gaps, keep counts even)    *
 * ==================================================================== */

add('cmp-080', '200g dal makhani', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'dal makhani|makhani dal|maa ki dal|kali dal', reject_name_matches: 'raw|dry|black gram.*raw' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['INDB'], /dal makhani/i, 'cooked', 200, 0.30));

add('cmp-081', '150g aloo gobi', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'aloo gobi|gobi.*aloo|potato.*cauliflower|cauliflower.*potato', reject_name_matches: 'raw|manchurian' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['INDB'], /aloo gobi|potato.*cauliflower|cauliflower.*potato/i, 'cooked', 150, 0.30));

add('cmp-082', '1 bowl tom yum soup', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'tom yum|tom yam', reject_name_matches: 'paste only|cube' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [250, 450] }, strategy: 'direct', plausible: true },
  published(n(60, 300, 4, 20, 4, 20, 1, 14), 300, 'tom yum ≈ 30–90 kcal/100g'));

add('cmp-083', '250g pad thai', 'composite_dish', ['east_asian', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'pad thai|phad thai', reject_name_matches: 'sauce only|dry noodle brick' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [245, 255] }, strategy: 'direct' },
  published(n(300, 650, 10, 26, 35, 75, 8, 28), 250, 'pad thai ≈ 150–220 kcal/100g'));

add('cmp-084', '1 serving lasagna', 'composite_dish', ['european', 'baked', 'generic', 'no_quantity'], 'medium',
  { entity: { name_matches: 'lasagn', reject_name_matches: 'sheet only|dry pasta|sauce jar' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [250, 450] }, strategy: 'direct' },
  std(n(300, 700, 14, 34, 22, 55, 12, 40), 250, 'meat lasagna ≈ 130–180 kcal/100g'));

add('cmp-085', '200g chicken tikka masala', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'tikka masala|chicken.*tikka.*masala', reject_name_matches: 'dry tikka|tandoori.*dry|paste only|powder' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [195, 205] }, strategy: 'direct' },
  published(n(220, 520, 16, 36, 6, 22, 10, 34), 200, 'CTM ≈ 120–200 kcal/100g'));

add('cmp-086', '1 arepa with cheese', 'composite_dish', ['latin_american', 'cooked_dry', 'generic', 'count_portion', 'stuffed'], 'hard',
  { entity: { name_matches: 'arepa', reject_name_matches: 'flour only|masarepa' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [120, 260] }, strategy: 'decompose', plausible: true },
  published(n(220, 520, 6, 18, 30, 65, 6, 24), 150, 'cheese arepa ≈ 250–380 kcal'));

add('cmp-087', '1 bowl feijoada', 'composite_dish', ['latin_american', 'cooked_wet', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'feijoada', reject_name_matches: 'beans only.*plain|seasoning' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [250, 450] }, strategy: 'decompose', plausible: true },
  published(n(350, 800, 18, 40, 25, 55, 12, 40), 300, 'feijoada ≈ 120–200 kcal/100g'));

add('cmp-088', '250g injera with doro wat', 'composite_dish', ['african', 'cooked_wet', 'generic', 'explicit_grams', 'combo'], 'hard',
  { entity: { name_matches: 'doro wat|injera|wat|wot', reject_name_matches: 'teff flour only|berbere only' }, food_class: 'meal', prep_state: 'cooked_wet', portion: { grams: [245, 255] }, strategy: 'decompose', plausible: true },
  published(n(300, 650, 12, 30, 30, 70, 8, 30), 250, 'injera + doro wat ≈ 120–200 kcal/100g'));

add('cmp-089', '1 bowl matzo ball soup', 'composite_dish', ['middle_eastern', 'cooked_wet', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'matzo ball|matzah ball|knaidel|chicken soup.*matzo', reject_name_matches: 'matzo cracker only|meal mix' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [300, 500] }, strategy: 'decompose', plausible: true },
  published(n(150, 420, 6, 18, 14, 40, 3, 18), 350, 'matzo ball soup ≈ 40–90 kcal/100g'));

add('cmp-090', '150g ratatouille', 'composite_dish', ['mediterranean', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'ratatouille', reject_name_matches: 'raw vegetable|frozen mix' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct', plausible: true },
  published(n(50, 220, 1, 6, 5, 18, 2, 14), 150, 'ratatouille ≈ 45–110 kcal/100g'));

/* ==================================================================== *
 *  P. EXTRA SINGLE / PREPARED (round out counts + cuisines)             *
 * ==================================================================== */

add('sng-040', '100g cooked quinoa', 'single_ingredient', ['latin_american', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'quinoa', reject_name_matches: 'raw|flour|puff|salad.*dressing' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /quinoa.*cooked|cooked.*quinoa/i, 'cooked', 100, 0.20));

add('sng-041', '150g lentil soup', 'composite_dish', ['middle_eastern', 'cooked_wet', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'lentil soup|soup.*lentil', reject_name_matches: 'raw lentil|dry|dal.*tadka' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['USDA_FDC'], /lentil soup/i, 'cooked', 150, 0.28));

add('sng-042', '30g raisins', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'raisin|kishmish|sultana|dried grape', reject_name_matches: 'grape.*raw|bran cereal|cookie|toast' }, prep_state: 'any', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /raisins|kishmish/i, null, 30, 0.20));

add('sng-043', '200g cucumber', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'cucumber|kheera', reject_name_matches: 'pickle|raita|salad.*dressing|juice' }, prep_state: 'raw', portion: { grams: [196, 204] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /cucumber.*raw|^cucumber/i, 'raw', 200, 0.30));

add('sng-044', '100g cooked pasta', 'single_ingredient', ['european', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'pasta|spaghetti|macaroni|penne|fusilli', reject_name_matches: 'raw|dry|sauce|salad|bake' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /pasta.*cooked|spaghetti.*cooked|macaroni.*cooked/i, 'cooked', 100, 0.20));

add('sng-045', '150g grilled prawns', 'prepared_food', ['east_asian', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'prawn|shrimp|jhinga', reject_name_matches: 'raw|curry|tempura|cocktail sauce|cracker|paste' }, prep_state: 'grilled', portion: { grams: [146, 154] }, strategy: 'prep_variant' },
  db(['IFCT2017', 'USDA_FDC'], /prawn.*(cooked|boiled)|shrimp.*cooked/i, null, 150, 0.28));

add('sng-046', '1 medium orange', 'single_ingredient', ['mediterranean', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'orange', reject_name_matches: 'juice|soda|marmalade|candied|chicken' }, prep_state: 'raw', portion: { grams: [120, 200] }, strategy: 'direct' },
  std(n(45, 100, 0.5, 2, 10, 22, 0, 0.6), 140, '1 medium orange ≈ 130–150 g'));

add('sng-047', '50g feta cheese', 'single_ingredient', ['mediterranean', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'feta', reject_name_matches: 'salad.*dressing|spread' }, prep_state: 'any', portion: { grams: [48, 52] }, strategy: 'direct' },
  db(['USDA_FDC'], /cheese, feta/i, null, 50, 0.18));

add('sng-048', '100g cooked black beans', 'single_ingredient', ['latin_american', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'black bean', reject_name_matches: 'raw|soup|sauce|refried.*lard heavy|dip' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  std(n(100, 160, 6, 11, 15, 28, 0.2, 2), 100, 'USDA cooked black beans ≈ 132 kcal/100g'));

add('sng-049', '80g hummus', 'sauce_condiment', ['middle_eastern', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'hummus|hommus|houmous' }, food_class: 'condiment', prep_state: 'any', portion: { grams: [78, 82] }, strategy: 'direct' },
  db(['USDA_FDC'], /hummus|hommus/i, null, 80, 0.22));

add('sng-050', '150g cooked brown rice', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'brown rice|rice, brown', reject_name_matches: 'raw|krispies|cake|syrup' }, prep_state: 'boiled', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /brown rice.*cooked|rice, brown.*cooked/i, 'cooked', 150, 0.22));

/* ==================================================================== */

export default C;
