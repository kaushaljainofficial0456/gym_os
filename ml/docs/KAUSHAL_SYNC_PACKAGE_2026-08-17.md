# Sync package for Kaushal — skos-cal-v1 scope gates

**From:** `ml-sambhav` · **To:** `origin/backend` (`skosCalV1.js` / `skosCalV1.model.json` @ `3999430`)
**Why not a PR from me:** the ML integration files don't exist on `ml-sambhav` — they live only on `origin/backend`. Editing them would need a checkout or cherry-pick across an actively-worked branch, which is exactly what shouldn't happen mid-flight. This is the exact change set instead.

**Fitted coefficients are unchanged.** `correction_kcal_per_min_by_exercise_and_tier`, `interval_offsets_kcal_per_min`, `baseline` and `trained_on` verified **IDENTICAL** before and after. No retraining. This is a scope restriction plus metadata.

---

## 1. Replace `skosCalV1.model.json`

Copy `ml/models/skos-cal-v1/model_v1.json` verbatim (same as the original port). Three new top-level keys:

| Key | Purpose |
|---|---|
| `validated_range` | Body weight 57.3–100.1 kg, duration ≤120 min — the evidence base |
| `estimable_range` | Body weight **45**–**125** kg, duration ≤**150** min — the hard gate |
| `external_plausibility_envelope_kcal_min_per_kg` | 0.0593–0.0665, from four independent labs |

Every other key, including all corrections and interval offsets, is byte-identical.

## 2. Add the hard gate to `mlEstimate()`

Immediately after the existing `if (!bw || !durationMin) throw ...`:

```js
  // ---- TWO-TIER SCOPE GATE (2026-08-17) ----
  // estimable_range = hard gate. Outside it we REFUSE and the caller's
  // existing baseline fallback takes over — baseline is less accurate but
  // never absurd, and out here the correction demonstrably is.
  // Both bands live in the artifact, never hardcoded.
  const hard = MODEL.estimable_range;
  if (hard) {
    const bwR = hard.body_weight_kg;
    if (bwR && (bw < bwR.min || bw > bwR.max)) {
      throw new Error(
        `skos-cal-v1 out of scope: body_weight_kg ${bw} outside estimable range ` +
        `[${bwR.min}, ${bwR.max}] — falling back to baseline (see skosCalV1.model.json estimable_range)`
      );
    }
    const durR = hard.duration_minutes;
    if (durR && (durationMin < durR.min || durationMin > durR.max)) {
      throw new Error(
        `skos-cal-v1 out of scope: duration_minutes ${durationMin} outside estimable range ` +
        `[${durR.min}, ${durR.max}] — falling back to baseline (see skosCalV1.model.json estimable_range)`
      );
    }
  }
```

## 3. Add extended-zone flags, immediately after `const notes = [];`

```js
  // Extended zone: inside the hard gate but outside the evidence base.
  const valid = MODEL.validated_range;
  if (valid) {
    if (valid.body_weight_kg && (bw < valid.body_weight_kg.min || bw > valid.body_weight_kg.max)) {
      notes.push(
        `body_weight_kg (${bw}) is outside the validated range ` +
        `[${valid.body_weight_kg.min}, ${valid.body_weight_kg.max}] — estimate is allowed but ` +
        `outside the evidence base; the correction term does not scale with body weight`
      );
    }
    if (valid.duration_minutes && durationMin > valid.duration_minutes.max) {
      notes.push(
        `session duration (${durationMin}min) exceeds the longest independently measured ` +
        `resistance session (${valid.duration_minutes.max}min) — the constant-rate assumption ` +
        `has no external corroboration beyond this point and most likely over-estimates`
      );
    }
  }
```

## 4. Remove the now-superseded body-weight warning

The old `body_weight_validity` block pushed a note for out-of-range weight. That case now either **refuses** (outside estimable) or is covered by the extended-zone flag (outside validated). Leaving it produces a duplicate note. `body_weight_validity` stays in the artifact for provenance; it's just no longer the runtime trigger.

---

## Expected behaviour after sync

| Body weight | Duration | Result |
|---|---|---|
| 40 kg | 60 min | **REFUSED** → baseline |
| 45 kg | 60 min | 112 kcal, **extended zone — flagged** |
| 50 kg | 60 min | 136 kcal, **extended zone — flagged** |
| 57.3 kg | 60 min | 170 kcal, validated |
| 75 kg | 60 min | 254 kcal, validated |
| 100 kg | 60 min | 372 kcal, validated |
| 110 kg | 60 min | 419 kcal, **extended zone — flagged** |
| 125 kg | 60 min | 490 kcal, **extended zone — flagged** |
| 130 kg | 60 min | **REFUSED** → baseline |
| 75 kg | 120 min | 508 kcal, validated |
| 75 kg | 150 min | 635 kcal, **extended zone — flagged** |
| 75 kg | 160 min | **REFUSED** → baseline |

---

## Two things to expect in staging

**1. Baseline fallback rate will rise.** Any user under 45 kg or over 125 kg, and any session over 150 minutes, now falls back. This is intended — those sessions were previously receiving ML numbers the audit showed to be implausible (a 60-minute session at 40 kg returned 15 kcal). If fallback rate spikes beyond expectation, that's a useful signal about your actual user distribution, not a bug.

**2. More sessions carry a `note`.** The extended zone flags rather than refuses. If the `note` field is surfaced in the UI, the 100–125 kg and 120–150 min bands will now show a caveat.

**No new error handling is required** — both throws use the existing baseline-fallback contract that was already in place and verified sound in the audit.

---

## Provenance of the two bounds

Worth recording, because they came from different places:

- **The validated band** is **evidence-anchored**: cohort mean ± 2SD (57.3–100.1 kg), and 120 min is the longest resistance session with any independent whole-session measurement behind it (Adeel 2021, João 2021 — both 116 min).
- **Outer bounds (45 kg, 125 kg, 150 min) are a product decision**, deliberately beyond the evidence. Both remain physically plausible — the correction's relative influence *shrinks* as body weight rises (−28% of net at 125 kg vs −53% at the 78.67 kg fit weight) — but neither is validated. That's precisely why the extended zone is flagged rather than silently accepted.

**The 45 kg floor was checked before being accepted, not just granted.** At 45 kg the worst-case combination (most negative correction, 60-min session) still implies **1.70–1.91 METs**, which is *above* the lowest resistance-exercise MET independently measured in any source we hold (1.30 — Adeel 2021, shoulder press, untrained). So output there is low but physiologically defensible. Below ~40 kg it is not: the constant correction dominates (−213% of net) and sessions clamp toward zero. That is why the floor sits at 45 and not lower.

**New guardrail shipped alongside:** `plausibility_guardrails.min_active_rate_met = 1.30`, symmetric with the existing `max_active_rate_kcal_min`. Verified **dormant across the entire 45–125 kg estimable range** (0 triggers across 1,944 body-weight × tier × exercise combinations) — it is insurance against unenumerated combinations, not an active adjustment. Port it with the rest.

## Verification on the ML side

- `ml/models/skos-cal-v1/mlEstimate.test.js` — **36/36**, including two-tier tests plus 45kg-boundary and MET-floor tests. One asserts a session inside the validated band can still reach *high* confidence, guarding against the widening making everything low-confidence; another asserts the MET floor stays dormant across the whole estimable range.
- `ml/tests/` — **40/40**.
- Coefficient identity verified against the pre-change artifact.
