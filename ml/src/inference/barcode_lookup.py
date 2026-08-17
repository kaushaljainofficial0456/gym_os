"""
Barcode -> product lookup, and barcode-scan auto-log resolution.

WHY THIS IS ITS OWN MODULE, NOT PART OF food_search.py:
Text search is fuzzy retrieval over free text -- it ranks candidates and
can legitimately be wrong. Barcode lookup is an EXACT key lookup over
whatever a scanner reads verbatim: dict[barcode] -> product, or a miss.
There is no ranking, no ambiguity, and therefore no confidence
CALIBRATION question the way §3.2 of the contract means it for text
search -- conflating the two modules would make this one's simplicity
look like an oversight instead of the point.

`confidence` on a barcode result is always `"high"` -- the identity match
is exact by construction. That is a DIFFERENT claim from "we know how
much of it you ate": `serving_grams_known` is the separate, honest flag
for that, because plenty of OFF products carry no serving_size at all.

DATA: ml/data/processed/off_barcode_index.json, built by
ml/src/ingestion/build_barcode_index.py from the Open Food Facts bulk
export. Every record's `source` is OPEN_FOOD_FACTS -- barcode lookup is
a packaged-goods feature by nature; IFCT/INDB/USDA/CNF carry no retail
barcodes to scan.

NOTE FOR TEXT SEARCH: a product findable by barcode here is not
guaranteed to also surface via food_search.py -- the barcode index is
deliberately broader (see build_barcode_index.py) than the India-tagged
set text search draws on, because broadening carries no "wrong food"
risk for an exact key lookup the way it would for ranked text search.
"""
import json
import re
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
INDEX_PATH = PROC / "off_barcode_index.json"

DEFAULT_SERVING_G = 100.0
SCALED_FIELDS = [
    "energy_kcal", "protein_g", "fat_g", "carb_g", "fiber_g", "sugar_g",
    "sodium_mg", "calcium_mg", "iron_mg",
]


def clean_code(code):
    """Scanners hand back plain digits; tolerate whitespace and a stray
    'off:' source_id prefix if a caller passes that in by mistake."""
    if code is None:
        return ""
    s = str(code).strip()
    if s.startswith("off:"):
        s = s[4:]
    return re.sub(r"\D", "", s)


def canonical_ean13(code):
    """A UPC-A code is numerically an EAN-13 with a leading zero,
    so 12-digit and 13-digit scans of the SAME physical product must
    both resolve. See build_barcode_index.py for why both forms are
    stored as keys at build time."""
    if len(code) <= 13:
        return code.zfill(13)
    return code


class BarcodeIndex:
    """Loads off_barcode_index.json once; reuse the instance across
    lookups rather than re-reading the file per scan."""

    def __init__(self, index_path=None, data=None):
        """`data`, when given, is used directly (as-is) and the file is
        never touched -- this is what tests use to inject small fixture
        indexes without depending on the built artifact."""
        self.path = Path(index_path) if index_path else INDEX_PATH
        if data is not None:
            self._data = data
            return
        self._data = {}
        if self.path.exists():
            self._data = json.loads(self.path.read_text(encoding="utf-8"))

    def __len__(self):
        return len({r["barcode"] for r in self._data.values()})

    def lookup(self, code):
        """Exact lookup only. Returns the record dict or None -- never a
        'closest' match; a scanned barcode that isn't indexed is a miss,
        not an invitation to guess."""
        c = clean_code(code)
        if not c:
            return None
        if c in self._data:
            return self._data[c]
        return self._data.get(canonical_ean13(c))


def resolve_serving(record, servings=1.0):
    """Scale a barcode record's per-100g macros to N of the PRODUCT'S OWN
    serving size. Falls back to 100 g only when the product publishes no
    serving size at all, and says so explicitly via
    `serving_grams_known: False` -- an assumed default must never be
    presented as the product's real serving."""
    if record is None:
        return None
    serving_grams = record.get("serving_grams")
    known = serving_grams is not None
    grams_each = serving_grams if known else DEFAULT_SERVING_G
    total_grams = round(grams_each * servings, 1)
    factor = total_grams / 100.0

    totals = {}
    for f in SCALED_FIELDS:
        v = record.get(f)
        totals[f] = None if v is None else round(v * factor, 2)

    return {
        "servings": servings,
        "serving_grams_known": known,
        "serving_grams_each": grams_each,
        "grams": total_grams,
        "totals": totals,
    }


_INDEX_SINGLETON = None


def _default_index():
    global _INDEX_SINGLETON
    if _INDEX_SINGLETON is None:
        _INDEX_SINGLETON = BarcodeIndex()
    return _INDEX_SINGLETON


def auto_log_from_barcode(code, servings=1.0, index=None):
    """The barcode-scan auto-log flow end to end: scanned code -> product
    -> totals for N of THAT product's own servings. Returns None on a
    miss; the caller (Kaushal's endpoint) owns the not-found UX (manual
    search / manual entry) -- this layer never guesses a substitute food
    for an unrecognised code."""
    idx = index if index is not None else _default_index()
    record = idx.lookup(code)
    if record is None:
        return None
    resolved = resolve_serving(record, servings=servings)
    notes = []
    if not resolved["serving_grams_known"]:
        notes.append(
            "Product does not publish a serving size; defaulted to 100 g. "
            "Confirm the actual amount before logging.")
    return {
        "schema_version": "food-v1",
        "tier": "barcode",
        "match_kind": "barcode_exact",
        "food": record,
        "quantity": {
            "servings": resolved["servings"],
            "grams": resolved["grams"],
            "serving_grams_each": resolved["serving_grams_each"],
            "serving_grams_known": resolved["serving_grams_known"],
        },
        "totals": resolved["totals"],
        "confidence": "high",   # identity match is exact by construction
        "notes": notes,
    }
