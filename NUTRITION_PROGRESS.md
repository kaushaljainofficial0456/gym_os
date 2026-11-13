# Nutrition Overhaul — Progress Log

Read this first when resuming. Branch: **`feature/nutrition-engine-overhaul`** (from `main` @ `04c0389`).
**`main` is never committed to, merged into, or pushed.** PRs (if any) target `feature/nutrition-engine-overhaul`.

## Documents
- `NUTRITION_COMPLETE_TECHNICAL_AUDIT.md` — Phase 0 audit (findings B1–B15, priorities).
- `NUTRITION_BENCHMARK_REPORT.md` — benchmark baseline vs improved (written in the benchmark phase).
- `NUTRITION_COMMERCIAL_READINESS.md` — final evidence-based readiness report.
- `docs/nutrition/benchmark/baseline/` — untouched V1/V2/V3 benchmark output from the start of the overhaul.

## How to verify
```
npm run setup                      # root
cd backend && node --test          # full suite (baseline: 2050 tests, 2045 pass, 0 fail, 5 skip)
node backend/scripts/food-benchmark.js --engine v1   # live engine benchmark
```

## Phase log

### Phase 0 — Audit (done)
- Baseline: 2,050 tests / 0 failures; benchmark V1 weighted 78.6%, identity 92.0%, silent-drop 10% of multi-food cases, ECE 0.113.
- Live probes reproduced: aloo paratha → potato pancake, puran poli → Polish sausage, misal pav → pav bhaji, sambar/bhature/rice silently dropped.

<!-- later phases append below -->
