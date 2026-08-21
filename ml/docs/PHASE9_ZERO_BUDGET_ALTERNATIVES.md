# Phase 9 — Zero-Budget Alternatives

**Context (2026-08-16):** the paid lab-partnership route in `PHASE9_STUDY_PROTOCOL.md` is not fundable. That protocol is not wasted — it is exactly what a student researcher or collaborating clinician would need. What changes is *who runs it and why they agree to*, not *what gets measured*.

This document is the honest set of options at ~zero budget, ranked by realism, plus a plain recommendation.

---

## The reframe that makes this viable

The paid model asks a lab to sell us measurement time. That is expensive because it is a service purchase.

**Every zero-cost route below works differently: the other party wants something we already have — participants, real-world workout data, and a publishable question — and they already own the equipment.** We are not buying lab time; we are supplying the missing half of someone else's research project.

---

## Option 1 — Student dissertation collaboration (RECOMMENDED)

**Cost: effectively zero. Realism: high.**

Indian **MPT (Master of Physiotherapy) Sports Physiotherapy** and MSc Exercise Physiology programs require a dissertation. Their syllabi explicitly cover exercise physiology, energy systems, VO2 max and metabolic assessment. Students need: a defined research question, access to participants, and equipment. Their department already has the equipment. **We can supply the other two.**

Critically, **Sri Ramachandra (SRCSS) runs an MPT Sports Physiotherapy program AND has the Metamax VO2 analyser** already identified in `PHASE9_CALIBRATION_COHORT_PLAN.md` as the best equipment match found. Same institution, two routes in — one costs money, one is a student needing a thesis topic.

**What the student gets:**
- A ready-made, pre-specified protocol (`PHASE9_STUDY_PROTOCOL.md`) — analysis plan already written, which is often the hardest part of a dissertation
- A genuinely novel population: real gym members, not undergraduate volunteers (most of this literature is undergraduates)
- Recruitment access via SK OS gyms — usually a student's biggest bottleneck
- A publishable question with a clear gap: *"how accurate are app-based calorie estimates during real resistance-training sessions?"*
- Co-authorship, and the dataset for their own future work

**What SK OS gets:** the calibration data, and the audit's open questions answered.

**Cost to SK OS:** recruitment coordination, possibly participant refreshments/travel. Not lab fees.

**Approach:** contact the **department head / MPT programme coordinator**, not the commercial lab office. Different door, different economics. Ask: *"Do you have a student looking for a dissertation topic? We have the protocol, the participants, and the industry data — you have the calorimeter."*

**Realistic timeline:** academic-year bound. Dissertation topics are typically allocated at semester start, so timing matters more than money here.

---

## Option 2 — Hospital cardiac-rehab / pulmonary-function departments

**Cost: low. Realism: moderate.**

Metabolic carts are standard in cardiac rehabilitation and pulmonary function labs, and are often idle outside clinic hours. A sympathetic clinician with a research interest may allow a small number of sessions.

Weaker than Option 1 — no built-in incentive for them unless someone is personally interested — but worth asking if there is an existing relationship. Note the equipment is usually **stationary**, which conflicts with the protocol's portability requirement (§4.3); a stationary cart cannot follow someone around a gym floor. Would likely force a reduced-scope, machine-based session.

---

## Option 3 — Keep author outreach running (already in flight, free)

Four requests: Rustaden 2020, João 2021, Nakagata 2019, Adeel cluster. Zero cost, already sent or identified. Any single positive reply adds a genuinely independent participant-level dataset.

**Honest expectation:** most such requests go unanswered, and the Adeel group's data-availability statement ("all available in the article") is a soft no. But it costs nothing to have four requests outstanding, and one reply changes the situation materially.

---

## Option 4 — Ship V1 and stop ML work (SERIOUS OPTION, NOT A FAILURE)

**Cost: zero. Realism: total.**

V1 is already validated at **19.1% MAPE out-of-sample**, which sits at the *good* end of the published range for consumer wearables measured against calorimetry (15–57%, Mitchell et al. 2024). It has honest documented limitations, validated uncertainty intervals, a plausibility guardrail, and a full pre-integration audit.

The strategic question is not "can the model be better?" — it always can. It is: **does calorie accuracy differentiate SK OS?** For a gym-management product at ₹12,000/year, users are unlikely to perceive any difference between 19% and 15% error, and neither number is precise enough to present without a range regardless.

Going from 19% → ~15% would require the entire calibration study. That is a large effort for a change no user will notice.

---

## What is explicitly NOT an option

- **Kaggle/Hugging Face calorie columns.** Empirically tested and disqualified (`V2_DATA_QUALITY_RULES.md` worked example: R²=0.966 from six trivial features — a formula, not a measurement).
- **Wearable-reported calories as ground truth.** That is the very thing this model exists to improve on.
- **Self-reported or estimated labels.** Same reason.
- **Synthesising or augmenting the existing 14 participants into "new" ones.**

Being unable to fund a lab does not lower the evidence bar. It changes which doors we knock on.

---

## Recommendation

**Do Options 1, 3 and 4 in parallel. They do not conflict.**

1. **Ship V1 to staging now** (Option 4) — it is ready, audited, and gated behind `CALORIE_MODEL_PROVIDER=ml`. The remaining blockers are the contract question for Kaushal and a UI decision on the `note` field, neither of which needs new data.
2. **Send one email to an MPT programme coordinator** (Option 1) — near-zero cost, and the protocol is already written. Sri Ramachandra is the obvious first target: right equipment, right programme, already researched.
3. **Let the four author requests sit** (Option 3) — free, already in flight.

**Treat V2 as opportunistic, not planned.** If a student project or an author reply materialises, the pipeline is built and tested (40/40 tests) and Phase G runs immediately. If neither does, V1 remains a legitimate, honestly-documented product feature — which it already is.

The thing to avoid is holding the product back waiting for data that may never arrive.
