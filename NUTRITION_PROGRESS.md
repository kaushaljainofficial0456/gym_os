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

### Phase 1 — Stabilise (done) · `082ed82`, `1ea6668`
- `food/coverage.js` + parser fixes: silent drops 10% → 0% (v1). "X with Y" guard, context words, no-shared-word guard, plural staples.
- `services/nutrition/mealLogWriter.js` + `provenance.js`: idempotent (`meal_log_requests`), server-priced, provenance-stamped logging; plate requires a second tap to log with "not found" items.

### Phases 2–4 — Indian coverage, decomposition, portions (done) · `df503eb`, `518789d`
- `food/recipes.js`: 18 dishes priced from ingredient rows (yield method, absorbed oil). Staples: puran poli, pav, jam, papad, egg dishes.
- N-food segmentation with customary pairs; container counts multiply servings; weighed fragments never split.

### Phase 5 — Confidence (done) · `72d7b6b`
- `food/confidence.js`: identification / portion / composition; overall = weakest. ECE on independently measurable cases 0.133 → 0.078.

### Benchmark (done) · `2004e4d`, `d410882`
- v2 dataset: 534 cases (`case_specs.v2.mjs`, `npm run bench:build:v2`, `npm run bench:v2`), CI gate for zero silent drops / fabrication.
- Original vs improved, same scorer: v1 79.0% → 82.9%, v2 78.5% → 86.0%, 0 cases worse. Full detail: `NUTRITION_BENCHMARK_REPORT.md`.

### Phase 6–7 — Safety and hardening (partial) · `4b4b494`, `e4988f4`
- `services/nutrition/targets.js`: safeguards (minors, underweight, BMI ≥ 30 protein, macro/calorie consistency, medical notes, disclaimer).
- `mealLogPg.test.js`: idempotency under concurrency + RLS isolation proven on PostgreSQL 16; added to CI's PG job.

### Final — `NUTRITION_COMMERCIAL_READINESS.md`: 7.0/10, ready for a controlled pilot, not general release.

## Next session: start here
Priority order (reasons in the readiness report §8):
1. Collect 50–100 real meals with weighed portions; add them as a v3 benchmark slice.
2. Validate the 18 recipe dishes; convert the 23 hand-entered staples to computed recipes.
3. Legal: INDB / IFCT terms; Open Food Facts attribution in the app.
4. International coverage pass (identity 93.8% → ≥ 95%).
5. AI meal-level decomposition; corrections review pipeline; supplement intake; diet-type-aware suggestions.
6. Playwright end-to-end test of the plate flow; Postgres load test.

`main` has moved since the branch point (teammates' PRs #23, #25, #26); a trial merge is conflict-free. Do not merge into `main` without the owner's explicit instruction.

