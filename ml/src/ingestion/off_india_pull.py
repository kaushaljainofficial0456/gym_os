"""
Pull the full Open Food Facts India catalogue (~22,500 products).

WHY MORE PACKAGED FOODS MATTERS:
The end-to-end benchmark showed error concentrates in LOW-CONFIDENCE
matches (48% median APE) while high-confidence matches sit at 25%. The way
to move a query from low to high confidence is to actually have the food,
so tier-1 coverage is the highest-value remaining lever -- more so than any
further model tuning, which the measured error floor showed has little
left to give.

Packaged foods are also the case where a database value is EXACTLY right
rather than approximately right: a branded product has a printed label, so
there is no cultivar, portion or cooking-method variance at all.

WHY THIS IS A SCRIPT AND NOT A ONE-LINER:
The first attempt fetched 10 pages and silently received HTML error pages
for 3 of them -- curl reported success because an HTTP error page is still
a successful transfer. Anything that isn't valid JSON with a products array
is treated as a failure here and retried.

POLITENESS:
Open Food Facts is a volunteer-run nonprofit. This uses a descriptive
User-Agent (their stated requirement), paces requests, and backs off on
failure. It is a read-only bulk pull of openly-licensed data (ODbL),
resumable so an interruption does not mean re-fetching everything.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "off"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "off_india_products.json"

BASE = "https://in.openfoodfacts.org/api/v2/search"
FIELDS = ",".join([
    "code", "product_name", "brands", "categories", "quantity",
    "serving_size", "nutriments", "countries_tags", "nova_group",
])
PAGE_SIZE = 100          # smaller pages are far more reliable than 200
DELAY_S = 2.0            # deliberate pacing between requests
MAX_RETRIES = 4
USER_AGENT = (
    "SKOS-FoodModel/1.0 (nutrition research; non-commercial dataset build; "
    "contact: github.com/kaushaljainofficial0456/gym_os)"
)


def fetch_page(page):
    params = urllib.parse.urlencode({
        "countries_tags_en": "india",
        "page_size": PAGE_SIZE,
        "page": page,
        "fields": FIELDS,
    })
    url = f"{BASE}?{params}"
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    data = json.loads(body)          # raises if the server returned an HTML error page
    if "products" not in data:
        raise ValueError("response JSON has no 'products' key")
    return data


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    first = None
    for attempt in range(MAX_RETRIES):
        try:
            first = fetch_page(1)
            break
        except Exception as e:  # noqa: BLE001 - report and retry
            print(f"  page 1 attempt {attempt+1} failed: {e}", flush=True)
            time.sleep(5 * (attempt + 1))
    if first is None:
        print("could not reach Open Food Facts; aborting without partial data")
        return 1

    total = first.get("count", 0)
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    print(f"India products reported by API: {total}  ->  {pages} pages of {PAGE_SIZE}", flush=True)

    failed = []
    for page in range(1, pages + 1):
        target = RAW_DIR / f"india_p{page:04d}.json"
        if target.exists() and target.stat().st_size > 200:
            continue                       # resume: already have this page
        got = None
        for attempt in range(MAX_RETRIES):
            try:
                got = fetch_page(page) if page > 1 else first
                break
            except Exception as e:  # noqa: BLE001
                wait = 4 * (attempt + 1)
                print(f"  page {page} attempt {attempt+1} failed ({e}); waiting {wait}s",
                      flush=True)
                time.sleep(wait)
        if got is None:
            failed.append(page)
            # ABORT ON SYSTEMIC OUTAGE. Without this the script grinds
            # through every remaining page burning 4+8+12+16s of backoff
            # each -- 216 pages x ~45s is 2.7 hours of guaranteed failure.
            # That is exactly what happened on the first full run, when
            # Open Food Facts started returning HTTP 503. If several
            # consecutive pages fail, the service is down, not the page.
            if len(failed) >= 5 and failed[-5:] == list(range(page - 4, page + 1)):
                print(f"\n  5 consecutive pages failed at {page} -- treating this "
                      f"as a service outage and stopping. Re-run later; already "
                      f"downloaded pages are kept and skipped.", flush=True)
                break
            continue
        target.write_text(json.dumps(got), encoding="utf-8")
        if page % 10 == 0 or page == pages:
            print(f"  fetched {page}/{pages}", flush=True)
        time.sleep(DELAY_S)

    # ---- consolidate ----
    products, seen = [], set()
    bad_files = 0
    for f in sorted(RAW_DIR.glob("india_p*.json")) + sorted(RAW_DIR.glob("india_page_*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - legacy/HTML files from the first attempt
            bad_files += 1
            continue
        for p in d.get("products", []):
            code = p.get("code")
            if code and code in seen:
                continue
            if code:
                seen.add(code)
            products.append(p)

    usable = [
        p for p in products
        if p.get("product_name")
        and (p.get("nutriments") or {}).get("energy-kcal_100g") is not None
    ]
    OUT_PATH.write_text(json.dumps(usable, indent=2), encoding="utf-8")

    print(f"\npages that never succeeded: {len(failed)} {failed[:10]}")
    print(f"unreadable files skipped:   {bad_files}")
    print(f"distinct products fetched:  {len(products)}")
    print(f"usable (name + kcal/100g):  {len(usable)}  -> {OUT_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
