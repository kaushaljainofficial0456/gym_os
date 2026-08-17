"""
Cooking-state resolution — the largest measured error source in this
pipeline.

THE PROBLEM, QUANTIFIED FROM MEASURED DATA (cooked_raw_pairs.json):

    Rice, white     raw 358  ->  cooked 130 kcal/100g   (2.75x)
    Chickpeas       raw 378  ->  cooked 164             (2.30x)
    Oat bran        raw 246  ->  cooked  40             (6.15x)
    Beef, chuck     raw 145  ->  cooked 181             (1.25x, other way)
    Green beans     raw  40  ->  cooked 223             (5.58x, oil absorbed)

A user logging "150 g rice" means COOKED rice (~195 kcal). Resolving that
to the raw entry gives 537 kcal -- a 342 kcal error on a single item,
larger than every other error source measured in this project combined.

THE RULE, AND WHY:
Users log what they PUT IN THEIR MOUTH. Nobody eats raw rice, raw dal or
raw chicken. So for any food normally eaten cooked, the cooked form is
the correct default and the raw form must be opt-in. For foods normally
eaten raw (fruit, salad vegetables, nuts, curd) the reverse holds.

This is a genuine product decision, not a measurement, so it is stated
explicitly here rather than buried in a scoring heuristic -- and the
alternative form is always returned alongside, so the UI can offer a
one-tap correction instead of silently committing to a guess.

WHAT THIS FILE DOES NOT DO:
It does not convert between states with a factor. Where both states were
measured, both measured values are used. Where only one exists, the state
is reported as-is with `alternative: None` -- no synthetic conversion,
because a generic yield factor applied to an arbitrary dish is exactly
the kind of invented number this project avoids.
"""
import json
import re
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
PAIRS_PATH = PROC / "cooked_raw_pairs.json"

# Foods essentially always eaten cooked. Matching is on the food's own
# name tokens, so "rice" catches "Rice, white, long-grain" without
# catching "Rice cakes" (different head noun handled by the caller).
NORMALLY_COOKED = {
    # grains & staples -- the highest-impact group (2-6x errors)
    "rice", "wheat", "atta", "bulgur", "quinoa", "millet", "bajra", "jowar",
    "ragi", "barley", "oats", "oatmeal", "pasta", "noodles", "macaroni",
    "spaghetti", "vermicelli", "semolina", "suji", "rava", "poha",
    # pulses -- also 2-3x
    "dal", "daal", "lentil", "lentils", "chickpeas", "chickpea", "rajma",
    "kidney", "beans", "bean", "gram", "peas", "moong", "urad", "toor",
    "arhar", "masoor", "chana", "soybean", "soyabean",
    # animal proteins
    "chicken", "mutton", "lamb", "goat", "beef", "pork", "fish", "prawn",
    "shrimp", "crab", "squid", "liver", "kidney", "mince", "keema",
    # starchy vegetables
    "potato", "aloo", "yam", "tapioca", "arbi", "colocasia",
}

# Foods normally eaten raw -- defaulting these to a cooked entry would be
# just as wrong in the other direction.
NORMALLY_RAW = {
    "apple", "banana", "orange", "mango", "grape", "grapes", "papaya",
    "guava", "watermelon", "melon", "pear", "peach", "plum", "cherry",
    "strawberry", "pomegranate", "pineapple", "kiwi", "litchi", "lychee",
    "sapota", "chikoo", "jamun", "berries", "dates", "raisin", "fig",
    "cucumber", "tomato", "lettuce", "salad", "sprouts", "carrot",
    "radish", "onion", "beetroot",
    "almond", "cashew", "walnut", "pistachio", "peanut", "nuts", "seeds",
    "curd", "dahi", "yoghurt", "yogurt", "milk", "paneer", "cheese",
    "honey", "jaggery", "sugar", "oil", "ghee", "butter",
}


# ------------------------------------------------------------------
# MOISTURE STATE -- a second axis, independent of cooking, and measured
# as an even larger error source than raw/cooked.
#
# Found by the end-to-end benchmark (validation/end_to_end_benchmark.py),
# not by inspection:
#     "papaya"  -> "Papaya, dried"      302 kcal vs 24 truth   (+1164%)
#     "peach"   -> "Peach, dried"       239 vs 40               (+495%)
#     "fig"     -> "Fig, dried"         277 vs 82               (+240%)
#     "tapioca" -> "Tapioca, pearl,dry" 358 vs 80               (+349%)
#
# Drying removes ~80-90% of a fruit's mass as water while keeping all its
# energy, so per-100g density rises 5-12x. Nobody typing "papaya" means
# dried papaya. Same principle as cooking state: default to the form the
# food is normally eaten in, keep the other reachable.
# ------------------------------------------------------------------
DRIED_RE = re.compile(
    r"\b(dried|dry|dehydrated|desiccated|sun.dried|freeze.dried|powder|"
    r"powdered|flakes|raisin|raisins|sultana|prune|prunes)\b", re.I)

# Foods whose NORMAL form is dried -- for these, "dried" is not a warning.
# Pulses, grains, spices and nuts are bought and stored dry.
NORMALLY_DRY = {
    "dal", "daal", "dhal", "lentil", "lentils", "gram", "chana", "rajma",
    "bean", "beans", "pea", "peas", "chickpea", "chickpeas", "soybean",
    "rice", "wheat", "atta", "flour", "maida", "suji", "semolina", "rava",
    "millet", "bajra", "jowar", "ragi", "barley", "oats", "quinoa", "corn",
    "spice", "spices", "masala", "powder", "chilli", "chili", "turmeric",
    "coriander", "cumin", "jeera", "pepper", "clove", "cardamom", "cinnamon",
    "almond", "cashew", "walnut", "pistachio", "raisin", "date", "dates",
    "nut", "nuts", "seed", "seeds", "tea", "coffee", "sugar", "salt",
    "pasta", "noodle", "noodles", "vermicelli", "sago", "sabudana",
    "papad", "poha", "murmura", "tapioca",
}


def _tokens(name):
    return set(re.sub(r"[^a-z0-9\s]", " ", (name or "").lower()).split())


def moisture_mismatch(food_name):
    """True when a food is presented DRIED but is normally eaten fresh --
    a 5-12x energy-density error if served as the default."""
    name = food_name or ""
    if not DRIED_RE.search(name):
        return False
    return not (_tokens(name) & NORMALLY_DRY)


def expected_state(food_name):
    """The state this food is normally EATEN in -- which is what a user
    logging it almost certainly means."""
    toks = _tokens(food_name)
    if toks & NORMALLY_COOKED:
        return "cooked"
    if toks & NORMALLY_RAW:
        return "raw"
    return None      # no strong prior; do not force one


class CookingStateResolver:
    def __init__(self, pairs_path=PAIRS_PATH):
        self.by_source_id = {}
        pairs = json.loads(Path(pairs_path).read_text(encoding="utf-8")) \
            if Path(pairs_path).exists() else []
        for p in pairs:
            self.by_source_id[p["raw_source_id"]] = p
            self.by_source_id[p["cooked_source_id"]] = p
        self.pairs = pairs

    def resolve(self, food):
        """Given a matched food row, report its state, the measured
        alternative if one exists, and whether the default looks wrong for
        how this food is actually eaten.

        Returns a dict the caller can surface directly; it never mutates
        or invents nutrition values."""
        state = food.get("cooking_state")
        name = food.get("food_name")
        expect = expected_state(name)
        pair = self.by_source_id.get(food.get("source_id"))

        alt = None
        if pair:
            if state == "raw":
                alt = {
                    "cooking_state": "cooked",
                    "food_name": pair["cooked_name"],
                    "energy_kcal": pair["cooked_kcal"],
                    "source_id": pair["cooked_source_id"],
                }
            elif state == "cooked":
                alt = {
                    "cooking_state": "raw",
                    "food_name": pair["raw_name"],
                    "energy_kcal": pair["raw_kcal"],
                    "source_id": pair["raw_source_id"],
                }

        mismatch = bool(expect and state in ("raw", "cooked") and state != expect)
        out = {
            "cooking_state": state,
            "expected_state_when_eaten": expect,
            "state_mismatch": mismatch,
            "alternative": alt,
        }

        if mismatch and alt:
            ratio = None
            if food.get("energy_kcal"):
                ratio = round(alt["energy_kcal"] / food["energy_kcal"], 2)
            out["warning"] = (
                f"matched the {state} form, but this food is normally eaten "
                f"{expect}. The {expect} form is {alt['energy_kcal']:.0f} kcal/100g "
                f"vs {food['energy_kcal']:.0f}"
                + (f" ({ratio}x difference)" if ratio else "")
            )
            out["recommended"] = alt
        elif mismatch:
            out["warning"] = (
                f"matched the {state} form, but this food is normally eaten "
                f"{expect}; no measured {expect} entry exists for it, so the "
                f"value shown is for {state} and may be materially off"
            )
        return out


def _demo():
    db = json.loads((PROC / "unified_food_db.json").read_text(encoding="utf-8"))
    r = CookingStateResolver()
    probes = ["Rice, white, short-grain, raw, unenriched", "Oat bran, raw",
              "Chickpeas (garbanzo beans, bengal gram), mature seeds, raw",
              "Banana, raw", "Beef, chuck, shoulder clod, shoulder tender, raw"]
    by_name = {f["food_name"]: f for f in db}
    print(f"{'food':52s} {'state':>8s} {'eaten':>7s}  verdict")
    for p in probes:
        f = by_name.get(p)
        if not f:
            continue
        res = r.resolve(f)
        verdict = res.get("warning", "ok")
        print(f"{p[:52]:52s} {str(res['cooking_state']):>8s} "
              f"{str(res['expected_state_when_eaten']):>7s}  {verdict[:78]}")

    total = len(db)
    mism = 0
    for f in db:
        if r.resolve(f)["state_mismatch"]:
            mism += 1
    print(f"\nrows whose matched state differs from how they are eaten: {mism}/{total}")


if __name__ == "__main__":
    _demo()
