"""
Culinary unit -> grams conversion.

WHY THIS IS ITS OWN MODULE:
Users log portions, not grams. "2 tbsp oil", "1 katori dal", "3 cloves
garlic" all have to become a mass before any nutrition arithmetic can
happen, and getting it wrong scales the WHOLE food's contribution -- a
2x unit error is a 2x calorie error, larger than any modelling error in
this project.

DENSITY MATTERS AND IS NOT OPTIONAL:
A tablespoon is a VOLUME (15 ml). One tbsp of oil is ~13.8 g; one tbsp of
honey is ~21 g; one tbsp of wheat flour is ~8 g. Using a single "15 g per
tbsp" rule would be wrong by up to 2.6x. So volume units are converted
via a per-food-class density, and the class is inferred from the food's
own name.

COVERAGE IS DRIVEN BY REAL DATA:
The unit list comes from counting every unit string in INDB's 10,272
recipe ingredient rows, so it covers what actually appears rather than
what seemed likely: g (3,064), tsp (2,816), tbsp (774), cup (543),
ml (323), pinch (241), nos (217), sprig (132), cloves (145), inch (71),
slices (72), kg (53), drops (68), dash (32) ...

Anything genuinely unquantifiable ("to taste", "as required", "few") is
returned as None rather than guessed -- an invented quantity silently
corrupts the total, and for spices/garnishes the true contribution is
nutritionally negligible anyway.
"""
import re

# ---- volume units, in millilitres ----
ML_PER_UNIT = {
    "tsp": 5.0, "teaspoon": 5.0, "teaspoons": 5.0,
    "tbsp": 15.0, "tablespoon": 15.0, "tablespoons": 15.0,
    "cup": 240.0, "cups": 240.0,
    "katori": 150.0,          # standard Indian serving bowl
    "bowl": 250.0, "small bowl": 180.0, "soup bowl": 300.0,
    "glass": 250.0, "tall glass": 350.0, "tea cup": 150.0,
    "ml": 1.0, "millilitre": 1.0, "litre": 1000.0, "l": 1000.0,
    "drop": 0.05, "drops": 0.05,
    "pinch": 0.35, "dash": 0.6,     # ~1/16 and ~1/8 tsp
}

# ---- density (g/ml) by food class. Water = 1.0 ----
# Only classes that materially differ from water are listed; the fallback
# is 1.0, which is correct for most liquids and wet mixtures.
DENSITY_G_PER_ML = {
    "oil": 0.92, "ghee": 0.91, "butter": 0.91,
    "honey": 1.42, "syrup": 1.33, "jaggery_liquid": 1.30,
    "milk": 1.03, "curd": 1.03, "cream": 0.99,
    "sugar_granulated": 0.85, "salt": 1.20,
    "flour": 0.55, "besan": 0.60, "semolina": 0.75, "rice_raw": 0.85,
    "dal_raw": 0.85, "spice_powder": 0.50, "grated": 0.40,
    "chopped_veg": 0.55, "leafy": 0.25, "nuts": 0.60,
    "water": 1.0,
}

DENSITY_PATTERNS = [
    ("oil", r"\boil\b"),
    ("ghee", r"\bghee\b"),
    ("butter", r"\bbutter\b|\bmargarine\b|\bvanaspati\b"),
    ("honey", r"\bhoney\b"),
    ("syrup", r"\bsyrup\b|\bmolasses\b|\btreacle\b"),
    ("milk", r"\bmilk\b|\bbuttermilk\b|\bchaas\b"),
    ("curd", r"\bcurd\b|\bdahi\b|\byogh?urt\b"),
    ("cream", r"\bcream\b|\bmalai\b"),
    ("sugar_granulated", r"\bsugar\b|\bjaggery\b|\bgur\b"),
    ("salt", r"\bsalt\b|\bnamak\b"),
    ("besan", r"\bbesan\b|\bgram flour\b|\bchickpea flour\b"),
    ("semolina", r"\bsemolina\b|\bsuji\b|\brava\b"),
    ("flour", r"\bflour\b|\batta\b|\bmaida\b|\bstarch\b"),
    ("rice_raw", r"\brice\b|\bpoha\b|\bmurmura\b"),
    ("dal_raw", r"\bdal\b|\bdaal\b|\bgram\b|\blentil\b|\bbean\b|\bpea\b"),
    ("spice_powder", r"\bpowder\b|\bmasala\b|\bturmeric\b|\bhaldi\b|\bchilli\b|"
                     r"\bcumin\b|\bjeera\b|\bcoriander\b|\bdhania\b|\bgaram\b"),
    ("grated", r"\bgrated\b|\bshredded\b|\bdesiccated\b"),
    ("leafy", r"\bleaves\b|\bleaf\b|\bcoriander leaves\b|\bmint\b|\bpalak\b|"
              r"\bspinach\b|\bmethi\b|\bcurry leaves\b"),
    ("nuts", r"\balmond\b|\bcashew\b|\bwalnut\b|\bpeanut\b|\bpistachio\b"),
    ("chopped_veg", r"\bchopped\b|\bdiced\b|\bsliced\b|\bcubed\b|\bonion\b|"
                    r"\btomato\b|\bpotato\b|\bcarrot\b"),
]
COMPILED_DENSITY = [(k, re.compile(p, re.I)) for k, p in DENSITY_PATTERNS]

# ---- count-based units: grams per ONE item, by food ----
# Measured/standard reference weights. These are per-piece masses, so they
# do NOT go through density.
PIECE_GRAMS = [
    (r"\begg\b", 50.0),
    (r"\bclove\b.*\bgarlic\b|\bgarlic\b.*\bclove\b|\bcloves?\b", 3.0),
    (r"\bonion\b", 110.0), (r"\btomato\b", 100.0), (r"\bpotato\b", 150.0),
    (r"\bgreen chill?i(es)?\b|\bchill?i\b", 5.0),
    (r"\blemon\b|\blime\b", 60.0),
    (r"\bbanana\b", 120.0), (r"\bapple\b", 180.0), (r"\borange\b", 130.0),
    (r"\bcurry leaf\b|\bcurry leaves\b|\bsprig\b", 1.0),
    (r"\bbread\b|\bslice\b", 25.0),
    (r"\broti\b|\bchapati\b", 40.0), (r"\bdosa\b", 85.0), (r"\bidli\b", 45.0),
    (r"\bcashew\b", 1.5), (r"\balmond\b", 1.2), (r"\bwalnut\b", 5.0),
    (r"\braisin\b|\bkishmish\b", 0.5),
    (r"\bcardamom\b|\belaichi\b", 0.3),
    (r"\bpepper ?corn\b", 0.05),
    (r"\bcinnamon\b|\bdalchini\b", 2.0),
    (r"\bbay leaf\b|\btej patta\b", 0.2),
    (r"\bcoconut\b", 400.0),
    (r"\bcucumber\b", 200.0), (r"\bcarrot\b", 70.0),
    (r"\bcapsicum\b|\bbell pepper\b", 120.0),
    (r"\bbrinjal\b|\beggplant\b", 250.0),
    (r"\bokra\b|\bbhindi\b|\blady.?s? finger\b", 10.0),
]
COMPILED_PIECE = [(re.compile(p, re.I), g) for p, g in PIECE_GRAMS]

COUNT_UNITS = {"no", "nos", "no.", "nos.", "piece", "pieces", "pc", "pcs",
               "clove", "cloves", "slice", "slices", "cube", "cubes",
               "sprig", "sprigs", "stick", "sticks", "flake", "flakes",
               "medium", "small", "large", "whole", "pepper corns", "lemon"}

SIZE_SCALE = {"small": 0.65, "medium": 1.0, "large": 1.5}

# Length units for things like "1 inch ginger"
LENGTH_GRAMS_PER_UNIT = {"inch": 8.0, "cm": 3.0}   # ginger/cinnamon-ish

UNQUANTIFIABLE_RE = re.compile(
    r"to taste|as required|as needed|as per|enough|few|handful|garnish|"
    r"for frying|for greasing|a little|optional|pinch of salt", re.I)


def density_for(food_name):
    for cls, rx in COMPILED_DENSITY:
        if rx.search(food_name or ""):
            return DENSITY_G_PER_ML[cls], cls
    return DENSITY_G_PER_ML["water"], "water_default"


def piece_grams_for(food_name):
    for rx, g in COMPILED_PIECE:
        if rx.search(food_name or ""):
            return g
    return None


def to_grams(amount, unit, food_name=""):
    """Convert (amount, unit, food) -> (grams, method, note).

    Returns grams=None when the quantity is genuinely unquantifiable, so
    the caller can decide -- never a silent guess.
    """
    unit_raw = str(unit or "").strip().lower()
    if UNQUANTIFIABLE_RE.search(unit_raw) or UNQUANTIFIABLE_RE.search(str(amount or "")):
        return None, "unquantifiable", f"'{unit_raw or amount}' has no measurable quantity"

    try:
        amt = float(str(amount).strip())
    except (TypeError, ValueError):
        return None, "unparseable_amount", f"could not read amount '{amount}'"
    if amt <= 0:
        return None, "non_positive", "amount must be > 0"

    u = re.sub(r"\(.*?\)", "", unit_raw).strip()
    u = re.sub(r"[^a-z. ]", "", u).strip()

    # mass units first -- no density needed
    if u in ("g", "gram", "grams", "gm", "gms"):
        return amt, "mass", None
    if u in ("kg", "kilogram", "kilograms"):
        return amt * 1000.0, "mass", None
    if u in ("mg",):
        return amt / 1000.0, "mass", None

    # volume units -> density
    if u in ML_PER_UNIT:
        ml = amt * ML_PER_UNIT[u]
        dens, cls = density_for(food_name)
        return ml * dens, "volume", f"{ml:.1f}ml x {dens} g/ml ({cls})"

    # length units (ginger, cinnamon stick)
    if u in LENGTH_GRAMS_PER_UNIT:
        return amt * LENGTH_GRAMS_PER_UNIT[u], "length", None

    # count units -> per-piece reference weight
    if u in COUNT_UNITS or u == "":
        pg = piece_grams_for(food_name)
        scale = SIZE_SCALE.get(u, 1.0)
        if pg is not None:
            return amt * pg * scale, "count", f"{amt} x {pg}g/piece"
        return None, "unknown_piece_weight", (
            f"no reference weight for one '{food_name}'")

    return None, "unknown_unit", f"unit '{unit_raw}' not recognised"
