# Model Card — skos-cal-v2

**Status: DOES NOT EXIST YET.** This file is a placeholder by design, not an oversight — a real model card requires a real model, and none has been trained. Filling this in with V1's numbers, or with plausible-sounding placeholder numbers, would be exactly the "pretend V2 progress" the authorization explicitly prohibited.

## Why there's nothing here

Per `V2_VALIDATION_REPORT.md` §7: training any model on the currently-available data would use the identical 14 participants V1 already trained on. That's not V2 — it's either a re-derivation of V1's own already-completed work, or an unvalidated exercise in overfitting a fancier model to the same small population. Neither is being presented as a model.

## What exists instead

- `ml/src/v2/` — the full pipeline infrastructure (canonical schema, ingestion, provenance validation, leakage detection, frozen-V1 benchmark, baseline benchmark), built and tested against real data (18/18 tests passing).
- `ml/data/processed/v2_training_dataset.csv` — the canonical dataset, currently populated only with the same data V1 already used, correctly and transparently.
- `V2_VALIDATION_REPORT.md` — the honest status report.
- `V2_LEAKAGE_REPORT.md` — leakage analysis for current and candidate data.

## When this file gets written for real

The moment genuinely new, independent, participant-level GOLD/SILVER data is acquired (see `V2_VALIDATION_REPORT.md`'s "What's actually needed" section — Rustaden 2020 is the top candidate) and Phase G's model comparison can be run honestly against a real held-out population, this card gets populated with real numbers: training data, population, features, target, performance, known failure modes, intended use — the same structure as `MODEL_CARD.md` for V1, not a different template.
