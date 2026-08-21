"""
Repair fragmented IFCT food names.

THE BUG (found by end_to_end_benchmark.py, not by reading code):
ifct2017_extract.py reads names out of pdfplumber's
extract_table(vertical_strategy="text"), which splits a row into cells at
visual character gaps. IFCT's justified typesetting has wide inter-letter
spacing, so single words get split ACROSS cells and are then rejoined with
a space:

    "Amaranth leaves, green"   ->  "Amaranth leav es, green"
    "Apricot, processed"       ->  "Apricot, proc essed"
    "Rajmah, red (Phaseolus vulgaris)" -> "Rajmah, red (P haseolus vu lgaris)"

This corrupts the shipped database: a user searching "amaranth leaves"
cannot match "amaranth leav es". The benchmark surfaced it as a mass
resolution failure, which is exactly the sort of thing component tests
miss.

THE FIX:
extract_words() reads the same rows CLEANLY (verified: page 42 yields
"Lentil whole, brown (Lens culinaris)" with no fragmentation), because it
groups characters by actual proximity rather than by inferred column
boundaries. So names are re-read from word positions and matched back to
each record by food_code.

Only the `food_name` field is touched. No nutrient value is read, written
or recalculated here -- the numeric extraction was already verified by the
Atwater cross-check and must not be disturbed.
"""
import json
import re
from pathlib import Path

import pdfplumber

PDF_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "ifct" / "IFCT2017_NIN.pdf"
PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
TARGETS = [PROC / "ifct2017_table1_proximate.json", PROC / "ifct2017_table5_minerals.json"]

FOOD_CODE_RE = re.compile(r"^[A-Z]\d{3}$")
Y_TOL = 3.0
SCAN_PAGES = list(range(40, 68)) + list(range(150, 208))  # Table 1 + Table 5


def clean_names_from_pdf():
    """food_code -> clean name, read from word positions."""
    names = {}
    with pdfplumber.open(PDF_PATH) as pdf:
        for page_idx in SCAN_PAGES:
            if page_idx >= len(pdf.pages):
                continue
            words = pdf.pages[page_idx].extract_words()
            codes = [w for w in words if FOOD_CODE_RE.match(w["text"])]
            for c in codes:
                if c["text"] in names:
                    continue
                row = [w for w in words
                       if abs(w["top"] - c["top"]) <= Y_TOL and w["x0"] > c["x1"]]
                row.sort(key=lambda w: w["x0"])
                parts = []
                for w in row:
                    t = w["text"]
                    # stop at the region-count integer -- everything after is numeric
                    if re.fullmatch(r"\d", t) and parts:
                        break
                    if re.fullmatch(r"\d+(?:\.\d+)?(?:\xb1\d+(?:\.\d+)?)?", t):
                        break
                    parts.append(t)
                if parts:
                    name = " ".join(parts)
                    name = re.sub(r"\s+([,)])", r"\1", name)
                    name = re.sub(r"\(\s+", "(", name)
                    name = re.sub(r"\s{2,}", " ", name).strip()
                    if len(name) >= 2:
                        names[c["text"]] = name
    return names


def main():
    clean = clean_names_from_pdf()
    print(f"Clean names recovered from PDF word positions: {len(clean)}")

    for path in TARGETS:
        if not path.exists():
            continue
        recs = json.loads(path.read_text(encoding="utf-8"))
        changed, examples = 0, []
        for r in recs:
            code = r.get("food_code")
            new = clean.get(code)
            if not new:
                continue
            old = r.get("food_name") or ""
            # Only replace when the clean version differs by whitespace
            # placement -- guards against overwriting a good name with a
            # mis-parsed one from a different row.
            if old.replace(" ", "").lower() == new.replace(" ", "").lower() and old != new:
                if len(examples) < 8:
                    examples.append((old, new))
                r["food_name"] = new
                changed += 1
        path.write_text(json.dumps(recs, indent=2), encoding="utf-8")
        print(f"\n{path.name}: repaired {changed}/{len(recs)} names")
        for o, n in examples:
            print(f"   '{o}'  ->  '{n}'")


if __name__ == "__main__":
    main()
