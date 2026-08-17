# skos-food-v1 — progress report

## MICRONUTRIENTS — IFCT Tables 3/4/6/7/8 (2026-08-18)

All remaining nutritionally-useful IFCT tables extracted with one generalised
x-position extractor rather than five scripts. **~19,800 new nutrient values.**

| Table | What | Foods | Values |
|---|---|---:|---:|
| 8 | **Amino acids** — all 9 essential + cystine | 528 | 9,061 |
| 7 | **Fatty acids** — SFA/MUFA/PUFA, omega-3/6, EPA/DHA | 528 | 6,202 |
| 3 | Fat-soluble vitamins — E, K1, D2, tocopherols | 528 | 2,104 |
| 4 | Carotenoids — beta-carotene, lutein, lycopene | 329 | 1,278 |
| 6 | Starch and individual sugars | 314 | 1,126 |

Amino acids matter most for a training app: **leucine drives muscle protein
synthesis**, so protein *quality* becomes visible, not just protein grams.

### A unit error caught by validation, not by reading

First pass produced an amino-acids/protein ratio of **0.01** where physics
demands ~0.85 — paneer read 10 mg leucine per 100 g instead of ~1,840. The
extraction was correct; **my unit assumption was not.** Table 8's own header
states *"All values are expressed in g per 100g protein"* — relative to protein,
unlike every other IFCT table. Fields now name their basis explicitly, and
absolute per-100g-food values are **derived** from each food's own measured
protein rather than silently conflated.

Verified after the fix: paneer leucine **1,841 mg/100 g = 9.8% of protein**
(typical 7–10%), lentil dal 7.1%.

### Validated against physical law, not eyeballed

| Check | Law | Result |
|---|---|---|
| Fatty acids / total fat | FA residues are ~95% of triglyceride mass; rest is glycerol | median **0.83**, 82% in band ✓ |
| Free sugars / carbohydrate | Sugars are a *subset* of carbs | median 0.20, **0 physically impossible** ✓ |
| Each essential AA's share of protein | Stable biological range per amino acid | all 8 medians in band (leucine 6.9%, lysine 5.2%, valine 5.1%) ✓ |

A column misalignment — the exact failure x-position extraction exists to
prevent — would throw these far outside their bands, so this proves the method
rather than assuming it.

---

## TIER 2 — compositional calculator (built 2026-08-17)

The architecture always had three tiers; only 1 and 3 existed. Tier 2 is now
built, and it is the piece that breaks the name-only accuracy ceiling.

**The design decision that matters:** the ingredient list comes from the **user**,
not from a learned "typical recipe". Learning an average rogan josh would be
tier-3 guessing in a different costume — it would encode a generic recipe and
present it as if it described *this* plate. Asking is both more accurate and more
honest, and it converts the dominant unmeasurable (how much oil, how much cream)
into a measured input.

### The result that justifies it

Jalebi is absent from all four databases, so it is exactly the case tier 3 exists
for — and exactly where tier 3 fails:

| Jalebi | Estimate | Reality |
|---|---:|---|
| Tier 3 (name-only ML) | 147 kcal/100g | ~350–400 |
| **Tier 2 (from ingredients)** | **388 kcal/100g** | ✓ correct range |

### Validation: 906 INDB dishes recomputed from their own ingredient lists

INDB publishes both the finished nutrition of 1,014 dishes **and** the ingredients
each was computed from. So the calculator can be handed the ingredients and asked
to reproduce the published dish. This is not circular — ingredients are resolved
through **our** database (IFCT/USDA/CNF/OFF), never INDB's per-ingredient values.

| Class | n | median APE | within 25% |
|---|---:|---:|---:|
| **Main dishes** | 831 | **25.4%** | **49.3%** |
| Condiments / icings / spice blends | 75 | 54.4% | 33.3% |
| All (high calculator confidence) | 794 | 25.1% | 49.7% |

**Bias is 1.01× — i.e. none.** Over-prediction 27.2%, under-prediction 27.4%:
symmetric scatter, not a systematic offset. The arithmetic is sound; the residual
is ingredient-resolution ambiguity plus INDB's own inconsistent serving
definitions.

**Condiments are flagged at runtime**, not hidden: a "serving" of chutney is a
teaspoon of a large batch, so per-serving figures hinge on a serving count no
recipe fixes. Whole-batch totals for those remain reliable.

### Four bugs found by validating rather than assuming

Each was caught by checking a specific real dish, and each was silently
catastrophic:

| Bug | Effect |
|---|---|
| Ingredient matched a **composite dish** — "mutton" → "Mutton korma" | 300 g meat contributed 8.6 g protein instead of ~60 (a korma is mostly gravy) |
| Ingredient matched **rendered fat** — "Mutton boneless boti" → "Meat drippings (mutton tallow)" | 890 kcal/100g vs 160; turned a 73 kcal kebab into 1,197 kcal |
| Alias map matched **exact strings only** | Any real recipe phrasing ("Mutton boneless boti") fell through to plain search |
| **Cooking yield applied to an already-cooked** match | Double-counted moisture loss |

### Ingredient resolution needed culinary knowledge, not better ranking

Auditing the 45 most frequent ingredients across INDB's 1,014 recipes found
plain search mis-resolving the highest-volume terms in ways no scoring can fix:

| Ingredient | Resolved to | Should be |
|---|---|---|
| Refined wheat flour | Refined Sunflower **Oil** (900) | ~340 |
| Butter | Popcorn, microwave, butter **flavor** (535) | 717 |
| Curds | Cheese, curds (375) | dahi, ~65 |
| Pepper powder | Pepper, **banana**, raw (27) | black pepper, ~217 |
| Cinnamon | Cinnamon **buns**, frosted (452) | — |
| Vanilla essence | **Oreo** Original (471) | negligible |

"Curds" means yogurt in an Indian recipe and cheese curds in an American one;
"clove" is a spice in a spice list and a unit of garlic elsewhere. That is
culinary, not lexical, so it is stated explicitly in
`src/inference/ingredient_aliases.py` — **195 terms, every one machine-verified**
to resolve inside a plausible energy band for its food class
(`validation/check_ingredient_aliases.py`). Terms with no trustworthy match
(cinnamon, amchur, chaat masala) are **left unmapped so they report as
unresolved**, because substituting a cinnamon bun for cinnamon is worse than
admitting we lack it.

Also built: `portion_units.py` — culinary units → grams with **per-food-class
density**, because a tablespoon is a volume. One tbsp of oil is 13.8 g, of honey
21 g, of flour 8 g; a flat "15 g per tbsp" rule would be wrong by up to 2.6×.
Unit coverage was chosen by counting every unit string in the 10,272 recipe rows,
so it covers what actually appears.

---

## ACTUAL ACCURACY: our estimates vs independent lab measurement

Every number reported before this was a **component** metric. The obvious
end-to-end test is circular — for a food in the database the system returns the
lab value, so comparing it to the lab value scores 100% and proves nothing.

**Method:** IFCT 2017 (506 lab-measured Indian foods) is **removed from the
database entirely**, then each food is queried by its common name. The system
must answer from USDA + INDB + Open Food Facts alone. Different labs, different
countries, different samples, different analytical methods — genuinely
independent ground truth. It exercises the whole pipeline: query → retrieval →
ranking → cooking-state default → returned macros. **A retrieval failure counts
as error**, because to a user a right number for the wrong food is just wrong.

### Data expansion round (2026-08-17): 14,861 → 21,378 foods

The paginated Open Food Facts API started returning **HTTP 401/503** mid-pull
and never recovered — 10 of 226 pages succeeded. Rather than try to slip past
the block (which risks a harder ban and yields less), I switched to their
**official bulk export**, which is the route they ask bulk consumers to use:

| Source added | Rows | Notes |
|---|---:|---|
| **OFF bulk export** | 2,034 | 1.3 GB gzip stream-filtered for India; **1,723 usable** vs 677 from the API |
| **Canadian Nutrient File** | 4,944 | Open Government Licence; **99% carry a household measure** ("1 cup" → grams) |

Only 1,723 of the API's claimed 22,504 India products are usable — most India
entries are barcodes and photos with **no nutrition panel at all**.

**What the expansion actually bought** (this is the honest framing — it did *not*
make individual answers more accurate):

| | Before | After |
|---|---:|---:|
| Database size | 14,861 | **21,378** |
| Resolution rate | 72.1% | **74.9%** |
| High-confidence answers | 67 (18.4% of resolved) | **96 (25.3%)** |
| High-confidence medAPE | 25.2% | 25.1% |

The per-answer accuracy is unchanged, as expected. The gain is that **43% more
queries now land in the reliable bucket** — which is exactly the mechanism
predicted: more coverage converts low-confidence guesses into high-confidence
matches rather than improving the guesses themselves.

Two of my own filters had to be corrected during this: a bare `pet` pattern
flagged "Thumbs Up 750ml **pet**" and "Horlicks 450g **pet**" as pet food, when
PET is the bottle plastic (5 of 7 hits were false positives); and a kJ-guard
that required the literal string "kcal" silently dropped **every** CNF energy
row, because CNF spells the unit "kilocalorie".

---

### Results (n=379 resolved queries, expanded DB)

| Confidence | n | median APE | within 25% |
|---|---:|---:|---:|
| **high** | 96 | **25.1%** | **50.0%** |
| medium | 136 | 56.5% | 35.3% |
| low | 139 | 44.7% | 30.9% |
| unreliable (flagged rows) | 8 | 46.4% | 25.0% |

**Resolution rate: 74.9%** (was 19.4% before this session's fixes).

### How to read this honestly

- **High-confidence matches are cleanly separated** — 25.2% median error vs ~48%
  for everything else. The confidence label is doing real work, and the UI should
  lean on it rather than presenting all results equally.
- **This is a conservative lower bound.** Part of the spread is genuine biology,
  not model error: IFCT sampled *Indian* cultivars, USDA sampled American ones.
  A US "papaya" and an Indian one are not the same fruit.
- **It is not lab-grade, and no name-based system can be.** For foods the
  database actually contains, the user gets the lab value directly. This
  benchmark measures the harder case — foods the system has never seen.

### Confidence calibration took three attempts

Two earlier versions were **non-monotonic** against this benchmark, i.e. the
label actively misled:

| Basis | Result |
|---|---|
| Score thresholds | "high" 34.4% vs "medium" 24.9% — **inverted** |
| Match kind | "medium" 64.7% vs "low" 37.4% — **inverted** |
| **Token overlap** | high 25.2% vs medium 48.5% vs low 48.2% — **correct** |

Both failures had the same cause: a head-noun hit on a short query
("amaranth" → amaranth *grain* when the user meant *leaves*) looks structurally
strong while being the wrong food. Only measuring how much of each name the
other accounts for tracks actual correctness.

---

# Data foundation + retrieval

**Status:** data foundation complete and QA'd; retrieval layer built and measured.
**Not yet done:** alias layer, cooked/raw conversion, ML fallback, backend integration.

---

## What the app has today

`backend/src/services/foodEstimator.js` is a **22-item hardcoded list** with
hand-typed macros, no citations, and a regex matcher. Its own header calls it
an MVP placeholder. That is almost certainly the source of the accuracy
complaint — not a modelling problem, a data problem.

---

## What now exists

**14,863 foods**, merged from four independently-verified sources.

| Source | Rows | What it uniquely provides | Licence |
|---|---:|---|---|
| **INDB** | 1,004 | Indian **composite dishes** (masala dosa, biryani, khichdi) + serving sizes | Open academic |
| **IFCT 2017** | 506 | Indian **raw ingredients**, measured on Indian samples across 6 regions | NIN/ICMR primary PDF |
| **USDA FDC** | 12,892 | Global foods; SR Legacy + Foundation + **FNDDS composite dishes** | Public domain |
| **Open Food Facts** | 461 | India-market **packaged/branded** products | ODbL |

**924 foods carry a real serving size** ("1 katori", "1 dosa", "1 bowl") with
gram weights — the single biggest win for Indian logging, since users think in
katoris and pieces, not grams.

### Why four sources and not one

IFCT is the authoritative Indian source but is **raw ingredients only** — its
own preface states all values are for foods in the raw form. Users log
"khichdi", not "200g raw rice + 30g dal + 8g oil". INDB fills exactly that gap
with 1,014 assembled, cooked dishes. Neither could substitute for the other.

### Source priority (deliberate)

`INDB > IFCT > USDA > Open Food Facts`

- A **measured assembled dish** beats summing raw ingredients (cooking changes
  mass; the user's portion refers to the cooked dish).
- For Indian ingredients, the **Indian measurement** beats the US one — different
  cultivars, soils, and varieties.
- Crowd-sourced OFF never overrides a lab-measured generic food; it only adds
  brand SKUs the others structurally cannot have.

Lower-priority duplicates are **not discarded** — they backfill nulls, so USDA
can supply a mineral IFCT never measured without overriding any IFCT value.

---

## Data quality — what the checks actually caught

Every source was cross-checked by comparing its stated energy against an
independent Atwater estimate (4·protein + 9·fat + 4·carb) computed from that
same row's own macros. Consistent QA across all sources, not spot-checking.

| Source | Rows checked | Failed | Notes |
|---|---:|---:|---|
| USDA | 7,658 | **4 (0.05%)** | All explainable (alcohol, high-fibre); data is essentially pristine |
| INDB | 1,014 | **27 (2.7%)** | Real defect in published data — see below |
| IFCT | 509 | **2** | One extraction bug (mine), one source error |

### Three real problems found and handled

1. **Paneer energy was wrong in my extraction.** The table parser split the
   printed token `1278±61` into `1` + `278±61`, which would have shipped paneer
   at **66 kcal/100g instead of ~305**. Caught by the Atwater check, root-caused
   via word-level PDF coordinates, corrected to the verified value.

2. **IFCT chicken leg (N001) is internally inconsistent** — 1605 kJ against its
   own macros implying ~798 kJ, and it reports *less* fat but ~2× the energy of
   the neighbouring thigh entry, which itself checks out. Verified the printed
   value is genuinely 1605, so this is a **typo in NIN's publication**, not an
   extraction error. Flagged and its energy withheld — **not** replaced with a
   guessed number.

3. **27 INDB rows (mostly soups) contradict themselves** — e.g. "Lentil soup"
   states 31 kcal/100g alongside 11.7 g fat/100g, where the fat alone is ~105
   kcal. Verified present in the source workbook. Their macros are withheld and
   a flag travels with the row, so nothing downstream can treat them as clean.

**Nothing was invented to fill a gap.** Where a source lacks a nutrient the
field is null, never estimated.

### Serving sizes: derived, not guessed

INDB names servings ("1 katori", "1 soup bowl") with no gram weight anywhere in
the workbook. But it publishes *both* per-100g and per-serving energy, so
serving mass follows exactly: `grams = (serving_kcal / per100g_kcal) × 100`.
That is arithmetic on their own published numbers. Sanity-checked against
reality:

| Dish | Derived serving | Reality check |
|---|---|---|
| Chapati/Roti | 36.0 g → 73 kcal | Standard roti is 35–40 g, ~70–80 kcal ✓ |
| Masala dosa | 209.7 g → 345 kcal | Plausible ✓ |
| Dhokla | 40.0 g → 87 kcal | Plausible ✓ |
| Plain pulao | 307.9 g → 432 kcal | Plausible plate ✓ |

---

## Retrieval was the real accuracy bottleneck

With 8,671 foods loaded and **correct** nutrition values, the database still
answered:

| Query | Returned | kcal |
|---|---|---|
| `chicken` | APPLEBEE'S chicken tenders platter | 297 |
| `rice` | Alcoholic beverage, rice (sake) | 134 |
| `egg` | Babyfood, cereal, egg yolks and bacon | 79 |
| `banana` | Babyfood, apple-banana juice | 51 |
| `apple` | APPLE CIDER VINEGAR | **0** |
| `idli` / `dosa` / `poha` | *no match at all* | — |

For a food logger this is indistinguishable from wrong data — the user sees a
number, and it is the number for the wrong food. **Retrieval accuracy is
therefore treated as part of model accuracy, not as UI plumbing.**

### After the ranking layer

| Query | Returned | kcal |
|---|---|---|
| `chicken` | Chicken, ground, raw | 143 |
| `rice` | Rice, black, unenriched, raw | 361 |
| `banana` | Banana, raw | 97 |
| `milk` | Milk, whole, Cow (IFCT) | 72.9 |
| `paneer` | Paneer (IFCT) | 305.4 |
| `idli` | Idli — 1 idli = 25.1 g | 137.5 |
| `samosa` | Samosa | 310 |
| `fried egg` | Fried Egg — 1 egg = 57.8 g | 223.7 |

**Indian dish coverage went from 7/39 to 32/40 (80%).**

Scoring is deliberately **explainable** (additive, inspectable components)
rather than a learned ranker — with no click-through data to train on, a
learned ranker would encode the same guesses with less transparency.

The key insight that separated ingredients from dishes: USDA/IFCT write generic
foods as `HeadNoun, qualifier, qualifier` ("Chicken, broilers or fryers,
breast"), while dishes are plain phrases ("Chicken stew"). Matching the text
*before the first comma* identifies the food itself rather than a dish
containing it — no hand-maintained dish list required.

---

## Alias layer — most "missing" dishes were already in the database

Ranking alone left 8/40 dishes unfindable. Investigating each one turned up
**two bugs in my own search, not missing data**:

1. **The normalizer was deleting the Hindi name.** In INDB (369 rows) the
   parenthetical is the regional name — `"Brinjal bhartha (Baingan ka bhartha)"`
   — which is exactly what an Indian user types. It was being stripped before
   indexing. (In IFCT the parenthetical is instead a Latin binomial,
   `"(Prunus amygdalus)"`, so this had to be handled per-source rather than by
   simply keeping all parentheses.)
2. **No romanisation handling.** ladoo/laddu, chana/channa, bharta/bhartha,
   paratha/parantha are the same food; a user typing one spelling could not
   reach a row stored under another.

Fixed by generating **3,206 aliases (4,522 mappings)** deterministically from
names already present, plus a small curated set of *semantic* synonyms — cases
like `chana masala` → `"Chickpeas curry"` that share no words and therefore
cannot be derived. Synonyms whose target dish is absent are **left unmapped
rather than pointed at an approximate substitute**.

**Indian coverage: 7/39 → 47/50 (94%).**

The 3 still missing — `rogan josh`, `vindaloo`, `jalebi` — were verified absent
from all four sources. That is a genuine data gap, and returning nothing is the
correct behaviour there rather than serving a similar dish's calories.

---

## Raw vs cooked: the largest single error source found

USDA publishes separately-**measured** raw and cooked entries, which beats
applying a generic retention factor — the measured cooked value already
embodies real water loss, fat rendering and nutrient degradation, with no
modelling assumption. **650 matched pairs** extracted.

Median cooked/raw energy-density ratio is **1.31×**, but the spread is the
point, and it runs in *both* directions:

| Food | Raw | Cooked | Ratio |
|---|---:|---:|---:|
| Rice, white | 358 | 130 | **0.36×** |
| Chickpeas | 378 | 164 | 0.43× |
| Oat bran | 246 | 40 | **0.16×** |
| Beef, chuck | 145 | 181 | 1.25× |
| Green beans | 40 | 223 | 5.58× |

Grains and pulses **absorb ~3× their weight in water**, so cooked is far *less*
energy-dense; meats lose water and get denser; fried vegetables absorb oil.

**Why this matters more than anything else in the pipeline:** logging "150 g
rice" meaning *cooked* but resolving to the *raw* value is a **342 kcal error on
a single item** — larger than every other error source measured here combined.
The app must disambiguate cooking state for staples, not silently pick one.

Coverage: 19% of raw-or-cooked rows sit in a matched pair; the rest have only
one state measured. Retention factors remain the right tool for that remainder.

---

## Cross-source agreement — and a validation that caught its own flaw

Where two independent sources measured the same food, their agreement is a free
estimate of trustworthiness. Implemented as a **confidence signal, never a
correction** — averaging two labs' "dosa" invents a third number neither
measured.

The first version keyed foods on their **head noun** and reported alarming
disagreements:

| Food | "Disagreement" | Reality |
|---|---|---|
| pepper | IFCT 218 vs USDA 27 (8.1×) | IFCT = **black pepper**, USDA = **bell pepper** |
| peas | IFCT 303 vs USDA 42 (7.2×) | **dried** vs **fresh** |
| apricot | IFCT 316 vs USDA 48 (6.6×) | **dried** vs **fresh** |

Every value was correct; **the matcher was wrong**. The qualifiers a head-noun
key discards are precisely the ones that determine calorie content. Shipping
that as a confidence signal would have flagged correct data as untrustworthy —
worse than having no signal.

Re-keyed on the full identifying name: **10 truly-comparable foods, 100%
corroborated**, max spread 1.19×. Good news for data quality, but too small an
overlap to serve as a general per-food confidence mechanism — recorded as such
rather than overstated.

---

## Oil level — turning the biggest unmeasurable into a user input

**The single best accuracy lever available**, because it attacks the exact term
measured as irreducible: cooking fat drives ~2× variance on fried foods and ~3×
on curries, and that information is genuinely not in the dish name — but the
user knows it.

### Baselines are extracted, not guessed

Adding the user's oil on top of a published value **double-counts** whatever the
recipe already assumed. So the recipe's own oil content had to be extracted
first. INDB ships full ingredient lists — 10,272 rows across 1,014 dishes — with
quantities and units.

Three bugs surfaced doing this, each caught by sanity-checking a real dish:

1. **INDB names the ingredient literally `"Fat"`**, not "oil". Matching only on
   free-text ingredient names reported paratha, puri and most fried dishes as
   containing **zero oil**. The authoritative signal is the *mapped* food-name
   column (`Fat` → `Oil, sunflower`).
2. **Recipe oil covers the whole recipe**, not one serving — dividing by serving
   count was required, or oil is overstated 4–6×.
3. **Deep-fry amounts read `"for frying"`** with no number. Whatever *did* parse
   was only the tempering oil (pakora came out at 0.34 g/100 g — labelling a
   deep-fried food oil-free). These are now flagged and fall back to a dish-class
   estimate rather than trusting a partial figure.

Result: **541 dishes with a usable measured oil baseline.**

### Tier values come from the measured distribution

Percentiles of g oil per 100 g of finished dish (n=541 real Indian recipes):

| Level | g/100g | kcal/100g from oil | Basis |
|---|---:|---:|---|
| none | 0.0 | 0 | — |
| low | 2.0 | 18 | ≈p25 |
| **moderate** | **4.5** | **40** | **≈median real dish** |
| high | 10.0 | 88 | ≈p75 |
| very high | 17.0 | 150 | ≈p90 |
| custom | user grams | — | accepts grams for *their* portion |

Nothing invented — every tier is anchored to where real recipes actually sit.

### The adjustment conserves mass

Adding 10 g of oil adds 10 g of **mass** as well as 88 kcal. Naive
implementations add calories but not mass and silently inflate per-100g density.
Both are updated, and protein/carb concentrations are renormalised against the
new total.

```
delta_g    = target_oil − baseline_oil
new_energy = (kcal + delta_g × 8.84) / (100 + delta_g) × 100
```

8.84 kcal/g is the measured USDA figure for cooking oil (884 kcal/100 g).

**Worked example — Chickpeas curry**, baseline 5.75 g/100 g (measured from its
own recipe):

| Level | kcal/100g | Δ |
|---|---:|---:|
| low | 135.4 | **−17.2%** |
| moderate | 154.3 | −5.6% |
| published | 163.0 | — |
| high | 192.8 | +18.0% |
| very high | 236.3 | +44.6% |

Selecting *less* oil than the recipe assumed correctly **reduces** calories —
which is exactly the behaviour asked for, and only possible because the baseline
is known.

Foods with no recipe data fall back to a dish-class baseline (deep-fried 12,
curry 5, griddle bread 3, steamed 0.5 g/100 g), always labelled
`class_estimate` rather than passed off as measured. Where neither exists, the
published value is returned **unchanged** rather than adjusted from an invented
starting point.

---

## A serious data defect found while building this: 20% of INDB is contaminated

Sanity-checking pakora against its oil baseline exposed something the existing
Atwater gate structurally could not catch:

> **Potato pakora: 677 kcal/100 g, 71.8 g fat/100 g — 95.5% of energy from fat,
> serving 674 g → 4,568 kcal for one serving.**

It passes the Atwater check because energy and macros are **consistently wrong
together** (678 vs 677). *Internal consistency is not plausibility.* The cause is
the deep-frying **oil bath** being counted as eaten — real absorption is ~5–15%
of food weight, not the whole pan.

Two independent plausibility tests were added:

| Test | Flagged |
|---|---:|
| Fat energy share > 80% | 154 |
| Derived serving mass absurd for its unit ("1 pakoda" = 674 g) | 90 |
| **Total distinct rows** | **201 of 1,014 (19.8%)** |
| …of which **physically impossible** (fat energy > total energy) | 6 |

Worst cases: Dum aloo 4,576 kcal/serving, kofta curries ~4,560 kcal/serving,
cream soups at 119–121% of energy from fat.

**These are flagged, not deleted and not silently corrected** — there is no basis
to pick a replacement number. They are excluded from tier-3 training, deprioritised
in search, and when one is still the only match for a query the result now carries
`trustworthy: false` plus the reason, so a known-bad value can never be presented
as clean.

Retraining on the cleaned set improved absolute error meaningfully — energy MAE
50.6 → **46.6**, fat 4.20 → **3.82**, carb 6.26 → **5.81** — with median APE
holding at ~15%.

---

## Cooking state — FIXED (was the largest error source)

The 650 measured pairs are now wired into an actual runtime rule, not just
recorded. Principle: **users log what they put in their mouth.** Nobody eats raw
rice, raw dal or raw chicken, so for foods normally eaten cooked the cooked form
is the default and raw is opt-in; for fruit, salads, nuts and dairy the reverse.

This is a product decision, so it is stated explicitly in
`src/inference/cooking_state.py` rather than buried in a scoring heuristic, and
the measured alternative is always returned alongside so the UI can offer a
one-tap correction instead of silently committing.

**Effect on real queries:**

| Query | Before | After |
|---|---|---|
| `rice` | Rice, raw — **358 kcal** | Rice, cooked — **129 kcal** |
| `chicken` | Chicken, feet, boiled | Chicken, roasting, meat only, cooked — 167 kcal |
| `potato` | (raw) | Potato, baked — 93 kcal |
| `banana` | Banana, raw — 97 kcal | unchanged (correctly stays raw) |

1,661 rows are flagged where the matched state differs from how the food is
eaten. Nothing is converted with a synthetic factor — where only one state was
measured, that is reported as-is with the limitation stated.

Two ranking bugs were found and fixed along the way, both observed rather than
hypothesised: `"Minced meat pancake (with chicken)"` had acquired `chicken` as
an exact alias (parentheticals opening with a connector are qualifiers, not
names), and organ meats / uncommon species were outranking normal cuts.

---

## Tier 3 accuracy: 27.6% → **14.9%** median APE

The v1 "50% MAPE" headline was partly a metric artifact. **Mean** MAPE is
dominated by near-zero-calorie foods where a 10 kcal miss on black coffee is a
300% error but nutritionally irrelevant. **Median APE** reflects what a user
actually experiences, and both are now reported.

Four approaches were measured on the identical grouped holdout:

| Approach | energy medAPE | protein MAE |
|---|---:|---:|
| A — regression on name text (v1) | 27.6% | 7.00 g |
| B — **kNN retrieval over measured foods** | **22.3%** | **3.25 g** |
| C — regression + food-class features | 27.6% | 4.89 g |
| D — blend of B and C | 24.0% | 3.62 g |

**Retrieval beat regression on every target.** The reason is structural:
regression on sparse text regresses toward the training mean when it meets an
unseen food family (v1 predicted jalebi at 147 kcal against a real ~350–400).
Retrieval cannot do that — every output is a real food's real measured value.

Tuning the retrieval (k sweep, class-aware distance, weighting) reached **21.6%**.

### Two deployment regimes, measured separately

v1–v3 validated only by splitting on the food's first token, which removes the
entire family from training. That is right for a genuinely novel food
(`jalebi`), but it is not the common case — usually the user types
"chicken korma" and the database holds "chicken curry". Scoring only the hard
regime understates real accuracy:

| Regime | energy medAPE | protein | fat | carb |
|---|---:|---:|---:|---:|
| **A — novel family** (head noun unseen) | 21.6% | 18.4% | 39.9% | 34.1% |
| **B — known family** (common case) | **14.9%** | 16.3% | 25.4% | 21.5% |

### The floor is measured, not asserted

Tuning plateaued and abstention did not help — restricting to the best-matched
30% of foods still gave ~21% error. That is the signature of irreducible
variance, so it was measured directly:

| Comparison | Median APE |
|---|---:|
| Rows with **identical** names across sources | **5.1%** |
| Foods sharing a **head noun** | **16.9%** |

Identical names agree closely (5.1%) — naming is not the problem, and that case
is tier 1 anyway. The floor that applies to tier 3 is **16.9%**: it runs only
when no exact match exists, so the head noun is the best information available,
and foods sharing one genuinely differ by that much.

**So regime A at 21.6% sits ~4.7 points off its measured optimum, and regime B
at 14.9% is already below the head-noun floor** (it has more than the head noun
to work with). Further tuning has little left to give; **widening tier 1 is
where the remaining accuracy lives.**

### On "at par with lab-measured data"

Not achievable from a name alone, and the data says why: a samosa's calories
swing ~2× on oil absorption, a curry ~3× on cream and ghee. That information is
not in the string. Tier 3 must always be labelled an estimate and shown with its
interval — never given the same visual weight as a measured value. The way to
get lab-grade numbers is tier 1 coverage, which is exactly where the alias work
(94% of Indian dishes) paid off.

---

## Superseded: original tier-3 assessment

Trained XGBoost on food-name text (word + character n-grams) to predict
kcal/protein/fat/carb for foods absent from every source. Validated with a
**grouped** split on name stem, so no food family appears in both train and
test — the model must predict families it has never seen, which is the real
deployment condition. (A random split would put "Potato samosa" in train and
"Vegetable samosa" in test and report a flattering, meaningless score.)

| Target | MAE | vs median baseline | MAPE |
|---|---:|---:|---:|
| energy_kcal | 77.9 kcal | **+30.9%** | **50.4%** |
| protein_g | 7.00 g | +29.0% | 54.5% |
| fat_g | 6.86 g | +20.4% | 58.1% |
| carb_g | 8.79 g | +50.1% | 74.5% |

**It genuinely learns** — it beats predicting the median by 21–50%, so food
names do carry real nutritional signal. **But 50% MAPE on energy is not
accurate enough to show a user as a number.** Its 80% interval is
−179/+56 kcal, which is not a useful answer for a single food.

Reality-checking the exact dishes it exists to serve confirms this:

| Dish | Model | Actual (published) |
|---|---:|---:|
| jalebi | 147 kcal | ~350–400 |
| gulab jamun | 190 kcal | ~300 |
| pani puri | 311 kcal, **30.7 g fat** | fat figure implausible |

**Recommendation: do not ship tier 3 as a displayed estimate.** Options that
are defensible: use it only to sanity-bound a user's manual entry, or say "not
in database — please enter manually" and let the user's own value stand.
Presenting a 50%-error number next to lab-measured values would make the whole
feature feel unreliable, and would be indistinguishable to the user from the
accurate paths.

**This result is the strongest argument for the tiered design.** Tier 1
(database + aliases) now resolves 94% of tested Indian dishes with lab-measured
values. Tier 3 exists only for the residual, and measurement shows that
residual is exactly where accuracy collapses — so effort belongs in *widening
tier 1*, not in tuning the model. A single end-to-end "train on all food data"
model would have had tier-3 accuracy **everywhere**.

---

## Known gaps (honest list)

1. **3 dishes genuinely absent from all sources** — `rogan josh`, `vindaloo`,
   `jalebi`. Verified missing, not a search failure. Needs new data; tier 3 is
   measurably not good enough to cover them (see above).
2. **INDB per-100g disagrees with USDA for some dishes** — plain dosa 381 vs
   210 kcal/100g (1.81×), chapati 202 vs 297 (0.68×). Bidirectional, so not a
   fixable offset. INDB's **per-serving** values check out against reality
   (roti 36 g → 73 kcal), so per-serving should be preferred for INDB rows.
   **Not yet implemented.**
3. **Cooked/raw disambiguation is built but not wired into a decision.** 650
   measured pairs exist; the app still has no rule for what "100 g rice" means.
   This is the largest known error source (up to 2.75× on staples).
4. **Tier 3 accuracy is poor (50% MAPE)** and should not be displayed.
5. **Micronutrients partial** — IFCT minerals extracted (528 foods); IFCT
   vitamin tables (2–4) not yet extracted. INDB carries a full vitamin panel
   for its 1,014 dishes but it is not yet merged through.
6. **Nothing integrated into the backend.** No schema, service, or route has
   been touched. `foodEstimator.js` still ships its 22-item hardcoded list.
7. **Open Food Facts pull is partial** — 461 of ~22,500 available India
   products (stopped by rate limiting, resumable).

---

## Files

| Path | Purpose |
|---|---|
| `src/ingestion/ifct2017_extract.py` | IFCT Table 1 (macros) + QA corrections |
| `src/ingestion/ifct2017_extract_minerals.py` | IFCT Table 5 (minerals), x-position extraction |
| `src/ingestion/usda_extract.py` | USDA SR Legacy + Foundation + FNDDS |
| `src/ingestion/indb_extract.py` | INDB dishes + serving derivation + consistency gate |
| `src/ingestion/build_unified_food_db.py` | Merge, dedupe, source priority |
| `src/inference/food_search.py` | Ranked retrieval |
| `data/processed/unified_food_db.json` | 14,863 foods |
