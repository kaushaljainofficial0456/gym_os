# FRONTEND SPEC — Food logging UI for skos-food-v1

**For:** Manavi (frontend, `origin/ui-manavi`) · **From:** Sambhav (ML)
**Depends on:** Kaushal's backend work (`CONTRACT_skos-food-v1.md`) — build
against the shapes below; they are versioned (`food-v1`) and will not change
silently.

The existing screen is `frontend/src/pages/client/Nutrition.jsx`. This is not a
rewrite — it is five additions to how a logged food is chosen and quantified.

---

## 0. The one rule that matters most

**A `null` nutrient means NOT MEASURED. Never render it as 0.**

A food with `"carb_g": null` is one nobody measured carbohydrate for. Showing
"0 g carbs" tells the user something false about their food. Show `—` or omit
the row.

This applies to every nutrient field, everywhere.

---

## 1. Search results must show confidence

Every result carries `confidence`, measured against held-out lab data. It is not
decoration — it is the difference between a lab value and a guess.

| `confidence` | What it means | UI |
|---|---|---|
| `high` | Exact/alias match. Typically the lab measurement itself | Show plainly |
| `medium` | Good match, some query terms unmatched | Show + easy "not this?" affordance |
| `low` | Weak match | Visibly secondary; make correcting it obvious |
| `unreliable` | Row failed a plausibility check | **Do not show the number.** Show `data_quality_flag` text instead |

Also present: `query_relaxed: true` means we dropped some of the user's words to
find a match. Worth a quiet "showing results for *X*" line.

**Please don't compute confidence in the UI.** It is calibrated against a
benchmark, and two earlier server-side schemes were measurably *inverted*
before the current one. Use the field.

---

## 2. Portion picker — the biggest usability win

Every result carries a `portions` array **sized for that food**. Users log
"1 katori", not "150 g".

Two input modes, both required:

**A. Weighing scale** — a plain grams field, for users who weigh.
**B. Household portions** — the `portions` array, grouped by `group`:

| Group | Options |
|---|---|
| `spoon` | Teaspoon · Tablespoon · Serving spoon · Ladle |
| `bowl` | Small bowl · Katori · Medium bowl · Large bowl · Soup bowl |
| `plate` | Quarter · Half · Regular · Full |
| `glass` | Small glass · Glass · Tall glass · Tea cup · Cup · Mug |
| `count` | Roti · Dosa · Idli · Egg … (only when it applies to that food) |

Each entry has `label`, `grams`, and often `observed_range_g`.

### Two things to get right

**`grams` is per-food. Do not cache it across foods.** A medium bowl of dal is
250 g; of spinach, 62 g — the same bowl, different density. If you hardcode
"1 bowl = 250 g" it will be wrong by 4× on light foods.

**Show `observed_range_g` where present.** A "bowl" is not a defined unit — real
ones span 166–354 g in the measured data. Something like
*"Medium bowl ≈ 250 g (typically 166–354 g)"* is honest; a bare "250 g" implies
precision that does not exist.

The user picks a portion and a count (`2 × medium bowl`), and the backend returns
grams and totals. Always display the resolved grams — it lets the user catch a
bad conversion themselves.

---

## 3. Cooking state toggle

Foods carry `cooking_state`: `raw` · `cooked` · `ready_to_eat` · `unspecified`.

This is the **largest measured error source in the whole model**: rice is
358 kcal/100 g raw and 129 cooked. Logging 150 g against the wrong one is a
342 kcal error on a single item.

The backend already defaults to the state a food is *eaten* in (rice → cooked,
banana → raw). You do not need to ask. But when an `alternative` is present,
offer a compact one-tap switch:

> Cooked ⟷ Raw

Only show it for `raw`/`cooked`. `ready_to_eat` (packaged goods) and
`unspecified` have nothing to toggle.

---

## 4. Oil level selector

For cooked dishes, offer the oil control — it is the single biggest lever the
user has over accuracy, because oil is the largest thing the model cannot see.

> Oil: None · Low · Moderate · High · Very high · Custom (g)

- Default to **Moderate** (it is the median real Indian recipe).
- `Custom` takes grams for *their* portion.
- Optionally let them name the oil (ghee / mustard / sunflower / coconut …) —
  the response then includes `added_fat_profile` with the saturated /
  monounsaturated / polyunsaturated split. **This does not change calories** —
  all cooking fats are ~900 kcal/100 g — so present it as fat *quality*, not as
  a calorie difference.

---

## 5. "Made it myself" — ingredient entry (tier 2)

For a dish the database does not have (or a recipe the user wants priced
exactly), let them enter ingredients:

> **Rogan josh** · serves 4
> mutton — 500 g · curd — 150 g · oil — 4 tbsp · onion — 200 g

Each row is name / amount / unit. Send to the compositional endpoint.

**Surface `unresolved` prominently.** An unresolved ingredient means those
calories are **missing from the total**, not merely approximate:

> ⚠ Couldn't price: *salt (to taste)* — not included in the total.

Trace items (essences, food colour) are excluded deliberately and are not errors.

If `serving_caveat` is present (chutneys, masalas, icings), show it: their
whole-batch total is reliable but a per-serving figure depends on how much of
the batch is actually eaten.

---

## 6. Nutrition display

Beyond calories/protein/carbs/fat, results may carry:

- **minerals** — calcium, iron, potassium, magnesium, zinc, phosphorus
- **vitamins** — C, folate, E, B1/B2/B3/B6
- **fat quality** — saturated / mono / polyunsaturated
- **protein quality** — leucine (drives muscle protein synthesis; relevant here)

Put these behind a "details" expander rather than in the main row. Same null
rule: absent means unmeasured, not zero.

---

## 7. What NOT to do

1. **Never render `null` as 0.**
2. **Never re-derive confidence client-side.**
3. **Never cache portion grams across foods.**
4. **Never show an `unreliable` row's number** — show its reason.
5. **Never present a tier-3 estimate as a measurement.** If the response says
   `tier: 3`, label it an estimate.

---

## 8. Suggested build order

1. Confidence affordance in existing search results *(smallest change, biggest
   correctness win)*
2. Portion picker *(biggest usability win)*
3. Oil selector
4. Cooking-state toggle
5. Ingredient entry for tier 2
6. Micronutrient expander

1–2 alone make the feature meaningfully better than what ships today.

---

## 9. Accuracy, so you can size the UI claims honestly

Measured against IFCT 2017 lab values on 30 commonly-logged foods:

| Case | Median error |
|---|---|
| Food **is** in the database (the common case) | **~0%** — it returns the lab measurement itself |
| Food is **unknown**, model must infer | ~17% |

So for most logged foods the number is a lab measurement, not a guess. Don't
call it "AI-estimated" when `confidence: high` — that undersells it and it isn't
accurate. Reserve estimate language for `tier: 3` and low confidence.

---

## 10. Reference

| Thing | Path (`ml-sambhav`) |
|---|---|
| Contract — all JSON shapes | `ml/docs/CONTRACT_skos-food-v1.md` |
| Model card — limits, do-not-use | `ml/models/skos-food-v1/MODEL_CARD.md` |
| Backend migration (Kaushal) | `ml/docs/KAUSHAL_FOODS_TABLE_MIGRATION.md` |

Ask before designing around a shape you are unsure of — changing it later costs
all three of us more than a message does now.
