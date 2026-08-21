"""
Build a barcode -> product lookup index from the Open Food Facts bulk
export, for barcode-SCAN auto-logging. This is a different job from text
search and deliberately lives as its own artifact rather than folding
into off_india_bulk.json / unified_food_db.json.

WHY A SEPARATE, BROADER FILTER THAN off_india_bulk.json:
Text search ranks candidates by name plausibility, so casting a wide net
carries real risk -- a low-quality crowd-sourced row can out-score a
better one, which is why off_india_bulk.json stays restricted to
countries_tags=india. Barcode lookup has no such risk: a scanned code is
either an EXACT key match or it is a miss. There is nothing to rank and
no "wrong food, higher score" failure mode, so coverage should be
maximized rather than restricted -- every extra indexed barcode is pure
upside.

COVERAGE RULE: keep a row if EITHER
  (a) countries_tags/countries_en mentions India (sold in India, wherever
      made) -- same signal off_india_bulk.json already uses, OR
  (b) the barcode itself starts with "890" -- the GS1 company-prefix
      block issued to India (the same numbering scheme that gives
      US/Canada codes prefixes 000-139). This catches Indian-MANUFACTURED
      products even when OFF's crowd-sourced country tag is missing or
      wrong, which (a) alone cannot, without pulling in the rest of the
      global catalogue.
This stays a bounded, targeted filter -- an American-made, US-only
product an Indian gym user would never plausibly scan is excluded by
both conditions failing, so this is not "index all 4.5M rows".

SERVING SIZE: OFF publishes two fields -- serving_size (free text, e.g.
"1 bar (40 g)") and serving_quantity (OFF's OWN pre-parsed numeric grams
value for that text, when their parser succeeded). serving_quantity is
used directly when present and plausible; serving_size text is parsed
locally only as a fallback (see parse_serving_grams), and the original
text is always kept alongside as the human-readable label.

BARCODE VALIDITY: only standard retail barcode lengths are indexed --
EAN-8 (8), UPC-A (12), EAN-13 (13), GTIN-14 (14) digits. Anything else
(internal test codes, malformed rows) is dropped rather than indexed
under a code no real scanner will ever produce.

LEADING-ZERO NORMALIZATION: a UPC-A code is numerically an EAN-13 with a
leading zero (e.g. "012345678905" == "0012345678905"). Real scanners
disagree about which they hand back, so each product is indexed under
both its raw code AND its 13-digit zero-padded canonical form, so a
lookup succeeds regardless of which one the scanning hardware/library
returns.
"""
import csv
import gzip
import json
import re
import sys
from pathlib import Path

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "off_bulk" / "off_products.csv.gz"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "off_barcode_index.json"

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

INDIA_GS1_PREFIX = "890"
VALID_BARCODE_LENGTHS = {8, 12, 13, 14}

WANT_NUTRIENTS = {
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

# Same narrow non-food guard as off_bulk_filter.py -- see that file for why
# it requires the feed/non-edible sense explicitly rather than a bare
# "pet" (which false-positived on PET-bottled drinks).
NONFOOD_RE = re.compile(
    r"\b(animal\s*feed|cattle\s*feed|goat\s*feed|poultry\s*feed|"
    r"pet\s*food|dog\s*food|cat\s*food|fodder|forage|birdseed|"
    r"feed\s*grade|fertili[sz]er|non.?edible)\b", re.I)

SERVING_RE = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(kg|g|gram|grams|ml|milliliter|millilitre|cl|l|liter|litre)\b",
    re.I)


def to_float(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse_serving_grams(serving_size_text):
    """'1 bar (40 g)' -> 40.0. Prefers a parenthetical weight (the precise
    figure) over the leading count/unit label, which is often not a weight
    at all ('1 bar', '2 biscuits'). ml/l treated as ~1 g/ml (food-density
    approximation, documented rather than silently assumed)."""
    if not serving_size_text:
        return None
    text = serving_size_text.strip()
    paren = re.search(r"\(([^)]*)\)", text)
    for candidate in filter(None, [paren.group(1) if paren else None, text]):
        m = SERVING_RE.search(candidate)
        if m:
            val = float(m.group(1).replace(",", "."))
            unit = m.group(2).lower()
            if unit == "kg":
                return round(val * 1000, 1)
            if unit in ("l", "liter", "litre"):
                return round(val * 1000, 1)
            if unit == "cl":
                return round(val * 10, 1)
            return round(val, 1)  # g, gram, grams, ml, milliliter, millilitre
    return None


def canonical_ean13(code):
    """UPC-A and EAN-13 are the same numbering space -- a UPC-A code is
    numerically an EAN-13 with a leading zero. Zero-pad to 13 digits so a
    12-digit scan and a 13-digit scan of the same product both hit."""
    if len(code) <= 13:
        return code.zfill(13)
    return code  # EAN-14/GTIN-14 stays as-is, it is a distinct wider space


def main():
    if not RAW.exists():
        print(f"missing {RAW}")
        return 1

    index = {}          # barcode (raw + canonical) -> record
    scanned = 0
    kept_products = 0
    rejected_bad_code = 0
    rejected_no_nutrition = 0
    rejected_implausible = 0
    rejected_nonfood = 0
    by_india_tag = 0
    by_gs1_prefix = 0

    with gzip.open(RAW, "rt", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE)
        for row in reader:
            scanned += 1
            if scanned % 500000 == 0:
                print(f"  scanned {scanned:,}  kept {kept_products:,}", flush=True)

            code = (row.get("code") or "").strip()
            if not code.isdigit() or len(code) not in VALID_BARCODE_LENGTHS:
                rejected_bad_code += 1
                continue

            countries = (row.get("countries_en") or "")
            is_india_tagged = "india" in countries.lower()
            is_gs1_india = code.startswith(INDIA_GS1_PREFIX)
            if not (is_india_tagged or is_gs1_india):
                continue

            name = (row.get("product_name") or "").strip()
            kcal = to_float(row.get("energy-kcal_100g"))
            if not name or kcal is None:
                rejected_no_nutrition += 1
                continue
            if not (0 < kcal <= 900):
                rejected_implausible += 1
                continue
            if NONFOOD_RE.search(name) or NONFOOD_RE.search(row.get("categories_en") or ""):
                rejected_nonfood += 1
                continue

            if is_india_tagged:
                by_india_tag += 1
            if is_gs1_india:
                by_gs1_prefix += 1

            serving_size_text = row.get("serving_size") or None
            serving_qty = to_float(row.get("serving_quantity"))
            # OFF's own parse is trusted first; a value <=0 or absurdly
            # large (>5kg "serving") is treated as a data error, not used.
            if serving_qty is not None and not (0 < serving_qty <= 5000):
                serving_qty = None
            serving_grams = serving_qty if serving_qty is not None else parse_serving_grams(serving_size_text)

            rec = {
                "source": "OPEN_FOOD_FACTS",
                "barcode": code,
                "source_id": f"off:{code}",
                "food_name": name,
                "brand": (row.get("brands") or "").split(",")[0].strip() or None,
                "quantity_label": (row.get("quantity") or "").strip() or None,
                "category": (row.get("categories_en") or "").split(",")[0].strip() or None,
                "cuisine": "PACKAGED",
                "cooking_state": "ready_to_eat",
                "serving_size_label": serving_size_text,
                "serving_grams": serving_grams,
                "serving_grams_source": (
                    "off_serving_quantity" if serving_qty is not None
                    else ("parsed_serving_size" if serving_grams is not None else None)
                ),
            }
            for src, dst in WANT_NUTRIENTS.items():
                v = to_float(row.get(src))
                rec[dst] = v
            for g_field, mg_field in (("sodium_g", "sodium_mg"),
                                       ("calcium_g", "calcium_mg"),
                                       ("iron_g", "iron_mg")):
                gv = rec.pop(g_field, None)
                rec[mg_field] = None if gv is None else round(gv * 1000, 2)

            key_raw = code
            key_canon = canonical_ean13(code)
            # If the same product code recurs (rare -- export is normally
            # one row per code), keep whichever record has more complete
            # macros rather than blindly overwriting with the later row.
            def better(a, b):
                score = lambda r: sum(r.get(f) is not None for f in
                                       ("protein_g", "fat_g", "carb_g", "serving_grams"))
                return a if score(a) >= score(b) else b

            for k in {key_raw, key_canon}:
                if k in index:
                    index[k] = better(rec, index[k])
                else:
                    index[k] = rec
            kept_products += 1

    OUT_PATH.write_text(json.dumps(index, indent=2), encoding="utf-8")
    unique_products = len({r["barcode"] for r in index.values()})
    print(f"\nscanned rows          : {scanned:,}")
    print(f"kept products          : {kept_products:,}  (unique barcodes: {unique_products:,})")
    print(f"  via India country tag : {by_india_tag:,}")
    print(f"  via GS1 890 prefix    : {by_gs1_prefix:,}")
    print(f"index keys (raw+canon) : {len(index):,}")
    print(f"rejected, bad code fmt : {rejected_bad_code:,}")
    print(f"rejected, no nutrition : {rejected_no_nutrition:,}")
    print(f"rejected, implausible  : {rejected_implausible:,}")
    print(f"rejected, non-food     : {rejected_nonfood:,}")
    print(f"-> {OUT_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
