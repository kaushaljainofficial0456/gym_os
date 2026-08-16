# V2 pipeline — baseline + frozen-V1 benchmark (Phase E/F)

Computed through the NEW v2 infrastructure, on the v2 canonical dataset (currently identical population to V1's own training data). Purpose: prove the new pipeline reproduces V1's already-published numbers before trusting it with any new data.

| Model | MAE (kcal/min) | RMSE | MAPE | R2 |
|---|---|---|---|---|
| Baseline (zero correction) | 2.958 | 5.306 | 36.46% | 0.109 |
| V1 (frozen, model_v1.json's own coefficients, in-sample) | 1.431 | 2.869 | 18.36% | 0.739 |

**Reference — V1's own already-published, genuinely out-of-sample LOPO numbers**: baseline 36.5% MAPE, Model E 19.1% MAPE (`VALIDATION_REPORT.md`). This run's baseline MAPE (36.46%) matching that number confirms the new pipeline's baseline formula is correct. This run's V1 MAPE (18.36%) is *in-sample* (V1's coefficients already saw these participants during its own fitting), so it comes out a bit lower than the 19.1% LOPO figure — expected, not a discrepancy.

**This is a pipeline-correctness check, not a new V2 result.** No new model was fit here.