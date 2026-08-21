"""
Stream-filter the Open Food Facts bulk export for India products.

WHY BULK INSTEAD OF THE API:
The paginated search API started returning HTTP 401/503 partway through a
226-page pull and never recovered (10 of 226 pages succeeded). Open Food
Facts publishes an official full export precisely so that bulk consumers
do not hammer the API -- so this uses the sanctioned route rather than
trying to slip past the block. It also returns MORE than the API would
have: the whole catalogue, from which India rows are selected locally.

MEMORY: the export is ~1.3 GB gzipped and ~10 GB raw, so it is never
loaded into memory. It is read line by line straight out of the gzip
stream and only matching rows are kept.

TSV QUIRK: this file is TAB-separated (despite the .csv name) and contains
unescaped quote characters in product names, so QUOTE_NONE is required --
the default parser silently swallows rows and merges fields otherwise.
"""
import csv
import gzip
import json
import sys
from pathlib import Path

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "off_bulk" / "off_products.csv.gz"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "off_india_bulk.json"

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

WANT = {
    "code": "code",
    "product_name": "product_name",
    "brands": "brands",
    "categories_en": "categories",
    "countries_en": "countries",
    "serving_size": "serving_size",
    "energy-kcal_100g": "energy_kcal",
    "proteins_100g": "protein_g",
    "fat_100g": "fat_g",
    "carbohydrates_100g": "carb_g",
    "fiber_100g": "fiber_g",
    "sugars_100g": "sugar_g",
    "sodium_100g": "sodium_g",
    "calcium_100g": "calcium_g",
    "iron_100g": "iron_g",
}


# Animal feed and non-edibles occasionally appear in the crowd-sourced
# catalogue. Deliberately NARROW: an earlier draft matched a bare "pet"
# and flagged "Thumbs Up 750ml pet", "Horlicks 450g pet" and
# "Paper boat coconut water 200ml pet" -- where "PET" is the plastic the
# bottle is made from, not pet food. 5 of 7 hits were false positives, so
# the pattern now requires the feed sense explicitly.
NONFOOD_RE = None
try:
    import re as _re
    NONFOOD_RE = _re.compile(
        r"\b(animal\s*feed|cattle\s*feed|goat\s*feed|poultry\s*feed|"
        r"pet\s*food|dog\s*food|cat\s*food|fodder|forage|birdseed|"
        r"feed\s*grade|fertili[sz]er|non.?edible)\b", _re.I)
except Exception:  # pragma: no cover
    NONFOOD_RE = None


def to_float(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def main():
    if not RAW.exists():
        print(f"missing {RAW}")
        return 1

    kept, scanned, bad = [], 0, 0
    with gzip.open(RAW, "rt", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE)
        for row in reader:
            scanned += 1
            if scanned % 500000 == 0:
                print(f"  scanned {scanned:,}  kept {len(kept):,}", flush=True)
            countries = (row.get("countries_en") or "")
            if "india" not in countries.lower():
                continue
            name = (row.get("product_name") or "").strip()
            kcal = to_float(row.get("energy-kcal_100g"))
            if not name or kcal is None:
                continue
            # A packaged food above ~900 kcal/100g is impossible (pure fat is
            # ~900); these are unit-entry errors by contributors.
            if not (0 < kcal <= 900):
                bad += 1
                continue
            if NONFOOD_RE is not None and (
                    NONFOOD_RE.search(name)
                    or NONFOOD_RE.search(row.get("categories_en") or "")):
                bad += 1
                continue
            rec = {"source_id": f"off:{row.get('code')}", "food_name": name}
            for src, dst in WANT.items():
                if dst in ("code", "product_name"):
                    continue
                v = row.get(src)
                rec[dst] = to_float(v) if dst not in (
                    "brands", "categories", "countries", "serving_size") else (v or None)
            # OFF publishes sodium/calcium/iron in GRAMS per 100 g; the app
            # schema uses mg. Convert here so no downstream consumer has to
            # remember the difference.
            for g_field, mg_field in (("sodium_g", "sodium_mg"),
                                      ("calcium_g", "calcium_mg"),
                                      ("iron_g", "iron_mg")):
                gv = rec.pop(g_field, None)
                rec[mg_field] = None if gv is None else round(gv * 1000, 2)
            kept.append(rec)

    OUT_PATH.write_text(json.dumps(kept, indent=2), encoding="utf-8")
    print(f"\nscanned rows      : {scanned:,}")
    print(f"India + usable    : {len(kept):,}")
    print(f"rejected implausible energy: {bad:,}")
    print(f"-> {OUT_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
