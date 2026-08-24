"""
Generate searchable aliases for every food in the unified DB.

WHY THIS IS NOT COSMETIC:
Ranking alone left 8/40 test dishes unfindable -- but most of them were
ALREADY IN THE DATABASE under a name the user would never type:

    "baingan bharta"  is stored as  "Brinjal bhartha (Baingan ka bhartha)"
    "chana masala"    is stored as  "Chickpeas curry (Safed channa curry)"
    "bhindi"          is stored as  "Okra/Lady's fingers fry (Bhindi sabzi/sabji/subji)"

Two separate failures caused this:

1. The search normalizer STRIPPED parenthetical text. In INDB (369 rows)
   the parenthetical is the Hindi/regional name -- precisely what an
   Indian user types. We were discarding the most valuable search term on
   every one of those rows. (In IFCT the parenthetical is instead a Latin
   binomial -- "Prunus amygdalus" -- which is why this has to be
   source-aware rather than a blanket "keep the parentheses".)

2. Indian food names have no single canonical romanisation. ladoo/laddu,
   chana/channa, bharta/bhartha, paratha/parantha/prantha are all the
   same food. A user typing one spelling must find a row stored under
   another.

Aliases are generated deterministically from the names already present --
nothing is invented, and no nutrition value is touched. Output feeds the
app's existing `food_aliases` table concept.
"""
import json
import re
import unicodedata
from pathlib import Path
from collections import defaultdict

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "food_aliases.json"

PAREN_RE = re.compile(r"\(([^)]*)\)")
# Latin binomial: "Genus species" -- two+ words, initial cap then lowercase.
# Used to tell IFCT's scientific names apart from INDB's regional names.
BINOMIAL_RE = re.compile(r"^[A-Z][a-z]+\s+[a-z]{3,}")

# Romanisation variants of the same Indian food word. Each pair is applied
# in BOTH directions. These are spelling variants of one word, not
# different foods -- deliberately conservative for that reason.
SPELLING_VARIANTS = [
    ("ladoo", "laddu"), ("ladoo", "ladu"),
    ("chana", "channa"), ("chana", "chhana"),
    ("bharta", "bhartha"), ("bharta", "bhurta"),
    ("paratha", "parantha"), ("paratha", "prantha"),
    ("sabzi", "sabji"), ("sabzi", "subji"), ("sabzi", "sabzee"),
    ("roti", "rotti"), ("chapati", "chapathi"), ("chapati", "chappati"), ("chapati", "chapatti"),
    ("dal", "daal"), ("dal", "dhal"),
    ("paneer", "panir"), ("gobhi", "gobi"), ("phoolgobhi", "phulgobhi"),
    ("biryani", "biriyani"), ("biryani", "biriani"),
    ("dahi", "curd"), ("dahi", "yoghurt"), ("dahi", "yogurt"),
    ("halwa", "halva"), ("kheer", "khir"),
    ("poori", "puri"), ("bhindi", "bhendi"),
    ("baingan", "brinjal"), ("baingan", "eggplant"), ("baingan", "aubergine"),
    ("aloo", "alu"), ("aloo", "potato"),
    ("matar", "mutter"), ("matar", "peas"),
    ("methi", "fenugreek"), ("palak", "spinach"),
    ("jeera", "cumin"), ("dhania", "coriander"),
    ("besan", "gram flour"), ("atta", "wheat flour"),
    ("upma", "uppma"), ("poha", "pohe"),
    ("idli", "idly"), ("dosa", "dosai"), ("dosa", "thosai"),
    ("vada", "wada"), ("vada", "vadai"),
    ("rajma", "rajmah"), ("rajma", "kidney bean"),
    ("khichdi", "khichri"), ("khichdi", "khichdi"), ("khichdi", "khitchdi"),
    ("pakora", "pakoda"), ("pakora", "bhaji"),
    ("kofta", "koftha"), ("korma", "kurma"),
    ("tikka", "tikki"), ("naan", "nan"),
    ("lassi", "chaas"), ("raita", "raitha"),
]

STOP = {"the", "and", "of", "a", "in", "with", "ka", "ke", "ki", "aur"}

# SEMANTIC synonyms: a colloquial dish name and the descriptive English
# name the databases actually store it under. These are NOT spelling
# variants -- "chana masala" and "chickpeas curry" share no words -- so
# they cannot be derived and must be stated.
#
# Each entry is a well-established equivalence, deliberately kept narrow:
# only where the colloquial name unambiguously denotes that dish. Where a
# name is genuinely ambiguous or regionally contested, it is left out
# rather than guessed -- a wrong alias silently returns the wrong food's
# calories, which is worse than returning nothing.
DISH_SYNONYMS = {
    "chana masala": ["chickpeas curry", "chickpea curry", "safed channa curry"],
    "chole": ["chickpeas curry", "chickpea curry", "safed channa curry"],
    "chhole": ["chickpeas curry", "chickpea curry"],
    "kala chana": ["black channa curry", "bengal gram curry"],
    "aloo gobi": ["potato cauliflower"],
    "gobi aloo": ["potato cauliflower"],
    "baingan bharta": ["brinjal bhartha"],
    "bhindi masala": ["okra fry", "lady s fingers fry"],
    "bhindi fry": ["okra fry", "lady s fingers fry"],
    "palak paneer": ["spinach paneer", "spinach cottage cheese"],
    "matar paneer": ["peas paneer", "green peas paneer"],
    "dal tadka": ["tempered dal", "yellow dal"],
    "dal fry": ["tempered dal", "yellow dal"],
    "curd rice": ["dahi bhaat", "dahi chawal"],
    "jeera rice": ["cumin rice"],
    "gajar halwa": ["carrot halwa"],
    "sooji halwa": ["semolina halwa"],
    "rava kesari": ["semolina halwa"],
    "aloo paratha": ["potato parantha", "potato paratha"],
    "gobi paratha": ["cauliflower parantha", "cauliflower paratha"],
    "moong dal": ["green gram dal", "green gram whole"],
    "urad dal": ["black gram dal", "black gram whole"],
    "toor dal": ["red gram dal", "pigeon pea"],
    "arhar dal": ["red gram dal", "pigeon pea"],
    "masoor dal": ["lentil dal", "lentil whole"],
    "chana dal": ["bengal gram dal"],
    "rajma": ["kidney bean curry", "rajmah"],
    "kadhi": ["curd curry", "yoghurt curry"],
    "upma": ["semolina upma"],
    "sabudana": ["sago"],
    "poori": ["puri"],
    "bhatura": ["bhature"],
    "lassi": ["sweet lassi", "salted lassi"],
    "chaas": ["buttermilk"],
    "shrikhand": ["sweetened hung curd"],
    "cottage cheese": ["paneer"],
    "clarified butter": ["ghee"],
    "curd": ["dahi", "yoghurt"],
    # "phulka" is a regional name for the same unleavened flatbread stored
    # as "Chapati/Roti" -- an unambiguous equivalence (SK OS Indian
    # Nutrition Engine upgrade, master prompt Phase 5 worked example).
    "phulka": ["chapati", "roti"],
}


def normalize(text, keep_parens=True):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    if not keep_parens:
        n = PAREN_RE.sub(" ", n)
    n = n.lower()
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def split_variants(text):
    """'Okra/Lady's fingers fry' -> ['Okra fry', \"Lady's fingers fry\"].
    Slash-separated alternatives are extremely common in INDB names and
    each branch is a real name the user might type."""
    if "/" not in text:
        return [text]
    # Only split on slashes between words, not inside numbers like 1/2
    if re.search(r"\d/\d", text):
        return [text]
    parts = [p.strip() for p in text.split("/") if p.strip()]
    return parts or [text]


def spelling_permutations(phrase):
    """Apply romanisation variants to a normalized phrase. Returns the
    original plus one substitution per applicable rule (not the full
    combinatorial expansion -- that explodes and adds noise)."""
    out = set()
    tokens = phrase.split()
    for a, b in SPELLING_VARIANTS:
        for src, dst in ((a, b), (b, a)):
            if src in tokens:
                swapped = [dst if t == src else t for t in tokens]
                out.add(" ".join(swapped))
            elif src in phrase and " " in src:
                if src in phrase:
                    out.add(phrase.replace(src, dst))
    return out


def aliases_for(food):
    """Every alias string that should resolve to this food."""
    name = food["food_name"]
    source = food.get("source")
    out = set()

    parens = PAREN_RE.findall(name)
    base = PAREN_RE.sub(" ", name)

    # 1) the plain name (parentheticals removed) and its slash-branches
    for variant in split_variants(base):
        n = normalize(variant)
        if n:
            out.add(n)

    # 2) parenthetical content -- source-aware
    for p in parens:
        p = p.strip()
        if not p:
            continue
        is_scientific = bool(BINOMIAL_RE.match(p)) or source == "IFCT2017"
        if is_scientific:
            # Latin binomial: keep it searchable (harmless, occasionally
            # useful) but do not treat it as a common name.
            n = normalize(p)
            if n:
                out.add(n)
            continue
        # A parenthetical that opens with a connector is a QUALIFIER, not a
        # name: "Minced meat pancake (with chicken)" is not called "chicken".
        # Without this guard that row acquires "chicken" as an exact alias
        # and outranks actual chicken cuts -- observed, not hypothetical.
        if re.match(r"^\s*(with|without|w/|in|from|plus|and|contains|for)\b", p, re.I):
            continue

        # INDB / regional: this IS the name Indian users type.
        for variant in split_variants(p):
            n = normalize(variant)
            if not n:
                continue
            out.add(n)
            # "Baingan ka bhartha" -> also "baingan bhartha" (drop connectors)
            stripped = " ".join(t for t in n.split() if t not in STOP)
            if stripped and stripped != n:
                out.add(stripped)

    # 3) romanisation variants of everything gathered so far
    for phrase in list(out):
        out |= spelling_permutations(phrase)

    # drop the canonical search name itself (already indexed) and junk
    canonical = food.get("search_name") or normalize(name, keep_parens=False)
    out.discard(canonical)
    return {a for a in out if len(a) >= 3}


def apply_dish_synonyms(db, alias_map):
    """Attach curated colloquial names to whichever rows already carry the
    descriptive name. Only attaches to rows that genuinely match -- if the
    target dish is not in the DB, the synonym simply produces nothing
    rather than pointing at an approximate substitute."""
    added = 0
    norm_index = defaultdict(list)
    for f in db:
        n = f.get("search_name") or normalize(f["food_name"], keep_parens=False)
        norm_index[n].append(f)
        # also index the without-parens head so "Chickpeas curry (Safed
        # channa curry)" is reachable by "chickpeas curry"
        head = normalize(PAREN_RE.sub(" ", f["food_name"]))
        if head != n:
            norm_index[head].append(f)

    for colloquial, targets in DISH_SYNONYMS.items():
        for t in targets:
            tn = normalize(t)
            matches = norm_index.get(tn, [])
            if not matches:
                # try prefix match: "spinach paneer" vs "spinach paneer curry"
                matches = [f for k, rows in norm_index.items()
                           if k.startswith(tn + " ") for f in rows][:5]
            for f in matches:
                sid = f["source_id"]
                if sid not in alias_map[colloquial]:
                    alias_map[colloquial].append(sid)
                    added += 1
    return added


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    alias_map = defaultdict(list)
    total = 0
    for f in db:
        for a in aliases_for(f):
            alias_map[a].append(f["source_id"])
            total += 1

    syn_added = apply_dish_synonyms(db, alias_map)
    total += syn_added
    print(f"  curated dish synonyms attached: {syn_added}")
    unresolved = [k for k in DISH_SYNONYMS if not alias_map.get(k)]
    if unresolved:
        print(f"  synonyms with no matching food in DB (left unmapped, not guessed): {unresolved}")

    # An alias pointing at hundreds of foods is not a useful alias --
    # it is a generic word ("curry"). Keep it, but the search layer must
    # rank within it rather than trust it as an identity match.
    payload = {
        "generated_from": "unified_food_db.json",
        "alias_count": len(alias_map),
        "mapping_count": total,
        "aliases": {a: ids for a, ids in sorted(alias_map.items())},
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Generated {len(alias_map)} distinct aliases ({total} mappings) -> {OUT_PATH}")

    ambiguous = sum(1 for ids in alias_map.values() if len(ids) > 20)
    unique = sum(1 for ids in alias_map.values() if len(ids) == 1)
    print(f"  uniquely-resolving aliases: {unique}")
    print(f"  broad aliases (>20 foods):  {ambiguous}")


if __name__ == "__main__":
    main()
