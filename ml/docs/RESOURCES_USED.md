# Resources Used — skos-cal-v1, start to end

Compiled from the actual pipeline files, `requirements.txt`, and `DATA_PROVENANCE.md` — not from memory. Every dataset/paper below is cross-checked against a source file that still exists in this repo.

## Modeling method — no XGBoost, no gradient boosting

**Confirmed by direct search: no XGBoost, LightGBM, or CatBoost anywhere in this codebase.** `requirements.txt` explicitly excludes them, with the reason stated inline: *"only if the simpler models... fail to beat baseline AND scikit-learn's RandomForest first — no justification yet with n=25 participants."* That bar was never crossed, so they were never installed or tried.

What was actually used (all via `scikit-learn>=1.4,<1.5`):
- **LinearRegression** — the shipped model (Model E: exercise×intensity correction on top of the MET baseline).
- **RandomForestRegressor** — tried as Model D during comparison (`exploratory_correction_v0.py`), numerically closest competitor (19.3% vs. 19.1% MAPE) but *not* selected — flagged as overfitting-risk at n=14 per the project's own model-selection rule, favoring the interpretable linear model instead.
- **OneHotEncoder**, **LeaveOneGroupOut** — feature encoding and participant-grouped cross-validation, not models themselves.
- **HuberRegressor**-style robust variant (Model F) — tested, not shipped (small bias tradeoff, noted in `VALIDATION_REPORT.md`, kept as a documented alternative).

## Training / ground-truth datasets (the only 3 used to fit the shipped model)

All CC BY, commercially usable, verified from the actual downloaded files (not paper abstracts):

| Dataset | Study | DOI | License | n | Role |
|---|---|---|---|---|---|
| `reis2017` | Reis et al. 2017, PLOS ONE — "Energy cost of isolated resistance exercises across low- to high-intensities" | 10.1371/journal.pone.0181311 | CC BY 4.0 | 14 | Training (VO2 → kcal/min) |
| `reis2019` | Reis et al. 2019, PLOS ONE — "Are wearable heart rate measurements accurate to estimate aerobic energy cost during low-intensity resistance exercise?" | 10.1371/journal.pone.0221284 | CC BY 4.0 | 14 (same cohort as reis2017, proven numerically) | Training (directly-reported EC) |
| `brunelli2019` | Brunelli et al. 2019, PLOS ONE — "Acute low- compared to high-load resistance training to failure results in greater energy expenditure..." | 10.1371/journal.pone.0224801 | CC BY 4.0 | 11 | Confirmatory check only, **not** used to fit the model (different target unit — absolute kcal, not a rate) |

## Reference / context literature — read, informed judgment calls, never used as training rows

- **Vianna et al. 2011** (×2 papers), *J. Human Kinetics* — CC BY 3.0. Confirmed same reis-lab cohort; added aerobic/anaerobic energy-source breakdown and real per-bout duration data.
- **Phillips & Ziuraitis 2004**, JSCR — "Energy Cost of Single-Set Resistance Training in Older Adults." Standard copyright, reference-only.
- **Phillips & Ziuraitis 2003**, JSCR 17(2) — companion paper, younger population. Standard copyright, reference-only.
- **Reis, Júnior, Zajac, Oliveira 2011**, *J. Human Kinetics* — CC BY 3.0 review; sanity-bound context ("up to 40 kcal/min" ceiling for high-intensity compound work).
- **João et al.**, *Clinical Physiology and Functional Imaging* (Wiley) — systematic review/meta-analysis, license unclear (Accepted Article), treated research-only.
- **Mitchell et al. 2024**, *Sports Medicine* — systematic review, source of the "15-57% MAPE for consumer wearables" benchmark cited in `VALIDATION_REPORT.md`.
- **Nakagata, Yamada, Naito 2022**, JSCR 36(5) — **CC BY-NC-ND**, explicitly excluded from commercial use.
- **Nakagata, Naito, Yamada**, デサントスポーツ科学 Vol. 40 (Descente Sports Science bulletin) — license unclear, research-only.
- **Hunter et al. 2000**, *J Appl Physiol* — read, found not applicable (chronic adaptation study, not acute session energy cost).
- **Benito et al. 2016**, PLOS ONE, CC BY 4.0 — individual-level data legally restricted by the authors' institution; aggregate-only reference.

## Datasets/repositories searched and explicitly excluded

- **Escobar et al. 2017** (CrossFit) — CC BY-NC-ND, license-excluded.
- **Washburn et al. 2012** — trial protocol paper, no actual data.
- **PERSIST** (Zenodo 7437230) — wrong target variable (RPE, not calorimetry).
- **WEEE** (Zenodo 6420886) — CC BY 4.0 but no resistance-training data.
- **StrengthSense** (Zenodo 2025) — CC BY 4.0 but no energy-expenditure label at all.

## Referenced but never actually incorporated

- **Compendium of Physical Activities** — flagged early (`DATA_AUDIT.md`) as a future Phase 3 need for validating MET values; the MET constants actually used (3.0/4.5/6.0 for light/moderate/hard) are the **pre-existing production formula's own values**, benchmarked against, not derived from the Compendium by this project.
- **"Lytle 2019" formula** — referenced once in `ML_DATA_REQUIREMENTS.md` regarding future body-composition (fat/lean mass) fields; not incorporated into the shipped model, and I don't have a verified full citation for it in current context — flagging rather than fabricating one.
- **calorie-model-contract.md / calorieModel.js** — referenced constantly throughout this project as the integration target, but **confirmed absent from this repository** (see `V1_PRE_INTEGRATION_AUDIT.md` §1) — knowledge of its shape came from a zip Kaushal delivered in an earlier session, not from anything committed here.

## Software / libraries actually installed and used (`requirements.txt`)

`pandas`, `numpy`, `openpyxl` (reading the .xlsx source files), `requests`, `jupyter`, `matplotlib`/`seaborn` (audit visualization), `scikit-learn` (modeling — see above). Runtime/deployment side: plain JSON (`model_v1.json`, no ML framework needed) + dependency-free JavaScript (`mlEstimate.reference.js`), tested with **Node.js** (v24.16.0, via `mlEstimate.test.js`).

## Other material reviewed (not a data resource, but part of this engagement)

- Kaushal's backend delivery (a zip file, reviewed in an earlier session) — informed the assumed contract shape; not present in this repo, hence the open question in the pre-integration audit.
- A $1 Academia.edu 37-paper bundle (user-purchased) — 10 read in full, 27 screened by title, findings logged in `DATA_PROVENANCE.md`.
