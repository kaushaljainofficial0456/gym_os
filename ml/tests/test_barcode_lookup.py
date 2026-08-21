"""
Test suite for barcode-scan lookup (skos-food-v1).

WHY THESE CASES SPECIFICALLY:
Barcode lookup is exact-key retrieval, so the failure modes are narrow and
concrete rather than "did it rank the right thing" -- which is exactly why
each test below pins one of them: the UPC-A/EAN-13 leading-zero collision
(a real scanner will hand back either form for the SAME product), the
unknown-serving-size fallback never being presented as measured, and null
macros staying null through scaling rather than becoming a fabricated 0.

Fixtures are synthetic and injected directly -- this suite does not depend
on off_barcode_index.json existing on disk, so it runs the same whether or
not the (large, gitignored-raw-sourced) build has been run locally. A
separate lightweight self-consistency check runs against the real index
file only when present.
"""
import json
import sys
import unittest
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / "src"))

from inference.barcode_lookup import (              # noqa: E402
    BarcodeIndex, clean_code, canonical_ean13, resolve_serving,
    auto_log_from_barcode, DEFAULT_SERVING_G,
)

PROC = ML_ROOT / "data" / "processed"

# A 12-digit UPC-A product with a known serving size, and its 13-digit
# EAN-13 canonical form stored alongside it -- mirrors exactly what
# build_barcode_index.py writes for every product.
PROTEIN_BAR = {
    "source": "OPEN_FOOD_FACTS",
    "barcode": "890123456789",
    "source_id": "off:890123456789",
    "food_name": "Test Protein Bar",
    "brand": "TestBrand",
    "serving_size_label": "1 bar (40 g)",
    "serving_grams": 40.0,
    "serving_grams_source": "off_serving_quantity",
    "energy_kcal": 450.0,
    "protein_g": 30.0,
    "fat_g": 15.0,
    "carb_g": 40.0,
    "fiber_g": None,       # genuinely unmeasured -- must stay null, not 0
    "sugar_g": 10.0,
    "sodium_mg": 200.0,
    "calcium_mg": None,
    "iron_mg": None,
}

# A product with NO serving size published at all.
LOOSE_SNACK = {
    "source": "OPEN_FOOD_FACTS",
    "barcode": "8901234567895",
    "source_id": "off:8901234567895",
    "food_name": "Test Loose Snack",
    "brand": None,
    "serving_size_label": None,
    "serving_grams": None,
    "serving_grams_source": None,
    "energy_kcal": 500.0,
    "protein_g": 8.0,
    "fat_g": 25.0,
    "carb_g": 55.0,
    "fiber_g": 3.0,
    "sugar_g": 20.0,
    "sodium_mg": 300.0,
    "calcium_mg": 50.0,
    "iron_mg": 2.0,
}


def fixture_index():
    data = {}
    for rec in (PROTEIN_BAR, LOOSE_SNACK):
        raw = rec["barcode"]
        canon = canonical_ean13(raw)
        data[raw] = rec
        data[canon] = rec
    return BarcodeIndex(data=data)


class TestCleanCode(unittest.TestCase):
    def test_strips_whitespace(self):
        self.assertEqual(clean_code("  890123456789  "), "890123456789")

    def test_strips_off_prefix(self):
        # A caller passing a source_id instead of a raw scan should still
        # resolve -- this is what the DB's own source_id values look like.
        self.assertEqual(clean_code("off:890123456789"), "890123456789")

    def test_strips_non_digits(self):
        self.assertEqual(clean_code("8901-2345-6789"), "890123456789")

    def test_none_and_empty(self):
        self.assertEqual(clean_code(None), "")
        self.assertEqual(clean_code(""), "")


class TestCanonicalEan13(unittest.TestCase):
    def test_pads_12_digit_upc_a(self):
        # This is the case that matters most: a real scanner reading a
        # UPC-A barcode returns 12 digits for a product OFF stores keyed
        # by its 13-digit EAN-13 form (leading zero).
        self.assertEqual(canonical_ean13("890123456789"), "0890123456789")

    def test_leaves_13_digit_alone(self):
        self.assertEqual(canonical_ean13("8901234567895"), "8901234567895")

    def test_leaves_14_digit_gtin_alone(self):
        # GTIN-14 is a wider numbering space, not a padding of EAN-13 --
        # must not be truncated or reinterpreted.
        code14 = "12345678901234"
        self.assertEqual(canonical_ean13(code14), code14)

    def test_pads_short_ean8(self):
        self.assertEqual(canonical_ean13("12345678"), "0000012345678")


class TestBarcodeIndexLookup(unittest.TestCase):
    def setUp(self):
        self.idx = fixture_index()

    def test_exact_raw_code_hit(self):
        r = self.idx.lookup("890123456789")
        self.assertIsNotNone(r)
        self.assertEqual(r["food_name"], "Test Protein Bar")

    def test_leading_zero_collision_both_directions(self):
        # A scanner that hands back the 13-digit padded form for a product
        # stored under its raw 12-digit code must still resolve, and
        # vice versa -- this is exactly the UPC-A/EAN-13 ambiguity real
        # hardware exhibits.
        raw_hit = self.idx.lookup("890123456789")
        padded_hit = self.idx.lookup("0890123456789")
        self.assertIsNotNone(raw_hit)
        self.assertIsNotNone(padded_hit)
        self.assertEqual(raw_hit["barcode"], padded_hit["barcode"])

    def test_miss_returns_none(self):
        self.assertIsNone(self.idx.lookup("000000000000"))

    def test_lookup_tolerates_whitespace_and_prefix(self):
        self.assertIsNotNone(self.idx.lookup("  890123456789 "))
        self.assertIsNotNone(self.idx.lookup("off:890123456789"))

    def test_empty_code_is_a_clean_miss_not_an_error(self):
        self.assertIsNone(self.idx.lookup(""))
        self.assertIsNone(self.idx.lookup(None))


class TestResolveServing(unittest.TestCase):
    def test_known_serving_scales_correctly(self):
        r = resolve_serving(PROTEIN_BAR, servings=1.0)
        self.assertTrue(r["serving_grams_known"])
        self.assertEqual(r["grams"], 40.0)
        # 450 kcal/100g * 40g/100 = 180 kcal for one bar
        self.assertAlmostEqual(r["totals"]["energy_kcal"], 180.0, places=1)
        self.assertAlmostEqual(r["totals"]["protein_g"], 12.0, places=1)

    def test_multiple_servings_multiplies(self):
        r = resolve_serving(PROTEIN_BAR, servings=2.5)
        self.assertEqual(r["grams"], 100.0)   # 40g x 2.5
        self.assertAlmostEqual(r["totals"]["energy_kcal"], 450.0, places=1)

    def test_unknown_serving_falls_back_to_100g_and_flags_it(self):
        r = resolve_serving(LOOSE_SNACK, servings=1.0)
        self.assertFalse(r["serving_grams_known"])
        self.assertEqual(r["grams"], DEFAULT_SERVING_G)

    def test_null_macro_stays_null_through_scaling(self):
        # fiber_g is None on PROTEIN_BAR -- scaling must never turn an
        # unmeasured nutrient into a fabricated 0.
        r = resolve_serving(PROTEIN_BAR, servings=3)
        self.assertIsNone(r["totals"]["fiber_g"])

    def test_none_record_returns_none(self):
        self.assertIsNone(resolve_serving(None))


class TestAutoLogFromBarcode(unittest.TestCase):
    def setUp(self):
        self.idx = fixture_index()

    def test_hit_shape_and_confidence_always_high(self):
        result = auto_log_from_barcode("890123456789", servings=1.0, index=self.idx)
        self.assertIsNotNone(result)
        self.assertEqual(result["schema_version"], "food-v1")
        self.assertEqual(result["tier"], "barcode")
        self.assertEqual(result["match_kind"], "barcode_exact")
        # Identity match is exact by construction -- confidence is not the
        # calibrated text-search field and must always read "high" here,
        # even when the SERVING size itself is unknown (that is a
        # separate flag, checked below).
        self.assertEqual(result["confidence"], "high")

    def test_known_serving_produces_no_notes(self):
        result = auto_log_from_barcode("890123456789", servings=1.0, index=self.idx)
        self.assertEqual(result["notes"], [])
        self.assertTrue(result["quantity"]["serving_grams_known"])

    def test_unknown_serving_produces_a_note_and_still_logs(self):
        result = auto_log_from_barcode("8901234567895", servings=1.0, index=self.idx)
        self.assertIsNotNone(result)
        self.assertFalse(result["quantity"]["serving_grams_known"])
        self.assertEqual(result["quantity"]["grams"], DEFAULT_SERVING_G)
        self.assertTrue(len(result["notes"]) >= 1)

    def test_miss_returns_none_not_a_guess(self):
        result = auto_log_from_barcode("000000000000", servings=1.0, index=self.idx)
        self.assertIsNone(result)

    def test_totals_scale_with_servings_count(self):
        one = auto_log_from_barcode("890123456789", servings=1.0, index=self.idx)
        two = auto_log_from_barcode("890123456789", servings=2.0, index=self.idx)
        self.assertAlmostEqual(
            two["totals"]["energy_kcal"], one["totals"]["energy_kcal"] * 2, places=1)


class TestRealIndexSelfConsistency(unittest.TestCase):
    """Runs only when off_barcode_index.json has actually been built --
    a lightweight sanity pass over the real artifact, not a replacement
    for the fixture-based tests above."""

    @classmethod
    def setUpClass(cls):
        cls.path = PROC / "off_barcode_index.json"
        if not cls.path.exists():
            raise unittest.SkipTest("off_barcode_index.json not built locally")
        cls.data = json.loads(cls.path.read_text(encoding="utf-8"))

    def test_every_key_resolves_to_a_record_naming_a_consistent_barcode(self):
        # Each key must be either the record's own raw barcode or its
        # canonical EAN-13 padding -- never point at an unrelated product.
        sample = list(self.data.items())[:2000]
        for key, rec in sample:
            self.assertIn(key, (rec["barcode"], canonical_ean13(rec["barcode"])))

    def test_every_record_has_usable_energy(self):
        sample = list(self.data.values())[:2000]
        for rec in sample:
            self.assertIsNotNone(rec.get("energy_kcal"))
            self.assertTrue(0 < rec["energy_kcal"] <= 900)

    def test_index_is_nonempty(self):
        self.assertGreater(len(self.data), 0)


if __name__ == "__main__":
    unittest.main()
