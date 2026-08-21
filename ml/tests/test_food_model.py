"""
Test suite for skos-food-v1.

WHY THIS EXISTS AND WHAT IT PRIORITISES:
Every significant defect found in this model so far surfaced because a
specific real food happened to look wrong -- paneer at 66 kcal, a kebab at
1,197 kcal, "papaya" resolving to dried papaya, a regex that silently
matched nothing because its word-boundary escapes had become backspace
bytes. None of those were caught by reading the code.

So these tests are deliberately NOT generic smoke tests. Each one pins a
behaviour that was measured, or locks a bug that already shipped once and
must not return. Where a test asserts a number, the number comes from the
benchmark or from a published reference, never from whatever the code
happened to output.
"""
import json
import re
import sys
import unittest
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / "src"))

from inference.food_search import FoodSearch, normalize                      # noqa: E402
from inference.cooking_state import expected_state, moisture_mismatch        # noqa: E402
from inference.portion_units import to_grams, density_for                    # noqa: E402
from inference.portion_catalog import (portion_to_grams, canonical,          # noqa: E402
                                       effective_density, VOLUME_PORTIONS,
                                       COUNT_PORTIONS)
from inference.oil_adjustment import (OilAdjuster, OIL_LEVELS,               # noqa: E402
                                      KCAL_PER_G_OIL, fatty_acid_split,
                                      OIL_FATTY_ACID_PROFILE)
from inference.compositional import (CompositionalCalculator,                # noqa: E402
                                     RENDERED_FAT_RE, CONDIMENT_RE,
                                     FAT_INGREDIENT_RE, yield_factor)
from inference.ingredient_aliases import resolve_ingredient                  # noqa: E402

PROC = ML_ROOT / "data" / "processed"

_SEARCH = None
_CALC = None


def search():
    global _SEARCH
    if _SEARCH is None:
        _SEARCH = FoodSearch()
    return _SEARCH


def calc():
    global _CALC
    if _CALC is None:
        _CALC = CompositionalCalculator(search=search())
    return _CALC


def first(query, **kw):
    r = search().search(query, limit=1, **kw)
    return r[0] if r else None


class TestDatabaseIntegrity(unittest.TestCase):
    """The database is the product; these guard its shape."""

    @classmethod
    def setUpClass(cls):
        cls.db = json.loads((PROC / "unified_food_db.json").read_text(encoding="utf-8"))

    def test_database_is_populated(self):
        self.assertGreater(len(self.db), 20000)

    def test_every_food_has_stable_identity(self):
        """source_id is what callers persist; a missing or duplicate one
        silently corrupts a user's saved log."""
        ids = [f.get("source_id") for f in self.db]
        self.assertTrue(all(ids), "every row needs a source_id")
        self.assertEqual(len(ids), len(set(ids)), "source_id must be unique")

    def test_energy_is_physically_possible(self):
        """Pure fat is ~900 kcal/100g; nothing edible exceeds it."""
        bad = [f for f in self.db
               if f.get("energy_kcal") is not None and not (0 <= f["energy_kcal"] <= 902)]
        self.assertEqual(bad, [], f"impossible energy: {[b['food_name'] for b in bad[:3]]}")

    def test_macros_never_negative(self):
        for field in ("protein_g", "fat_g", "carb_g", "fiber_g"):
            bad = [f for f in self.db if (f.get(field) or 0) < 0]
            self.assertEqual(bad, [], f"negative {field}")

    def test_missing_nutrients_are_null_not_zero(self):
        """A null means 'not measured'. Coercing it to 0 would let a food
        with unknown protein read as a zero-protein food."""
        sample = [f for f in self.db if f.get("source") == "IFCT2017"]
        self.assertTrue(any(f.get("sugar_g") is None for f in sample),
                        "unmeasured nutrients must stay null")

    def test_known_bad_rows_are_flagged_not_deleted(self):
        """201 INDB rows count the deep-frying oil bath as eaten. They are
        kept but flagged, so provenance survives and nothing silently
        'corrects' a value we cannot replace."""
        flagged = [f for f in self.db if f.get("data_quality_flag")]
        self.assertGreater(len(flagged), 100)


class TestSearchRanking(unittest.TestCase):
    """Retrieval accuracy IS model accuracy: a right number for the wrong
    food is indistinguishable from a wrong number."""

    def test_generic_query_returns_generic_food(self):
        """Regression: 'chicken' once returned APPLEBEE'S chicken tenders,
        'rice' returned sake, 'apple' returned APPLE CIDER VINEGAR 0 kcal."""
        for q, banned in (("chicken", "applebee"), ("rice", "alcoholic"),
                          ("apple", "vinegar")):
            r = first(q)
            self.assertIsNotNone(r, f"{q} must resolve")
            self.assertNotIn(banned, r["food_name"].lower(),
                             f"{q} resolved to {r['food_name']}")

    def test_staples_default_to_the_state_they_are_eaten_in(self):
        """Largest measured error source: rice is 358 kcal/100g raw and 129
        cooked. Users log what they eat, so cooked must win."""
        r = first("rice")
        self.assertEqual(r["cooking_state"], "cooked")
        self.assertLess(r["energy_kcal"], 200, "raw rice leaked through")

    def test_fresh_fruit_is_not_returned_dried(self):
        """Regression: 'papaya' returned dried papaya, 302 vs 24 kcal
        (+1164%). Drying strips ~85% of water but keeps the energy."""
        for q, ceiling in (("papaya", 60), ("peach", 90), ("fig", 150)):
            r = first(q)
            self.assertIsNotNone(r)
            self.assertLess(r["energy_kcal"], ceiling,
                            f"{q} -> {r['food_name']} {r['energy_kcal']}")

    def test_offal_does_not_outrank_normal_cuts(self):
        """Regression: 'chicken' returned 'Chicken, feet, boiled'."""
        r = first("chicken")
        for organ in ("feet", "giblet", "skin", "gizzard"):
            self.assertNotIn(organ, r["food_name"].lower())

    def test_indian_dishes_resolve(self):
        dishes = ["idli", "dosa", "poha", "biryani", "samosa", "paratha",
                  "sambar", "khichdi", "pulao", "dhokla", "paneer", "rajma",
                  "chapati", "halwa", "kheer", "chole", "laddu", "bhindi"]
        missing = [d for d in dishes if first(d) is None]
        self.assertEqual(missing, [], f"unresolved Indian dishes: {missing}")

    def test_regional_names_resolve_via_alias(self):
        """The normalizer used to strip parentheses, discarding the Hindi
        name INDB stores there -- 'baingan bharta' could not reach
        'Brinjal bhartha (Baingan ka bhartha)'."""
        for q in ("baingan bharta", "aloo gobi", "gajar ka halwa", "chana masala"):
            self.assertIsNotNone(first(q), f"{q} must resolve via alias")

    def test_confidence_is_present_and_valid(self):
        r = first("paneer")
        self.assertIn(r["confidence"], {"high", "medium", "low", "unreliable"})

    def test_exact_match_is_high_confidence(self):
        r = first("paneer")
        self.assertEqual(r["confidence"], "high")

    def test_flagged_rows_are_marked_untrustworthy(self):
        """A known-bad row may still be the only match; it must never be
        presented as clean. 'Dum aloo' reads 4,576 kcal/serving."""
        r = first("dum aloo")
        if r is not None:
            self.assertFalse(r["trustworthy"])
            self.assertIn("data_quality_flag", r)

    def test_empty_query_returns_nothing(self):
        self.assertEqual(search().search(""), [])
        self.assertEqual(search().search("   "), [])

    def test_nonsense_query_does_not_invent_a_match(self):
        self.assertEqual(search().search("zzzqqxwv"), [])


class TestCookingState(unittest.TestCase):
    def test_staples_are_expected_cooked(self):
        for food in ("rice", "dal", "chicken", "potato", "rajma"):
            self.assertEqual(expected_state(food), "cooked", food)

    def test_fruit_and_dairy_are_expected_raw(self):
        for food in ("banana", "apple", "curd", "almond"):
            self.assertEqual(expected_state(food), "raw", food)

    def test_no_prior_returns_none_rather_than_guessing(self):
        self.assertIsNone(expected_state("zzz unknown substance"))

    def test_moisture_mismatch_detects_dried_fruit(self):
        self.assertTrue(moisture_mismatch("Papaya, dried"))
        self.assertFalse(moisture_mismatch("Papaya, raw"))

    def test_normally_dry_foods_are_not_flagged(self):
        """Pulses, grains and spices are SOLD dry -- flagging them would
        fire the penalty on almost every staple."""
        for name in ("Lentil dal, dried", "Cumin seeds, dry", "Rice, raw"):
            self.assertFalse(moisture_mismatch(name), name)


class TestPortionUnits(unittest.TestCase):
    """A unit error scales the whole food's contribution, so it is a larger
    error than anything the model itself can make."""

    def test_mass_units_are_exact(self):
        self.assertEqual(to_grams(250, "g", "rice")[0], 250)
        self.assertEqual(to_grams(1, "kg", "rice")[0], 1000)

    def test_volume_uses_food_specific_density(self):
        """A tablespoon is a VOLUME. One tbsp of oil is ~13.8 g, of honey
        ~21 g, of flour ~8 g. A flat 15 g/tbsp is wrong by up to 2.6x."""
        oil = to_grams(1, "tbsp", "sunflower oil")[0]
        honey = to_grams(1, "tbsp", "honey")[0]
        flour = to_grams(1, "tbsp", "wheat flour")[0]
        self.assertAlmostEqual(oil, 13.8, delta=0.5)
        self.assertGreater(honey, oil)
        self.assertLess(flour, oil)

    def test_density_lookup_is_food_aware(self):
        self.assertLess(density_for("sunflower oil")[0], 1.0)
        self.assertGreater(density_for("honey")[0], 1.0)

    def test_count_units_use_reference_weights(self):
        eggs, method, _ = to_grams(3, "nos", "egg")
        self.assertAlmostEqual(eggs, 150, delta=10)
        self.assertEqual(method, "count")

    def test_unquantifiable_returns_none_not_a_guess(self):
        """'to taste' has no measurable quantity. Inventing one silently
        corrupts the total."""
        grams, method, _ = to_grams(1, "to taste", "salt")
        self.assertIsNone(grams)
        self.assertEqual(method, "unquantifiable")

    def test_unknown_unit_returns_none(self):
        self.assertIsNone(to_grams(1, "smidgen", "flour")[0])

    def test_non_positive_amount_rejected(self):
        self.assertIsNone(to_grams(0, "g", "rice")[0])
        self.assertIsNone(to_grams(-5, "g", "rice")[0])


class TestOilAdjustment(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.oa = OilAdjuster()
        db = json.loads((PROC / "unified_food_db.json").read_text(encoding="utf-8"))
        cls.by_name = {f["food_name"]: f for f in db}
        cls.curry = cls.by_name.get("Chickpeas curry (Safed channa curry)")

    def test_levels_are_ordered_and_measured(self):
        """Anchored to percentiles of 541 real recipes, not invented."""
        self.assertLess(OIL_LEVELS["low"], OIL_LEVELS["moderate"])
        self.assertLess(OIL_LEVELS["moderate"], OIL_LEVELS["high"])
        self.assertLess(OIL_LEVELS["high"], OIL_LEVELS["very_high"])
        self.assertEqual(OIL_LEVELS["none"], 0.0)

    def test_more_oil_increases_energy_monotonically(self):
        if not self.curry:
            self.skipTest("reference dish absent")
        vals = [self.oa.adjust(self.curry, lv)["energy_kcal_adjusted"]
                for lv in ("none", "low", "moderate", "high", "very_high")]
        self.assertEqual(vals, sorted(vals), "energy must rise with oil")

    def test_less_oil_than_the_recipe_reduces_energy(self):
        """The whole point of a DELTA: selecting 'low' on a dish that
        already assumes oil must subtract, not add."""
        if not self.curry:
            self.skipTest("reference dish absent")
        r = self.oa.adjust(self.curry, "low")
        self.assertLess(r["energy_kcal_adjusted"], r["energy_kcal_original"])
        self.assertLess(r["delta_oil_g_per_100g"], 0)

    def test_mass_is_conserved(self):
        """Adding 10 g of oil adds 10 g of MASS as well as 88 kcal. Naive
        implementations add only the calories and inflate density."""
        if not self.curry:
            self.skipTest("reference dish absent")
        r = self.oa.adjust(self.curry, "very_high")
        delta = r["delta_oil_g_per_100g"]
        abs_energy = r["energy_kcal_original"] + delta * KCAL_PER_G_OIL
        expected = abs_energy / (100.0 + delta) * 100.0
        self.assertAlmostEqual(r["energy_kcal_adjusted"], expected, places=1)

    def test_unknown_level_is_rejected(self):
        if not self.curry:
            self.skipTest("reference dish absent")
        self.assertIn("error", self.oa.adjust(self.curry, "extreme"))

    def test_custom_requires_a_value(self):
        if not self.curry:
            self.skipTest("reference dish absent")
        self.assertIn("error", self.oa.adjust(self.curry, "custom"))

    def test_negative_oil_rejected(self):
        if not self.curry:
            self.skipTest("reference dish absent")
        self.assertIn("error", self.oa.adjust(self.curry, "custom",
                                              custom_oil_g_per_100g=-5))

    def test_fatty_acid_profiles_sum_to_100(self):
        """IFCT Table 12: SFA+MUFA+PUFA IS the whole composition."""
        for oil, p in OIL_FATTY_ACID_PROFILE.items():
            total = p["sfa"] + p["mufa"] + p["pufa"]
            self.assertAlmostEqual(total, 100.0, delta=0.2, msg=oil)

    def test_oil_types_differ_in_saturation(self):
        """Coconut is 90.9% saturated, mustard 5.7% -- a 16x difference at
        identical calories. That is the point of tracking oil type."""
        coco = fatty_acid_split("coconut oil", 10)
        mustard = fatty_acid_split("mustard oil", 10)
        self.assertGreater(coco["saturated_g"], 5 * mustard["saturated_g"])

    def test_unknown_oil_returns_no_profile_rather_than_a_default(self):
        self.assertIsNone(fatty_acid_split("avocado oil", 10))


class TestIngredientResolution(unittest.TestCase):
    """Tier 2 sums measured ingredients, so it is only as good as the
    lookup. Every case here mis-resolved at some point."""

    def test_curds_is_yogurt_not_cheese(self):
        """'Curds' means dahi in an Indian recipe (65 kcal) and cheese
        curds in an American one (375). Culinary, not lexical."""
        row, _, _ = calc()._lookup("curds")
        self.assertIsNotNone(row)
        self.assertLess(row["energy_kcal"], 150)

    def test_meat_does_not_resolve_to_rendered_fat(self):
        """Regression: 'Mutton boneless boti' matched 'Meat drippings
        (mutton tallow)' at 890 kcal/100g, turning a 73 kcal kebab into
        1,197 kcal."""
        for term in ("mutton", "pork", "beef", "mutton boneless boti"):
            row, _, _ = calc()._lookup(term)
            self.assertIsNotNone(row, term)
            self.assertLess(row["energy_kcal"], 400, f"{term} -> {row['food_name']}")
            self.assertGreater(row.get("protein_g") or 0, 10, term)

    def test_ingredient_never_resolves_to_a_composite_dish(self):
        """'mutton' once matched 'Mutton korma' -- 300 g of meat then
        contributed 8.6 g of protein instead of ~60, because a korma is
        mostly gravy."""
        row, _, _ = calc()._lookup("mutton")
        self.assertNotEqual(row.get("source"), "INDB")
        self.assertNotEqual(row.get("category"), "indian_dish")

    def test_generic_oil_resolves_to_a_cooking_oil(self):
        """Regression: 'oil' matched 'Oil, oat', a specialty oil."""
        row, _, _ = calc()._lookup("oil")
        self.assertGreater(row["energy_kcal"], 800)

    def test_spice_terms_are_spices_not_products(self):
        """'Pepper powder' matched 'Pepper, banana, raw' (27 kcal)."""
        row, _, _ = calc()._lookup("pepper powder")
        self.assertGreater(row["energy_kcal"], 150)

    def test_trace_items_are_negligible_not_force_matched(self):
        """'Vanilla essence' matched 'OREO Original'. Better to contribute
        nothing than something wrong."""
        row, _, negligible = calc()._lookup("vanilla essence")
        self.assertTrue(negligible)
        self.assertIsNone(row)

    def test_alias_matches_real_recipe_phrasing(self):
        """Exact-only matching meant any extra word fell through."""
        q, _ = resolve_ingredient("Mutton boneless boti")
        self.assertIsNotNone(q)
        self.assertNotEqual(q.lower(), "mutton boneless boti")


class TestRegexGuardsAreLive(unittest.TestCase):
    """A regex written through a shell heredoc once had its word-boundary
    escapes turned into literal BACKSPACE bytes. grep showed clean source,
    it compiled without error, and it silently matched nothing -- the guard
    was dead code while appearing to work. These assert the guards actually
    fire, and that no control bytes crept back in."""

    def test_patterns_contain_no_control_bytes(self):
        for rx in (RENDERED_FAT_RE, CONDIMENT_RE, FAT_INGREDIENT_RE):
            self.assertTrue(all(ord(c) >= 9 for c in rx.pattern),
                            f"control byte in {rx.pattern!r}")

    def test_rendered_fat_guard_actually_matches(self):
        self.assertTrue(RENDERED_FAT_RE.search("Animal fat, lard (pork)"))
        self.assertTrue(RENDERED_FAT_RE.search("Oscar Mayer, Bologna (beef)"))
        self.assertFalse(RENDERED_FAT_RE.search("Goat, legs"))

    def test_fat_ingredient_guard_actually_matches(self):
        self.assertTrue(FAT_INGREDIENT_RE.search("oil"))
        self.assertTrue(FAT_INGREDIENT_RE.search("ghee"))
        self.assertFalse(FAT_INGREDIENT_RE.search("pork"))

    def test_condiment_guard_actually_matches(self):
        self.assertTrue(CONDIMENT_RE.search("Tamarind chutney"))
        self.assertFalse(CONDIMENT_RE.search("Rogan josh"))


class TestCompositionalCalculator(unittest.TestCase):
    RECIPE = [
        {"name": "mutton", "amount": 500, "unit": "g"},
        {"name": "curd", "amount": 150, "unit": "g"},
        {"name": "oil", "amount": 4, "unit": "tbsp"},
        {"name": "onion", "amount": 200, "unit": "g"},
        {"name": "salt", "amount": 1, "unit": "to taste"},
    ]

    def test_computes_a_plausible_dish(self):
        r = calc().compute(self.RECIPE, servings=4, dish_name="Rogan josh")
        self.assertTrue(r["ok"])
        kcal = r["per_serving"]["energy_kcal"]
        self.assertTrue(150 < kcal < 700, f"implausible per-serving {kcal}")

    def test_unresolved_ingredients_are_reported_not_hidden(self):
        """An unresolved ingredient means those calories are MISSING from
        the total, not merely approximate. Silence would understate."""
        r = calc().compute(self.RECIPE, servings=4)
        self.assertIn("unresolved", r)
        self.assertTrue(any(u["ingredient"] == "salt" for u in r["unresolved"]))

    def test_totals_scale_with_servings(self):
        a = calc().compute(self.RECIPE, servings=2)
        b = calc().compute(self.RECIPE, servings=4)
        self.assertAlmostEqual(a["per_serving"]["energy_kcal"],
                               2 * b["per_serving"]["energy_kcal"], delta=1.0)

    def test_empty_ingredients_fails_cleanly(self):
        r = calc().compute([], servings=1)
        self.assertFalse(r["ok"])

    def test_condiments_carry_a_serving_caveat(self):
        """Measured 52.4% per-serving error for condiments vs 25.7% for
        main dishes, because a 'serving' of chutney is arbitrary."""
        r = calc().compute([{"name": "tamarind", "amount": 100, "unit": "g"},
                            {"name": "sugar", "amount": 50, "unit": "g"}],
                           servings=8, dish_name="Tamarind chutney")
        self.assertIsNotNone(r.get("serving_caveat"))

    def test_yield_factors_move_in_the_right_direction(self):
        """Grains absorb water (>1); meat loses it (<1). Getting the sign
        wrong inverts every per-100g density."""
        self.assertGreater(yield_factor("rice"), 1.5)
        self.assertGreater(yield_factor("dal"), 1.5)
        self.assertLess(yield_factor("chicken"), 1.0)
        self.assertLess(yield_factor("spinach"), 1.0)

    def test_absent_dish_gets_a_plausible_answer(self):
        """Jalebi is in no database. Tier 3 guessed 147 kcal/100g against a
        real ~350-400; tier 2 must land in the real range."""
        r = calc().compute([
            {"name": "refined wheat flour", "amount": 100, "unit": "g"},
            {"name": "sugar", "amount": 200, "unit": "g"},
            {"name": "oil", "amount": 50, "unit": "g"},
            {"name": "curd", "amount": 30, "unit": "g"},
        ], servings=8, dish_name="Jalebi")
        per100 = r["per_100g_cooked"]["energy_kcal"]
        self.assertTrue(250 < per100 < 500, f"jalebi {per100} kcal/100g")


class TestPortionCatalog(unittest.TestCase):
    """Household portions are how users actually log food. A portion is a
    VOLUME, so the same portion is a different mass for different foods --
    getting that wrong scales the whole entry."""

    def test_same_portion_differs_by_food_density(self):
        """A medium bowl of dal and of spinach are not the same mass."""
        dal = portion_to_grams("medium_bowl", 1, "Dal makhani",
                               density_for, cooking_state="cooked")[0]
        spinach = portion_to_grams("medium_bowl", 1, "Spinach", density_for)[0]
        self.assertGreater(dal, 2 * spinach,
                           f"dal {dal}g vs spinach {spinach}g — density ignored")

    def test_portions_scale_linearly_with_count(self):
        one = portion_to_grams("medium_bowl", 1, "Dal", density_for)[0]
        three = portion_to_grams("medium_bowl", 3, "Dal", density_for)[0]
        self.assertAlmostEqual(three, 3 * one, places=1)

    def test_portion_sizes_are_ordered(self):
        food = "Dal makhani"
        sizes = [portion_to_grams(k, 1, food, density_for)[0]
                 for k in ("small_bowl", "medium_bowl", "large_bowl")]
        self.assertEqual(sizes, sorted(sizes), f"bowl sizes not ordered: {sizes}")
        plates = [portion_to_grams(k, 1, food, density_for)[0]
                  for k in ("quarter_plate", "half_plate", "plate", "full_plate")]
        self.assertEqual(plates, sorted(plates), f"plate sizes not ordered: {plates}")

    def test_aliases_resolve_to_canonical_portions(self):
        for alias, expected in (("tbsp", "tablespoon"), ("big bowl", "large_bowl"),
                                ("regular plate", "plate"), ("half plate", "half_plate"),
                                ("serving spoon", "serving_spoon")):
            self.assertEqual(canonical(alias), expected, alias)

    def test_unknown_portion_is_rejected_not_guessed(self):
        grams, basis, _ = portion_to_grams("bucket", 1, "Dal", density_for)
        self.assertIsNone(grams)
        self.assertEqual(basis, "unknown_portion")

    def test_bad_count_rejected(self):
        self.assertIsNone(portion_to_grams("bowl", 0, "Dal", density_for)[0])
        self.assertIsNone(portion_to_grams("bowl", -2, "Dal", density_for)[0])

    def test_measured_serving_beats_the_generic_figure(self):
        """When the food publishes its own serving weight, that wins."""
        grams, basis, _ = portion_to_grams("bowl", 2, "Some dish", density_for,
                                           food_serving_grams=180.0)
        self.assertEqual(basis, "measured_serving")
        self.assertAlmostEqual(grams, 360.0, places=1)

    def test_count_portions_use_item_weight_not_dish_weight(self):
        """INDB's '1 egg' for boiled egg is 151 g (the dish). One egg is
        ~50 g, and fitting to 151 would corrupt every bare-egg entry."""
        grams, basis, _ = portion_to_grams("egg", 2, "Egg", density_for)
        self.assertEqual(basis, "count")
        self.assertAlmostEqual(grams, 100.0, places=1)

    def test_cooked_wet_dish_is_denser_than_its_dry_ingredient(self):
        """'Dal makhani' matches dry-dal density but is served as a curry."""
        dry = effective_density("Dal", None, density_for)
        wet = effective_density("Dal makhani", "cooked", density_for)
        self.assertGreater(wet, dry)

    def test_search_results_carry_food_specific_portions(self):
        r = first("dal makhani")
        self.assertIsNotNone(r)
        self.assertIn("portions", r)
        keys = {p["key"] for p in r["portions"]}
        for expected in ("teaspoon", "tablespoon", "medium_bowl", "plate", "glass"):
            self.assertIn(expected, keys)

    def test_observed_range_is_reported_where_known(self):
        """A 'bowl' is not a defined unit; the real spread must travel with
        it so the UI does not imply false precision."""
        r = first("dal makhani")
        bowl = next(p for p in r["portions"] if p["key"] == "bowl")
        self.assertIn("observed_range_g", bowl)
        lo, hi = bowl["observed_range_g"]
        self.assertLess(lo, hi)


class TestNormalisation(unittest.TestCase):
    def test_normalize_strips_scientific_names(self):
        self.assertNotIn("lens", normalize("Lentil (Lens culinaris)"))

    def test_normalize_is_case_and_punctuation_insensitive(self):
        self.assertEqual(normalize("Rice, White!"), normalize("rice white"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
