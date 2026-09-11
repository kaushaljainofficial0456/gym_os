"""
Food retrieval + ranking for skos-food-v1.

WHY THIS FILE EXISTS AT ALL:
The first unified build had 8,671 foods and still answered "chicken" with
"APPLEBEE'S chicken tenders platter", "rice" with "Alcoholic beverage,
rice (sake)", and "apple" with "APPLE CIDER VINEGAR, 0 kcal". The
nutrition values were correct; the RETRIEVAL was wrong. For a food logger
that is indistinguishable from the data being wrong -- the user sees a
number, and it is the number for the wrong food.

So retrieval accuracy is treated here as a first-class part of model
accuracy, not as UI plumbing. Scoring is deliberately explainable
(additive, inspectable components) rather than a learned ranker: with no
click-through data to train on, a learned ranker would just be encoding
my guesses with less transparency.

Ranking principles, in order of weight:
  1. EXACT normalized-name match wins outright.
  2. A query is usually a GENERIC food ("chicken"), so prefer generic
     entries over branded/restaurant/babyfood/prepared-with-qualifiers.
  3. Prefer whole-word matches at the START of the name over a substring
     buried mid-name ("Rice, white" beats "Alcoholic beverage, rice").
  4. Fewer extra qualifier tokens = more generic = better default.
  5. Source priority breaks remaining ties (INDB dish > IFCT > USDA > OFF).
"""
import json
import re
import unicodedata
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "unified_food_db.json"
ALIAS_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "food_aliases.json"

try:
    from .cooking_state import expected_state, CookingStateResolver, moisture_mismatch
    from .portion_catalog import list_portions
    from .portion_units import density_for
except ImportError:  # running as a script rather than a package
    from cooking_state import expected_state, CookingStateResolver, moisture_mismatch
    from portion_catalog import list_portions
    from portion_units import density_for

# CNF_CANADA was added to the merge but originally omitted here, so its
# 4,944 rows silently fell to the unknown-source default (rank 5) instead of
# their intended rank 3 -- caught by JS/Python parity testing, not by
# reading either file. Both implementations must list every source.
SOURCE_RANK = {"INDB": 0, "IFCT2017": 1, "USDA_FDC": 2, "CNF_CANADA": 3,
               "OPEN_FOOD_FACTS": 4}

# Name markers that signal "this is NOT the generic food the user meant".
# Each is a real failure observed in the pre-ranking baseline, not a guess.
BRANDY_PENALTIES = [
    (re.compile(r"\bbabyfood\b", re.I), 60),        # "banana" -> babyfood juice
    (re.compile(r"\b(restaurant|fast ?food)\b", re.I), 40),
    (re.compile(r"^[A-Z][A-Z0-9'&., -]{4,}$"), 35),  # ALL-CAPS brand rows
    (re.compile(r"\b(applebee|mcdonald|burger king|kfc|domino|subway|denny|"
                r"wendy|taco bell|papa john|pizza hut|starbucks|kellogg|"
                r"general mills|kraft|nestle|hershey|pillsbury)\b", re.I), 45),
    (re.compile(r"\balcoholic beverage\b", re.I), 50),  # "rice" -> sake
    (re.compile(r"\b(vinegar|extract|flavou?ring|seasoning mix)\b", re.I), 30),
    (re.compile(r"\b(dry mix|dry powder|concentrate|dehydrated)\b", re.I), 20),
    (re.compile(r"\b(school lunch|reduced (sodium|fat|calorie)|low.fat|"
                r"fat.free|sugar.free|light|diet)\b", re.I), 12),
    (re.compile(r"\bnfs\b", re.I), 8),   # "not further specified"
    # Real foods, but nobody searching "chicken" means these. Correct
    # values, wrong default -- observed returning "Chicken, feet, boiled"
    # and "Chicken, skin" ahead of any actual meat cut.
    (re.compile(r"\b(feet|foot|skins?|giblets?|gizzards?|necks?|backs?|tails?|"
                r"livers?|hearts?|brains?|tripe|offal|bones?|cartilage|"
                r"combs?|blood|marrow|rinds?|trimmings)\b", re.I), 55),
    # Deli/processed forms: water-added, reformed sandwich meats at roughly
    # half the energy of the cut they are named after -- "chicken breast"
    # returned an oven-roasted deli slice at 79 kcal against a real breast's
    # 168. Kept HERE as a name penalty (precomputed, like every other entry)
    # rather than inside score(): it is a property of the food, not of the
    # query, and the in-score version silently failed to fire.
    (re.compile(r"\b(deli|luncheon|oven.roasted|honey.roasted|cold cut|"
                r"reformed|water added)\b", re.I), 160),
]

# Uncommon species/variants. "egg" should default to a hen's egg, not a
# duck or quail egg -- all correct data, but not what the word means to
# almost any user. Only penalised when the user did not name the species.
UNCOMMON_VARIANTS = {
    # "quial" is IFCT2017's own misspelling of quail in its row names
    # ("Egg, quial, whole, raw"), so the correctly-spelled entry never
    # matched them and a bare "egg" query resolved to a QUAIL egg.
    "duck", "quail", "quial", "goose", "emu", "ostrich", "turkey", "guinea", "pigeon",
    "capon", "capons", "stewing", "venison", "bison", "elk", "moose", "rabbit",
    "squirrel", "raccoon", "opossum", "beaver", "seal", "whale", "caribou",
    "navajo", "alaska", "apache", "shoshone", "hopi",
}

# COMPONENTS of a food, not the food. Caught by comparing model output
# against lab values on ordinary queries: "egg" returned "Egg, chicken,
# YOLK, cooked" at 351 kcal against a whole egg's 135 -- a +160% error on
# one of the most commonly logged foods in existence. A yolk is part of an
# egg, not an egg; likewise egg white, wheat bran, and milk fat.
COMPONENT_PARTS = {
    "yolk", "yolks", "white", "whites", "albumen", "bran", "germ",
    "husk", "peel", "rind", "pulp", "juice", "solids", "curds", "whey",
}

# Processed/deli forms sold ready-to-eat. "chicken breast" returned an
# oven-roasted deli slice at 79 kcal against real chicken breast at 168 --
# these are water-added, sliced sandwich meats, not the cut itself.
DELI_FORM_RE = re.compile(
    r"\b(deli|luncheon|oven.roasted|honey.roasted|smoked sliced|"
    r"sandwich (meat|slice)|cold cut|processed|reformed|"
    r"water added|sliced, prepackaged)\b", re.I)

STOPWORDS = {"raw", "fresh", "whole", "the", "and", "with", "without", "of", "in", "a"}

# Preparation/dish qualifiers. When the user queries a bare ingredient
# ("egg"), a prepared variant ("Egg, creamed", "Egg, Benedict") is a worse
# default than the plain food -- they asked for the ingredient, not a
# recipe built from it. Only applied when the qualifier is NOT in the
# query, so searching "fried egg" still ranks fried egg first.
PREP_WORDS = {
    # "poached" was the one egg preparation missing from a list holding every
    # other, so a bare "egg" answered with "Egg, chicken, whole, cooked,
    # POACHED". "omlet" is IFCT2017's spelling of the "omelet" already listed.
    "poached", "omlet",
    # An INGREDIENT OR AID used to make a dish is not the dish: "rasam"
    # returned "Rasam powder (Rasam masala)" -- a spice mix -- ahead of the
    # real rasam rows just below it. Penalised only when not asked for, so
    # "rasam powder" and "tomato paste" still rank their own product first.
    "powder", "paste", "concentrate", "essence", "seasoning", "premix",
    "creamed", "deviled", "benedict", "fried", "scrambled", "omelet", "omelette",
    "battered", "breaded", "stuffed", "glazed", "candied", "pickled", "smoked",
    "sauce", "salad", "soup", "stew", "curry", "casserole", "sandwich", "burger",
    "pie", "cake", "cookie", "chips", "kebab", "kabab", "roll", "wrap", "pizza",
    "juice", "drink", "shake", "smoothie", "dessert", "pudding", "custard",
    "creamy", "seasoned", "marinated", "canned", "frozen", "instant",
}


# Above this many targets an "alias" is a bulk-extraction artefact rather than
# a synonym and does not earn the exact-alias score floor. Of 4,006 aliases in
# food_aliases.json, 3,482 point at exactly one row and 3,971 (99.1%) at twelve
# or fewer; the nine broadest -- "alaska native" (108), "yogurt" (86), "dahi"
# (85), and literally "includes foods for usda s food distribution program"
# (54) -- are self-evidently not synonyms. A flat boost let all 86 of the
# "yogurt" targets (down to babyfood and yogurt-covered candy) outrank plain
# yogurt. Their tokens still feed the weaker regional_alias_tokens tier.
MAX_SPECIFIC_ALIAS_TARGETS = 12

# Words describing a container, category, size or negation but never naming a
# food. A relaxed query anchored only on these matches whatever rows share the
# packaging word: "zzzq-not-a-food" relaxed to "not food" and matched
# "...skin NOT eaten, from fast FOOD / restaurant". Only blocks a sub-query in
# which EVERY token is one of these. Explicit rather than an IDF cutoff --
# corpus frequency does not separate them ("food" 1.26% of rows sits between
# "chips" 1.26% and "broccoli" 1.40%).
NON_ANCHOR_TOKENS = {
    "food", "foods", "item", "items", "meal", "meals", "dish", "dishes",
    "recipe", "product", "products", "packet", "pack", "packed", "packaged",
    "plate", "bowl", "cup", "glass", "serving", "servings", "portion",
    "piece", "pieces", "slice", "slices", "homemade", "generic", "style",
    "mix", "assorted", "mixed", "other", "misc", "miscellaneous",
    "not", "no", "none", "free", "less", "more", "low", "high", "extra",
    "light", "regular", "small", "medium", "large", "big", "mini", "jumbo",
}

# Fields counted for the data-completeness tie-break.
COMPLETENESS_FIELDS = ("energy_kcal", "protein_g", "fat_g", "carb_g",
                       "fiber_g", "sugar_g", "sodium_mg")


def name_contains_query(norm_name, q_norm):
    """Does q_norm occur in norm_name as a WORD rather than buried inside a
    longer unrelated one?

    A plain `in` test says yes to "chole" inside "cholesterol", which returned
    "Mayonnaise dressing, no cholesterol" for one of the most common Indian
    dishes. A single-word query must line up with the START of some token and
    stay within a length slack scaled to the query -- half its length, capped
    at 3 -- which admits real inflections ("egg"->"eggs", "curd"->"curds",
    "tomato"->"tomatoes") while refusing to grow a short stem into an unrelated
    word ("car"->"carrot", "bag"->"bagel"). A multi-word query keeps plain
    phrase-contains: a space already implies a boundary.
    """
    if not norm_name or not q_norm:
        return False
    if q_norm not in norm_name:
        return False
    if " " in q_norm:
        return True
    slack = min(3, max(1, len(q_norm) // 2))
    return any(t.startswith(q_norm) and len(t) <= len(q_norm) + slack
               for t in norm_name.split())


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


class FoodSearch:
    def __init__(self, db_path=DB_PATH, alias_path=ALIAS_PATH):
        self.foods = json.loads(Path(db_path).read_text(encoding="utf-8"))
        for f in self.foods:
            f["_norm"] = f.get("search_name") or normalize(f["food_name"])
            f["_tokens"] = f["_norm"].split()
            f["_penalty"] = self._name_penalty(f["food_name"])
            f["_head"] = self._head_noun(f["food_name"])
            # The `brand` COLUMN was never searchable: _norm/_tokens come from
            # food_name alone, so "amul curd" could not reach a row stored as
            # {food_name: "Curd", brand: "Amul"} -- every query token must
            # match and "amul" matched nothing. Indexing brand tokens is what
            # makes an explicitly branded query resolvable at all, and (in
            # score) what tells a generic query it is looking at a product.
            f["_brand_tokens"] = set(normalize(f.get("brand") or "").split())
            # Cheap completeness count for a deterministic tie-break.
            f["_filled"] = sum(1 for k in COMPLETENESS_FIELDS if f.get(k) is not None) \
                + (1 if (f.get("serving_grams") or 0) > 0 else 0)

        # alias -> [source_id]. Lets "baingan bharta" reach a row stored as
        # "Brinjal bhartha (Baingan ka bhartha)", and "laddu" reach "ladoo".
        self.aliases = {}
        self._by_source_id = {f.get("source_id"): f for f in self.foods}
        p = Path(alias_path)
        if p.exists():
            self.aliases = json.loads(p.read_text(encoding="utf-8")).get("aliases", {})

        # Push alias TOKENS onto each food as well. Exact-phrase alias
        # lookup alone only catches queries typed exactly as the alias --
        # a bare "bhindi" would still miss a row whose alias is
        # "bhindi sabzi", because the canonical search_name has the
        # parenthetical (and therefore every regional word) stripped out.
        # Indexing the tokens makes single-word regional queries work.
        for alias, sids in self.aliases.items():
            toks = alias.split()
            for sid in sids:
                f = self._by_source_id.get(sid)
                if f is not None:
                    f.setdefault("_alias_tokens", set()).update(toks)
        for f in self.foods:
            f.setdefault("_alias_tokens", set())

    @staticmethod
    def _head_noun(name):
        """USDA/IFCT name generic foods as 'HeadNoun, qualifier, qualifier'
        ("Chicken, broilers or fryers, breast, meat only, raw"), while
        composite dishes are written as plain phrases ("Chicken stew",
        "Chicken kebab"). So the text before the first comma is the food's
        actual identity, and matching it means the row IS the queried food
        rather than a dish that merely contains it.

        This is what separates "chicken" -> chicken breast from "chicken"
        -> chicken stew, without needing a hand-maintained dish list."""
        return normalize((name or "").split(",")[0])

    @staticmethod
    def _name_penalty(name):
        return sum(pen for rx, pen in BRANDY_PENALTIES if rx.search(name or ""))

    def score(self, food, q_norm, q_tokens, alias_base=None):
        """alias_base: when this row is an EXACT-ALIAS target for the query,
        the base tier score that alias earns. It used to be applied in
        _search_exact_tokens INSTEAD of calling this method, so an alias hit
        skipped every penalty below -- brand, prep-word, extra-token,
        component-part, moisture. Passing it THROUGH keeps the alias as a floor
        on the match tier while the ordinary quality penalties still decide
        which alias target is actually the best answer.
        """
        name = food["_norm"]
        tokens = food["_tokens"]
        if not name:
            return None

        score = 0.0
        self._last_match_kind = None
        if name == q_norm:
            score += 1000                      # exact match dominates
            self._last_match_kind = "exact_name"
        elif food.get("_head") == q_norm:
            # The row's identity (text before first comma) IS the query:
            # "Chicken, broilers or fryers, breast" for query "chicken".
            # Ranked just under an exact match and above any dish that
            # merely starts with the same word ("Chicken stew").
            #
            # But the "HeadNoun, qualifier" convention is not universal:
            # "Cauliflower, pea and potato bhujia" has the right SHAPE yet
            # is a multi-ingredient dish, and the benchmark caught it
            # outranking plain cauliflower (96 kcal vs a true 23). When the
            # qualifier lists OTHER ingredients, this is a composite dish,
            # so it gets the weaker dish-level score instead.
            rest_of_name = (food.get("food_name") or "")[len(q_norm):].lower()
            looks_composite = bool(re.search(r"\band\b|\bwith\b|\bmixed\b", rest_of_name))
            score += 300 if looks_composite else 800
        elif name.startswith(q_norm + " "):
            score += 500                       # "rice, white" for query "rice"
            self._last_match_kind = "name_prefix"
        else:
            matched = sum(1 for t in q_tokens if t in tokens)
            alias_toks = food.get("_alias_tokens") or ()
            alias_matched = sum(1 for t in q_tokens if t in alias_toks)
            # Same tiers and numbers as before, expressed as a value so a
            # "nothing matched lexically" verdict can fall back to the alias
            # floor instead of returning out of the whole scorer.
            lexical = None
            if matched == 0 and alias_matched == 0:
                # substring, but only at a word boundary -- see
                # name_contains_query ("chole" vs "cholesterol")
                if name_contains_query(name, q_norm):
                    lexical = (40, "substring")
            elif matched >= alias_matched:
                # every query token must appear for multi-word queries
                if matched >= len(q_tokens):
                    # earlier position = more likely the head noun
                    first = min(tokens.index(t) for t in q_tokens if t in tokens)
                    lexical = (200 - first * 12, "all_tokens")
            else:
                # matched via regional-name tokens only. Every query token
                # must still be accounted for by name OR alias, so a
                # 2-word query cannot match on one word alone.
                covered = sum(1 for t in q_tokens if t in tokens or t in alias_toks)
                if covered >= len(q_tokens):
                    lexical = (180, "regional_alias_tokens")

            if lexical is not None:
                score += lexical[0]
                self._last_match_kind = lexical[1]
            elif alias_base is None:
                # nothing lexical and no alias floor -- not a candidate
                return None
            else:
                self._last_match_kind = "alias_exact"

        # The alias floor: an exact-alias target can never score BELOW what the
        # alias itself is worth, but everything after this point still applies.
        if alias_base is not None and alias_base > score:
            score = float(alias_base)
            self._last_match_kind = "alias_exact"

        # generic-ness: each extra qualifier token past the query costs a
        # little. Weighted by how specific the QUERY was: a one-word query is a
        # strong signal the user wants the plain food ("egg" should not land on
        # "Egg, chicken, whole, cooked, poached"), while multi-word queries are
        # already specific and keep the gentler penalty.
        extra = max(0, len(tokens) - len(q_tokens))
        score -= extra * (20 if len(q_tokens) == 1 else 6)

        q_set = set(q_tokens)

        # BRANDED PRODUCT vs GENERIC FOOD. A branded row stores only the
        # product half of its identity in food_name -- the Amul carton is
        # {food_name: "Milk", brand: "Amul"} -- so it took the full exact-name
        # 1000 for the query "milk" and beat IFCT's lab-measured "Milk, whole,
        # Cow". Naming the brand boosts that product; not naming one demotes
        # it, by enough to fall behind a genuine generic head-noun match (800)
        # without ever suppressing it when it is the only candidate.
        if food["_brand_tokens"]:
            query_names_brand = any(t in q_set for t in food["_brand_tokens"])
            score += 120 if query_names_brand else -180
            if query_names_brand:
                self._last_match_kind = "brand_match"

        # preparation qualifiers the user did not ask for
        prep_hits = sum(1 for t in tokens if t in PREP_WORDS and t not in q_set)
        score -= prep_hits * 45

        # uncommon species/regional variants the user did not ask for
        rare_hits = sum(1 for t in tokens if t in UNCOMMON_VARIANTS and t not in q_set)
        score -= rare_hits * 40

        # a COMPONENT of the food is not the food ("egg" != egg yolk)
        part_hits = sum(1 for t in tokens if t in COMPONENT_PARTS and t not in q_set)
        score -= part_hits * 90

        # A bare one-word query is asking for the INGREDIENT, not a dish made
        # from it. INDB is ranked first overall (right for "masala dosa"), but
        # that made "brinjal" return "Brinjal bhartha" -- 65 kcal for a dish
        # against 25 for the vegetable, a +157% error. Only applies when the
        # query is a single word and the row is a composite dish, so
        # multi-word dish queries are untouched.
        if len(q_tokens) == 1 and food.get("category") == "indian_dish" \
                and len(tokens) > len(q_tokens):
            score -= 120

        # deli/processed forms when the user asked for the plain cut

        # "Rice, cooked, WITH MILK" is rice plus something else. For a bare
        # "rice" query the plain entry is the better default, so added
        # ingredients cost -- but only when the user did not name them.
        raw_name = (food.get("food_name") or "").lower()
        if re.search(r"\b(with|w/)\b", raw_name):
            after = re.split(r"\b(?:with|w/)\b", raw_name, maxsplit=1)[-1]
            if not any(t in after for t in q_set):
                score -= 25

        # COOKING STATE -- the largest measured error source in this pipeline.
        # Rice is 358 kcal/100g raw and 130 cooked (2.75x). A user typing
        # "rice" means the cooked rice they are about to eat, so defaulting
        # to the raw entry is a 342 kcal error on a single 150g portion.
        # Rank by the state the food is actually EATEN in; the opposite
        # state stays reachable, just not the default.
        state = food.get("cooking_state")
        eaten_as = expected_state(food.get("food_name"))
        if eaten_as and state in ("raw", "cooked"):
            score += 70 if state == eaten_as else -70
        elif state == "raw":
            # no strong prior: plain/unprocessed is still the better default
            score += 10

        # MOISTURE STATE -- measured as an even bigger error source than
        # cooking state. Drying strips ~80-90% of a fruit's water while
        # keeping its energy, so density rises 5-12x. Benchmark caught
        # "papaya" resolving to dried papaya: 302 kcal vs 24 (+1164%).
        # Penalised only when the user did not ask for it.
        if moisture_mismatch(food.get("food_name")) and not (
                q_set & {"dried", "dry", "dehydrated", "powder", "raisin", "prune"}):
            score -= 120
        score -= food["_penalty"]
        score -= SOURCE_RANK.get(food.get("source"), 5) * 4

        # a dish entry with a real serving size is more useful for logging
        if food.get("serving_grams"):
            score += 8
        # A QUARANTINED ROW IS UNUSABLE, NOT MERELY WORSE. The estimator
        # refuses to let an untrustworthy row contribute a number at all, so
        # ranking one above a usable row does not trade accuracy for some other
        # quality -- it trades an answer for NO answer. At -150 this was
        # smaller than the -180 a branded row now pays, which inverted exactly
        # that comparison. The penalty has to exceed every penalty a USABLE row
        # can accumulate.
        if food.get("data_quality_flag"):
            score -= 400
        return score

    def search(self, query, limit=8, cuisine=None, _allow_backoff=True):
        q_norm = normalize(query)
        if not q_norm:
            return []
        q_tokens = [t for t in q_norm.split() if t not in STOPWORDS] or q_norm.split()

        results = self._search_exact_tokens(q_norm, q_tokens, limit, cuisine)
        if results or not _allow_backoff or len(q_tokens) < 2:
            return results

        # PROGRESSIVE BACKOFF. Every query token must normally be present,
        # which is right for precision but returns NOTHING for a query like
        # "apple big" when the database holds "Apples, raw". The benchmark
        # measured this as the single largest cause of unresolved queries.
        #
        # WHICH END TO KEEP IS NOT FIXED. Dropping only trailing tokens had it
        # backwards for the commonest phrasing: in "medium apple", "grilled
        # tofu", "black coffee", "masala chai" the HEAD NOUN is LAST, so
        # discarding the tail threw away the food and searched on the modifier,
        # which reliably matched something unrelated sharing that adjective
        # ("1 medium apple" -> "Beef, ground, MEDIUM, baked"). But the
        # convention is not universal either -- Indian dish names often lead
        # with the head noun ("rajma chawal") -- so both forms are tried at
        # each depth and the one whose best hit SCORES HIGHER wins. Depth still
        # takes precedence over score, because a shorter query trivially scores
        # higher and ranking purely on score would discard as much of the
        # user's query as possible.
        #
        # At most HALF the query may be discarded, and what remains must still
        # name a food (NON_ANCHOR_TOKENS) and earn a positive score --
        # otherwise "zzqxvv-not-a-real-ingredient" "matches" by anchoring on
        # "real", and "xyyzqq nonfoodterm 500g" on the pack size "500g".
        max_drop = len(q_tokens) // 2
        for drop in range(1, max_drop + 1):
            subs = (q_tokens[drop:], q_tokens[:-drop])   # keep tail, keep head
            best = None
            for sub in subs:
                if not sub:
                    continue
                if all(t in NON_ANCHOR_TOKENS for t in sub):
                    continue
                hits = self._search_exact_tokens(" ".join(sub), sub, limit, cuisine)
                if not hits:
                    continue
                top = hits[0].get("_score")
                if top is None or top <= 0:
                    continue
                if best is None or top > best[0]:
                    best = (top, hits, sub)
            if best is not None:
                _, hits, sub = best
                kept = set(sub)
                for r in hits:
                    r["matched_on"] = " ".join(sub)
                    r["query_relaxed"] = True
                    r["unmatched_query_terms"] = [t for t in q_tokens if t not in kept]
                return hits
        return []

    def _search_exact_tokens(self, q_norm, q_tokens, limit, cuisine):

        # Alias hits are scored as strongly as a direct name match, because
        # an alias IS the food's name in another language/romanisation --
        # "baingan bharta" is not a fuzzy guess at "Brinjal bhartha", it is
        # the same dish written the way the user actually says it.
        # Only a SPECIFIC alias earns the floor -- see
        # MAX_SPECIFIC_ALIAS_TARGETS. An over-broad alias is not discarded:
        # its tokens still feed the regional_alias_tokens tier in score().
        alias_boost = {}
        direct = self.aliases.get(q_norm, [])
        if direct and len(direct) <= MAX_SPECIFIC_ALIAS_TARGETS:
            for sid in direct:
                alias_boost[sid] = 900
        if not alias_boost:
            # multi-word query: try the alias table on the token-sorted form
            key = " ".join(sorted(q_tokens))
            for a, ids in self.aliases.items():
                if " ".join(sorted(a.split())) == key:
                    if len(ids) <= MAX_SPECIFIC_ALIAS_TARGETS:
                        for sid in ids:
                            alias_boost[sid] = 850
                    break

        scored = []
        for f in self.foods:
            if cuisine and f.get("cuisine") != cuisine:
                continue
            # The alias floor goes THROUGH the scorer rather than around it, so
            # an alias target still pays the brand / prep-word / extra-token /
            # source-quality penalties every other candidate pays.
            s = self.score(f, q_norm, q_tokens,
                           alias_base=alias_boost.get(f.get("source_id")))
            kind = self._last_match_kind
            if s is not None:
                scored.append((s, f, kind))
        # TIE-BREAK, IN ORDER: score, shorter (more generic) name, better
        # source, more completely measured, then source_id for a total, stable
        # order. Ties are not a corner case: "curd" returns five rows named
        # exactly "Curd" (43.5-77 kcal/100 g) with identical scores AND
        # identical name lengths, so the winner was decided by their position
        # in the source JSON -- a 77%-wide spread of answers behind an
        # arbitrary ordering.
        scored.sort(key=lambda x: (-x[0], len(x[1]["_norm"]),
                                   SOURCE_RANK.get(x[1].get("source"), 5),
                                   -x[1]["_filled"],
                                   str(x[1].get("source_id"))))

        out = []
        for s, f, match_kind in scored[:limit]:
            out.append({
                "food_name": f["food_name"],
                "energy_kcal": f.get("energy_kcal"),
                "protein_g": f.get("protein_g"),
                "fat_g": f.get("fat_g"),
                "carb_g": f.get("carb_g"),
                "source": f.get("source"),
                "cuisine": f.get("cuisine"),
                "cooking_state": f.get("cooking_state"),
                "serving_description": f.get("serving_description"),
                "serving_grams": f.get("serving_grams"),
                "source_id": f.get("source_id"),
                "_score": round(s, 1),
            })
            # A known-bad row is deprioritised by scoring, but when it is the
            # ONLY match for a query it still surfaces -- and silently serving
            # a value we have already proven wrong is worse than saying so.
            # The flag travels with the result so the caller can warn or
            # withhold rather than present it as a clean number.
            if f.get("data_quality_flag"):
                out[-1]["data_quality_flag"] = f["data_quality_flag"]
                out[-1]["trustworthy"] = False
            else:
                out[-1]["trustworthy"] = True

            # CONFIDENCE, calibrated against the end-to-end benchmark
            # (IFCT held out, queried by common name, n=365):
            #     exact / alias match      -> the food itself; lab value
            #     strict token match       -> 31.6% median APE, 44% within 25%
            #     relaxed (terms dropped)  -> 50.2% median APE, 32% within 25%
            # Relaxed matches are kept because without them 72% of real
            # queries return nothing -- but they are labelled, never
            # presented with the same weight as an exact match.
            # Derived from HOW the food matched, not from the blended
            # score. An earlier version thresholded on score and produced
            # an inverted ranking -- "high" measured 34.4% median APE while
            # "medium" measured 24.9% -- because the score mixes alias
            # boosts, penalties and source rank, so equal scores did not
            # mean equal match quality. Match kind is the honest signal.
            out[-1]["match_kind"] = match_kind

            # Confidence is driven by TOKEN OVERLAP between the query and
            # the matched food's name, not by match kind alone. Two earlier
            # attempts were non-monotonic against the benchmark:
            #   * score thresholds  -> "high" 34.4% vs "medium" 24.9% APE
            #   * match kind        -> "medium" 64.7% vs "low" 37.4% APE
            # Both failed for the same reason: a head-noun hit on a short
            # query ("amaranth" -> amaranth GRAIN when the user meant
            # amaranth LEAVES) looks structurally strong while being the
            # wrong food. Overlap measures what actually matters -- how
            # much of each name the other one accounts for.
            m_tokens = set(f["_tokens"]) | set(f.get("_alias_tokens") or ())
            q_set_c = set(q_tokens)
            inter = len(q_set_c & m_tokens)
            q_cov = inter / max(1, len(q_set_c))       # query explained by match
            m_cov = inter / max(1, len(set(f["_tokens"])))  # match explained by query
            overlap = min(q_cov, m_cov)
            out[-1]["_overlap"] = round(overlap, 2)

            if not out[-1]["trustworthy"]:
                conf = "unreliable"
            elif match_kind in ("exact_name", "alias_exact") or overlap >= 0.65:
                conf = "high"
            elif overlap >= 0.40:
                conf = "medium"
            else:
                conf = "low"
            out[-1]["confidence"] = conf

            # Household portions sized FOR THIS FOOD. Users log "1 katori",
            # not "150 g", and a portion is a volume -- a bowl of dal and a
            # bowl of salad differ ~3x in mass -- so the gram figure has to
            # be computed per food rather than published as a constant.
            out[-1]["portions"] = list_portions(
                f.get("food_name"), density_for, f.get("cooking_state"))
        return out


if __name__ == "__main__":
    import sys
    fs = FoodSearch()
    queries = sys.argv[1:] or [
        "chicken", "rice", "egg", "banana", "milk", "apple", "paneer", "roti",
        "dal", "dosa", "idli", "poha", "biryani", "samosa", "curd", "oats",
    ]
    for q in queries:
        res = fs.search(q, limit=3)
        print(f"\n{q!r}")
        for r in res:
            serv = f" | 1 {r['serving_description']} = {r['serving_grams']}g" if r.get("serving_grams") else ""
            print(f"   {r['_score']:7.1f}  {r['food_name'][:52]:52s} {str(r['energy_kcal']):>7}kcal [{r['source']}]{serv}")
