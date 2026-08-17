"""
Household portion catalogue — the portions users actually think in.

WHY THIS MATTERS MORE THAN IT LOOKS:
Almost nobody weighs food. If the only input is grams, users guess, and a
guessed gram figure is a worse input than a well-defined household portion.
So the app offers a weighing-scale entry AND a set of familiar portions,
and this file is what converts the latter into mass.

THE THING NAIVE IMPLEMENTATIONS GET WRONG:
A portion is a VOLUME, not a mass. One medium bowl of dal, of rice, and of
salad are three different weights, because their densities differ by ~3x.
Publishing "1 bowl = 250 g" for everything would be wrong by that factor on
most foods. So every portion here is defined in millilitres and converted
with a per-food density (see portion_units.density_for), except the
piece-type portions which are genuinely counts.

CALIBRATED, NOT INVENTED:
Volumes are anchored to the real distribution of INDB serving weights
(~900 Indian dishes that publish both a serving name and its mass):

    bowl        n=269   median 258 g   p25 166   p75 354
    plate       n= 72   median 350 g   p25 236   p75 554
    tall glass  n= 21   median 340 g
    small bowl  n= 15   median 226 g
    soup bowl   n= 18   median 366 g
    tablespoon  n= 21   median  19 g

Those are MASSES of mixed foods, so they are used to sanity-check the
volume x density result rather than as the volumes themselves -- a 250 ml
bowl of a ~1.03 g/ml curry lands at ~258 g, which is exactly the observed
median. Where the two disagreed, the volume was adjusted to match the
measurement.

HONESTY ABOUT PRECISION:
A "medium bowl" is not a defined unit; real bowls vary. The p25-p75 spread
above (166-354 g for a bowl) IS that variation, and it is reported as a
range so the UI can show it rather than implying a precision that does not
exist. This is still far better than an unguided gram guess.
"""
import re

# ---------------------------------------------------------------------
# VOLUME PORTIONS -- ml. Converted to grams with the food's own density.
# `hint` is what the UI should show; `ml` is the working figure.
# ---------------------------------------------------------------------
VOLUME_PORTIONS = {
    # spoons
    "teaspoon":        {"ml": 5,   "label": "Teaspoon",        "group": "spoon"},
    # CALIBRATED IN TWO ROUNDS: a level 15 ml tablespoon under-predicted
    # real servings by 1.8x (bias 0.56, n=21); 20 ml still ran 0.74. A
    # tablespoon of food is heaped rather than level, and the foods INDB
    # measures by the spoonful are low-density (chutneys, pastes), so the
    # effective figure is ~25 ml. Measured median is 19.4 g.
    "tablespoon":      {"ml": 25,  "label": "Tablespoon",      "group": "spoon"},
    "serving_spoon":   {"ml": 45,  "label": "Serving spoon",   "group": "spoon"},
    "ladle":           {"ml": 90,  "label": "Ladle",           "group": "spoon"},

    # bowls -- the core Indian portions
    # CALIBRATED: 150 ml under-predicted by 1.5x (bias 0.65, n=15); measured
    # median is 225 g. Indian "small" bowls are larger than the name suggests.
    "small_bowl":      {"ml": 220, "label": "Small bowl",      "group": "bowl"},
    "katori":          {"ml": 150, "label": "Katori",          "group": "bowl"},
    "medium_bowl":     {"ml": 250, "label": "Medium bowl",     "group": "bowl"},
    "bowl":            {"ml": 250, "label": "Bowl",            "group": "bowl"},
    "large_bowl":      {"ml": 400, "label": "Large bowl",      "group": "bowl"},
    "soup_bowl":       {"ml": 350, "label": "Soup bowl",       "group": "bowl"},

    # plates
    "half_plate":      {"ml": 200, "label": "Half plate",      "group": "plate"},
    "quarter_plate":   {"ml": 120, "label": "Quarter plate",   "group": "plate"},
    "plate":           {"ml": 350, "label": "Regular plate",   "group": "plate"},
    "full_plate":      {"ml": 500, "label": "Full plate",      "group": "plate"},

    # drinkware
    "small_glass":     {"ml": 150, "label": "Small glass",     "group": "glass"},
    # CALIBRATED: 250 ml gave bias 0.70 (n=15); measured median 339 g.
    "glass":           {"ml": 330, "label": "Glass",           "group": "glass"},
    "tall_glass":      {"ml": 350, "label": "Tall glass",      "group": "glass"},
    "tea_cup":         {"ml": 150, "label": "Tea cup",         "group": "glass"},
    "cup":             {"ml": 240, "label": "Cup",             "group": "glass"},
    "mug":             {"ml": 300, "label": "Mug",             "group": "glass"},

    # misc
    "handful":         {"ml": 60,  "label": "Handful",         "group": "misc"},
    "pinch":           {"ml": 0.35, "label": "Pinch",          "group": "misc"},
}

# ---------------------------------------------------------------------
# COUNT PORTIONS -- genuinely counted items, so grams come from a
# reference weight for that specific food, not from a volume.
#
# DELIBERATELY *NOT* CALIBRATED AGAINST INDB, unlike the volume portions
# above. Calibration showed apparent bias (egg 0.58, vada 0.37), but
# inspecting the rows shows a SEMANTIC mismatch, not a measurement error:
#
#     "1 egg"  for Boiled egg      = 151.0 g   <- egg + accompaniments
#     "1 vada" for Dahi vada       = 172.3 g   <- vada + dahi, i.e. the dish
#
# INDB's count units denote a whole DISH serving, while these denote one
# ITEM. One egg is ~50 g and that is correct; "fitting" it to 151 g would
# make every bare-egg entry wrong. Where the two meanings collide,
# portion_to_grams() prefers the food's OWN measured serving weight, which
# resolves it without corrupting the generic reference.
# ---------------------------------------------------------------------
COUNT_PORTIONS = {
    "piece":     {"label": "Piece",     "group": "count"},
    "slice":     {"label": "Slice",     "group": "count"},
    "roti":      {"label": "Roti / chapati", "group": "count", "grams": 40},
    "paratha":   {"label": "Paratha",   "group": "count", "grams": 85},
    "dosa":      {"label": "Dosa",      "group": "count", "grams": 85},
    "idli":      {"label": "Idli",      "group": "count", "grams": 45},
    "poori":     {"label": "Poori",     "group": "count", "grams": 119},
    "samosa":    {"label": "Samosa",    "group": "count", "grams": 68},
    "vada":      {"label": "Vada",      "group": "count", "grams": 60},
    "ladoo":     {"label": "Ladoo",     "group": "count", "grams": 36},
    "biscuit":   {"label": "Biscuit",   "group": "count", "grams": 19},
    "egg":       {"label": "Egg",       "group": "count", "grams": 50},
    "banana":    {"label": "Banana",    "group": "count", "grams": 120},
    "apple":     {"label": "Apple",     "group": "count", "grams": 180},
    "sandwich":  {"label": "Sandwich",  "group": "count", "grams": 78},
}

# Observed spread of real serving weights, used to report an honest range
# rather than a false precision. From the INDB distribution.
OBSERVED_SPREAD = {
    "bowl":       (166, 354),
    "medium_bowl": (166, 354),
    "small_bowl": (181, 343),
    "soup_bowl":  (307, 398),
    "plate":      (236, 554),
    "tall_glass": (304, 423),
    "glass":      (203, 411),
    "cup":        (191, 486),
    "tablespoon": (16, 26),
    "piece":      (50, 234),
    "slice":      (73, 184),
}

_ALIAS = {
    "tbsp": "tablespoon", "tsp": "teaspoon", "katoris": "katori",
    "bowls": "bowl", "plates": "plate", "glasses": "glass",
    "big bowl": "large_bowl", "big_bowl": "large_bowl",
    "regular plate": "plate", "regular_plate": "plate",
    "half plate": "half_plate", "serving spoon": "serving_spoon",
    "small glass": "small_glass", "tall glass": "tall_glass",
    "tea cup": "tea_cup", "medium bowl": "medium_bowl",
    "small bowl": "small_bowl", "large bowl": "large_bowl",
    "soup bowl": "soup_bowl", "quarter plate": "quarter_plate",
    "full plate": "full_plate",
}


def canonical(portion_key):
    k = re.sub(r"\s+", "_", (portion_key or "").strip().lower())
    k_spaces = k.replace("_", " ")
    if k in VOLUME_PORTIONS or k in COUNT_PORTIONS:
        return k
    if k_spaces in _ALIAS:
        return _ALIAS[k_spaces]
    if k in _ALIAS:
        return _ALIAS[k]
    return None


# A COOKED dish is not its dry ingredient. "Dal makhani" matches the
# dry-dal density (0.85 g/ml) but is served as a wet curry (~1.0), and
# "Rice, cooked" is likewise not dry rice. Using the ingredient density for
# a finished dish under-predicts portion mass, which is exactly the residual
# bias calibration showed on bowls (0.87). Wet cooked dishes are close to
# water; only genuinely dry/fried finished foods stay light.
WET_DISH_RE = re.compile(
    "curry|gravy|dal|daal|sambar|rasam|soup|stew|kadhi|korma|makhani|"
    "rajma|chole|kheer|payasam|halwa|raita|lassi|shorba|khichdi|"
    "porridge|dalia|upma|poha|pulao|biryani|rice", re.I)
DRY_FINISHED_RE = re.compile(
    "roasted|fried|fry|papad|chips|namkeen|bhujia|sev|biscuit|cookie|"
    "cracker|khakhra|toast|rusk|puff|wafer", re.I)
COOKED_WET_DENSITY = 1.0


def effective_density(food_name, cooking_state=None, density_fn=None):
    """Density to use for THIS food, accounting for cooking state."""
    base = 1.0
    if food_name and density_fn:
        d = density_fn(food_name)
        base = d[0] if isinstance(d, tuple) else d
    if cooking_state == "cooked" and WET_DISH_RE.search(food_name or "") \
            and not DRY_FINISHED_RE.search(food_name or ""):
        return max(base, COOKED_WET_DENSITY)
    return base


def list_portions(food_name=None, density_fn=None, cooking_state=None):
    """Portions to offer the user, each with the grams IT WOULD MEAN FOR
    THIS FOOD. Passing the food is what makes the list honest: a medium
    bowl of dal and of salad are not the same mass."""
    out = []
    density = effective_density(food_name, cooking_state, density_fn)

    for key, spec in VOLUME_PORTIONS.items():
        grams = round(spec["ml"] * density, 1)
        entry = {
            "key": key, "label": spec["label"], "group": spec["group"],
            "grams": grams, "basis": "volume",
            "volume_ml": spec["ml"],
        }
        spread = OBSERVED_SPREAD.get(key)
        if spread:
            entry["observed_range_g"] = list(spread)
        out.append(entry)

    for key, spec in COUNT_PORTIONS.items():
        g = spec.get("grams")
        if food_name and not _count_applies(key, food_name):
            continue
        entry = {"key": key, "label": spec["label"], "group": spec["group"],
                 "grams": g, "basis": "count"}
        spread = OBSERVED_SPREAD.get(key)
        if spread:
            entry["observed_range_g"] = list(spread)
        out.append(entry)
    return out


def _count_applies(key, food_name):
    """A count portion only makes sense for a food that comes in that
    form -- offering "1 idli" for dal would be nonsense."""
    if key in ("piece", "slice"):
        return True
    return re.search(key, food_name or "", re.I) is not None


def portion_to_grams(portion_key, count, food_name="", density_fn=None,
                     food_serving_grams=None, cooking_state=None):
    """(portion, count) -> grams for THIS food.

    Precedence, strongest evidence first:
      1. the food's OWN measured serving weight, when the requested portion
         is that same unit (e.g. INDB knows this dish's katori is 150 g);
      2. a count portion's reference weight;
      3. volume x the food's density.
    Returns (grams, basis, note) with grams None when undeterminable.
    """
    key = canonical(portion_key)
    if key is None:
        return None, "unknown_portion", f"'{portion_key}' is not a known portion"
    try:
        n = float(count)
    except (TypeError, ValueError):
        return None, "bad_count", f"could not read count '{count}'"
    if n <= 0:
        return None, "bad_count", "count must be > 0"

    # 1) the food's own measured serving beats any generic figure
    if food_serving_grams and key in ("serving", "bowl", "katori", "plate",
                                      "piece", "medium_bowl"):
        return round(n * food_serving_grams, 1), "measured_serving", \
            "this food publishes its own serving weight"

    # 2) counts
    if key in COUNT_PORTIONS:
        g = COUNT_PORTIONS[key].get("grams")
        if g is None:
            return None, "unknown_piece_weight", \
                f"no reference weight for one '{key}' of this food"
        return round(n * g, 1), "count", f"{n} x {g} g"

    # 3) volume x density
    spec = VOLUME_PORTIONS[key]
    density = effective_density(food_name, cooking_state, density_fn)
    grams = n * spec["ml"] * density
    return round(grams, 1), "volume", \
        f"{n} x {spec['ml']}ml x {density} g/ml"
