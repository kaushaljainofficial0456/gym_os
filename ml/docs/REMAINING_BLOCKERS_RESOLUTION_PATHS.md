# How to solve the remaining 5 blockers

**Context:** blockers 5–8 were closed on 2026-08-17 (`SKOS_CALORIE_MODEL_VALIDATION_CALIBRATION_REPORT.md` addendum). The remaining five — **1** (multi-exercise), **2** (individual body weight), **3** (duration extrapolation), **4** (population), **9** (exercise coverage) — were all classified "requires measured data."

That classification is correct but incomplete. It conflates three different ways a blocker can be retired, only one of which needs new data.

---

## The three routes

| Route | What it achieves | Cost |
|---|---|---|
| **1. VALIDATE** | Learn *how wrong* the model is | Measured sessions — **far fewer than expected** |
| **2. BOUND** | Make the model structurally unable to be badly wrong | **Free** — logic + scope changes only |
| **3. NARROW SCOPE** | Only claim what evidence supports | **Free** — documentation + product framing |

A blocker doesn't have to be *solved* to stop being a production blocker. It has to stop being able to cause a wrong number to reach a user unchallenged.

---

## The number that changes the plan

**[MEASURED]** Sessions required to *detect* a systematic bias (α=0.05, power=0.80, per-session relative-error SD 25%):

| True bias | Measured sessions needed |
|---|---|
| 100% (2×) | **3** |
| 50% | **3** |
| 30% | **7** |
| 20% | 14 |
| 10% | 52 |

**Contrast: full calibration — fitting a corrected model — needs 20–30 participants** (`PHASE9_STUDY_PROTOCOL.md` §3).

**[INFERENCE] Detecting whether V1 is badly wrong costs roughly a tenth of what fixing it costs.** Three to seven measured sessions would settle the largest open question in this project. That is one afternoon in a university lab, not a funded study — and it changes the framing of every conversation with a potential partner, because "validate our model in 5 sessions" is a much smaller ask than "run us a 30-person study."

---

## Route 2 applied now, at zero cost: the external plausibility envelope

**[MEASURED]** We cannot *train* on aggregate published data, but we can use it as an **external band** that V1's session-level output should fall inside. Normalised per kg so body weight cancels:

| Source | Population | kcal/min/kg |
|---|---|---|
| Rustaden 2020 (Oxycon) | 18 women, heavy-load, 12 exercises, 58 min | 0.0593 |
| Benito 2016 (Oxycon Mobile) | 29 mixed-sex, circuit, 64 min | 0.0603 |
| Adeel 2021 (Cortex) | trained, squat 60% 1RM, exercise periods only | 0.0598 |
| Nakagata 2019 | 13 men + 7 women, 66–80y, bodyweight squat | 0.0630–0.0665 |

**Combined plausible whole-session band: 0.0593 – 0.0665 kcal/min/kg** (four independent labs, four countries).

**V1 checked against it:**

| Scenario | V1 output | Verdict |
|---|---|---|
| Benito-like: 8 exercises, circuit, 64 min, 70 kg, moderate | 0.0661 | **INSIDE band** |
| 10 exercises, 115 min, 65 kg, moderate | 0.0650 | **INSIDE band** |
| Typical member: 6 exercises, 45 min, 75 kg, moderate | 0.0670 | Marginally above |
| Rustaden-like: 12 exercises, heavy, 58 min, 84 kg, **hard** | **0.1182** | **~1.8× ABOVE band** |

**[INFERENCE] This is the single most useful thing produced since the audit, and it cost nothing:**
- **V1's `moderate` tier is externally plausible.** Independent measurement from four labs agrees with it at session level. Blocker 1 is *partially* retired for moderate-tier sessions.
- **V1's `hard` tier over-estimates by roughly 1.8×.** Rustaden measured a genuinely heavy 8RM 12-exercise session — exactly what a user would rate "hard" — at 0.0593, where V1 says 0.1182.

**Caveat, stated plainly:** two whole-session studies is a thin band, the comparison is aggregate-to-aggregate, and per-kg normalisation assumes linear body-weight scaling (itself unvalidated, blocker 2). This narrows uncertainty; it does not replace measurement. Reproducible via `scripts/external_plausibility_envelope.py`.

---

## Blocker-by-blocker

### Blocker 1 — zero multi-exercise validation
- **BOUND (free, do now):** the envelope above already gives an external check. Wire it in as a startup assertion — if a session's kcal/min/kg leaves the band, downgrade confidence automatically.
- **VALIDATE (cheap):** **3–7 measured sessions** would confirm or refute the hard-tier 1.8× finding definitively.
- **Full fix:** 20–30 participants.

### Blocker 2 — no individual body weights
This one is structural, not just unmeasured: the correction is a **fixed kcal/min fit at one cohort weight**, so its relative influence swings from −213% of net at 40 kg to −22% at 150 kg (audit §3).

- **BOUND (free, do now):** restrict ML to the `body_weight_validity` range already in the artifact (57.3–100.1 kg) and fall back to **baseline** outside it, rather than returning a flagged-but-wrong number. This is the cleanest available fix and needs no data.
- **Alternative worth evaluating:** re-express the correction as a **fraction of baseline** rather than an absolute offset, making it scale with mass automatically. Physiologically this is arguably *more* defensible (energy cost of moving mass scales with mass). **But it is an unvalidated re-parameterisation** — it would need to be labelled as such and tested against the envelope before shipping. I would not do this without at least the 3–7 validation sessions.
- **Full fix:** measured sessions with individual weights spanning ~50–120 kg.

### Blocker 3 — duration extrapolation up to 180×
- **BOUND (free, do now):** cap the duration the model will estimate for (e.g. refuse beyond 120 min and fall back to baseline), or refuse to estimate `hard` tier beyond some bound given the envelope finding above. Both make the worst case unreachable.
- **VALIDATE (cheap):** the same 3–7 sessions, if chosen at realistic 45–90 min lengths, test this simultaneously.
- **Full fix:** measurement across 30/60/90/120 min.

### Blocker 4 — no female / older / beginner representation
- **NARROW SCOPE (free, do now):** state the validated population explicitly in-product wherever the estimate appears. This is honest and costs nothing.
- **Partial evidence already exists:** Nakagata 2019 (7 women, 13 men, 66–80y) and Rustaden 2020 (18 women) sit inside the envelope, which is weak but real evidence that the band holds outside young males.
- **Full fix:** stratified recruitment per `PHASE9_STUDY_PROTOCOL.md` §3.

### Blocker 9 — ~4% exercise coverage (8 of 207)
- **NARROW SCOPE (free, do now):** already handled — unknown exercises get zero correction, proportional interval widening, and (since 2026-08-17) a hard-tier confidence downgrade.
- **BOUND (free, do now):** **track which `exercise_id`s users actually pick.** This is the highest-leverage free action in this document. If real usage concentrates on 15–20 exercises, the blocker shrinks from "measure 199 exercises" to "measure 12 more" — turning an impossible task into a feasible one, using data you already generate.
- **Full fix:** measure the top-N by real usage.

---

## Recommended order

**Free, this week — no data required:**
1. **Ship usage tracking on `exercise_id`.** Highest leverage; makes blocker 9 tractable and tells you what to measure later.
2. **Restrict ML to the validated body-weight range**, baseline outside it (blocker 2, bounded).
3. **Cap estimable duration**, baseline beyond it (blocker 3, bounded).
4. **Add the envelope check** as an automatic confidence downgrade (blocker 1, bounded).
5. **State the validated population** wherever the number appears (blocker 4, scoped).

After these five, **no remaining blocker can silently produce a badly wrong number** — each either falls inside externally-measured bounds or falls back to baseline. That is enough to move from **C (Research/Experimental)** to a defensible **B (Staging)**. It is *not* enough for A.

**Cheap, next — 3–7 measured sessions:**
6. Settle the hard-tier 1.8× question. This is a single afternoon with a portable metabolic cart, and it is a far easier ask of a university partner than a full study. Per `PHASE9_ZERO_BUDGET_ALTERNATIVES.md`, an MPT student dissertation is the realistic route.

**Full calibration — 20–30 participants:**
7. Only needed for **A (Production-ready)**, and only worth doing if calorie accuracy proves to be a genuine product differentiator.

---

## What I would not do

- **Re-parameterise the correction to be multiplicative without validation data.** More physiologically defensible, still unproven — swapping one unvalidated assumption for another isn't progress.
- **Use the envelope as a training target.** It is aggregate, ~4 data points, and derived from other populations. It is a sanity check, not ground truth.
- **Treat "inside the envelope" as accuracy.** Moderate-tier sessions landing in the band means V1 is not *grossly* wrong there. It says nothing about per-session error, which remains ~22–35% on net output.

---

# IMPLEMENTATION LOG — the 5 free actions (2026-08-17)

All five executed. `correction_kcal_per_min_by_exercise_and_tier`, `interval_offsets_kcal_per_min`, `baseline` and `trained_on` verified **IDENTICAL** before and after; `backend/`, `database/` and `frontend/` untouched.

| # | Action | Status | Where |
|---|---|---|---|
| 1 | Track `exercise_id` usage | **SPECIFIED** (backend territory) | `ACTION1_EXERCISE_USAGE_TRACKING_SPEC.md` |
| 2 | Restrict ML to validated body-weight range | **DONE** | `estimable_range.body_weight_kg` in artifact; enforced in `mlEstimate` |
| 3 | Cap estimable duration | **DONE** | `estimable_range.duration_minutes` (max 120); enforced in `mlEstimate` |
| 4 | Envelope confidence downgrade | **DONE, recalibrated** | `displayEstimate.js` |
| 5 | State validated population with the number | **DONE** | `validated_population` + `validated_scope` on every result |

## Actions 2 & 3 — warnings became refusals

Previously both were `note` flags. A flag does not stop a wrong number reaching a user. Outside these bounds the correction is demonstrably implausible (a 60-minute session returning 15 kcal at 40 kg), so `mlEstimate` now **throws**, and the caller's existing baseline-fallback path takes over. Baseline is less accurate but never absurd.

Bounds ship in the artifact, not hardcoded:
- **Body weight 57.3–100.1 kg** — cohort mean ± 2SD.
- **Duration 1–120 min** — 120 is the longest resistance session with *any* independent whole-session measurement behind it (Adeel 2021 and João 2021 both 116 min). An evidence limit, not a physiological one.

Verified: 40 kg → refused, 50 kg → refused, 75 kg → 254 kcal, 110 kg → refused, 180 min → refused, 120 min → accepted (inclusive bound).

**This is a behaviour change Kaushal's port will inherit on next sync — see the coordination note below.**

## Action 4 — the envelope needed recalibrating, and the first attempt was wrong

Scoring confidence on the raw band fired on **92% of 400 simulated realistic sessions** — an always-on flag, exactly the failure mode the duration flag already had. Root cause: the band (0.0593–0.0665) comes from only two whole-session studies that happened to agree very closely, so it is far narrower than genuine between-session variability.

Fix: the comparison is **always reported** (`envelope.per_kg`, `ratio_to_band_midpoint`, `inside`) for monitoring, but only **scores into confidence on an extreme departure** — >2× from the band midpoint. Firing rate fell from 92% → **12%**, which is a usable signal.

The 2× bar is explicitly a heuristic "clearly implausible" threshold, labelled as such in code. It is not a validated boundary.

**Finding worth keeping separately:** across 2,000 simulated sessions, V1's median rate is **0.0787 kcal/min/kg vs the band midpoint of 0.0629 — about 25% high**, with p75 at 0.1103. V1 systematically runs above independent measurement. That is a real signal about the model, not a display concern, and it strengthens the case for the 3–7 validation sessions.

## Action 5 — scope travels with the number

Every `formatEstimate()` result now carries `validated_population` and `validated_scope` ("body weight 57.3–100.1kg, sessions up to 120min"), both read from the artifact. The figure can no longer be quoted without its scope attached.

## Verification

- `mlEstimate.test.js` — **28/28**, including 9 new tests for actions 2–5.
- `ml/tests/` — **40/40**.
- One pre-existing test was **deliberately updated, not weakened**: `body weight far outside training range is flagged` asserted the old warning behaviour and correctly failed once the refusal landed. It now asserts the refusal contract.

## Coordination note for Kaushal

`backend/src/services/intelligence/mlModels/skosCalV1.js` @`3999430` is a mechanical port of `mlEstimate.reference.js` and is now **out of sync**. Two changes to carry over:

1. The `estimable_range` scope gates (new `throw` paths near the top of `mlEstimate`).
2. The refreshed `model_v1.json` → `skosCalV1.model.json` (two new keys: `estimable_range`, `external_plausibility_envelope_kcal_min_per_kg`; **all fitted coefficients unchanged**).

Both throws use the existing baseline-fallback contract, so no new error handling is required — but the fallback will now trigger for a **materially larger share of sessions** (any user outside 57.3–100.1 kg, any session over 120 min). That is intended: those sessions were previously receiving implausible ML numbers.

## Verdict after the five free actions

**C → B (Staging) is now defensible.** No remaining blocker can silently produce a badly wrong number: each either falls inside externally-measured bounds, or refuses and falls back to baseline. Still **not A** — blockers 1–4 and 9 remain open on evidence, and the ~25% systematic elevation vs independent measurement is unresolved.

---

# UPDATE — bounds widened on product decision (2026-08-17)

Upper bounds extended per product call: **body weight to 125 kg**, **duration to 150 min**. Implemented as a **two-tier gate** rather than simply moving the numbers, because both extensions go beyond the evidence base and should not look as trustworthy as estimates inside it.

| Tier | Body weight | Duration | Behaviour |
|---|---|---|---|
| **Validated** (evidence-anchored) | 57.3–100.1 kg | ≤120 min | Full confidence available |
| **Extended** (product decision) | 100.1–125 kg | 120–150 min | Estimates, but flagged + confidence downgraded |
| **Refused** | <57.3 or >125 kg | >150 min | Falls back to baseline |

**The lower bound was deliberately not widened.** Below 57.3 kg the constant correction dominates catastrophically (−213% of net at 40 kg, 60-minute sessions returning 15 kcal). The upper end fails differently and far more gently — the correction's relative influence *shrinks* as body weight rises (−28% of net at 125 kg), so output stays physically plausible even outside the evidence. Asymmetric bounds reflect an asymmetric failure mode.

Verified end to end: 50 kg refused · 75 kg validated · 125 kg flagged · 130 kg refused · 120 min validated · 150 min flagged · 160 min refused. A session inside the validated band still reaches *high* confidence, so the widening did not flatten the signal.

Backend sync instructions: **`KAUSHAL_SYNC_PACKAGE_2026-08-17.md`**.

## Correction to my earlier assessment (2026-08-17)

I previously wrote that 45 kg would not be a defensible lower bound. **Measurement says otherwise, and I was over-cautious.**

At 45 kg the worst-case combination (most negative correction, 60-min session) implies **1.70–1.91 METs** — *above* the lowest resistance-exercise MET independently measured in any source we hold (1.30, Adeel 2021 shoulder press, untrained). The output is low but physiologically defensible.

My concern was anchored on the 30–40 kg cases from audit §3, where sessions clamp toward zero and the correction reaches −213% of net. Those remain genuinely broken — which is why the floor is 45 and not lower — but 45 kg is materially different from 40 kg, and I had conflated them.

Final bounds: **estimable 45–125 kg / ≤150 min**, **validated 57.3–100.1 kg / ≤120 min**, extended zone flagged and confidence-downgraded.
