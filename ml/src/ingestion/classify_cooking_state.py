"""
Classify cooking state for the 12,106 foods currently `unspecified`.

WHY THIS IS THE HIGHEST-VALUE REMAINING DATA WORK:
Cooking state is the largest measured error source in this project. Rice is
358 kcal/100 g raw and 129 cooked -- resolving "150 g rice" against the
wrong one is a 342 kcal error on a single item, larger than every other
error source measured here combined. Search already prefers the state a
food is EATEN in, but that preference cannot fire on a row whose state is
unknown.

THE THIRD CATEGORY THIS ADDS, and why it is not a dodge:
Inspecting the unspecified rows showed most are packaged or processed
products -- Oreos, whey protein, instant noodles, sauces -- where raw
vs cooked is not merely unknown, it is NOT APPLICABLE. Forcing those into
raw/cooked would be inventing a distinction the food does not have, and
would make the search penalty fire wrongly. So they are classified
`ready_to_eat`: consumed exactly as sold.

    raw           eaten uncooked, or sold raw for cooking
    cooked        heat has been applied
    ready_to_eat  packaged/processed; the question does not apply
    unspecified   genuinely undetermined -- evidence absent, LEFT ALONE

CONFIDENCE IS RECORDED, NOT ASSUMED:
Every assignment carries the evidence that produced it. Where a name gives
no signal, the row stays `unspecified` rather than defaulting -- a wrong
state is worse than a missing one, because search acts on it.
"""
import json
import re
from collections import Counter
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "cooking_state_classified.json"

# --- explicit cooking verbs: strongest possible evidence ---
COOKED_RE = re.compile(
    r"\b(cooked|boiled|roasted|baked|fried|grilled|broiled|steamed|braised|"
    r"stewed|toasted|microwaved|poached|blanched|simmered|sauteed|sauteed|"
    r"rotisserie|barbecued|smoked|charred|seared|scrambled|pan.fried|"
    r"deep.fried|stir.fried|reheated|heated|parboiled|precooked|"
    r"pre.cooked|caramelized|caramelised|toasting|"
    # stems, not just past participles: "Barbecue pork" is as cooked as
    # "Barbecued pork", and the audit caught the former falling through
    r"barbecue|barbeque|bbq|tandoori|grill|boil|bake|steam|fry)\b", re.I)

RAW_RE = re.compile(r"\b(raw|uncooked|fresh|unheated|sashimi|tartare)\b", re.I)

# --- dish forms that are cooked by definition, even without a verb ---
COOKED_BY_NATURE_RE = re.compile(
    r"\b(stew|soup|curry|casserole|pie|pizza|bread|cake|cookie|biscuit|"
    r"muffin|pancake|waffle|omelet|omelette|frittata|quiche|lasagna|"
    r"lasagne|risotto|paella|pilaf|pulao|biryani|kebab|kabab|roast|"
    r"gravy|sauce, cooked|porridge|oatmeal|dal|daal|sambar|rasam|"
    r"idli|dosa|uttapam|chapati|roti|paratha|naan|puri|poori|vada|"
    r"samosa|pakora|pakoda|halwa|kheer|dhokla|upma|poha|khichdi|"
    r"tandoori|tikka|korma|kofta|bhurji|paneer tikka)\b", re.I)

# --- packaged / processed: raw-vs-cooked does not apply ---
READY_TO_EAT_RE = re.compile(
    r"\b(protein powder|whey|isolate|casein|supplement|shake mix|"
    r"drink mix|energy drink|soft drink|soda|cola|juice|squash|syrup|"
    r"candy|chocolate|toffee|chewing gum|jelly|jam|marmalade|"
    r"biscuit|cookie|cracker|wafer|chips|crisps|namkeen|bhujia|sev|"
    r"mixture|snack|cereal bar|granola bar|energy bar|muesli|cornflakes|"
    r"instant|ready.to.eat|rte|packaged|canned drink|bottled|"
    r"ketchup|mayonnaise|dressing|achar|"
    r"ice cream|yoghurt drink|lassi|smoothie|milkshake|"
    r"alcohol|beer|wine|whisky|whiskey|vodka|rum|gin|liqueur|cocktail|"
    r"infant formula|babyfood|baby food|formula)\b", re.I)

# Products where the word must be the item ITSELF, not an aside. The audit
# caught "Beef and potatoes, NO SAUCE" and "Barbecue pork, no sauce" being
# classified packaged because a bare "sauce" pattern matched inside a phrase
# that explicitly says there is none. These require the term at the start of
# the name or immediately after a comma -- i.e. the product head.
PACKAGED_HEAD_RE = re.compile(
    r"(?:^|,\s*)(sauce|jam|jelly|marmalade|spread|pickle|chutney|"
    r"dressing|syrup|dip)", re.I)

# --- spices, oils, sweeteners, flours: state is meaningless ---
STATE_NOT_APPLICABLE_RE = re.compile(
    r"\b(oil|ghee|butter|margarine|lard|tallow|shortening|"
    r"salt|sugar|jaggery|honey|molasses|sweetener|"
    r"spice|masala|powder|seasoning|essence|extract|colour|color|"
    r"baking powder|baking soda|yeast|vinegar|starch|"
    r"flour|atta|maida|besan|semolina|water)\b", re.I)


# ---- second-pass categories (see step 5 in classify()) ----
BAKED_GOOD_RE = re.compile(
    "scone|pastry|danish|croissant|bagel|doughnut|donut|brownie|"
    "cupcake|tart|strudel|eclair|profiterole|shortbread|"
    "focaccia|baguette|ciabatta|pretzel|crumpet|stuffing", re.I)

ASSEMBLED_DISH_RE = re.compile(
    "ravioli|lasagna|lasagne|cannelloni|tortellini|gnocchi|ramen|"
    "pho|udon|chow mein|lo mein|burrito|taco|enchilada|quesadilla|"
    "pupusa|empanada|dumpling|momo|spring roll|samosa|"
    "with .*sauce|with gravy|home recipe|restaurant|"
    "stir.fry|hot pot|platter|thali|combo meal", re.I)

CURED_DAIRY_RE = re.compile(
    "deli.?meat|salami|pepperoni|bologna|prosciutto|pastrami|"
    "cured|fermented|natto|tempeh|kimchi|sauerkraut|"
    "cheese|yogh?urt|yogourt|dahi|paneer|quark|kefir|"
    "cottage cheese|cream cheese|milk", re.I)

DRY_STAPLE_RE = re.compile(
    "(pasta|noodle|noodles|macaroni|spaghetti|vermicelli|rice|lentil|"
    "bean|beans|pea|peas|gram|dal|oats|barley|quinoa|couscous)"
    ".{0,30}(dry|dried|uncooked|raw)", re.I)


def classify(name):
    """Return (state, evidence) or (None, reason) when undetermined."""
    n = name or ""

    # 1) explicit verb beats everything -- "Chicken, raw" / "Rice, cooked"
    if RAW_RE.search(n) and not COOKED_RE.search(n):
        return "raw", "explicit raw/fresh in name"
    if COOKED_RE.search(n) and not RAW_RE.search(n):
        return "cooked", "explicit cooking verb in name"
    if COOKED_RE.search(n) and RAW_RE.search(n):
        # e.g. "fresh, cooked" -- the cooking verb is the operative one
        return "cooked", "both present; cooking verb takes precedence"

    # 2) dish forms that are cooked by definition. Checked BEFORE the
    # packaged test: a cooked dish that merely mentions a sauce is still a
    # cooked dish, and testing packaged first mislabelled "Beef and
    # potatoes, no sauce" as a packaged product.
    if COOKED_BY_NATURE_RE.search(n):
        return "cooked", "dish form implies cooking"

    # 3) packaged/processed -- the distinction does not apply
    if READY_TO_EAT_RE.search(n) or PACKAGED_HEAD_RE.search(n):
        return "ready_to_eat", "packaged/processed product"

    # 4) ingredients whose state is meaningless
    if STATE_NOT_APPLICABLE_RE.search(n):
        return "ready_to_eat", "ingredient with no meaningful cooking state"

    # 5) SECOND PASS -- categories a first reading missed. Added after
    # sampling the remaining 6,013 unspecified rows and finding real
    # evidence still present: baked goods, assembled dishes, cured meats,
    # dairy products and explicitly-dry staples. Each rule below is one
    # where the inference is reliable, not merely plausible.
    if BAKED_GOOD_RE.search(n):
        return "cooked", "baked good"
    if ASSEMBLED_DISH_RE.search(n):
        return "cooked", "assembled/prepared dish"
    if CURED_DAIRY_RE.search(n):
        return "ready_to_eat", "cured, fermented or dairy product eaten as sold"
    if DRY_STAPLE_RE.search(n):
        # "Pasta, egg noodles, DRY" is an uncooked staple, not a finished
        # food -- the opposite of the packaged/ready reading.
        return "raw", "explicitly dry/uncooked staple"

    # 6) no evidence -- do NOT guess
    return None, "no cooking-state evidence in name"


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    changed, evidence_counts, still_unknown = 0, Counter(), 0

    for f in db:
        if f.get("cooking_state") != "unspecified":
            continue
        state, why = classify(f.get("food_name"))
        if state is None:
            still_unknown += 1
            continue
        f["cooking_state"] = state
        f["cooking_state_evidence"] = why
        f["cooking_state_inferred"] = True
        changed += 1
        evidence_counts[f"{state}: {why}"] += 1

    DB_PATH.write_text(json.dumps(db, indent=2), encoding="utf-8")

    dist = Counter(f.get("cooking_state") for f in db)
    print(f"classified {changed} previously-unspecified foods")
    print(f"left unspecified (no evidence, deliberately not guessed): {still_unknown}")
    print("\nevidence used:")
    for k, v in evidence_counts.most_common():
        print(f"   {v:6d}  {k}")
    print("\nfinal distribution across all", len(db), "foods:")
    for k, v in dist.most_common():
        print(f"   {str(k):14s} {v:6d}  ({100*v/len(db):.1f}%)")

    OUT_PATH.write_text(json.dumps({
        "classified": changed,
        "left_unspecified": still_unknown,
        "distribution": dict(dist),
        "evidence_counts": dict(evidence_counts),
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
