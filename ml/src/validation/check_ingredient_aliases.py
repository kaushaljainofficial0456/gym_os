"""
Self-check for the ingredient alias map.

An alias that points at a query which resolves to something absurd is
WORSE than no alias, because it silently substitutes the wrong food into
every recipe that uses that ingredient. Real examples caught this way:
"mutton" -> "Meat drippings (mutton tallow)" 890 kcal, and "cinnamon" ->
"QUAKER Instant Oatmeal, Cinnamon" 369 kcal.

So every mapping is resolved and screened against a plausible energy band
for its food class. Anything outside the band is reported for a human
decision rather than shipped.
"""
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))

from inference.compositional import CompositionalCalculator          # noqa: E402
from inference.ingredient_aliases import INGREDIENT_ALIASES          # noqa: E402

# plausible kcal/100g band by ingredient class -- deliberately wide
# ORDER MATTERS: the first matching pattern wins, so specific terms must
# precede general ones. An earlier version listed "butter" before the dairy
# band and flagged buttermilk (43 kcal, correct) as out of a 600-920 band.
BANDS = [
    (r"buttermilk|butter ?milk", 20, 120),
    (r"unsalted butter|salted butter", 500, 920),
    (r"coconut milk", 100, 300),
    (r"peanut butter|nut butter", 500, 700),
    (r"oil|ghee|tallow|dripping", 400, 920),
    (r"butter|margarine|vanaspati", 500, 920),
    (r"condensed milk|evaporated milk|milk powder", 100, 400),
    (r"egg white", 20, 120),
    (r"green chilli|green chillies|chillies, green", 20, 120),
    (r"mustard seeds|nutmeg|poppy|sesame", 300, 700),
    (r"baking|yeast", 0, 150),
    (r"prawn|shrimp", 40, 200),
    (r"sugar|jaggery|honey|castor|icing|powdered sugar", 280, 420),
    (r"flour|maida|atta|besan|semolina|suji|rava|starch|cornflour", 300, 400),
    (r"dal|gram|lentil|rajma|chana|chickpea|moong|urad|toor|masoor", 280, 400),
    (r"rice|poha|sago|sabudana|vermicelli", 80, 400),
    (r"milk|curd|dahi|yogh?urt|buttermilk", 30, 120),
    (r"paneer|cheese|khoa|mawa|cream", 150, 450),
    (r"chicken|mutton|goat|lamb|beef|pork|fish|prawn|keema|minced", 80, 300),
    (r"egg", 100, 400),
    (r"onion|tomato|potato|carrot|peas|capsicum|cauliflower|cabbage|"
     r"brinjal|okra|bhindi|cucumber|beetroot|mushroom|spinach|palak|"
     r"coriander leaves|curry leaves|mint|leaves", 10, 130),
    (r"pepper|chilli|chili|turmeric|cumin|coriander seeds|garam masala|"
     r"clove|cinnamon|cardamom|bay leaf|mustard|fenugreek|asafoetida|"
     r"ajwain|fennel|nutmeg|mace|saffron|amchur|chaat", 150, 450),
    (r"cashew|almond|walnut|peanut|groundnut|sesame|poppy|coconut", 300, 750),
    (r"salt|water|baking|yeast|vinegar", 0, 60),
    (r"tamarind|imli", 100, 350),
    (r"raisin|kishmish", 250, 400),
]


def band_for(term):
    for pat, lo, hi in BANDS:
        if re.search(pat, term, re.I):
            return lo, hi
    return None


def main():
    calc = CompositionalCalculator()
    bad, unresolved, ok = [], [], 0
    for term in sorted(INGREDIENT_ALIASES):
        row, state, neg = calc._lookup(term)
        if neg:
            continue
        if not row or row.get("energy_kcal") is None:
            unresolved.append(term)
            continue
        kcal = row["energy_kcal"]
        b = band_for(term)
        if b and not (b[0] <= kcal <= b[1]):
            bad.append((term, row["food_name"], kcal, b))
        else:
            ok += 1

    print(f"alias terms checked : {len(INGREDIENT_ALIASES)}")
    print(f"  resolved plausibly: {ok}")
    print(f"  resolved OUT OF BAND: {len(bad)}")
    print(f"  did not resolve   : {len(unresolved)}")
    if bad:
        print("\nOUT OF BAND (fix or remove these):")
        for t, n, k, b in bad:
            print(f"   {t:22s} -> {n[:44]:44s} {k:7.1f}  expected {b[0]}-{b[1]}")
    if unresolved:
        print(f"\nUNRESOLVED: {unresolved}")


if __name__ == "__main__":
    main()
