# Nutrition Real-World Validation

Branch `feature/nutrition-engine-overhaul` · 2026-11-16

## Status: **Requires external validation — not started. No real-world data has been collected.**

Every accuracy number in the Phase 1 and Phase 2 reports comes from the benchmark: 945 typed descriptions scored against database rows, published ranges and USDA reference portions. None comes from a real person's real plate. This document covers three things:

1. What the benchmark **cannot** tell us (§1).
2. The protocol that would (§2–§5).
3. The real-use signals the product **already records**, which can be read from the first day of deployment without a study (§6).

Nothing in this file is an observed result. Where a number appears, it is a design target or a threshold to be tested.

---

## 1. What the benchmark cannot show

| Question | Why the benchmark can't answer it |
|---|---|
| How big is a real person's katori, bowl or plate? | The benchmark scores portions against the catalogue's own unit weights or USDA reference portions. Real Indian kitchens vary, and portion is already the largest measured error (MAE 104 kcal on standard-portion cases). |
| How much oil goes into a real home or mess dish? | Reference rows are fixed recipes; real oil use varies several-fold. |
| What do people actually type, and how often is the first answer accepted? | The benchmark's phrasing was written by us. |
| How do errors add up over a day or a week? | Every case is scored alone. |
| Are confidence labels honest for real use? | Calibration (ECE 0.08 on independent references) was measured on benchmark cases only. |

---

## 2. Study design — weighed-plate agreement

**Goal:** measure how closely an SK OS log matches what was actually eaten, for real meals in real settings.

**Design:** prospective, free-living agreement study.

1. The participant logs each meal in the app, normally, before eating.
2. They then weigh each component on a supplied kitchen scale (1 g resolution) and photograph the plate.
3. A trained reviewer, blind to the SK OS output, builds a **reference record**:
   - weighed grams per component;
   - nutrition from IFCT 2017 / INDB / USDA rows chosen by the reviewer;
   - for home-cooked dishes, a recipe recorded on the day (ingredients weighed raw, the dish weighed cooked), priced by the yield method.

**Sample (design target, to be confirmed with a statistician):**
- about 30 participants, 10 days each, about 3 logged meals per day, giving roughly 900 meals and 2,500 items;
- at least 4 regions (North, South, West, East), because regional dishes and katori sizes differ;
- 3 settings: home-cooked, canteen or mess, restaurant or takeaway;
- both sexes, ages 18–60, a range of body sizes;
- **no minors.** The app's under-18 safeguards apply, and a study with minors needs separate ethics approval.

**Why this many:** about 900 meals gives a 95% confidence half-width of roughly ±3 percentage points on an in-range rate near 70%. It also gives enough meals per setting (around 300) to see whether restaurant meals are worse.

---

## 3. What is measured

Each metric is reported **per item and per meal**, and **split by setting and region**.

| Metric | Definition |
|---|---|
| Identification accuracy | The logged item is the food eaten (reviewer judgement against the photo and recipe) |
| Silent drops | A food eaten but absent from the log, unless the person chose to leave it out (which is recorded) |
| Portion error | \|logged grams − weighed grams\| ÷ weighed grams |
| Energy error | MAE and median absolute % error in kcal, item and meal |
| Agreement | Bland–Altman bias and 95% limits of agreement for meal kcal, and for daily kcal on complete days |
| Macro error | The same for protein, carbohydrate and fat |
| Calibration | Expected calibration error by confidence band, and by food category |
| Correction behaviour | Share of items the person changed before logging (from `nutrition_corrections`) |
| Effort | Seconds from opening the logger to logging, and taps per meal |

---

## 4. Acceptance thresholds (proposed — owner to confirm before the study)

| Claim | Threshold to call it met |
|---|---|
| "Identifies what you ate" | Item identification ≥ 95% |
| "Never silently drops food" | Silent-drop rate 0% (any drop is a defect) |
| "Portions are usually close" | ≥ 70% of items within 25% of weighed grams |
| "Meal calories are reliable" | Median meal kcal error ≤ 20%; Bland–Altman bias within ±10% |
| "Confidence means something" | ECE ≤ 0.10 overall and in each setting |

If a threshold is missed, the claim is not made in marketing or in-app copy until it is met.

---

## 5. Consent, privacy and data handling

- **Informed consent** that explains purpose, data collected, retention and withdrawal. Participation is separate from gym membership, and declining has no effect on membership.
- **India's Digital Personal Data Protection Act, 2023:** consent must be specific to this study. Collect only what the study needs: meal logs, weights, photos of food, age band, sex, region. Erase on withdrawal and at study end.
- **Separation:**
  - study data goes in a separate export keyed by a study id, not in tenant tables;
  - photos are taken of the plate only, with faces and people excluded, and are not stored with any account identifier;
  - reviewer tooling never shows names.
- **Ethics:** if the results are to be published, submit to an institutional ethics committee first.
- **No incentives tied to logging accuracy**, which would bias the logs.

---

## 6. Real-use signals already recorded (available at deployment, no study needed)

Phase 2 added three things that start producing real-world evidence as soon as the branch is deployed. None is a substitute for §2, because nobody weighs anything, but together they show where the engine is wrong in practice.

**1. `nutrition_corrections`.** Every food swap or assumed-amount change made before logging, plus every later quantity edit.
- Phrases that are corrected often are where identification or default portions are wrong.
- Phrases that are swapped to the same food by many people are the review queue for shared mappings (`/console/intelligence/food/correction-candidates`).

**2. `meal_logs.nutrition_source` and `confidence`.** These record what share of logged calories rests on measured rows, on recipe estimates, on AI estimates and on the person's own numbers.

**3. `meal_log_requests.excluded_json`.** This records what people chose **not** to log after being told an item wasn't found: real coverage gaps.

Example monitoring queries (PostgreSQL, run as the platform operator; counts only, no identities):

```sql
-- How often each phrase is corrected, by kind (last 30 days)
SELECT phrase, kind, COUNT(*) AS corrections, COUNT(DISTINCT client_id) AS people
  FROM nutrition_corrections
 WHERE created_at >= to_char(now() - interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS')   -- created_at is ISO text
 GROUP BY phrase, kind
HAVING COUNT(DISTINCT client_id) >= 3
 ORDER BY people DESC, corrections DESC
 LIMIT 50;

-- Where logged calories come from
SELECT COALESCE(nutrition_source, 'legacy (before provenance)') AS source,
       COUNT(*) AS items, ROUND(SUM(calories)::numeric) AS kcal
  FROM meal_logs
 WHERE eaten = 1 AND date >= to_char(now() - interval '30 days', 'YYYY-MM-DD')
 GROUP BY 1 ORDER BY kcal DESC;

-- Foods people could not log
SELECT jsonb_array_elements_text(excluded_json::jsonb) AS not_found, COUNT(*) AS times
  FROM meal_log_requests
 WHERE excluded_json IS NOT NULL
 GROUP BY 1 ORDER BY times DESC LIMIT 50;
```

A minimum of 3 distinct people per phrase in shared views is deliberate: it is the same threshold the shared-mapping review uses, so no single person's eating can be singled out.

---

## 7. Image estimation (F10): decision

- **What exists.** `POST /intel/meal-photo` sends a photo to a vision model and asks it for calorie *ranges* directly. The numbers it returns are the model's, not the food database's. The only UI is `AskSK.jsx`, which nothing renders. It needs a paid vision provider.
- **Decision: not exposed, and no paid service introduced.** The brief requires owner approval before adding a paid external service. A photo path is also the least verifiable part of food logging until §2 exists.
- **Design for when it is approved:**
  1. The vision model only **identifies foods and estimates portion ranges**.
  2. Each food is priced by the deterministic engine from the catalogue (`estimateFood` / `priceBySourceId`), never by the model.
  3. Items are labelled `ai_estimate` with portion confidence `low`, and the person confirms each item on the plate before logging.
  4. Cost is assessed per photo before launch.
  5. It is validated on the §2 photos, which is why the protocol asks for one photo per meal.
- **Status:** **Not implemented — requires an owner decision on a paid provider, and external validation.**
