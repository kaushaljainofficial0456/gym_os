# Reviewer's guide — skos-cal-v1 (for Kaushal)

Short version: run two commands, answer one question. Everything else in this branch is background/evidence if you want it.

## 1. Run the tests (2 minutes)

```bash
cd ml && .venv/Scripts/python.exe -m unittest discover -s tests -v   # 9 checks, pipeline/model integrity
cd ml/models/skos-cal-v1 && node mlEstimate.test.js                  # 9 checks, runtime logic + all safety fixes
```
Both should print all-passing. If either fails on your machine, that's the first thing worth flagging back — it means something drifted between environments, not that the model is wrong.

## 2. The one question I actually need from you

**Does `estimated_active_kcal` mean gross energy expenditure during the exercise period, or net calories above resting expenditure?**

I couldn't answer this myself — `calorie-model-contract.md` and `calorieModel.js` aren't in this repo (checked exhaustively, see `V1_PRE_INTEGRATION_AUDIT.md` §1), so I don't have the field's actual definition to check against. The model as shipped computes **gross** (no resting-rate subtraction) — internally consistent with its own training data, but I have no way to confirm that's what your contract expects. The difference is real money: ~83 kcal/hour at a typical body weight. Whichever it is, tell me and I'll either confirm the field name is fine as-is, or we fix the calculation (not just rename it).

## 3. Everything else, if you want the detail

- `V1_PRE_INTEGRATION_AUDIT.md` — the full 20-check audit + a Fix Log at the bottom with real before/after numbers (e.g., a squat-heavy 90-minute session went from an impossible 3,261 kcal to a capped, flagged 1,800 kcal).
- `_v1_audit_fix_diff.txt` — proof no fitted coefficient changed during the fix pass, only additive metadata.
- `MODEL_CARD.md` / `VALIDATION_REPORT.md` — scope, accuracy numbers, honest limitations.
- `README.md` (in `models/skos-cal-v1/`) — integration steps, rollout sequence, and what to watch for once you wire it in (the `note` field is now a real signal — worth a product decision on how it surfaces).

## 4. What I'm not asking you to decide right now

Whether/how to integrate into `main` — that's explicitly on hold per Sambhav. This branch is for your review only at this stage.
