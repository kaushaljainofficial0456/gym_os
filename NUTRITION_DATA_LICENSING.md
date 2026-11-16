# Nutrition Data Licensing

Branch `feature/nutrition-engine-overhaul` · 2026-11-16 · status as researched in this session

**This is not legal advice.** It is a record of what each data source's own published terms say, where the terms are unclear, how much the product depends on each source, and what the owner needs to decide.

- No source has been removed or replaced.
- No attribution text has been added to the product. Per the Phase 2 brief, changes to commercial licensing or attribution arrangements need the owner's approval.

Status keys: **OK**, **Gap** (fixable, needs an approved change), **Blocker** (commercial release should not proceed without resolving it), **Requires owner decision**.

---

## 1. Summary

| Source | Rows in index | Licence (per the source) | Obligations | What the product does today | Status |
|---|---:|---|---|---|---|
| **USDA FoodData Central** | 12,890 | Public domain, CC0 1.0 | None. USDA *asks* to be credited as "FoodData Central". | No credit shown | **OK**; credit recommended |
| **Canadian Nutrient File (Health Canada)** | 4,944 | Open Government Licence – Canada | Attribution: "Contains information licensed under the Open Government Licence – Canada"; name the source "Canadian Nutrient File, Health Canada" | No attribution shown | **Gap**: attribution required |
| **Open Food Facts** | 2,009 + 4,078 barcode products | Database: ODbL. Individual contents: Database Contents License. Images: CC BY-SA 3.0 | Attribution for any use. **Share-alike** for any adapted database that is publicly used. | No attribution shown. OFF rows are merged into `unified_food_db.json` and two SK OS recipes. | **Gap** (attribution); share-alike scope **Requires owner decision / legal review** |
| **IFCT 2017 (ICMR–NIN)** | 506 | © 2017 National Institute of Nutrition. "Use and dissemination … encouraged"; reproduction for personal use with acknowledgement; **"no part … can be stored or reproduced in any electronic format for creating a product without the prior written permission of NIN"** | Written permission from NIN for product use | Used without recorded permission. It underlies 28 staples and 25 of 34 recipes. | **Blocker** |
| **INDB (Indian Nutrient Databank)** | 1,004 | **Unclear.** The paper (Vijayakumar et al., *Current Developments in Nutrition*, 2024) appears to be CC BY; the data repository carries **no licence**; a public commercial-use request to the maintainers has no reply | Unknown until the authors confirm | Used, no attribution. It underlies 36 staples. | **Blocker** (unconfirmed terms) |
| **SK OS standard recipes** (`food/recipes.js`) | 34 recipes | SK OS curation; each ingredient value comes from the rows above | Inherit the obligations of their ingredient rows (IFCT, USDA, CNF, OFF) | Labelled "recipe estimate" in the UI | Follows IFCT/OFF status |
| `github.com/ifct2017/compositions` (AGPL-3.0) | 0 | AGPL-3.0 (code); does not license NIN's data | — | **Deliberately not used** (`MODEL_CARD.md`) | **OK** |

The repository is private (checked through the GitHub API), so the committed `unified_food_db.json` is not publicly redistributed. **The product does serve values derived from every source above to paying gyms and their members.** That use is what the IFCT "creating a product" clause and the ODbL attribution requirement cover.

---

## 2. How much the product depends on each source (measured)

These counts were taken from the engine at commit `267fba3`.

| Source | Curated staples priced from it (of 164) | Recipe ingredient rows (of 44) | Items priced from it on benchmark v3 (1,090 items) |
|---|---:|---:|---:|
| USDA FDC | 53 | 20 | 429 (39.4%) |
| INDB | 36 | 0 | 233 (21.4%) |
| IFCT 2017 | 28 | 21 (used by 25 of 34 recipes) | 167 (15.3%) |
| SK OS recipes | 34 | — | 104 (9.5%) |
| Open Food Facts | 9 | 2 (misal topping, soya chunks) | 65 (6.0%) |
| CNF | 5 | 1 | 64 (5.9%) |
| Inline curated values | 10 | — | 28 (2.6%) |

What this means for a decision:

- **IFCT and INDB together price about 37% of items**, plus most recipes. Most Indian staples (roti, paneer, dal ingredients, the raw dals, atta, suji, vegetables) are IFCT or INDB.
- **Withdrawing either source is not a quick switch.** Most IFCT ingredients have USDA/CNF equivalents, and the multi-source benchmark band (§ benchmark v3) shows how close each is. INDB's *cooked Indian dishes* have no equivalent in USDA/CNF.

---

## 3. Source by source

### 3.1 USDA FoodData Central — OK

- **Terms.** FoodData Central says its data "are in the public domain and they are not copyrighted… published under CC0 1.0 Universal". No permission is needed. USDA asks users to credit FoodData Central and, where possible, to tell them about products that use it. Suggested citation: *U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov.*
- **Product:** usable commercially. A credit line is recommended, not required.

### 3.2 Canadian Nutrient File — Gap (attribution)

- **Terms.** The open-data listing publishes the CNF under the Open Government Licence – Canada (licence id `ca-ogl-lgo`). The licence requires the attribution statement *"Contains information licensed under the Open Government Licence – Canada."* Health Canada also asks that the source be named "Canadian Nutrient File, Health Canada". The licence does not cover official names, crests or logos.
- **Edition:** the index uses the 2015 CNF. Health Canada has published 2026 material, so a refresh may be worth checking separately; that is not a licensing issue.
- **Product:** usable commercially once the attribution statement is shown, for example on an "About the food data" screen.

### 3.3 Open Food Facts — Gap (attribution); share-alike needs review

- **Terms.** The database is under the ODbL, individual contents under the Database Contents License, and product images under CC BY-SA 3.0. Images may include third-party marks.
- **Attribution:** any public use of OFF data, including results shown in an app (a "Produced Work"), must carry a notice that OFF data is used under the ODbL.
- **Share-alike:** if an *adapted database* (OFF data mixed or modified with other data) is publicly used, that adapted database must be offered under the ODbL. `unified_food_db.json` and `off_barcode_index.json` contain OFF rows that were filtered and normalised.
  - Whether serving results through the API counts as "publicly using" the adapted database is a legal question; ODbL's own guidance treats some network uses as public use.
  - OFF recommends contributing modifications back.
- **Product today:** no OFF attribution appears anywhere in the app. Product photos are not used, so CC BY-SA images are not in play.
- **Options for the owner:**
  - (a) Add the ODbL notice and keep the OFF-derived rows in a separately identifiable file, so that only the OFF-derived part would ever need to be shared alike.
  - (b) Get legal advice on whether the barcode/API use triggers share-alike.
  - (c) Contribute corrections back to OFF.

### 3.4 IFCT 2017 (ICMR–National Institute of Nutrition) — Blocker

- **Terms**, from the book: "Copyright © 2017 by National Institute of Nutrition… The use and dissemination of the data in this book is encouraged… [this publication] can be reproduced for personal use with full acknowledgment of the source", and "**no part of this publication can be stored or reproduced in any electronic format for creating a product without the prior written permission of the National Institute of Nutrition, Hyderabad**".
- The INDB authors themselves say their IFCT inputs "must be requested from the original source".
- **Reading:** a commercial app that stores IFCT values and serves them to users is "creating a product". No written permission is recorded anywhere in this repository.
- **What the owner needs to do:**
  - Request written permission from NIN Hyderabad (the book lists nin@ap.nic.in and +91 40 27197334). The request should state the use: storing per-100 g values for 506 foods, displaying computed nutrition to users, and SK OS recipes computed from them.
  - Keep the reply with the codebase.
  - **Until then, treat commercial launch as blocked on this item.**
- **If permission is refused:** the IFCT-priced staples and recipe ingredients would have to move to USDA/CNF rows. Benchmark v3's multi-source cases measure the effect: for most raw foods the sources agree within about 10–20%, but some differ a lot (desi vs kabuli chana 287 vs 378 kcal/100 g, ripe papaya 24 vs 43). That would be a measured accuracy change for Indian foods, and the owner should decide on it knowingly.

### 3.5 INDB (Indian Nutrient Databank) — Blocker (terms unconfirmed)

- **What is known:**
  - The INDB is described in Vijayakumar et al., "Development of an Indian Food Composition Database", *Current Developments in Nutrition* (2024); the article appears to be open access under CC BY.
  - The data is distributed through a GitHub repository (`lindsayjaacks/Indian-Nutrient-Databank-INDB-`) that has **no licence file**.
  - An open issue there (#3) from another diet-app developer asks for permission to use INDB commercially and for a licence to be added. **It has no reply.**
  - Third-party copies label INDB variously as CC BY 4.0 or CC BY-SA 4.0. Those are their claims, not the authors'.
- **Reading:** a CC-licensed *paper* does not license the *dataset*. Code or data published without a licence grants no reuse rights by default.
- **What the owner needs to do:** write to the corresponding authors to confirm the dataset's licence and that commercial use is allowed, with the attribution they want. Until they confirm, treat commercial use as **blocked on this item**.
- **Note:** the INDB rows this engine uses are cooked Indian dishes (rajma, poha, chole, roti, curries). SK OS's own computed recipes are the fallback design, built from measured ingredients; 34 exist. Replacing INDB entirely would mean writing many more recipes.

### 3.6 SK OS standard recipes

These are computed in `food/recipes.js` by the yield method from the rows above, with SK OS-curated proportions. The proportions are SK OS's own. The numbers derive from IFCT, USDA, CNF and two OFF rows, so the recipes carry those sources' obligations: IFCT permission, OFF attribution and share-alike review. The UI labels them "Recipe estimate".

### 3.7 AI estimates

AI-produced estimates are not database data. They are stored in the shared `ai_food_estimates` cache, labelled "AI estimate", and promoted only through admin review (`food_data_reviews`). Whether the AI provider's terms allow storing and reusing outputs is a provider-contract question and was not checked here.

---

## 4. Attribution — proposed, NOT applied (needs owner approval)

This is a suggested "About the food data" block for the nutrition screen footer or settings. It has not been added to the product:

> Food data: USDA FoodData Central (public domain). Contains information licensed under the Open Government Licence – Canada (Canadian Nutrient File, Health Canada). Packaged-food data © Open Food Facts contributors, under the Open Database License (ODbL). Indian Food Composition Tables 2017, ICMR–National Institute of Nutrition [subject to NIN permission]. Indian Nutrient Databank [subject to the authors' terms]. Recipe estimates are calculated by SK OS from these sources.

---

## 5. Blockers and decisions for the owner

| # | Item | Status | Owner action |
|---|---|---|---|
| L1 | IFCT 2017 written permission for product use | **Blocker** | Request in writing from NIN Hyderabad; keep the reply |
| L2 | INDB dataset licence / commercial use | **Blocker** | Ask the authors to confirm licence and attribution |
| L3 | Open Food Facts ODbL attribution | **Gap** | Approve an attribution notice (§4) |
| L4 | Whether OFF share-alike applies to the adapted database | **Requires owner decision / legal review** | Decide (a), (b) or (c) in §3.3 |
| L5 | CNF Open Government Licence attribution | **Gap** | Approve the attribution statement (§4) |
| L6 | USDA credit | Recommended | Approve the credit line (§4) |
| L7 | AI provider output-reuse terms | **Unverified** | Check the provider contract |

No source was removed and no product text was changed while preparing this document.

---

## Sources consulted

- [USDA FoodData Central](https://fdc.nal.usda.gov/) — public domain / CC0 1.0 statement and suggested citation; [Data.gov listing](https://catalog.data.gov/dataset/fooddata-central)
- [Canadian Nutrient File on open.canada.ca](https://open.canada.ca/data/en/dataset/90a31d6a-9131-4f31-a156-cd1f3b2717fe) — Open Government Licence – Canada; [About the CNF](https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/nutrient-data/canadian-nutrient-file-about-us.html); [archived CNF copyright guidelines](https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/nutrient-data/copyright-guidelines-canadian-nutrient-file.html)
- [Open Food Facts — "License: be on the legal side"](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side); [OFF wiki: ODbL License](https://wiki.openfoodfacts.org/ODBL_License)
- [Indian Food Composition Tables 2017 (NIN PDF)](https://www.nin.res.in/ebooks/IFCT2017.pdf)
- [INDB repository](https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-) and [issue #3, commercial-use request](https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-/issues/3); [Development of an Indian Food Composition Database (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11277795)
