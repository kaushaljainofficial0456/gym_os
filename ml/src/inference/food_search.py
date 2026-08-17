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
except ImportError:  # running as a script rather than a package
    from cooking_state import expected_state, CookingStateResolver, moisture_mismatch

SOURCE_RANK = {"INDB": 0, "IFCT2017": 1, "USDA_FDC": 2, "OPEN_FOOD_FACTS": 3}

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
]

# Uncommon species/variants. "egg" should default to a hen's egg, not a
# duck or quail egg -- all correct data, but not what the word means to
# almost any user. Only penalised when the user did not name the species.
UNCOMMON_VARIANTS = {
    "duck", "quail", "goose", "emu", "ostrich", "turkey", "guinea", "pigeon",
    "capon", "capons", "stewing", "venison", "bison", "elk", "moose", "rabbit",
    "squirrel", "raccoon", "opossum", "beaver", "seal", "whale", "caribou",
    "navajo", "alaska", "apache", "shoshone", "hopi",
}

STOPWORDS = {"raw", "fresh", "whole", "the", "and", "with", "without", "of", "in", "a"}

# Preparation/dish qualifiers. When the user queries a bare ingredient
# ("egg"), a prepared variant ("Egg, creamed", "Egg, Benedict") is a worse
# default than the plain food -- they asked for the ingredient, not a
# recipe built from it. Only applied when the qualifier is NOT in the
# query, so searching "fried egg" still ranks fried egg first.
PREP_WORDS = {
    "creamed", "deviled", "benedict", "fried", "scrambled", "omelet", "omelette",
    "battered", "breaded", "stuffed", "glazed", "candied", "pickled", "smoked",
    "sauce", "salad", "soup", "stew", "curry", "casserole", "sandwich", "burger",
    "pie", "cake", "cookie", "chips", "kebab", "kabab", "roll", "wrap", "pizza",
    "juice", "drink", "shake", "smoothie", "dessert", "pudding", "custard",
    "creamy", "seasoned", "marinated", "canned", "frozen", "instant",
}


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

    def score(self, food, q_norm, q_tokens):
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
            if matched == 0 and alias_matched == 0:
                # allow substring only as a weak last resort
                if q_norm not in name:
                    return None
                score += 40
                self._last_match_kind = "substring"
            elif matched >= alias_matched:
                if matched < len(q_tokens):
                    # every query token must appear for multi-word queries
                    return None
                score += 200
                self._last_match_kind = "all_tokens"
                # earlier position = more likely the head noun
                first = min(tokens.index(t) for t in q_tokens if t in tokens)
                score -= first * 12
            else:
                # matched via regional-name tokens only. Every query token
                # must still be accounted for by name OR alias, so a
                # 2-word query cannot match on one word alone.
                covered = sum(1 for t in q_tokens if t in tokens or t in alias_toks)
                if covered < len(q_tokens):
                    return None
                score += 180
                self._last_match_kind = "regional_alias_tokens"

        # generic-ness: each extra qualifier token past the query costs a little
        extra = max(0, len(tokens) - len(q_tokens))
        score -= extra * 6

        # preparation qualifiers the user did not ask for
        q_set = set(q_tokens)
        prep_hits = sum(1 for t in tokens if t in PREP_WORDS and t not in q_set)
        score -= prep_hits * 45

        # uncommon species/regional variants the user did not ask for
        rare_hits = sum(1 for t in tokens if t in UNCOMMON_VARIANTS and t not in q_set)
        score -= rare_hits * 40

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
        # never surface rows we know are internally inconsistent
        if food.get("data_quality_flag"):
            score -= 150
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
        # So drop trailing qualifier tokens one at a time -- the head noun
        # is the food's identity and is dropped last -- and mark the result
        # as relaxed so the caller knows the qualifier went unmatched.
        for drop in range(1, len(q_tokens)):
            sub = q_tokens[:-drop]
            if not sub:
                break
            results = self._search_exact_tokens(" ".join(sub), sub, limit, cuisine)
            if results:
                for r in results:
                    r["matched_on"] = " ".join(sub)
                    r["query_relaxed"] = True
                    r["unmatched_query_terms"] = q_tokens[-drop:]
                return results
        return []

    def _search_exact_tokens(self, q_norm, q_tokens, limit, cuisine):

        # Alias hits are scored as strongly as a direct name match, because
        # an alias IS the food's name in another language/romanisation --
        # "baingan bharta" is not a fuzzy guess at "Brinjal bhartha", it is
        # the same dish written the way the user actually says it.
        alias_boost = {}
        for sid in self.aliases.get(q_norm, []):
            alias_boost[sid] = 900
        if not alias_boost:
            # multi-word query: try the alias table on the token-sorted form
            key = " ".join(sorted(q_tokens))
            for a, ids in self.aliases.items():
                if " ".join(sorted(a.split())) == key:
                    for sid in ids:
                        alias_boost[sid] = 850
                    break

        scored = []
        for f in self.foods:
            if cuisine and f.get("cuisine") != cuisine:
                continue
            s = self.score(f, q_norm, q_tokens)
            kind = self._last_match_kind
            boost = alias_boost.get(f.get("source_id"))
            if boost is not None:
                base = s if s is not None else 0.0
                relaxed = boost - f["_penalty"] - SOURCE_RANK.get(f.get("source"), 5) * 4
                if relaxed >= base:
                    s, kind = relaxed, "alias_exact"
                else:
                    s = base
            if s is not None:
                scored.append((s, f, kind))
        scored.sort(key=lambda x: (-x[0], len(x[1]["_norm"])))

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
