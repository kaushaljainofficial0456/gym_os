// ============================================================
// SKOS FOOD BENCHMARK — CASE SPECS v2 (nutrition overhaul expansion)
//
// Merged with the v1 specs by build.mjs --version v2 into
// food_eval_set.v2.json. Same spec format, plus one ground-truth method:
//
//   dbsum   a multi-food meal whose every component is weighed in the input
//           ("100g rice, 150g dal makhani and 50g curd"). Each component's
//           reference row is selected by the SPEC's own criteria (source
//           preference + name regex + cooking state), never the engine's
//           ranker, and the band is the SUM of rows × grams ± tolerance.
//
// GROUND-TRUTH POLICY FOR THIS FILE
//   - Explicit-gram cases: db / dbsum against IFCT 2017, INDB, USDA FDC,
//     CNF, Open Food Facts rows chosen independently of the estimator.
//   - Dishes the engine prices from its OWN standard recipes
//     (backend/src/services/food/recipes.js: misal, thalipeeth, pithla,
//     bhakri, pongal, paneer bhurji, bhatura, kachori, ...) are scored on
//     identity, decomposition and silent drops ONLY (method none). Grading
//     their calories against the same recipes would be circular, and no
//     independent measured row exists for them. Stated plainly in
//     NUTRITION_BENCHMARK_REPORT.md.
//   - Natural-language meals with household units are scored on identity
//     per item and silent drops (method none) unless a published range is
//     already established in v1.
// ============================================================
'use strict';

const db = (prefer, name, cs, grams, tol = 0.2) => ({ m: 'db', prefer, name, cs: cs ?? null, grams, tol });
const dbsum = (parts, tol = 0.2) => ({ m: 'dbsum', parts: parts.map(([prefer, name, cs, grams]) => ({ prefer, name, cs: cs ?? null, grams })), tol });
const none = () => ({ m: 'none' });

const C = [];
const add = (id, input, primary, tags, difficulty, expect, gt) =>
  C.push({ id, input, primary, tags, difficulty, expect, gt: gt || none() });
const items = (...res) => res.map((r) => ({ entity: { name_matches: r } }));

const INDB = ['INDB'];
const IFCT = ['IFCT2017'];
const USDA = ['USDA_FDC'];
const IN_ANY = ['IFCT2017', 'INDB', 'USDA_FDC', 'CNF_CANADA'];

/* =====================================================================
 * I1. Indian dishes at an explicit weight -- reference: the INDB row
 * ===================================================================== */
const I1 = [
  ['in1-001', '200g rajma curry', 'rajma|kidney bean', /^Kidney bean curry/i],
  ['in1-002', '150g chickpea curry', 'chole|chickpea|channa|chana', /^Chickpeas curry/i],
  ['in1-003', '200g matar paneer', 'matar paneer|pea.*paneer', /Matar paneer/i],
  ['in1-004', '150g shahi paneer', 'shahi paneer', /^Shahi paneer/i],
  ['in1-005', '150g paneer butter masala', 'paneer.*butter|butter.*paneer|paneer butter masala', /^Paneer in butter sauce/i],
  ['in1-006', '200g aloo gobi', 'aloo gob|potato cauliflower', /Aloo gobhi/i],
  ['in1-007', '150g bhindi sabzi', 'bhindi|okra|lady', /Bhindi sabzi/i],
  ['in1-008', '250g sambar', 'sambar', /^Sambar$/i],
  ['in1-009', '200g vegetable poha', 'poha', /^Vegetable poha/i],
  ['in1-010', '120g idli', 'idli', /^Idli$/i],
  ['in1-011', '150g masala dosa', 'masala dosa', /^Masala dosa$/i],
  ['in1-012', '150g uttapam', 'uttapam|uthappam', /^Uttapam/i],
  ['in1-013', '250g vegetable khichdi', 'khichdi|khichri', /^Vegetable khichdi/i],
  ['in1-014', '300g vegetable biryani', 'biryani', /^Vegetable biryani/i],
  ['in1-015', '300g mutton biryani', 'mutton biryani|biryani', /^Mutton biryani/i],
  ['in1-016', '200g plain pulao', 'pulao|pulav', /^Plain pulao/i],
  ['in1-017', '200g curd rice', 'curd rice|dahi', /^Curd rice/i],
  ['in1-018', '200g lemon rice', 'lemon rice|chitranna|pulihora', /^Lemon rice/i],
  ['in1-019', '100g dhokla', 'dhokla', /^Dhokla$/i],
  ['in1-020', '80g methi thepla', 'thepla', /^Methi thepla/i],
  ['in1-021', '200g sarson ka saag', 'sarson|saag', /^Sarson ka saag/i],
  ['in1-022', '100g makki ki roti', 'makki', /^Makki ki roti/i],
  ['in1-023', '250g chicken curry', 'chicken curry', /^Chicken curry$/i],
  ['in1-024', '200g fish curry', 'fish curry|machli', /^Fish curry/i],
  ['in1-025', '200g egg curry', 'egg curry|anda', /^Egg curry/i],
  ['in1-026', '150g tandoori chicken', 'tandoori chicken', /^Tandoori chicken/i],
  ['in1-027', '150g aloo paratha', 'aloo paratha|potato paratha|aloo ka', /^Potato parantha/i],
  ['in1-028', '150g paneer paratha', 'paneer paratha|paneer parantha', /^Paneer parantha/i],
  ['in1-029', '150g gobi paratha', 'gobi paratha|cauliflower parantha|cauliflower paratha', /^Cauliflower parantha/i],
  ['in1-030', '100g methi paratha', 'methi', /^Methi parantha/i],
  ['in1-031', '150g appam', 'appam', /^Appam$/i],
  ['in1-032', '200g avial', 'avial', /^Avial/i],
  ['in1-033', '100g pesarattu', 'pesarattu|moong.*dosa', /Pesarattu/i],
  ['in1-034', '200g pav bhaji', 'pav bhaji', /^Pav bhaji$/i],
  ['in1-035', '150g handvo', 'handvo', /handvo/i],
  ['in1-036', '100g moong dal halwa', 'moong dal halwa|halwa', /^Moong dal halwa/i],
  ['in1-037', '150g vangi bhath', 'vangi|brinjal rice|eggplant rice', /Vangi bhat/i],
  ['in1-038', '150g bharwa baingan', 'baingan|brinjal', /Bharwa baingan/i],
  ['in1-039', '150g beans thoran', 'thoran|beans', /Beans thoran/i],
  ['in1-040', '200g palak paneer', 'palak paneer|spinach paneer', /Palak paneer/i],
];
for (const [id, input, re, rowRe] of I1) {
  add(id, input, 'composite_dish', ['indian', 'cooked_wet', 'generic', 'explicit_grams', 'v2_indian'], 'easy',
    { entity: { name_matches: re }, strategy: 'direct' },
    db(INDB, rowRe, null, Number(input.match(/^(\d+)/)[1]), 0.22));
}

/* =====================================================================
 * I2. Indian raw / single ingredients at an explicit weight (IFCT first)
 * ===================================================================== */
const I2 = [
  ['in2-001', '150g paneer', 'paneer', /^Paneer$/i, IFCT, 'raw'],
  ['in2-002', '50g peanuts', 'peanut|groundnut|ground nut', /^Ground nut/i, IFCT, 'raw'],
  ['in2-003', '30g cashews', 'cashew|kaju', /^Cashew nut/i, IFCT, 'raw'],
  ['in2-004', '40g jaggery', 'jaggery|gur', /^Jaggery, cane/i, IFCT, 'raw'],
  ['in2-005', '200ml cow milk', 'milk', /^Milk, whole, Cow/i, IFCT, null],
  ['in2-006', '200ml buffalo milk', 'buffalo', /^Milk, whole, Buffalo/i, IFCT, null],
  ['in2-007', '100g raw potato', 'potato|aloo', /^Potato, brown skin, big/i, IFCT, 'raw'],
  ['in2-008', '100g raw onion', 'onion', /^Onion, big/i, IFCT, 'raw'],
  ['in2-009', '20g fresh coconut', 'coconut', /^Coconut, kernel, fresh/i, IFCT, 'raw'],
  ['in2-010', '100g green peas', 'peas|matar', /^Peas, fresh/i, IFCT, 'raw'],
  ['in2-011', '50g atta', 'atta|wheat flour', /^Wheat flour, atta/i, IFCT, 'raw'],
  ['in2-012', '50g moong dal', 'moong|green gram', /^Green gram, dal/i, IFCT, 'raw'],
  ['in2-013', '50g chana dal', 'chana|bengal gram', /^Bengal gram, dal/i, IFCT, 'raw'],
  ['in2-014', '50g urad dal', 'urad|black gram', /^Black gram, dal/i, IFCT, 'raw'],
  ['in2-015', '50g moth beans', 'moth|matki', /^Moth bean/i, IFCT, 'raw'],
  ['in2-016', '100g tomato', 'tomato', /^Tomato, ripe, hybrid/i, IFCT, 'raw'],
  ['in2-017', '10g green chillies', 'chill', /^Chillies, green - all/i, IFCT, 'raw'],
  ['in2-018', '15g ghee', 'ghee|clarified', /^Butter, Clarified butter \(ghee\)/i, USDA, null],
  ['in2-019', '10g sugar', 'sugar', /^Sugars, granulated/i, USDA, null],
  ['in2-020', '100g cooked rice', 'rice', /^Rice, white, long-grain, regular, enriched, cooked/i, USDA, 'cooked'],
];
for (const [id, input, re, rowRe, prefer, cs] of I2) {
  add(id, input, 'single_ingredient', ['indian', 'raw', 'generic', 'explicit_grams', 'v2_indian'], 'easy',
    { entity: { name_matches: re }, strategy: 'direct' },
    db(prefer, rowRe, cs, Number(input.match(/^(\d+)/)[1]), 0.2));
}

/* =====================================================================
 * I3. Indian multi-food meals with every component weighed (dbsum)
 * ===================================================================== */
const MEAL = (id, input, matchers, parts, difficulty = 'medium') =>
  add(id, input, 'meal', ['indian', 'cooked_wet', 'generic', 'explicit_grams', 'multi_food', 'v2_indian'], difficulty,
    { strategy: 'direct', items: items(...matchers) }, dbsum(parts, 0.22));
const ROW = {
  rice: [USDA, /^Rice, white, long-grain, regular, enriched, cooked/i, 'cooked'],
  dalmakhani: [INDB, /^Dal makhani$/i, null],
  rajma: [INDB, /^Kidney bean curry/i, null],
  chole: [INDB, /^Chickpeas curry/i, null],
  curd: [USDA, /^Yogurt, plain, whole milk$/i, null],
  paneer: [IFCT, /^Paneer$/i, 'raw'],
  sambar: [INDB, /^Sambar$/i, null],
  idli: [INDB, /^Idli$/i, null],
  chicken: [INDB, /^Chicken curry$/i, null],
  palak: [INDB, /Palak paneer/i, null],
  aloogobi: [INDB, /Aloo gobhi/i, null],
  curdrice: [INDB, /^Curd rice/i, null],
  poha: [INDB, /^Vegetable poha/i, null],
  milk: [IFCT, /^Milk, whole, Cow/i, null],
  banana: [USDA, /^Bananas, raw$/i, 'raw'],
  egg: [USDA, /^Egg, whole, boiled/i, null],
  peanut: [IFCT, /^Ground nut/i, 'raw'],
  fishcurry: [INDB, /^Fish curry/i, null],
  eggcurry: [INDB, /^Egg curry/i, null],
  masaladosa: [INDB, /^Masala dosa$/i, null],
};
const P = (k, g) => [...ROW[k].slice(0, 2), ROW[k][2], g];
MEAL('in3-001', '150g rice, 150g dal makhani and 50g curd', ['rice', 'dal makhani|makhani', 'curd|yogh?urt|dahi'], [P('rice', 150), P('dalmakhani', 150), P('curd', 50)]);
MEAL('in3-002', '200g rajma curry with 150g rice', ['rajma|kidney', 'rice'], [P('rajma', 200), P('rice', 150)]);
MEAL('in3-003', '150g chickpea curry and 100g rice', ['chole|chickpea|channa|chana', 'rice'], [P('chole', 150), P('rice', 100)]);
MEAL('in3-004', '100g paneer and 150g rice', ['paneer', 'rice'], [P('paneer', 100), P('rice', 150)]);
MEAL('in3-005', '120g idli with 200g sambar', ['idli', 'sambar'], [P('idli', 120), P('sambar', 200)]);
MEAL('in3-006', '250g chicken curry, 200g rice', ['chicken curry', 'rice'], [P('chicken', 250), P('rice', 200)]);
MEAL('in3-007', '200g palak paneer and 100g rice', ['palak|spinach', 'rice'], [P('palak', 200), P('rice', 100)]);
MEAL('in3-008', '200g aloo gobi with 150g rice and 100g curd', ['aloo gob|potato cauliflower', 'rice', 'curd|yogh?urt|dahi'], [P('aloogobi', 200), P('rice', 150), P('curd', 100)]);
MEAL('in3-009', '200g vegetable poha and 200ml milk', ['poha', 'milk'], [P('poha', 200), P('milk', 200)]);
MEAL('in3-010', '2 boiled eggs (100g) and 1 banana (120g)', ['egg', 'banana'], [P('egg', 100), P('banana', 120)], 'hard');
MEAL('in3-011', '200g fish curry and 200g rice', ['fish curry|machli', 'rice'], [P('fishcurry', 200), P('rice', 200)]);
MEAL('in3-012', '200g egg curry, 150g rice', ['egg curry|anda', 'rice'], [P('eggcurry', 200), P('rice', 150)]);
MEAL('in3-013', '150g masala dosa and 150g sambar', ['masala dosa', 'sambar'], [P('masaladosa', 150), P('sambar', 150)]);
MEAL('in3-014', '200g curd rice and 30g peanuts', ['curd rice', 'peanut|groundnut|ground nut'], [P('curdrice', 200), P('peanut', 30)]);
MEAL('in3-015', '100g paneer, 200ml milk and 1 banana (120g)', ['paneer', 'milk', 'banana'], [P('paneer', 100), P('milk', 200), P('banana', 120)], 'hard');

/* =====================================================================
 * I4. Natural-language Indian meals: identity per item + no silent drops
 * ===================================================================== */
const NL = (id, input, matchers, difficulty = 'medium', extraTags = []) =>
  add(id, input, 'meal', ['indian', 'cooked_wet', 'generic', 'nl_quantity', 'multi_food', 'v2_indian', ...extraTags], difficulty,
    { strategy: 'direct', items: items(...matchers) }, none());
NL('in4-001', '2 homemade aloo parathas with curd and chai', ['aloo paratha|potato paratha|aloo ka', 'curd|dahi|yogh?urt', 'chai|tea']);
NL('in4-002', 'I ate 2 rotis, one bowl of dal, 100 grams of rice and some aloo sabzi', ['roti|chapati', '\\bdal|lentil', 'rice', 'aloo|potato']);
NL('in4-003', 'masala dosa with sambar and coconut chutney', ['masala dosa', 'sambar', 'chutney|coconut'], 'hard');
NL('in4-004', 'idli vada sambar', ['idli', 'vada', 'sambar'], 'hard');
NL('in4-005', '2 idli and a vada with chutney', ['idli', 'vada', 'chutney']);
NL('in4-006', 'poha and chai', ['poha', 'chai|tea']);
NL('in4-007', 'rice with rajma and a side salad', ['rice', 'rajma|kidney', 'salad']);
NL('in4-008', 'dal chawal papad', ['\\bdal|lentil', 'rice|chawal', 'papad']);
NL('in4-009', 'bread butter jam', ['bread', 'butter', 'jam']);
NL('in4-010', 'chole bhature', ['chole|chickpea|chana', 'bhatur'], 'hard', ['combo']);
NL('in4-011', 'misal pav', ['misal', '\\bpav|pao|roll'], 'hard', ['combo']);
NL('in4-012', 'pithla bhakri', ['pithla', 'bhakri'], 'hard', ['combo']);
NL('in4-013', 'puri bhaji', ['puri|poori', 'bhaji|sabzi|potato|aloo'], 'hard', ['combo']);
NL('in4-014', 'thalipeeth with curd', ['thalipeeth', 'curd|dahi|yogh?urt']);
NL('in4-015', 'sabudana khichdi and buttermilk', ['sabudana|sago', 'buttermilk|chaas']);
NL('in4-016', 'usal pav', ['usal|matki', '\\bpav|pao|roll'], 'hard', ['combo']);
NL('in4-017', 'paneer bhurji with 2 rotis', ['paneer bhurji|bhurji|scrambled paneer', 'roti|chapati']);
NL('in4-018', 'egg bhurji and 2 slices of bread', ['egg|bhurji|scrambled', 'bread']);
NL('in4-019', 'upma with coconut chutney and filter coffee', ['upma', 'chutney|coconut', 'coffee'], 'hard');
NL('in4-020', 'curd rice with pickle', ['curd rice', 'pickle|achar']);
NL('in4-021', 'dal makhani with 2 naan', ['makhani', 'naan']);
NL('in4-022', 'chicken biryani with raita', ['biryani', 'raita']);
NL('in4-023', 'kadhi chawal', ['kadhi', 'rice|chawal']);
NL('in4-024', 'sambar rice and papad', ['sambar', 'rice', 'papad']);
NL('in4-025', 'thepla with chai', ['thepla', 'chai|tea']);
NL('in4-026', 'dhokla and green chutney', ['dhokla', 'chutney']);
NL('in4-027', '2 samosas and a cup of tea', ['samosa', 'tea|chai']);
NL('in4-028', 'vada pav and cutting chai', ['vada pav', 'chai|tea']);
NL('in4-029', 'jowar bhakri with pithla and onion', ['bhakri|jowar', 'pithla', 'onion'], 'hard');
NL('in4-030', 'roti sabzi dal', ['roti|chapati', 'sabzi|vegetable|bhaji', '\\bdal|lentil']);
NL('in4-031', 'fish curry rice', ['fish', 'rice'], 'medium', ['combo']);
NL('in4-032', 'egg curry with rice', ['egg curry|anda', 'rice']);
NL('in4-033', 'palak paneer with 2 rotis and salad', ['palak|spinach', 'roti|chapati', 'salad']);
NL('in4-034', 'oats with milk and a banana', ['oat', 'milk', 'banana']);
NL('in4-035', 'protein shake and a banana', ['whey|protein', 'banana']);
NL('in4-036', 'two eggs, toast and orange juice', ['egg', 'toast|bread', 'orange']);
NL('in4-037', 'pongal with sambar and vada', ['pongal', 'sambar', 'vada'], 'hard');
NL('in4-038', 'appam with vegetable stew', ['appam', 'stew']);
NL('in4-039', 'pav bhaji with extra butter', ['pav bhaji', 'butter']);
NL('in4-040', 'rava dosa and coconut chutney', ['rava dosa|semolina dosa', 'chutney|coconut']);

/* =====================================================================
 * I5. Regional dishes the engine prices from its own standard recipes
 *     -- identity + single-item behaviour ONLY (see header).
 * ===================================================================== */
const REG = [
  ['in5-001', 'misal', 'misal'], ['in5-002', '1 plate misal', 'misal'], ['in5-003', 'thalipeeth', 'thalipeeth'],
  ['in5-004', '2 thalipeeth', 'thalipeeth'], ['in5-005', 'pithla', 'pithla'], ['in5-006', 'jowar bhakri', 'jowar bhakri|bhakri'],
  ['in5-007', '2 bajra bhakri', 'bajra'], ['in5-008', 'ven pongal', 'pongal'], ['in5-009', 'paneer bhurji', 'paneer bhurji'],
  ['in5-010', 'paneer tikka', 'paneer tikka'], ['in5-011', '2 aloo tikki', 'aloo tikki|tikki'], ['in5-012', '3 sabudana vada', 'sabudana vada'],
  ['in5-013', '2 kachori', 'kachori'], ['in5-014', '2 bhatura', 'bhatur'], ['in5-015', '5 modak', 'modak'],
  ['in5-016', 'rava sheera', 'sheera|halwa'], ['in5-017', 'zunka', 'zunka'], ['in5-018', 'usal', 'usal'],
  ['in5-019', '2 puran poli', 'puran'], ['in5-020', '2 pav', '\\bpav|roll'],
];
for (const [id, input, re] of REG) {
  add(id, input, 'composite_dish', ['indian', 'cooked_wet', 'generic', 'v2_indian', 'v2_recipe_dish'], 'medium',
    { entity: { name_matches: re, reject_name_matches: 'sausage|pancake|polish|mix\\b' }, strategy: 'direct' }, none());
}

/* =====================================================================
 * G1. International foods at an explicit weight (USDA / CNF)
 * ===================================================================== */
const G1 = [
  ['gl1-001', '150g grilled chicken breast', 'chicken breast|chicken', /^Chicken, broilers or fryers, breast, meat only, cooked, roasted/i, 'cooked', 'prepared_food'],
  ['gl1-002', '200g cooked pasta', 'pasta|spaghetti|macaroni', /^Pasta, cooked, enriched, without added salt/i, 'cooked', 'single_ingredient'],
  ['gl1-003', '100g cheddar cheese', 'cheddar', /^Cheese, cheddar \(Includes/i, null, 'single_ingredient'],
  ['gl1-004', '150g salmon', 'salmon', /^Fish, salmon, Atlantic, farmed, raw/i, 'raw', 'single_ingredient'],
  ['gl1-005', '200g Greek yogurt', 'greek', /^Yogurt, Greek, plain, whole milk/i, null, 'single_ingredient'],
  ['gl1-006', '100g avocado', 'avocado', /^Avocados, raw, all commercial/i, 'raw', 'single_ingredient'],
  ['gl1-007', '50g almonds', 'almond', /^Nuts, almonds$/i, null, 'single_ingredient'],
  ['gl1-008', '40g rolled oats', 'oat', /^Oats \(Includes foods for USDA/i, null, 'single_ingredient'],
  ['gl1-009', '150g boiled potatoes', 'potato', /^Potatoes, boiled, cooked in skin, flesh, with salt/i, 'cooked', 'single_ingredient'],
  ['gl1-010', '100g firm tofu', 'tofu', /^Tofu, raw, firm, prepared with calcium sulfate/i, null, 'single_ingredient'],
  ['gl1-011', '120g cooked quinoa', 'quinoa', /^Quinoa, cooked/i, 'cooked', 'single_ingredient'],
  ['gl1-012', '200g broccoli', 'broccoli', /^Broccoli, raw$/i, 'raw', 'single_ingredient'],
  ['gl1-013', '100g canned tuna', 'tuna', /^Fish, tuna, light, canned in water, drained solids/i, null, 'single_ingredient'],
  ['gl1-014', '150g cooked brown rice', 'brown rice', /^Rice, brown, long-grain, cooked/i, 'cooked', 'single_ingredient'],
  ['gl1-015', '30g peanut butter', 'peanut butter', /^Peanut butter, smooth style, without salt/i, null, 'sauce_condiment'],
  ['gl1-016', '250ml orange juice', 'orange juice', /^Orange juice, raw/i, null, 'beverage'],
  ['gl1-017', '100g blueberries', 'blueberr', /^Blueberries, raw/i, 'raw', 'single_ingredient'],
  ['gl1-018', '150g strawberries', 'strawberr', /^Strawberries, raw/i, 'raw', 'single_ingredient'],
  ['gl1-019', '100g sweet potato', 'sweet potato', /^Sweet potato, raw, unprepared/i, 'raw', 'single_ingredient'],
  ['gl1-020', '200g cottage cheese', 'cottage cheese|paneer', /^Cheese, cottage, creamed, large or small curd/i, null, 'single_ingredient'],
  ['gl1-021', '100g hummus', 'hummus', /^Hummus, commercial/i, null, 'sauce_condiment'],
  ['gl1-022', '60g bagel', 'bagel', /^Bagels, plain, enriched/i, null, 'prepared_food'],
  ['gl1-023', '100g ground beef', 'beef', /^Beef, ground, 80% lean meat \/ 20% fat, raw/i, 'raw', 'single_ingredient'],
  ['gl1-024', '120g pork chop', 'pork', /^Pork, fresh, loin, center loin \(chops\), bone-in, separable lean only, cooked/i, 'cooked', 'prepared_food'],
  ['gl1-025', '200ml skim milk', 'milk', /^Milk, nonfat, fluid/i, null, 'beverage'],
];
for (const [id, input, re, rowRe, cs, primary] of G1) {
  add(id, input, primary, ['global', 'generic', 'explicit_grams', 'v2_international'], 'easy',
    { entity: { name_matches: re }, strategy: 'direct' },
    db(['USDA_FDC', 'CNF_CANADA'], rowRe, cs, Number(input.match(/^(\d+)/)[1]), 0.22));
}

/* =====================================================================
 * G2. International multi-food meals, every component weighed
 * ===================================================================== */
const GROW = {
  chicken: [USDA, /^Chicken, broilers or fryers, breast, meat only, cooked, roasted/i, 'cooked'],
  brownrice: [USDA, /^Rice, brown, long-grain, cooked/i, 'cooked'],
  broccoli: [USDA, /^Broccoli, raw$/i, 'raw'],
  pasta: [USDA, /^Pasta, cooked, enriched, without added salt/i, 'cooked'],
  salmon: [USDA, /^Fish, salmon, Atlantic, farmed, raw/i, 'raw'],
  potato: [USDA, /^Potatoes, boiled, cooked in skin, flesh, with salt/i, 'cooked'],
  yogurt: [USDA, /^Yogurt, Greek, plain, whole milk/i, null],
  oats: [USDA, /^Oats \(Includes foods for USDA/i, null],
  blueberries: [USDA, /^Blueberries, raw/i, 'raw'],
  almonds: [USDA, /^Nuts, almonds$/i, null],
  egg: [USDA, /^Egg, whole, boiled/i, null],
  avocado: [USDA, /^Avocados, raw, all commercial/i, 'raw'],
  tofu: [USDA, /^Tofu, raw, firm, prepared with calcium sulfate/i, null],
  quinoa: [USDA, /^Quinoa, cooked/i, 'cooked'],
};
const GP = (k, g) => [...GROW[k].slice(0, 2), GROW[k][2], g];
const GMEAL = (id, input, matchers, parts, difficulty = 'medium') =>
  add(id, input, 'meal', ['global', 'generic', 'explicit_grams', 'multi_food', 'v2_international'], difficulty,
    { strategy: 'direct', items: items(...matchers) }, dbsum(parts, 0.22));
GMEAL('gl2-001', '150g grilled chicken breast, 150g brown rice and 100g broccoli', ['chicken', 'brown rice|rice', 'broccoli'], [GP('chicken', 150), GP('brownrice', 150), GP('broccoli', 100)]);
GMEAL('gl2-002', '150g salmon with 200g boiled potatoes', ['salmon', 'potato'], [GP('salmon', 150), GP('potato', 200)]);
GMEAL('gl2-003', '200g Greek yogurt with 100g blueberries and 20g almonds', ['greek|yogh?urt', 'blueberr', 'almond'], [GP('yogurt', 200), GP('blueberries', 100), GP('almonds', 20)]);
GMEAL('gl2-004', '40g oats, 100g blueberries', ['oat', 'blueberr'], [GP('oats', 40), GP('blueberries', 100)]);
GMEAL('gl2-005', '100g boiled egg and 100g avocado', ['egg', 'avocado'], [GP('egg', 100), GP('avocado', 100)]);
GMEAL('gl2-006', '150g firm tofu with 120g cooked quinoa', ['tofu', 'quinoa'], [GP('tofu', 150), GP('quinoa', 120)]);
GMEAL('gl2-007', '200g cooked pasta and 100g grilled chicken breast', ['pasta|spaghetti|macaroni', 'chicken'], [GP('pasta', 200), GP('chicken', 100)]);
GMEAL('gl2-008', '150g brown rice, 100g broccoli and 150g tofu', ['brown rice|rice', 'broccoli', 'tofu'], [GP('brownrice', 150), GP('broccoli', 100), GP('tofu', 150)]);

/* =====================================================================
 * G3. International dishes and drinks by name -- identity only
 * ===================================================================== */
const G3 = [
  ['gl3-001', 'chicken caesar salad', 'caesar|salad', 'composite_dish'], ['gl3-002', 'margherita pizza slice', 'pizza', 'composite_dish'],
  ['gl3-003', 'cheeseburger', 'burger|cheeseburger', 'composite_dish'], ['gl3-004', 'pad thai', 'pad thai|noodle', 'composite_dish'],
  ['gl3-005', 'sushi roll', 'sushi|roll|maki', 'composite_dish'], ['gl3-006', 'chicken burrito', 'burrito', 'composite_dish'],
  ['gl3-007', 'latte', 'latte|coffee', 'beverage'], ['gl3-008', 'cappuccino', 'cappuccino|coffee', 'beverage'],
  ['gl3-009', 'green tea', 'green tea|tea', 'beverage'], ['gl3-010', 'banana smoothie', 'smoothie|banana', 'beverage'],
  ['gl3-011', 'croissant', 'croissant', 'prepared_food'], ['gl3-012', 'pancakes with maple syrup', 'pancake', 'composite_dish'],
  ['gl3-013', 'scrambled eggs', 'scrambled|egg', 'prepared_food'], ['gl3-014', 'french fries', 'fries|french fried|potato', 'prepared_food'],
  ['gl3-015', 'apple pie', 'apple pie|pie', 'dessert'],
];
for (const [id, input, re, primary] of G3) {
  add(id, input, primary, ['global', 'generic', 'no_quantity', 'v2_international'], 'medium',
    { entity: { name_matches: re }, strategy: 'direct' }, none());
}

/* =====================================================================
 * P1. Packaged / branded foods (Open Food Facts label rows)
 * ===================================================================== */
const P1 = [
  ['pk-001', '70g maggi masala noodles', 'maggi|noodle', /^Maggi 2 Minutes Noodles Masala/i],
  ['pk-002', '30g parle g biscuits', 'parle|biscuit|glucose', /^parle.?g/i],
  ['pk-003', '25g lays classic salted chips', 'lay|chip|crisp', /lay.?s.*(classic|salted)/i],
  ['pk-004', '40g kurkure', 'kurkure', /kurkure/i],
  ['pk-005', '30g haldiram aloo bhujia', 'bhujia', /aloo bhujia/i],
  ['pk-006', '20g amul butter', 'butter', /amul.*butter|^butter$/i],
  ['pk-007', '30g britannia marie gold', 'marie|biscuit', /^Britannia Marie Gold/i],
  ['pk-008', '30g kelloggs corn flakes', 'corn ?flakes|kellogg', /corn ?flakes/i],
  ['pk-009', '40g dairy milk chocolate', 'dairy milk|chocolate', /dairy milk/i],
  ['pk-010', '330ml coca cola', 'coca|cola|coke', /coca.?cola/i],
  ['pk-011', '30g oreo biscuits', 'oreo', /oreo/i],
  ['pk-012', '200ml amul kool', 'kool|milk|flavou?red', /amul kool/i],
];
for (const [id, input, re, rowRe] of P1) {
  add(id, input, 'snack', ['indian', 'ready_to_eat', 'branded', 'explicit_grams', 'v2_packaged'], 'medium',
    { entity: { name_matches: re }, strategy: 'direct' },
    db(['OPEN_FOOD_FACTS', 'USDA_FDC'], rowRe, null, Number(input.match(/^(\d+)/)[1]), 0.25));
}

/* =====================================================================
 * A1. Ambiguity, honesty and silent-drop traps
 * ===================================================================== */
const TRAP = (id, input, expect, primary = 'meal', tags = []) =>
  add(id, input, primary, ['global', 'generic', 'v2_trap', ...tags], 'hard', expect, none());
TRAP('tr-001', '2 rotis and some xyzzqq plover', { strategy: 'direct', items: items('roti|chapati', 'xyzzqq|plover') }, 'meal', ['multi_food']);
TRAP('tr-002', 'masala dosa with sambar and chutney', { strategy: 'direct', items: items('masala dosa', 'sambar', 'chutney') }, 'meal', ['multi_food']);
TRAP('tr-003', 'paneer jalfrezi with rice', { strategy: 'direct', items: items('paneer|jalfrezi', 'rice') }, 'meal', ['multi_food']);
TRAP('tr-004', 'car keys', { strategy: 'unresolved', is_nonfood: true }, 'nonfood_or_malformed');
TRAP('tr-005', 'asdfghjkl', { strategy: 'unresolved', is_nonfood: true }, 'nonfood_or_malformed');
TRAP('tr-006', 'puran poli', { entity: { name_matches: 'puran|poli|chickpea roti', reject_name_matches: 'sausage|polish' }, strategy: 'direct' }, 'dessert', ['indian']);
TRAP('tr-007', 'homemade aloo paratha', { entity: { name_matches: 'aloo paratha|potato parantha|potato paratha', reject_name_matches: 'pancake' }, strategy: 'direct' }, 'prepared_food', ['indian']);
TRAP('tr-008', 'restaurant style dal makhani', { entity: { name_matches: 'makhani' }, strategy: 'direct' }, 'composite_dish', ['indian']);
TRAP('tr-009', 'tea biscuit', { strategy: 'direct', items: items('tea|chai', 'biscuit') }, 'meal', ['multi_food', 'indian']);
TRAP('tr-010', 'bread omelette', { strategy: 'direct', items: items('bread', 'omelet') }, 'meal', ['multi_food', 'indian']);
TRAP('tr-011', 'chapatti', { entity: { name_matches: 'chapati|roti' }, strategy: 'direct' }, 'prepared_food', ['indian', 'spelling_variant']);
TRAP('tr-012', 'chapathi with dhal', { strategy: 'direct', items: items('chapati|roti', '\\bdal|dhal|lentil') }, 'meal', ['indian', 'spelling_variant', 'multi_food']);
TRAP('tr-013', 'curd', { entity: { name_matches: 'curd|dahi|yogh?urt' }, strategy: 'direct' }, 'single_ingredient', ['indian']);
TRAP('tr-014', 'black coffee', { entity: { name_matches: 'coffee', reject_name_matches: 'berry|cream|russian' }, strategy: 'direct' }, 'beverage');
TRAP('tr-015', 'side salad', { entity: { name_matches: 'salad', reject_name_matches: 'potato|macaroni|egg salad|chicken salad' }, strategy: 'direct' }, 'composite_dish');

export default C;
