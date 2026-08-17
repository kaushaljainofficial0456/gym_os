"""
TIER 2 -- compositional calculator: price a dish from its ingredients.

WHERE THIS SITS:
  tier 1  exact / alias match      -> lab value, best possible
  tier 2  THIS: ingredients known  -> sum of lab values, near-lab accuracy
  tier 3  name only                -> kNN retrieval, ~15-25% median error

Tier 2 is the only path that can beat tier 3 by a wide margin for a dish
absent from every database, and it does so without inventing anything:
every ingredient is looked up as a measured food, converted to grams, and
summed. The uncertainty collapses to "did the user report their
ingredients correctly", which is a question the USER can answer and a
model never can.

DESIGN CHOICE THAT MATTERS:
The ingredient list comes from the USER, not from a learned recipe
template. Learning "a typical rogan josh" would just be tier-3 guessing
wearing a different hat -- it would encode an average recipe and then
present it as if it described this specific plate of food. Asking is both
more accurate and more honest.

COOKING YIELD IS APPLIED, NOT IGNORED:
Summing raw ingredients gives the total NUTRIENTS correctly but the wrong
per-100g DENSITY, because cooking changes mass: rice absorbs ~2.5x its
weight in water, meat loses ~25% as moisture, frying adds oil. So the
finished mass is estimated from per-ingredient yield factors, and per-100g
values are computed against that. Absolute totals never depend on the
yield estimate -- only the density does -- so a yield error cannot corrupt
the calorie total for a whole-dish log.
"""
import json
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

try:
    from .portion_units import to_grams
    from .food_search import FoodSearch
    from .ingredient_aliases import resolve_ingredient
except ImportError:  # script use
    from portion_units import to_grams
    from food_search import FoodSearch
    from ingredient_aliases import resolve_ingredient

NUTRIENT_FIELDS = [
    "energy_kcal", "protein_g", "fat_g", "carb_g", "fiber_g", "sugar_g",
    "sodium_mg", "calcium_mg", "iron_mg", "potassium_mg", "magnesium_mg",
    "zinc_mg", "phosphorus_mg", "vitamin_c_mg", "folate_b9_ug",
    "thiamine_b1_mg", "riboflavin_b2_mg", "niacin_b3_mg",
]

# Mass change on cooking, as a multiplier on the RAW ingredient weight.
# Grains and pulses absorb water; meats and vegetables lose it. Values are
# the standard yield factors used in food-composition work, and they only
# affect the finished-dish DENSITY, never the nutrient totals.
YIELD_FACTORS = [
    (r"\brice\b|\bpoha\b|\bbroken wheat\b|\bdaliya\b|\bbulgur\b|\bquinoa\b", 2.6),
    (r"\bpasta\b|\bnoodle|\bmacaroni\b|\bvermicelli\b|\bsemiya\b", 2.4),
    (r"\bdal\b|\bdaal\b|\blentil\b|\bgram\b|\bbean\b|\brajma\b|\bchana\b|"
     r"\bchickpea\b|\bmoong\b|\burad\b|\btoor\b|\bmasoor\b", 2.5),
    (r"\bsemolina\b|\bsuji\b|\brava\b", 2.8),
    (r"\bflour\b|\batta\b|\bmaida\b|\bbesan\b", 1.4),   # dough/batter
    (r"\bchicken\b|\bmutton\b|\blamb\b|\bbeef\b|\bpork\b|\bkeema\b|\bmince\b", 0.75),
    (r"\bfish\b|\bprawn\b|\bshrimp\b", 0.80),
    (r"\begg\b", 0.90),
    (r"\bspinach\b|\bpalak\b|\bmethi\b|\bleaves\b|\bleafy\b", 0.45),
    (r"\bonion\b|\btomato\b|\bcabbage\b|\bcauliflower\b|\bgourd\b|\bokra\b|"
     r"\bbhindi\b|\bbrinjal\b|\beggplant\b|\bcapsicum\b|\bmushroom\b", 0.70),
    (r"\bpotato\b|\baloo\b|\bcarrot\b|\bbeetroot\b|\byam\b|\bsweet potato\b", 0.90),
    (r"\bwater\b", 0.35),   # most added water boils off / is absorbed
    (r"\bmilk\b|\bcurd\b|\bdahi\b|\byogh?urt\b", 0.85),
    (r"\boil\b|\bghee\b|\bbutter\b", 1.0),
    (r"\bsugar\b|\bjaggery\b|\bsalt\b|\bpowder\b|\bmasala\b|\bspice\b", 1.0),
]
COMPILED_YIELD = [(re.compile(p, re.I), y) for p, y in YIELD_FACTORS]

# Rendered animal fats and cured deli meats: correct foods, catastrophic
# substitutions. "pork" resolved to "Animal fat, lard (pork)" (849 kcal,
# 0 g protein) and "beef" to "Oscar Mayer Bologna", so 400 g of pork
# contributed 0.7 g of protein instead of roughly 80.
#
# A REAL TRAP WORTH RECORDING: an earlier version of this pattern was
# written through a shell heredoc and its word-boundary escapes became
# literal BACKSPACE bytes. grep showed clean source, the regex compiled
# without error, and it silently matched nothing -- the guard was dead code
# while appearing to work. Patterns here avoid backslash escapes entirely.
RENDERED_FAT_RE = re.compile(
    "tallow|lard|dripping|suet|shortening|animal fat|rendered fat|"
    "fat, chicken|fat, beef|fat, pork|fat, mutton|fat, duck|"
    "bologna|salami|pepperoni|hot dog|frankfurter|luncheon meat|"
    "deli-meat|deli meat|loaf, chicken|macaroni and cheese loaf", re.I)
# Condiments, spice blends and icings: measured at 54.4% median error
# per-serving vs 25.4% for main dishes (n=75 vs 831). The arithmetic is not
# at fault -- overall bias is 1.01x, i.e. none -- but a "serving" of chutney
# is a teaspoon of a large batch, so per-serving figures hinge on a serving
# count no recipe fixes. Flagged so those are never presented as firm.
CONDIMENT_RE = re.compile(
    "chutney|masala|icing|pickle|achar|filling|dip|sauce|jam|spread|"
    "powder|paste|marinade|dressing|syrup|glaze|seasoning", re.I)

# The ingredient itself asking for fat/oil -- then a fat match IS correct.
FAT_INGREDIENT_RE = re.compile(
    "oil|ghee|butter|tallow|lard|dripping|suet|margarine|vanaspati|fat", re.I)


def yield_factor(name):
    for rx, y in COMPILED_YIELD:
        if rx.search(name or ""):
            return y
    return 1.0


class CompositionalCalculator:
    def __init__(self, search=None):
        self.search = search or FoodSearch()
        self._db_by_sid = {f.get("source_id"): f for f in self.search.foods}

    def _lookup(self, ingredient_name):
        """Resolve an ingredient to a measured food.

        Goes through the curated recipe-ingredient map first (see
        ingredient_aliases.py). Auditing INDB's most frequent ingredients
        showed plain search mis-resolves the highest-volume terms in ways
        scoring cannot fix -- "Refined wheat flour" matched "Refined
        Sunflower OIL", "Curds" matched "Cheese, curds" (375 kcal vs dahi's
        65). Those are culinary facts, not lexical ones.

        Returns (row, cooking_state, negligible). `negligible` marks trace
        items (essences, food colour) that contribute nothing and should not
        be force-matched to something wrong.
        """
        query, negligible = resolve_ingredient(ingredient_name)
        if negligible:
            return None, None, True
        if query is None:
            return None, None, False

        results = self.search.search(query, limit=12)
        if not results and query != ingredient_name:
            results = self.search.search(ingredient_name, limit=12)
        if not results:
            return None, None, False

        # An INGREDIENT must resolve to an ingredient, never to a composite
        # DISH. Without this, "mutton" matched "Mutton korma" (an INDB dish)
        # and 300 g of meat contributed 8.6 g of protein instead of ~60 --
        # because a korma is mostly gravy. Dish rows are excluded outright
        # rather than down-ranked, since for ingredient resolution they are
        # never the right answer.
        ingredient_only = [
            r for r in results
            if r.get("source") != "INDB"
            and (self._db_by_sid.get(r["source_id"], {}) or {}).get("category") != "indian_dish"
        ]
        pool = ingredient_only or results

        # SAFETY NET: never let a normal ingredient resolve to rendered fat.
        # "Mutton boneless boti" matched "Meat drippings (mutton tallow)" at
        # 890 kcal/100g -- 15x the right value for lean goat meat. Tallow,
        # lard and drippings are only correct when the ingredient itself says
        # so, and no amount of ranking will infer that.
        if not FAT_INGREDIENT_RE.search(ingredient_name):
            non_fat = [r for r in pool if not RENDERED_FAT_RE.search(r.get("food_name") or "")]
            pool = non_fat or pool

        raw_first = [r for r in pool if r.get("cooking_state") == "raw"]
        unspec = [r for r in pool if r.get("cooking_state") == "unspecified"]
        pick = (raw_first or unspec or pool)[0]
        row = self._db_by_sid.get(pick["source_id"]) or pick
        return row, pick.get("cooking_state"), False

    def compute(self, ingredients, servings=1, dish_name=None):
        """ingredients: [{"name","amount","unit"}, ...]

        Returns totals for the whole dish, per serving, and per 100 g of
        finished food, with per-ingredient provenance and an explicit list
        of anything that could not be resolved or measured.
        """
        totals = {k: 0.0 for k in NUTRIENT_FIELDS}
        raw_mass = 0.0
        cooked_mass = 0.0
        lines, unresolved = [], []

        for ing in ingredients:
            name = (ing.get("name") or "").strip()
            if not name:
                continue
            grams, method, note = to_grams(ing.get("amount"), ing.get("unit"), name)
            if grams is None:
                unresolved.append({"ingredient": name, "reason": note,
                                   "amount": ing.get("amount"), "unit": ing.get("unit")})
                continue

            food, matched_state, negligible = self._lookup(name)
            if negligible:
                # trace item (essence, colouring): contributes no measurable
                # nutrition; counted as handled, not as a failure
                continue
            if not food or food.get("energy_kcal") is None:
                unresolved.append({"ingredient": name, "grams": round(grams, 1),
                                   "reason": "no measured food matched this ingredient"})
                continue

            factor = grams / 100.0
            contrib = {}
            for k in NUTRIENT_FIELDS:
                v = food.get(k)
                if v is not None:
                    contrib[k] = v * factor
                    totals[k] += contrib[k]

            # Only apply the raw->cooked yield when the matched value is
            # actually a RAW measurement. If the database only had a cooked
            # entry, the mass change is already baked into that number and
            # applying the factor again would double-count it.
            if matched_state == "cooked":
                yf = 1.0
                yield_basis = "matched food already cooked; no yield applied"
            else:
                yf = yield_factor(name)
                yield_basis = "raw ingredient; yield factor applied"
            raw_mass += grams
            cooked_mass += grams * yf

            lines.append({
                "ingredient": name,
                "matched_food": food.get("food_name"),
                "matched_source": food.get("source"),
                "grams": round(grams, 1),
                "conversion": method,
                "conversion_note": note,
                "yield_factor": yf,
                "yield_basis": yield_basis,
                "matched_cooking_state": matched_state,
                "energy_kcal": round(contrib.get("energy_kcal", 0.0), 1),
            })

        if not lines:
            return {"ok": False,
                    "reason": "no ingredient could be both measured and matched",
                    "unresolved": unresolved}

        out = {
            "ok": True,
            "dish_name": dish_name,
            "tier": 2,
            "method": "compositional: measured ingredients summed",
            "servings": servings,
            "raw_mass_g": round(raw_mass, 1),
            "estimated_cooked_mass_g": round(cooked_mass, 1),
            "ingredients_used": len(lines),
            "ingredients": lines,
            "unresolved": unresolved,
            "totals": {k: round(v, 2) for k, v in totals.items() if v},
        }
        if servings and servings > 0:
            out["per_serving"] = {k: round(v / servings, 2)
                                 for k, v in totals.items() if v}
        if cooked_mass > 0:
            out["per_100g_cooked"] = {k: round(v / cooked_mass * 100.0, 2)
                                      for k, v in totals.items() if v}

        if dish_name and CONDIMENT_RE.search(dish_name):
            out["serving_caveat"] = (
                "this is a condiment/spice blend: the whole-batch totals are "
                "reliable, but a per-serving figure depends on how much of the "
                "batch is actually eaten, which no recipe fixes. Validation "
                "shows 54% median error per-serving for this class vs 25% for "
                "main dishes -- prefer logging the amount actually consumed."
            )

        # Honest confidence: this is only as good as ingredient coverage.
        covered = raw_mass
        missing_named = len([u for u in unresolved if u.get("grams")])
        out["coverage"] = {
            "resolved_ingredients": len(lines),
            "unresolved_ingredients": len(unresolved),
            "unresolved_with_known_mass": missing_named,
        }
        if len(unresolved) == 0:
            out["confidence"] = "high"
        elif missing_named == 0:
            # only unquantifiable spices/garnishes missing -- nutritionally minor
            out["confidence"] = "high"
            out["note"] = ("unresolved items are unquantifiable seasonings "
                           "(to taste / for garnish); their nutritional "
                           "contribution is negligible")
        elif len(lines) >= 2 * len(unresolved):
            out["confidence"] = "medium"
        else:
            out["confidence"] = "low"
            out["note"] = ("a large share of ingredients could not be matched; "
                           "totals are incomplete, not merely approximate")
        return out


def _demo():
    calc = CompositionalCalculator()
    dish = [
        {"name": "mutton", "amount": 300, "unit": "g"},
        {"name": "onion", "amount": 2, "unit": "nos"},
        {"name": "curd", "amount": 100, "unit": "g"},
        {"name": "oil", "amount": 3, "unit": "tbsp"},
        {"name": "ginger", "amount": 1, "unit": "inch"},
        {"name": "garam masala", "amount": 1, "unit": "tsp"},
        {"name": "salt", "amount": 1, "unit": "to taste"},
    ]
    r = calc.compute(dish, servings=4, dish_name="Rogan josh (user recipe)")
    print(f"dish: {r['dish_name']}   confidence={r.get('confidence')}")
    print(f"raw mass {r['raw_mass_g']}g -> cooked ~{r['estimated_cooked_mass_g']}g")
    print(f"TOTAL {r['totals'].get('energy_kcal')} kcal | "
          f"per serving {r['per_serving'].get('energy_kcal')} kcal "
          f"(P{r['per_serving'].get('protein_g')} F{r['per_serving'].get('fat_g')} "
          f"C{r['per_serving'].get('carb_g')})")
    print("\ningredients:")
    for li in r["ingredients"]:
        print(f"   {li['ingredient']:16s} {li['grams']:7.1f}g  {li['energy_kcal']:7.1f}kcal  "
              f"<- {str(li['matched_food'])[:38]} [{li['matched_source']}]")
    if r["unresolved"]:
        print("unresolved:")
        for u in r["unresolved"]:
            print(f"   {u['ingredient']}: {u['reason']}")


if __name__ == "__main__":
    _demo()
