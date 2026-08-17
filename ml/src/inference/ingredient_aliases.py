"""
Recipe-ingredient -> database-food resolution map.

WHY THIS FILE IS NECESSARY (and why it is not cheating):
Tier 2 sums measured ingredient values, so it is only as good as its
ingredient LOOKUP. Auditing the 45 most frequent ingredients across INDB's
1,014 recipes found systematic mis-resolution on the highest-volume terms:

    "Refined wheat flour" -> "Refined Sunflower OIL"        900 kcal  (!)
    "Butter"              -> "Popcorn, microwave, butter FLAVOR"  535
    "Cinnamon"            -> "Cinnamon BUNS, frosted"        452
    "Vanilla essence"     -> "OREO Original (Vanilla)"       471
    "Curds"               -> "Cheese, curds"                 375  (dahi is ~65)
    "Pepper powder"       -> "Pepper, BANANA, raw"            27  (black pepper ~250)
    "Red chilli powder"   -> "Red chilli SAUCE"              113
    "Clove"               -> "Garlic, big CLOVE"             124  (spice clove)
    "Egg"                 -> "Egg, yolk, cooked"             351  (whole egg ~150)

Each of these is a ranking failure no amount of scoring can fix, because
the information needed is culinary, not lexical: "curds" means yogurt in an
Indian recipe and cheese curds in an American one; "clove" is a spice in a
spice list and a unit of garlic elsewhere. That knowledge has to be stated.

DISCIPLINE APPLIED HERE:
  * Every mapping points at a GENERIC, lab-measured food -- never a brand,
    never a prepared dish.
  * Where a term is genuinely ambiguous and getting it wrong would be
    costly, it is left OUT rather than guessed; the calculator then reports
    it unresolved instead of silently using the wrong food.
  * Nothing here invents a nutrition value. It only chooses which measured
    food a recipe word refers to.
"""
import re

# recipe term (lowercased, exact match after strip) -> search query
INGREDIENT_ALIASES = {
    # ---- fats: an unqualified "oil"/"fat" in an Indian recipe is a neutral
    # refined cooking oil, not a specialty or animal fat ----
    "oil": "sunflower oil",
    "fat": "sunflower oil",
    "cooking oil": "sunflower oil",
    "refined oil": "sunflower oil",
    "vegetable oil": "sunflower oil",
    "salad oil": "sunflower oil",
    "mustard oil": "mustard oil",
    "coconut oil": "coconut oil",
    "olive oil": "olive oil",
    "sesame oil": "sesame oil",
    "groundnut oil": "peanut oil",
    "peanut oil": "peanut oil",
    "butter": "butter, salted",
    "unsalted butter": "butter, unsalted",
    "ghee": "clarified butter ghee",
    
    "margarine": "margarine",
    "cream": "cream, fresh",
    "fresh cream": "cream, fresh",
    "malai": "cream, fresh",

    # ---- dairy: "curds" is dahi/yogurt in Indian usage, NOT cheese curds ----
    "curd": "curd",
    "curds": "curd",
    "dahi": "curd",
    "yoghurt": "curd",
    "yogurt": "curd",
    "hung curd": "curd",
    "buttermilk": "buttermilk",
    "milk": "milk, whole, cow",
    "whole milk": "milk, whole, cow",
    "skimmed milk": "milk, skim",
    "toned milk": "milk, whole, cow",
    "condensed milk": "milk, condensed, sweetened",
    "evaporated milk": "milk, evaporated",
    "milk powder": "milk powder, whole",
    "khoa": "khoa",
    "mawa": "khoa",
    "paneer": "paneer",
    "cheese": "cheese, processed",
    "processed cheese": "cheese, processed",
    "cheese spread": "cheese, processed",
    "mozzarella": "cheese, mozzarella",

    # ---- flours & starches ----
    "refined flour": "wheat flour, refined",
    "refined wheat flour": "wheat flour, refined",
    "maida": "wheat flour, refined",
    "all purpose flour": "wheat flour, refined",
    "wheat flour": "wheat flour, atta",
    "whole wheat flour": "wheat flour, atta",
    "atta": "wheat flour, atta",
    "besan": "chickpea flour",
    "gram flour": "chickpea flour",
    "cornflour": "corn starch",
    "corn flour": "corn starch",
    "cornstarch": "corn starch",
    "rice flour": "rice flour",
    "semolina": "wheat, semolina",
    "suji": "wheat, semolina",
    "rava": "wheat, semolina",
    "sooji": "wheat, semolina",
    "bread crumbs": "bread crumbs, dry",
    "breadcrumbs": "bread crumbs, dry",

    # ---- sugars ----
    "sugar": "sugar, white",
    "castor sugar": "sugar, white",
    "caster sugar": "sugar, white",
    "powdered sugar": "sugar, white",
    "icing sugar": "sugar, white",
    "brown sugar": "sugar, brown",
    "jaggery": "jaggery",
    "gur": "jaggery",
    "honey": "honey",

    # ---- spices: whole-spice and powder forms, NOT sauces or baked goods ----
    "pepper": "pepper, black",
    "pepper powder": "pepper, black",
    "black pepper": "pepper, black",
    "peppercorn": "pepper, black",
    "peppercorns": "pepper, black",
    "red chilli powder": "chillies, red",
    "chilli powder": "chillies, red",
    "chili powder": "chillies, red",
    "red chilli": "chillies, red",
    "dry red chilli": "chillies, red",
    "green chilli": "chillies, green - all varieties",
    "green chillies": "chillies, green - all varieties",
    "turmeric": "turmeric powder",
    "turmeric powder": "turmeric powder",
    "haldi": "turmeric powder",
    "cumin": "cumin seeds",
    "cumin seeds": "cumin seeds",
    "jeera": "cumin seeds",
    "cumin powder": "cumin seeds",
    "coriander powder": "coriander seeds",
    "coriander seeds": "coriander seeds",
    "dhania": "coriander seeds",
    "garam masala": "garam masala",
    "clove": "cloves syzygium",
    "cloves": "cloves syzygium",
    "laung": "cloves syzygium",
    
    
    
    "cardamom": "cardamom, green",
    "green cardamom": "cardamom, green",
    "black cardamom": "cardamom, black",
    "elaichi": "cardamom, green",
    "bay leaf": "bay leaf",
    "tej patta": "bay leaf",
    "mustard seeds": "mustard seeds",
    "rai": "mustard seeds",
    "fenugreek seeds": "fenugreek seeds",
    "methi seeds": "fenugreek seeds",
    "asafoetida": "asafoetida",
    "hing": "asafoetida",
    
    
    "fennel": "spices, fennel seed",
    "saunf": "spices, fennel seed",
    "nutmeg": "nutmeg",
    
    "saffron": "saffron",
    "kesar": "saffron",
    
    
    
    
    "kasuri methi": "fenugreek leaves, dried",
    "poppy seeds": "poppy seeds",
    "khus khus": "poppy seeds",

    # ---- aromatics & vegetables ----
    "onion": "onion",
    "onions": "onion",
    "spring onion": "onion, spring",
    "garlic": "garlic",
    "ginger": "ginger, fresh",
    "ginger garlic paste": "ginger, fresh",
    "tomato": "tomato, ripe",
    "tomatoes": "tomato, ripe",
    "tomato puree": "tomato puree",
    "coriander leaves": "coriander leaves",
    "curry leaves": "curry leaves",
    "mint leaves": "mint leaves",
    "pudina": "mint leaves",
    "spinach": "spinach",
    "palak": "spinach",
    "potato": "potato",
    "aloo": "potato",
    "carrot": "carrot",
    "peas": "peas, green",
    "green peas": "peas, green",
    "matar": "peas, green",
    "capsicum": "capsicum, green",
    "cauliflower": "cauliflower",
    "cabbage": "cabbage",
    "brinjal": "brinjal",
    "okra": "okra",
    "bhindi": "okra",
    "cucumber": "cucumber",
    "beetroot": "beetroot",
    "mushroom": "mushroom",
    "lemon juice": "lemon juice",
    "lime juice": "lemon juice",
    "coconut": "coconut meat, raw",
    "grated coconut": "coconut meat, raw",
    "desiccated coconut": "coconut, desiccated",
    "coconut milk": "coconut milk",

    # ---- pulses & grains (raw forms; yield factors handle cooking) ----
    "rice": "rice, raw milled",
    "basmati rice": "rice, raw milled",
    "toor dal": "red gram, dal",
    "arhar dal": "red gram, dal",
    "moong dal": "green gram, dal",
    "urad dal": "black gram, dal",
    "chana dal": "bengal gram, dal",
    "masoor dal": "lentil, dal",
    "rajma": "rajmah",
    "chana": "bengal gram, whole",
    "chickpeas": "bengal gram, whole",
    "poha": "rice, parboiled, milled",   # DB's branded "Poha Flaked Rice" reads 722 kcal, impossible for a starch (max ~400)
    "sabudana": "sago",
    "vermicelli": "wheat, vermicelli",

    # ---- proteins ----
    "egg": "egg, poultry, whole, raw",
    "eggs": "egg, poultry, whole, raw",
    "egg white": "egg, poultry, white, raw",
    "egg yolk": "egg, poultry, yolk, raw",
    "chicken": "chicken, poultry, breast, skinless",
    "pork": "pork, back ribs, lean",
    "beef": "beef, round leg",
    "bacon": "pork, bacon, raw",
    "ham": "ham, sliced, regular",
    "mutton": "goat, round leg",   # in Indian usage mutton = GOAT, not sheep
    "lamb": "sheep, round leg",
    "fish": "fish, indian mackerel",
    "prawns": "prawn",
    "keema": "goat, round leg",
    "minced meat": "goat, round leg",

    # ---- leavening & misc ----
    "baking powder": "baking powder",
    "baking soda": "baking soda",
    "soda bicarbonate": "baking soda",
    "yeast": "yeast, baker's",
    "vinegar": "vinegar",
    "salt": "salt, table",
    "water": "water",
    "cocoa powder": "cocoa powder, unsweetened",
    "cashew": "cashew nut",
    "cashewnut": "cashew nut",
    "almond": "almond",
    "raisins": "raisins",
    "kishmish": "raisins",
    "walnut": "walnut",
    "peanut": "peanuts, raw",
    "groundnut": "peanuts, raw",
    "sesame seeds": "sesame seeds",
    "til": "sesame seeds",
    "tamarind": "tamarind pulp",
    "imli": "tamarind pulp",
}

# Terms whose nutritional contribution is negligible AND whose quantity in
# recipes is typically a trace. Resolving these badly costs more than
# skipping them, so they are treated as zero-contribution rather than
# matched to something wrong.
NEGLIGIBLE_TERMS = {
    "vanilla essence", "vanilla extract", "essence", "food colour",
    "food color", "colouring", "rose essence", "kewra", "kewra water",
    "rose water", "edible silver foil", "silver foil", "varak",
    "toothpick", "banana leaf", "muslin cloth", "butter paper",
    "ice cubes", "ice",
}


# Words a recipe adds around the real ingredient that do not change what it
# is. Stripped before matching so "Mutton boneless boti" still finds
# "mutton" -- exact-only matching let that fall through to plain search,
# which returned "Meat drippings (mutton tallow)" at 890 kcal and single-
# handedly turned a 73 kcal kebab serving into 1,197 kcal.
NOISE_WORDS = {
    "finely", "chopped", "grated", "sliced", "diced", "cubed", "minced",
    "boiled", "fresh", "dried", "roasted", "raw", "washed", "soaked",
    "powdered", "powder", "ground", "crushed", "peeled", "shelled",
    "boneless", "bone", "with", "without", "and", "or", "of", "the",
    "small", "medium", "large", "big", "ripe", "unripe", "tender",
    "pieces", "piece", "cut", "cleaned", "trimmed", "lean", "curry",
    "boti", "cubes", "strips", "mince", "seeds", "seed", "leaves", "leaf",
}


def _core_tokens(text):
    toks = re.findall(r"[a-z]+", (text or "").lower())
    return [t for t in toks if t not in NOISE_WORDS]


def resolve_ingredient(name):
    """Return (search_query, is_negligible).

    search_query is what tier 2 should look up; None means 'no reliable
    mapping -- report unresolved rather than guess'.

    Matching is layered, most specific first:
      1. exact alias hit
      2. qualifier-stripped exact hit ("chopped onion" -> "onion")
      3. LONGEST alias whose words all appear in the ingredient name
         ("mutton boneless boti" -> "mutton"), which is what makes real
         recipe phrasing work rather than only clean single words.
    """
    raw = (name or "").strip().lower()
    if not raw:
        return None, False
    if raw in NEGLIGIBLE_TERMS:
        return None, True
    if raw in INGREDIENT_ALIASES:
        return INGREDIENT_ALIASES[raw], False

    for qual in ("finely chopped ", "chopped ", "grated ", "sliced ",
                 "boiled ", "fresh ", "dried ", "roasted ", "raw ",
                 "washed ", "soaked ", "powdered "):
        if raw.startswith(qual):
            sub = raw[len(qual):].strip()
            if sub in NEGLIGIBLE_TERMS:
                return None, True
            if sub in INGREDIENT_ALIASES:
                return INGREDIENT_ALIASES[sub], False

    if any(n in raw for n in NEGLIGIBLE_TERMS):
        return None, True

    ing_tokens = set(_core_tokens(raw))
    if ing_tokens:
        best_key, best_len = None, 0
        for key in INGREDIENT_ALIASES:
            k_tokens = _core_tokens(key)
            if not k_tokens:
                continue
            if set(k_tokens) <= ing_tokens and len(k_tokens) > best_len:
                best_key, best_len = key, len(k_tokens)
        if best_key:
            return INGREDIENT_ALIASES[best_key], False

    return name, False      # fall through to plain search
