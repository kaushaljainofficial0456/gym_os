// ============================================================
// SKOS FOOD BENCHMARK — CASE SPECS  (supplementary breadth set)
// Merged with case_specs.v1.mjs by build.mjs. Same spec format.
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
const n = (kl, kh, pl, ph, cl, ch, fl, fh) => {
  const o = { kcal: [kl, kh] };
  if (pl != null) o.protein_g = [pl, ph];
  if (cl != null) o.carb_g = [cl, ch];
  if (fl != null) o.fat_g = [fl, fh];
  return o;
};

/* ---- more single ingredients (breadth: cuisines, forms) ---- */
add('x-sng-001', '100g raw tomato', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'tomato', reject_name_matches: 'ketchup|sauce|soup|curry|puree|paste|sundried|babyfood' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /tomato,?\s*(ripe|raw)/i, 'raw', 100, 0.25));
add('x-sng-002', '100g raw onion', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'onion', reject_name_matches: 'ring|fried|bhaji|pakora|powder|soup|gravy' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /onion.*raw|^onion/i, 'raw', 100, 0.25));
add('x-sng-003', '30g pumpkin seeds', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'pumpkin seed|pepita', reject_name_matches: 'pumpkin, raw|pie|soup' }, prep_state: 'any', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['USDA_FDC'], /pumpkin.*seed|pepita/i, null, 30, 0.20));
add('x-sng-004', '150g cooked lentils', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'lentil|masoor', reject_name_matches: 'raw|dry|soup|dal.*tadka|chip' }, prep_state: 'boiled', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /lentils.*cooked|cooked.*lentil/i, null, 150, 0.24));
add('x-sng-005', '100g cooked chickpeas', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'chickpea|bengal gram|garbanzo', reject_name_matches: 'flour|besan|curry|snack|fried|roasted|raw' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /chickpeas.*cooked|garbanzo.*cooked/i, null, 100, 0.24));
add('x-sng-006', '200g apple', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: '\\bapple', reject_name_matches: 'juice|sauce|pie|cider|babyfood|crumble' }, prep_state: 'raw', portion: { grams: [196, 204] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /apple.*raw|apples, raw/i, 'raw', 200, 0.25));
add('x-sng-007', '50g dates', 'single_ingredient', ['middle_eastern', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'date|khajur|khajoor', reject_name_matches: 'palm sugar|syrup|shake|bar|energy ball' }, prep_state: 'any', portion: { grams: [48, 52] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /dates|^date,/i, null, 50, 0.22));
add('x-sng-008', '100g raw beetroot', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'beet', reject_name_matches: 'juice|halwa|pickled|chip|greens only' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /beet.*raw|beetroot.*raw|beets, raw/i, 'raw', 100, 0.28));
add('x-sng-009', '30g sunflower seeds', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'sunflower seed', reject_name_matches: 'oil|butter|bread' }, prep_state: 'any', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['USDA_FDC'], /sunflower seed/i, null, 30, 0.20));
add('x-sng-010', '150g cooked spinach', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'spinach', reject_name_matches: 'raw|creamed.*heavy|paneer|dip|babyfood' }, prep_state: 'boiled', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /spinach.*(cooked|boiled)/i, 'cooked', 150, 0.30));
add('x-sng-011', '100g raw green peas', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'pea', reject_name_matches: 'peanut|split pea soup|pea protein|snap.*fried' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /peas, green.*raw|green peas.*raw/i, 'raw', 100, 0.28));
add('x-sng-012', '100g raw mushroom', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'mushroom', reject_name_matches: 'soup|sauce|gravy|risotto|fried.*crumb' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /mushroom.*raw|mushrooms, white, raw/i, 'raw', 100, 0.30));
add('x-sng-013', '30g flax seeds', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'flax|linseed|alsi', reject_name_matches: 'oil|bread|cracker' }, prep_state: 'any', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['USDA_FDC'], /flaxseed|flax seed|linseed/i, null, 30, 0.20));
add('x-sng-014', '150g cooked white rice', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'rice', reject_name_matches: 'raw|fried|pudding|krispies|cake' }, prep_state: 'boiled', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /rice, white.*cooked|cooked.*white rice/i, 'cooked', 150, 0.22));
add('x-sng-015', '40g mixed nuts', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'mixed nuts|nuts, mixed', reject_name_matches: 'trail mix.*chocolate|bar|butter' }, prep_state: 'any', portion: { grams: [38, 42] }, strategy: 'direct' },
  db(['USDA_FDC'], /nuts, mixed|mixed nuts/i, null, 40, 0.22));
add('x-sng-016', '100g raw cauliflower', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'cauliflower|gobi', reject_name_matches: 'manchurian|fried|65|pakora|cheese|soup' }, prep_state: 'raw', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /cauliflower.*raw|^cauliflower/i, 'raw', 100, 0.30));
add('x-sng-017', '120g grilled tofu', 'prepared_food', ['east_asian', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'tofu', reject_name_matches: 'silken.*raw|dessert|scramble' }, prep_state: 'grilled', portion: { grams: [117, 123] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /tofu.*(cooked|grilled|baked|fried)/i, null, 120, 0.30));
add('x-sng-018', '100g cooked kidney beans', 'single_ingredient', ['latin_american', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'kidney bean|rajma', reject_name_matches: 'raw|curry|masala|chawal|canned.*sauce' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct' },
  std(n(100, 155, 6, 11, 15, 27, 0.2, 2), 100, 'USDA cooked kidney beans ≈ 127 kcal/100g'));
add('x-sng-019', '100g cooked couscous', 'single_ingredient', ['african', 'steamed', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'couscous', reject_name_matches: 'raw|dry|salad.*dressing' }, prep_state: 'steamed', portion: { grams: [98, 102] }, strategy: 'direct' },
  db(['USDA_FDC'], /couscous.*cooked|cooked.*couscous/i, null, 100, 0.22));
add('x-sng-020', '150g grapes', 'single_ingredient', ['mediterranean', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'grape', reject_name_matches: 'juice|wine|raisin|jelly|leaves' }, prep_state: 'raw', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /grapes.*raw|grape,?\s*(seedless|raw)/i, 'raw', 150, 0.25));

/* ---- more prepared foods ---- */
add('x-prp-001', '150g roasted chicken thigh', 'prepared_food', ['global', 'roasted', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken.*thigh|thigh.*chicken', reject_name_matches: 'raw|nugget|deli|curry' }, prep_state: 'roasted', portion: { grams: [147, 153] }, strategy: 'prep_variant' },
  db(['USDA_FDC', 'IFCT2017'], /chicken.*thigh.*(cooked|roasted)/i, 'cooked', 150, 0.26));
add('x-prp-002', '100g boiled egg white', 'single_ingredient', ['global', 'boiled', 'generic', 'explicit_grams', 'ambiguous'], 'hard',
  { entity: { name_matches: 'egg.*white|white.*egg|albumen', reject_name_matches: 'whole egg|yolk' }, prep_state: 'boiled', portion: { grams: [98, 102] }, strategy: 'direct', plausible: true },
  db(['USDA_FDC', 'IFCT2017'], /egg.*white.*(cooked|raw)|egg white/i, null, 100, 0.22));
add('x-prp-003', '100g grilled halloumi', 'prepared_food', ['mediterranean', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'halloumi|haloumi|cheese', reject_name_matches: 'raw milk|salad.*dressing|cheddar|feta.*only' }, prep_state: 'grilled', portion: { grams: [98, 102] }, strategy: 'direct', plausible: true },
  std(n(280, 400, 18, 28, 1, 6, 22, 32), 100, 'halloumi ≈ 320–360 kcal/100g'));
add('x-prp-004', '2 hard boiled eggs', 'prepared_food', ['global', 'boiled', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white only|substitute|scrambled|deviled' }, prep_state: 'boiled', portion: { grams: [88, 110] }, strategy: 'direct' },
  std(n(130, 180, 11, 16, 0, 2.5, 9, 13), 100, '2 large hard-boiled eggs ≈ 100 g, 155 kcal'));
add('x-prp-005', '150g baked cod', 'prepared_food', ['european', 'baked', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: '\\bcod\\b', reject_name_matches: 'raw|liver oil|fish finger|cake' }, prep_state: 'baked', portion: { grams: [147, 153] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /cod.*(cooked|baked)/i, 'cooked', 150, 0.26));
add('x-prp-006', '1 waffle', 'prepared_food', ['american', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'waffle', reject_name_matches: 'mix.*dry|batter|potato waffle' }, prep_state: 'baked', portion: { grams: [30, 90] }, strategy: 'direct' },
  std(n(80, 260, 2, 8, 12, 35, 2, 12), 39, '1 round waffle ≈ 35–45 g, 100–130 kcal'));
add('x-prp-007', '150g roasted vegetables', 'prepared_food', ['mediterranean', 'roasted', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'roasted vegetable|vegetable.*roasted|grilled vegetable', reject_name_matches: 'raw|frozen mix|babyfood' }, prep_state: 'roasted', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(60, 220, 1, 6, 6, 24, 2, 14), 150, 'olive-oil roasted mixed veg ≈ 60–130 kcal/100g'));
add('x-prp-008', '1 pancake', 'prepared_food', ['american', 'cooked_dry', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'pancake|hotcake|griddle cake', reject_name_matches: 'mix.*dry|batter|potato pancake|cheela' }, prep_state: 'cooked_dry', portion: { grams: [30, 100] }, strategy: 'direct' },
  std(n(60, 220, 2, 7, 10, 32, 1, 10), 38, '1 4-inch pancake ≈ 38 g, 86 kcal'));
add('x-prp-009', '200g boiled pasta', 'single_ingredient', ['european', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'pasta|spaghetti|macaroni|penne', reject_name_matches: 'raw|dry|sauce|bake|salad' }, prep_state: 'boiled', portion: { grams: [196, 204] }, strategy: 'direct' },
  db(['USDA_FDC'], /pasta.*cooked|spaghetti.*cooked/i, 'cooked', 200, 0.20));
add('x-prp-010', '1 hash brown', 'prepared_food', ['american', 'fried', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'hash brown|hashbrown|potato.*fried.*patty', reject_name_matches: 'raw|mashed|tots.*bulk' }, prep_state: 'fried', portion: { grams: [40, 90] }, strategy: 'direct' },
  std(n(90, 240, 1, 4, 10, 28, 4, 16), 55, '1 fast-food hash brown ≈ 55 g, 150 kcal'));

/* ---- more composite dishes ---- */
add('x-cmp-001', '200g fish curry', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'fish curry|curry.*fish|meen|machli.*curr|machhi', reject_name_matches: 'raw|fried.*dry|finger|powder' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['INDB'], /fish curry|curry.*fish/i, 'cooked', 200, 0.32));
add('x-cmp-002', '150g egg curry', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'egg curry|anda curr|curry.*egg', reject_name_matches: 'boiled egg only|raw|omelet' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  db(['INDB'], /egg curry|anda.*curr/i, 'cooked', 150, 0.30));
add('x-cmp-003', '1 bowl minestrone', 'composite_dish', ['mediterranean', 'cooked_wet', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'minestrone', reject_name_matches: 'dry mix|cube' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [220, 400] }, strategy: 'direct' },
  db(['USDA_FDC'], /minestrone/i, 'cooked', 250, 0.28));
add('x-cmp-004', '250g chicken fried rice', 'composite_dish', ['east_asian', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'fried rice', reject_name_matches: 'raw|steamed rice$|plain rice' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [245, 255] }, strategy: 'direct' },
  db(['USDA_FDC', 'INDB'], /fried rice.*(chicken|meat)|chicken fried rice/i, 'cooked', 250, 0.30));
add('x-cmp-005', '1 bowl clam chowder', 'composite_dish', ['american', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'clam chowder|chowder.*clam', reject_name_matches: 'clam.*raw|cracker only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [240, 400] }, strategy: 'direct' },
  db(['USDA_FDC'], /clam chowder/i, 'cooked', 250, 0.28));
add('x-cmp-006', '150g saag', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'saag|sarson.*saag|mustard greens.*cooked|palak.*bhaji', reject_name_matches: 'raw|paneer.*only|saagwala novelty' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct', plausible: true },
  published(n(70, 260, 3, 12, 5, 20, 3, 20), 150, 'sarson ka saag ≈ 90–150 kcal/100g'));
add('x-cmp-007', '200g vegetable pulao', 'composite_dish', ['indian', 'cooked_dry', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'pulao|pilaf|pulav|pilau', reject_name_matches: 'raw|biryani.*mutton|masala.*powder' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [195, 205] }, strategy: 'direct' },
  db(['INDB'], /pulao|pilaf|vegetable.*rice/i, 'cooked', 200, 0.30));
add('x-cmp-008', '1 bowl gazpacho', 'composite_dish', ['mediterranean', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'gazpacho', reject_name_matches: 'tomato juice|salsa' }, food_class: 'dish', prep_state: 'raw', portion: { grams: [200, 350] }, strategy: 'direct', plausible: true },
  published(n(40, 160, 1, 5, 5, 22, 1, 10), 250, 'gazpacho ≈ 30–60 kcal/100g'));
add('x-cmp-009', '250g bibimbap', 'composite_dish', ['east_asian', 'cooked', 'generic', 'explicit_grams', 'topped'], 'hard',
  { entity: { name_matches: 'bibimbap', reject_name_matches: 'rice only|sauce only|gochujang' }, food_class: 'meal', prep_state: 'cooked', portion: { grams: [245, 255] }, strategy: 'decompose' },
  published(n(280, 620, 8, 24, 30, 70, 6, 26), 250, 'bibimbap ≈ 120–200 kcal/100g'));
add('x-cmp-010', '1 gyro', 'composite_dish', ['mediterranean', 'grilled', 'generic', 'count_portion', 'stuffed', 'combo'], 'hard',
  { entity: { name_matches: 'gyro|gyros|doner|donair', reject_name_matches: 'meat only|pita only|tzatziki only' }, food_class: 'meal', prep_state: 'grilled', portion: { grams: [250, 450] }, strategy: 'decompose' },
  published(n(400, 900, 20, 46, 30, 75, 15, 45), 300, 'gyro sandwich ≈ 500–750 kcal'));
add('x-cmp-011', '150g mapo tofu', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'mapo tofu|ma po tofu|mapo doufu', reject_name_matches: 'tofu.*plain|sauce only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(140, 360, 8, 22, 4, 16, 8, 26), 150, 'mapo tofu ≈ 100–200 kcal/100g'));
add('x-cmp-012', '1 bowl dal tadka', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'dal tadka|tadka dal|dal fry|toor dal|arhar dal|yellow dal', reject_name_matches: 'raw|dry|makhani|vada|halwa' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [180, 320] }, strategy: 'direct', plausible: true },
  published(n(120, 400, 6, 20, 12, 42, 3, 18), 250, 'dal tadka ≈ 100–150 kcal/100g'));
add('x-cmp-013', '200g vegetable stew', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'stew|ishtu|vegetable.*curry.*coconut', reject_name_matches: 'raw|beef stew.*heavy' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [195, 205] }, strategy: 'direct', plausible: true },
  published(n(80, 300, 2, 10, 8, 28, 2, 18), 200, 'kerala vegetable stew ≈ 60–130 kcal/100g'));
add('x-cmp-014', '1 spring roll', 'composite_dish', ['east_asian', 'fried', 'generic', 'count_portion', 'stuffed'], 'easy',
  { entity: { name_matches: 'spring roll|egg roll|lumpia', reject_name_matches: 'wrapper only|fresh.*rice paper.*plain' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [30, 90] }, strategy: 'direct' },
  std(n(60, 220, 1.5, 6, 6, 24, 3, 14), 40, '1 fried veg spring roll ≈ 35–50 g, 100–150 kcal'));
add('x-cmp-015', '150g chicken 65', 'composite_dish', ['south_asian', 'fried', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'chicken 65|chicken sixty five', reject_name_matches: 'gravy only|raw|marinade only' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(250, 500, 16, 32, 6, 22, 12, 36), 150, 'chicken 65 ≈ 200–320 kcal/100g'));
add('x-cmp-016', '1 quesadilla', 'composite_dish', ['latin_american', 'cooked_dry', 'generic', 'count_portion', 'stuffed'], 'medium',
  { entity: { name_matches: 'quesadilla', reject_name_matches: 'tortilla only|cheese only' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [120, 300] }, strategy: 'direct' },
  published(n(250, 650, 10, 30, 22, 55, 10, 36), 180, 'cheese quesadilla ≈ 300–500 kcal'));
add('x-cmp-017', '1 bowl congee', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'congee|jook|rice porridge|zhou', reject_name_matches: 'raw rice|kheer' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [250, 500] }, strategy: 'direct', plausible: true },
  published(n(80, 300, 2, 12, 14, 45, 0.5, 8), 300, 'plain/chicken congee ≈ 30–70 kcal/100g'));
add('x-cmp-018', '250g paella', 'composite_dish', ['mediterranean', 'cooked_dry', 'generic', 'explicit_grams'], 'hard',
  { entity: { name_matches: 'paella', reject_name_matches: 'rice only|seasoning|sofrito only' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [245, 255] }, strategy: 'decompose' },
  published(n(280, 620, 10, 28, 30, 70, 6, 26), 250, 'seafood paella ≈ 130–200 kcal/100g'));
add('x-cmp-019', '150g keema', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'keema|kheema|qeema|minced.*meat.*curr|mince.*curr', reject_name_matches: 'raw mince|samosa|pav only' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [146, 154] }, strategy: 'direct' },
  published(n(220, 480, 16, 32, 3, 16, 12, 34), 150, 'mutton keema ≈ 180–300 kcal/100g'));
add('x-cmp-020', '1 bowl thukpa', 'composite_dish', ['east_asian', 'cooked_wet', 'generic', 'volume_portion', 'transliteration'], 'hard',
  { entity: { name_matches: 'thukpa|thenthuk|noodle soup.*tibetan', reject_name_matches: 'dry noodle|momo' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [350, 700] }, strategy: 'decompose', plausible: true },
  published(n(300, 650, 12, 34, 35, 85, 5, 22), 450, 'chicken thukpa ≈ 350–500 kcal/bowl'));

/* ---- more beverages ---- */
add('x-bev-001', '250ml apple juice', 'beverage', ['global', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'apple juice', reject_name_matches: 'cider vinegar|apple.*raw|smoothie|10% drink' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [240, 270] }, strategy: 'direct' },
  db(['USDA_FDC'], /apple juice/i, null, 250, 0.20));
add('x-bev-002', '1 cup green tea', 'beverage', ['east_asian', 'cooked_wet', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'green tea|tea, green|matcha', reject_name_matches: 'ice cream|latte.*sweet|bottled.*sugar|leaves.*raw' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 260] }, strategy: 'direct' },
  std(n(0, 12, 0, 0.6, 0, 2, 0, 0.2), 240, 'plain brewed green tea ≈ 1 kcal/100g'));
add('x-bev-003', '200ml buttermilk', 'beverage', ['indian', 'raw', 'generic', 'volume_portion', 'transliteration'], 'easy',
  { entity: { name_matches: 'buttermilk|chaas|chaach|mattha|majjige', reject_name_matches: 'powder|pancake|biscuit' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [195, 210] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /buttermilk/i, null, 200, 0.25));
add('x-bev-004', '1 latte', 'beverage', ['european', 'cooked_wet', 'generic', 'no_quantity'], 'medium',
  { entity: { name_matches: 'latte|caffe? latte|coffee.*milk', reject_name_matches: 'black coffee|espresso.*plain|frappe' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 400] }, strategy: 'direct' },
  std(n(80, 220, 4, 12, 8, 22, 3, 10), 240, 'medium latte w/ whole milk ≈ 120–190 kcal'));
add('x-bev-005', '330ml sweetened iced tea', 'beverage', ['american', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'iced tea|ice tea|sweet tea', reject_name_matches: 'unsweetened|green tea plain|leaves' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [320, 350] }, strategy: 'direct' },
  std(n(60, 160, 0, 1, 15, 40, 0, 0.5), 335, 'sweetened iced tea ≈ 30 kcal/100g'));
add('x-bev-006', '1 glass fresh lime soda (sweet)', 'beverage', ['indian', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'lime soda|nimbu.*soda|lemonade|nimbu pani|shikanji', reject_name_matches: 'lime, raw|salted only.*no sugar' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 320] }, strategy: 'direct' },
  std(n(60, 180, 0, 1, 15, 45, 0, 0.5), 250, 'sweet lime soda ≈ 30–50 kcal/100g'));
add('x-bev-007', '250ml soy milk', 'beverage', ['east_asian', 'raw', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'soy milk|soya milk|soymilk', reject_name_matches: 'soybean.*raw|tofu|edamame|sauce' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [240, 270] }, strategy: 'direct' },
  db(['USDA_FDC'], /soy ?milk|soya milk/i, null, 250, 0.25));
add('x-bev-008', '1 can energy drink', 'beverage', ['global', 'raw', 'branded', 'count_portion'], 'easy',
  { entity: { name_matches: 'energy drink|red bull|monster|sting', reject_name_matches: 'sugar.?free|zero|coffee' }, food_class: 'branded_product', prep_state: 'any', portion: { grams: [240, 260] }, strategy: 'direct' },
  std(n(90, 170, 0, 2, 22, 40, 0, 0.5), 250, '250 ml energy drink ≈ 110–130 kcal'));
add('x-bev-009', '200ml mango lassi', 'beverage', ['indian', 'raw', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: 'mango lassi|lassi.*mango', reject_name_matches: 'plain lassi.*salt|mango pulp only' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [195, 210] }, strategy: 'direct' },
  published(n(130, 320, 3, 9, 20, 48, 2, 10), 200, 'mango lassi ≈ 90–150 kcal/100g'));
add('x-bev-010', '1 cup hot chocolate', 'beverage', ['european', 'cooked_wet', 'generic', 'volume_portion'], 'easy',
  { entity: { name_matches: 'hot chocolate|hot cocoa|drinking chocolate', reject_name_matches: 'chocolate bar|cocoa powder.*plain|cold' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [200, 300] }, strategy: 'direct' },
  std(n(120, 280, 4, 12, 18, 40, 3, 12), 250, 'hot chocolate w/ milk ≈ 60–110 kcal/100g'));

/* ---- more snacks / desserts ---- */
add('x-snk-001', '30g pretzels', 'snack', ['european', 'baked', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'pretzel', reject_name_matches: 'soft pretzel.*large|chocolate.*covered' }, prep_state: 'baked', portion: { grams: [29, 31] }, strategy: 'direct' },
  db(['USDA_FDC'], /pretzel/i, null, 30, 0.20));
add('x-snk-002', '1 rice cake', 'snack', ['global', 'cooked_dry', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'rice cake', reject_name_matches: 'mochi|kheer|fried|pudding' }, prep_state: 'any', portion: { grams: [7, 15] }, strategy: 'direct' },
  std(n(20, 60, 0.3, 2, 5, 14, 0, 1), 9, '1 plain rice cake ≈ 9 g, 35 kcal'));
add('x-snk-003', '40g khakhra', 'snack', ['indian', 'cooked_dry', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'khakhra|khakra', reject_name_matches: 'chaat|dough|raw' }, prep_state: 'cooked_dry', portion: { grams: [38, 42] }, strategy: 'direct' },
  published(n(140, 240, 4, 10, 20, 34, 3, 12), 40, 'khakhra ≈ 380–480 kcal/100g'));
add('x-snk-004', '50g banana chips', 'snack', ['south_asian', 'fried', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'banana chip|plantain chip|kela.*chip', reject_name_matches: 'banana, raw|shake|bread' }, prep_state: 'fried', portion: { grams: [48, 52] }, strategy: 'direct' },
  db(['USDA_FDC'], /banana chips|plantain chips/i, null, 50, 0.25));
add('x-snk-005', '25g dark chocolate square', 'snack', ['european', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'dark chocolate|chocolate.*dark', reject_name_matches: 'milk chocolate|white|drink|spread' }, prep_state: 'any', portion: { grams: [24, 26] }, strategy: 'direct' },
  db(['USDA_FDC'], /chocolate, dark|dark chocolate/i, null, 25, 0.22));
add('x-des-001', '1 slice carrot cake', 'dessert', ['american', 'baked', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'carrot cake', reject_name_matches: 'carrot, raw|carrot halwa|mix.*dry' }, food_class: 'dish', prep_state: 'baked', portion: { grams: [80, 160] }, strategy: 'direct' },
  std(n(250, 550, 3, 9, 30, 62, 12, 34), 110, '1 slice carrot cake w/ frosting ≈ 300–450 kcal'));
add('x-des-002', '100g gajar halwa', 'dessert', ['indian', 'cooked_wet', 'generic', 'explicit_grams', 'transliteration'], 'medium',
  { entity: { name_matches: 'gajar.*halwa|carrot halwa|halwa.*carrot|gajrela', reject_name_matches: 'carrot, raw|cake|soup' }, food_class: 'dish', prep_state: 'cooked_wet', portion: { grams: [98, 102] }, strategy: 'direct' },
  published(n(180, 400, 2, 8, 20, 45, 8, 24), 100, 'gajar ka halwa ≈ 200–350 kcal/100g'));
add('x-des-003', '1 chocolate chip cookie', 'dessert', ['american', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'chocolate chip cookie|cookie.*chocolate chip', reject_name_matches: 'dough.*raw|mix|protein' }, food_class: 'snack', prep_state: 'baked', portion: { grams: [12, 45] }, strategy: 'direct' },
  std(n(50, 220, 0.5, 3, 6, 30, 2, 12), 16, '1 medium cookie ≈ 16 g, 78 kcal'));
add('x-des-004', '1 scoop kulfi', 'dessert', ['south_asian', 'raw', 'generic', 'count_portion', 'transliteration'], 'medium',
  { entity: { name_matches: 'kulfi|malai kulfi', reject_name_matches: 'falooda only|ice cream, vanilla' }, food_class: 'dish', prep_state: 'any', portion: { grams: [40, 90] }, strategy: 'direct' },
  published(n(90, 320, 2, 8, 8, 34, 4, 18), 55, 'kulfi ≈ 180–280 kcal/100g'));
add('x-des-005', '1 doughnut', 'dessert', ['american', 'fried', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'doughnut|donut', reject_name_matches: 'hole only|mix|batter' }, food_class: 'dish', prep_state: 'fried', portion: { grams: [40, 90] }, strategy: 'direct' },
  db(['USDA_FDC'], /doughnut|donut/i, null, 60, 0.28));

/* ---- more meals ---- */
add('x-mel-001', 'chicken sandwich and a bag of chips', 'meal', ['american', 'cooked', 'generic', 'multi_food', 'combo'], 'medium',
  { items: [
    { entity: { name_matches: 'chicken sandwich|sandwich.*chicken' } },
    { entity: { name_matches: 'chip|crisp' } },
  ], strategy: 'direct' },
  published(n(500, 950, 22, 46, 45, 95, 18, 50), null, 'chicken sandwich (~450) + small chips (~250)'));
add('x-mel-002', 'dosa with sambar and chutney', 'meal', ['south_asian', 'cooked', 'generic', 'multi_food', 'combo'], 'medium',
  { items: [
    { entity: { name_matches: 'dosa' } },
    { entity: { name_matches: 'sambar|sambhar' } },
    { entity: { name_matches: 'chutney' } },
  ], strategy: 'direct' },
  published(n(300, 650, 7, 20, 45, 95, 8, 26), null, '1 dosa + sambar + coconut chutney'));
add('x-mel-003', 'two eggs and toast', 'meal', ['global', 'cooked', 'generic', 'multi_food', 'count_portion'], 'easy',
  { items: [
    { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|substitute' } },
    { entity: { name_matches: 'toast|bread' } },
  ], strategy: 'direct' },
  published(n(220, 440, 14, 24, 15, 40, 10, 24), null, '2 eggs + 1 slice toast'));
add('x-mel-004', 'rice with rajma and a side salad', 'meal', ['indian', 'cooked', 'generic', 'multi_food', 'combo'], 'medium',
  { items: [
    { entity: { name_matches: 'rice', reject_name_matches: 'raw|krispies' } },
    { entity: { name_matches: 'rajma|rajmah|kidney bean' } },
    { entity: { name_matches: 'salad|lettuce|greens|kachumber' } },
  ], strategy: 'direct' },
  published(n(350, 720, 12, 28, 55, 115, 6, 26), null, '1 cup rice + rajma + salad'));
add('x-mel-005', 'protein shake and a banana', 'meal', ['global', 'raw', 'generic', 'multi_food', 'count_portion'], 'easy',
  { items: [
    { entity: { name_matches: 'whey|protein.*shake|protein.*powder|protein drink' } },
    { entity: { name_matches: 'banana' } },
  ], strategy: 'direct' },
  published(n(200, 400, 18, 30, 25, 55, 1, 10), null, '1 scoop whey + 1 banana'));
add('x-mel-006', 'grilled cheese sandwich and tomato soup', 'meal', ['american', 'cooked', 'generic', 'multi_food', 'combo'], 'medium',
  { items: [
    { entity: { name_matches: 'grilled cheese|cheese sandwich|sandwich.*cheese' } },
    { entity: { name_matches: 'tomato soup|soup.*tomato' } },
  ], strategy: 'direct' },
  published(n(400, 800, 12, 30, 40, 80, 16, 44), null, 'grilled cheese (~350) + tomato soup (~150)'));
add('x-mel-007', 'idli sambar for breakfast', 'meal', ['south_asian', 'cooked', 'generic', 'multi_food', 'combo'], 'easy',
  { items: [
    { entity: { name_matches: '\\bidli' } },
    { entity: { name_matches: 'sambar|sambhar' } },
  ], strategy: 'direct' },
  published(n(200, 480, 6, 18, 35, 80, 3, 16), null, '3 idli + sambar'));
add('x-mel-008', 'chapati with sabzi and dahi', 'meal', ['indian', 'cooked', 'generic', 'multi_food', 'combo'], 'medium',
  { items: [
    { entity: { name_matches: 'chapati|roti|phulka' } },
    { entity: { name_matches: 'sabzi|sabji|vegetable|bhaji|curry' } },
    { entity: { name_matches: 'dahi|curd|yogh?urt' } },
  ], strategy: 'direct' },
  published(n(280, 620, 10, 26, 35, 80, 8, 28), null, '2 chapati + veg sabzi + curd'));

/* ---- portion + count edge cases ---- */
add('x-por-001', '12 almonds', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'medium',
  { entity: { name_matches: 'almond', reject_name_matches: 'milk|butter|flour' }, prep_state: 'raw', portion: { grams: [12, 20] }, strategy: 'direct' },
  std(n(70, 140, 2, 6, 2, 7, 6, 12), 15, '~1.2 g per almond → 12 ≈ 14 g'));
add('x-por-002', '1 handful of peanuts', 'single_ingredient', ['global', 'raw', 'generic', 'nl_quantity'], 'hard',
  { entity: { name_matches: 'peanut|groundnut', reject_name_matches: 'butter|oil|sauce|chikki' }, prep_state: 'any', portion: { grams: [20, 45] }, strategy: 'direct' },
  std(n(110, 280, 5, 14, 3, 12, 8, 24), 30, '1 handful ≈ 25–35 g'));
add('x-por-003', '4 tablespoons rice', 'single_ingredient', ['global', 'boiled', 'generic', 'volume_portion'], 'hard',
  { entity: { name_matches: 'rice', reject_name_matches: 'raw|fried|krispies|pudding' }, prep_state: 'any', portion: { grams: [40, 90] }, strategy: 'direct' },
  std(n(50, 170, 1, 5, 10, 36, 0.2, 3), 60, '4 tbsp cooked rice ≈ 50–70 g'));
add('x-por-004', '250 grams chicken', 'single_ingredient', ['global', 'raw', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'chicken', reject_name_matches: 'feet|skin only|giblet|nugget|deli' }, prep_state: 'any', portion: { grams_exact: 250 }, strategy: 'direct' },
  std(n(200, 620, 30, 80, 0, 6, 3, 40), 250, '250 g chicken meat'));
add('x-por-005', '1.5 cups milk', 'beverage', ['global', 'raw', 'generic', 'volume_portion', 'nl_quantity'], 'medium',
  { entity: { name_matches: '\\bmilk', reject_name_matches: 'powder|shake|almond|soy|condensed' }, prep_state: 'any', portion: { grams: [330, 400] }, strategy: 'direct' },
  std(n(180, 320, 10, 16, 15, 26, 8, 16), 366, '1.5 cups milk ≈ 366 g'));
add('x-por-006', '2 large eggs', 'single_ingredient', ['global', 'raw', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'egg', reject_name_matches: 'yolk|white|substitute|noodle' }, prep_state: 'any', portion: { grams: [96, 108] }, strategy: 'direct' },
  std(n(130, 170, 11, 15, 0, 2, 9, 13), 100, '2 large eggs 100 g'));
add('x-por-007', '1 slice of pizza', 'composite_dish', ['american', 'baked', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'pizza', reject_name_matches: 'dough only|sauce only|base' }, prep_state: 'baked', portion: { grams: [90, 170] }, strategy: 'direct' },
  std(n(180, 400, 7, 18, 18, 42, 6, 22), 110, '1 slice regular pizza ≈ 100–125 g'));
add('x-por-008', '300 ml dal', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'volume_portion'], 'medium',
  { entity: { name_matches: '\\bdal|\\bdaal|lentil', reject_name_matches: 'raw|dry|vada|halwa' }, prep_state: 'cooked_wet', portion: { grams: [270, 340] }, strategy: 'direct', plausible: true },
  published(n(150, 460, 8, 24, 16, 52, 4, 22), 300, '300 ml cooked dal'));

/* ---- more ambiguity / alias / transliteration ---- */
add('x-amb-001', 'anda', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'easy',
  { entity: { name_matches: 'egg|anda', reject_name_matches: 'yolk|white|substitute' }, prep_state: 'any', portion: { grams: [40, 120] }, strategy: 'direct' },
  std(n(45, 130, 4, 9, 0, 2, 3, 11), 50, 'anda → egg'));
add('x-amb-002', 'jeera rice', 'composite_dish', ['indian', 'cooked_dry', 'generic', 'no_quantity', 'combo', 'transliteration'], 'medium',
  { entity: { name_matches: 'jeera rice|cumin rice|rice.*jeera|rice.*cumin', reject_name_matches: 'raw|cumin seeds only|jeera water' }, food_class: 'dish', prep_state: 'cooked_dry', portion: { grams: [120, 300] }, strategy: 'direct' },
  published(n(150, 420, 3, 10, 25, 65, 3, 16), 200, 'jeera rice ≈ 130–180 kcal/100g'));
add('x-amb-003', 'chai', 'beverage', ['indian', 'cooked_wet', 'generic', 'no_quantity', 'alias', 'transliteration'], 'easy',
  { entity: { name_matches: 'chai|tea', reject_name_matches: 'leaves.*raw|green tea plain|chai spice mix|latte.*syrup novelty' }, food_class: 'beverage', prep_state: 'any', portion: { grams: [100, 220] }, strategy: 'direct' },
  published(n(30, 140, 1, 5, 4, 20, 1, 6), 150, 'chai → Indian milk tea w/ sugar'));
add('x-amb-004', 'sooji', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'medium',
  { entity: { name_matches: 'sooji|suji|semolina|rava|wheat, semolina', reject_name_matches: 'upma|halwa|idli|cheela|cooked' }, prep_state: 'raw', portion: { grams: [80, 200] }, strategy: 'direct' },
  db(['IFCT2017', 'USDA_FDC'], /semolina|wheat, semolina|rava/i, null, 100, 0.20));
add('x-amb-005', 'gobi', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'transliteration'], 'easy',
  { entity: { name_matches: 'gobi|cauliflower', reject_name_matches: 'manchurian|65|pakora|paratha|fried|aloo gobi' }, prep_state: 'any', portion: { grams: [80, 250] }, strategy: 'direct' },
  std(n(15, 120, 1, 5, 3, 20, 0, 6), 100, 'gobi → cauliflower'));
add('x-amb-006', 'curd', 'single_ingredient', ['indian', 'raw', 'generic', 'no_quantity', 'alias', 'ambiguous'], 'medium',
  { entity: { name_matches: 'curd|dahi|yogh?urt', reject_name_matches: 'bean curd|tofu|cottage.*dry|kadhi|rice, curd|cheese, cottage' }, prep_state: 'any', portion: { grams: [80, 200] }, strategy: 'direct' },
  std(n(40, 160, 3, 12, 3, 14, 1.5, 10), 100, 'curd → dahi/yogurt (not bean curd / cottage cheese)'));
add('x-amb-007', 'paratha', 'prepared_food', ['indian', 'fried', 'generic', 'no_quantity', 'transliteration'], 'medium',
  { entity: { name_matches: 'parat|parant', reject_name_matches: 'chapati only|naan|puri|kulcha' }, prep_state: 'fried', portion: { grams: [50, 130] }, strategy: 'direct' },
  db(['CNF_CANADA', 'USDA_FDC', 'INDB'], /bread.*paratha|paratha,?\s*whole wheat|^paratha/i, 'cooked', 80, 0.25));
add('x-amb-008', 'kadhi', 'composite_dish', ['indian', 'cooked_wet', 'generic', 'no_quantity', 'transliteration'], 'medium',
  { entity: { name_matches: 'kadhi|kadi|karhi', reject_name_matches: 'pakora only|besan.*plain' }, prep_state: 'cooked_wet', portion: { grams: [100, 300] }, strategy: 'direct', plausible: true },
  published(n(60, 300, 2, 12, 5, 24, 2, 18), 150, 'kadhi ≈ 70–130 kcal/100g'));
add('x-amb-009', 'roti', 'prepared_food', ['indian', 'cooked_dry', 'generic', 'no_quantity', 'alias'], 'easy',
  { entity: { name_matches: 'chapati|roti|phulka', reject_name_matches: 'paratha|naan|puri|kathi roll|frankie' }, prep_state: 'cooked_dry', portion: { grams: [25, 60] }, strategy: 'direct' },
  db(['INDB'], /chapati\/roti|^roti$|^chapati$/i, 'cooked', 40, 0.20));
add('x-amb-010', 'rasam', 'composite_dish', ['south_asian', 'cooked_wet', 'generic', 'no_quantity'], 'medium',
  { entity: { name_matches: 'rasam|saaru|chaaru', reject_name_matches: 'powder|paste|sambar' }, prep_state: 'cooked_wet', portion: { grams: [100, 300] }, strategy: 'direct', plausible: true },
  published(n(15, 120, 0.5, 5, 2, 16, 0.3, 8), 150, 'rasam ≈ 10–60 kcal/100g (very thin)'));

/* ---- more branded / generic ---- */
add('x-bnd-001', 'Amul cheese slice', 'single_ingredient', ['indian', 'raw', 'branded', 'count_portion'], 'easy',
  { entity: { name_matches: 'cheese', reject_name_matches: 'cottage|paneer|spread.*homemade|ricotta' }, food_class: 'branded_product', prep_state: 'any', portion: { grams: [15, 25] }, strategy: 'direct' },
  std(n(40, 90, 2, 6, 0, 3, 3, 7), 20, '1 processed cheese slice ≈ 20 g, ~60 kcal'));
add('x-bnd-002', 'plain white rice', 'single_ingredient', ['global', 'boiled', 'generic', 'no_quantity'], 'easy',
  { entity: { name_matches: 'rice, white|white rice', reject_name_matches: 'brand|uncle ben|minute rice|krispies|fried' }, food_class: 'ingredient', prep_state: 'boiled', portion: { grams: [100, 250] }, strategy: 'direct' },
  std(n(120, 340, 2, 8, 26, 75, 0.2, 3), 158, 'plain cooked white rice'));
add('x-bnd-003', 'Kellogg\'s corn flakes', 'snack', ['american', 'baked', 'branded', 'no_quantity'], 'easy',
  { entity: { name_matches: 'corn flakes|cornflakes', reject_name_matches: 'homemade|corn, raw|popcorn' }, food_class: 'branded_product', prep_state: 'any', portion: { grams: [25, 60] }, strategy: 'direct' },
  std(n(90, 240, 1, 6, 20, 52, 0.1, 2), 30, '1 serving corn flakes ≈ 30 g, 110 kcal'));
add('x-bnd-004', 'generic plain yogurt', 'single_ingredient', ['global', 'raw', 'generic', 'no_quantity'], 'easy',
  { entity: { name_matches: 'yogh?urt|curd|dahi', reject_name_matches: 'brand|activia|danone|greek.*honey brand|fruit.*brand|frozen' }, food_class: 'ingredient', prep_state: 'any', portion: { grams: [100, 250] }, strategy: 'direct' },
  std(n(50, 200, 3, 14, 4, 16, 1, 10), 150, 'plain yogurt, generic'));
add('x-bnd-005', 'McDonald\'s Big Mac', 'composite_dish', ['american', 'grilled', 'branded', 'no_quantity', 'topped', 'combo'], 'hard',
  { entity: { name_matches: 'big mac|mcdonald', reject_name_matches: 'homemade|patty only|sauce only' }, food_class: 'branded_product', prep_state: 'grilled', portion: { grams: [200, 260] }, strategy: 'direct' },
  std(n(480, 620, 22, 30, 40, 52, 26, 38), 219, 'Big Mac ≈ 219 g, 550 kcal (published)'));

/* ---- extra prepared / single to balance counts ---- */
add('x-prp-011', '200g grilled paneer', 'prepared_food', ['indian', 'grilled', 'generic', 'explicit_grams'], 'medium',
  { entity: { name_matches: 'paneer', reject_name_matches: 'butter masala|bhurji|tikka masala.*gravy|tofu' }, prep_state: 'grilled', portion: { grams: [195, 205] }, strategy: 'prep_variant' },
  db(['IFCT2017', 'INDB'], /^paneer/i, null, 200, 0.22));
add('x-prp-012', '1 boiled sweet corn cob', 'prepared_food', ['global', 'boiled', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'corn|maize|bhutta|sweet corn', reject_name_matches: 'flour|starch|chips|flakes|syrup|popcorn|oil' }, prep_state: 'boiled', portion: { grams: [90, 200] }, strategy: 'direct' },
  std(n(70, 200, 2, 6, 15, 42, 0.5, 4), 130, '1 medium corn cob kernels ≈ 90–125 g'));
add('x-prp-013', '150g boiled chickpeas', 'single_ingredient', ['middle_eastern', 'boiled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'chickpea|garbanzo|bengal gram', reject_name_matches: 'flour|besan|raw|snack|fried|curry' }, prep_state: 'boiled', portion: { grams: [147, 153] }, strategy: 'direct' },
  db(['USDA_FDC'], /chickpeas.*cooked|garbanzo.*cooked/i, null, 150, 0.24));
add('x-prp-014', '100g grilled zucchini', 'prepared_food', ['mediterranean', 'grilled', 'generic', 'explicit_grams'], 'easy',
  { entity: { name_matches: 'zucchini|courgette', reject_name_matches: 'raw|bread|fried.*crumb|noodle' }, prep_state: 'grilled', portion: { grams: [98, 102] }, strategy: 'prep_variant' },
  db(['USDA_FDC'], /zucchini.*(cooked|grilled)|courgette.*cooked/i, 'cooked', 100, 0.30));
add('x-prp-015', '1 boiled potato medium', 'prepared_food', ['global', 'boiled', 'generic', 'count_portion'], 'easy',
  { entity: { name_matches: 'potato', reject_name_matches: 'chip|fries|raw|mashed.*butter|wedge' }, prep_state: 'boiled', portion: { grams: [120, 220] }, strategy: 'direct' },
  db(['USDA_FDC', 'IFCT2017'], /potato.*boiled|boiled.*potato/i, 'cooked', 170, 0.24));

export default C;
