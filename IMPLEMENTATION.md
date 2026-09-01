# SK OS Nutrition Redesign — Implementation Report

**Branch:** `integrate-teammates` · **Commit:** `a791107` · **Status:** Pushed

This report covers the full 55-part nutrition/food-logging UX redesign
implemented in this arc, for review against the original spec.

---

## 1. Summary

Every functional requirement, correctness fix, test-coverage gap, and
accessibility requirement in the spec is implemented, tested, and
live-verified against the real dev stack. Both explicitly optional/
suggested items (a component-extraction breakdown and a visual-polish
pass) were also completed. Along the way, five real, previously-latent
bugs were found and fixed — most significantly, a silent correctness
bug in "Edit Quantity" that affected every individually-logged food.

**Test suite:** 843/844 backend tests passing. The one failure
(`community.test.js`'s `leaderboards: period=month`) is a pre-existing,
unrelated date-boundary flake — confirmed to fail in isolation, unchanged
by anything in this arc, re-confirmed after every change this session.

**Build:** `npm run build` (frontend) clean throughout.

**Database migrations required:** None. Every feature reuses existing
tables/columns.

---

## 2. Files changed

### New files
| File | Purpose |
|---|---|
| `frontend/src/nutritionCalc.js` | Single source of truth for the 4/4/9 calorie formula and "sum eaten totals" |
| `frontend/src/components/PortionWheel.jsx` | Generic, reusable animated quantity wheel (native scroll + CSS snap) |
| `frontend/src/components/nutrition/MealFoodRow.jsx` | One independent food-entry row for the multi-row meal builder |
| `frontend/src/components/nutrition/CustomFoodBadge.jsx` | Extracted provenance pill ("✓ Database" / "✨ AI Estimated") |
| `frontend/src/components/nutrition/AIEstimateCard.jsx` | Extracted compact AI-estimate preview card |
| `backend/test/nutritionTargets.test.js` | 9 tests — 4/4/9 derivation and validation |
| `backend/test/meFoods.test.js` | 17 tests — custom-food CRUD, fiber/sugar/sodium, two-user isolation, Recent foods |
| `backend/test/meFoodsResolve.test.js` | 7 tests — the core grams→macros endpoint, incl. multi-portion math proof |
| `backend/test/meMealLogs.test.js` | 10 tests — edit/delete a logged entry, proportional scaling, isolation |
| `backend/test/meShare.test.js` | 9 tests — sharing, duplicate-name handling, cross-client save |
| `backend/test/nutritionHistoryConsistency.test.js` | 2 tests — cross-route totals agreement |

### Modified files
| File | What changed |
|---|---|
| `backend/src/routes/me.js` | 4/4/9 derivation, fiber/sugar/sodium support, `GET /foods/recent`, quantity/unit persistence fixes |
| `backend/src/routes/nutrition.js` | Shared `sumEatenTotals()`, quantity/unit persistence on individual food logs |
| `backend/src/validate.js` | Schema support for fiber/sugar/sodium, quantity/unit, nullable `unit` |
| `backend/test/nutrition-meal-log-api.test.js` | +2 tests for quantity/unit persistence |
| `frontend/src/components/FoodLogSheet.jsx` | The bulk of the redesign — quick-log rows, portion picker rewrite, Custom Macros, duplicate handling, Recent foods, accessibility, state-machine navigation, portal rendering |
| `frontend/src/components/NutritionTargetSetup.jsx` | Live-derived calories from macros |
| `frontend/src/components/nutrition/CustomizeMealSheet.jsx` | Multi-row workspace, accessibility, portal rendering |
| `frontend/src/components/nutrition/MyDietCard.jsx` | Quantity/unit fix for its own quick-log path |
| `frontend/src/pages/client/Nutrition.jsx` | `keepOpen` pattern, toast z-index, lifted mode state, quantity/unit threading, math consolidation, cosmetic display fix |

---

## 3. API changes

| Endpoint | Change |
|---|---|
| `POST /me/nutrition/targets/confirm` | Derives `calories` server-side via 4/4/9; ignores any client-supplied value; validates macro ranges (422 on bad input) |
| `POST /me/foods`, `PUT /me/foods/:id` | Accept optional `fiber`/`sugar`/`sodium` |
| `GET /me/foods/recent` | **New.** Powers Recent foods in both entry points; excludes plan- and meal-template-sourced logs |
| `POST /nutrition/clients/:id/meals/log` | Now accepts and persists real `quantity`/`unit` |
| `PUT /me/meal-logs/:id` | `unit` is now nullable (previously rejected `null` outright) |

---

## 4. Feature-by-feature (mapped to spec parts)

**Search & logging (Parts 1–13, 20)**
- Every search result renders as a quick-log row: inline gram input + "+" button, staying open after logging (`keepOpen` pattern) instead of bouncing to the dashboard.
- Tapping a result's name opens the full portion picker; tapping "+" quick-logs immediately.
- AI fallback (Tier 4) and kNN fallback (Tier 3) both already existed and remain fully wired, both surfaced consistently in the redesigned search screen.

**Portion picker & quantity (Parts 4–10)**
- "How many" stepper removed. Replaced by `selectedPortions` (multiple simultaneous portions, e.g. "1 small bowl + 1 tablespoon") plus a mutually-exclusive custom-weight override.
- New `PortionWheel.jsx`: animated vertical quantity picker via native scroll-snap, with keyboard support, `prefers-reduced-motion` handling, and a numeric fallback.
- Multi-portion combination resolves via one `/me/foods/resolve` call per portion, summing already-server-computed totals client-side (never re-deriving portion→grams). **A dedicated backend test proves this is mathematically sound**: summing two separate resolves equals one resolve for the combined weight.
- A generic food-icon placeholder is shown where no real image exists (never a fabricated URL).

**Custom Macros (Parts 14–19)**
- A second entry mode (name + calories/protein/carbs/fat, always required) available in both Log Food and Customize Meal.
- Optional fiber/sugar/sodium fields behind a collapsed disclosure.
- Routes through the existing private `foods` table (`POST /me/foods`), then the ordinary `food_id` path — never mislabeled as an AI estimate.
- Duplicate-name handling: an exact case-insensitive match offers **Use existing** (logs the original's own stored macros) or **Create another** (bypasses the check once) — never silent overwrite, never a blocked spam of near-identical entries.

**Multi-row meal builder (Parts 18, 21–22)**
- `CustomizeMealSheet.jsx` now renders N independent `MealFoodRow` instances, each with its own Search/Custom-Macros toggle and local state.
- Rows are keyed by generated ids (not a bare count) — verified via a live test that a middle row's removal never discards a different row's in-progress typing.
- AI fallback and Recent foods both fully available per-row.

**Navigation (Parts 23–24)**
- Back (one step) vs. Close (exit from anywhere, no selection required) are strictly distinguished.
- Refactored from a repeated multi-boolean conjunction (found duplicated in 5 places) to one derived `screen` state, computed once and reused everywhere — directly addressing the "clean state model, not random booleans" requirement.

**Correctness (Parts 25–32, 37, 42, 46)**
- 4/4/9 Atwater formula is now the single, server-enforced source of truth for target calories.
- **Single source of truth for "eaten today" totals** — a real gap (3 independent implementations) closed via a shared `sumEatenTotals()` on both backend and frontend.
- **The most significant bug of this arc**: "Edit Quantity" silently scaled every individually-logged food from a fabricated 100-unit baseline, because `quantity`/`unit` were never persisted for any log except a saved-meal-template log. Fixed end to end (schema → route → every frontend logging call site). Live-verified: a real 150g entry now scales exactly 2× when edited to 300, not 3×.
- Historical-log immutability preserved throughout (a dedicated test proves editing one entry never touches another).
- Search network failures now show a distinct error + retry, never indistinguishable from "no results."

**Security & isolation (Part 38)**
- Custom-food ownership was already server-enforced; now backed by a real two-user isolation test suite (edit/delete/list, all blocked cross-user) rather than a code read alone.

**Recent foods (Parts 40–41)**
- Reconstructed from existing `meal_logs` history (no new table), available in both Log Food and the meal builder.
- Excludes both plan-assigned AND client-saved meal logs (a real bug — a saved meal could otherwise appear mislabeled as an individual food — found and fixed via the structural `meal_template_id` check).

**Accessibility & responsiveness (Parts 33–36, 46)**
- Escape closes the topmost layer only, one step at a time, across every sheet and the portion wheel.
- `role="dialog"` / `aria-modal` / dynamic `aria-label` added everywhere.
- Zero horizontal overflow confirmed at a real 375px viewport at every screen depth.
- Touch targets for Close/Back/remove controls grown to real hit areas without changing their visual footprint.
- A genuine CSS containing-block bug (an ancestor's `animation: ... both` leaving a stale `transform`, breaking `position: fixed` viewport-fixation) was found via screenshot auditing and fixed by rendering both sheets through a `document.body` portal — the fully general fix, with zero risk to the many other pages sharing that animation class.

**Testing (Part 50)**
- 50+ new backend tests across 6 files, closing every backend gap the architecture notes had flagged (`/me/foods*`, `/me/foods/resolve`, `/me/meal-logs/:id`, `/me/share*`).
- UI-only behaviors (rapid-tap duplicate-logging prevention, exact back/close sequences) were verified live in the browser repeatedly rather than automated, since this repo has no frontend test runner.

**Suggested component breakdown (Part 53)**
- `MealFoodRow.jsx`, `PortionWheel.jsx`, `CustomFoodBadge.jsx`, and `AIEstimateCard.jsx` all extracted as named, reusable components.

**Visual polish (Part 49)**
- Audited rather than blindly modified. Design-token discipline confirmed clean. One real CSS bug found and fixed (above). One initial "finding" (a font-family difference) was checked against `tailwind.config.js`'s own documented rationale and found to be a **deliberate two-face design system**, not a bug — corrected rather than force-"fixed."

---

## 5. Known, deliberate exceptions

- Portion-chip and oil-level buttons remain 26px tall (meets WCAG AA's 24px minimum, not the stricter AAA 44px) — left alone rather than risk the already-verified dense wrapping layout for a lower-value secondary control.
- Safe-area-inset (notch/home-indicator) awareness wasn't tested — no way to emulate a physical notch in the available browser tooling.
- A handful of UI-behavior test scenarios remain verified-live-only rather than automated, per the note under Testing above.

---

## 6. Verification performed

- Full backend suite run after every change (final: 843/844).
- Frontend production build run after every change (clean throughout).
- Extensive live browser verification against the real dev stack (SQLite, a real seeded client account): search → quick-log, the full portion picker with the wheel and multi-portion combination, Custom Macros with duplicate handling in both entry points, the multi-row workspace with independence proven via marker-text tests, Recent foods end-to-end, the complete Escape/Back/Close chain, editing and deleting logged entries, and the quantity-editing bug fix confirmed with exact arithmetic (94→188 kcal for a 150g→300g edit).
- All test data created during live verification was cleaned up via direct API/DB calls afterward — no test artifacts remain in the dev database.
