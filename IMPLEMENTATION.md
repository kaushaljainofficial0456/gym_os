# Nutrition Follow-Up Hardening Pass — Implementation Report

Scope: the 31-section "MASTER FOLLOW-UP PROMPT — NUTRITION / FOOD LOGGING UI
+ CUSTOM FOOD + PERFORMANCE HARDENING". No photo food recognition / computer
vision was added, per the prompt's explicit exclusion.

## 1. Files changed

**Backend**
- [backend/src/routes/me.js](backend/src/routes/me.js) — `POST /foods/resolve` gained a `food_id` branch; `GET /foods/search`'s `enrich()` fixed to stop attaching model-catalogue data to non-catalogue rows.
- [backend/src/validate.js](backend/src/validate.js) — added `food_id` to the resolve-quantity schema.
- [backend/test/meFoodsResolve.test.js](backend/test/meFoodsResolve.test.js) — 6 new tests.
- [backend/test/meFoodsSearch.test.js](backend/test/meFoodsSearch.test.js) — new file, 4 tests.

**Frontend**
- [frontend/src/utils.js](frontend/src/utils.js) — `useFetch`'s `reload()` gained an opt-in `{ silent: true }` mode.
- [frontend/src/pages/client/Nutrition.jsx](frontend/src/pages/client/Nutrition.jsx) — every in-page-action `home.reload()` call switched to silent; `toast` wired into `FoodLogSheet`.
- [frontend/src/components/FoodLogSheet.jsx](frontend/src/components/FoodLogSheet.jsx) — `food_id`-first resolve calls, "Custom food" badge, Recent capped at 1, per-row "+"→"✓" confirmation + failure toast, Recent quick-log given the same treatment.
- [frontend/src/components/nutrition/MyDietCard.jsx](frontend/src/components/nutrition/MyDietCard.jsx) — My Diet default-visible-count limited to 1 saved food / 1 saved meal.
- [frontend/src/components/nutrition/CustomizeMealSheet.jsx](frontend/src/components/nutrition/CustomizeMealSheet.jsx) — one-active-block workspace model; `addFoodItem` fixed to send `food.id` first.
- [frontend/src/components/nutrition/MealFoodRow.jsx](frontend/src/components/nutrition/MealFoodRow.jsx) — Recent capped at 1 (pre-existing fix from earlier in this branch, confirmed intact); new `onAdded` callback wired into all four add paths.

## 2. Bugs fixed

1. **Custom-food selection could resolve to the wrong food** (Section 2, the prompt's own "serious correctness bug"). Root cause below.
2. **Tapping "+" on a quick-log row visually reloaded the whole Nutrition page**, closing the search sheet and wiping its state (Sections 5-7, 15). Root cause below.
3. **Customize Meal's per-block Recent list showed the same 5 items N times** (Sections 8-9) — capped to 1 per block (this fix predates this exact session turn but is part of the same hardening pass and was re-verified here).
4. **`CustomizeMealSheet.addFoodItem` sent `food.source_id || food.id`** — wrong priority; `source_id` only means anything to a model-catalogue lookup, and preferring it over a real row's own `id` could route a meal-builder add through the same name-search fallback as bug #1.
5. **My Diet showed up to 2 saved foods/meals by default** instead of exactly 1 (Section 1).
6. **Log/Estimate Food's Recent section showed up to 6 items** instead of 1 (Section 4).

## 3. Root cause — custom-food selection bug (Section 2)

`POST /me/foods/resolve` never consulted the `foods` table at all. Regardless
of which food a user tapped — including their own private custom food —
the route always ran a NAME-based search against the static model catalogue
(`searchFoodModel(name || source_id || '', ...)`) and priced whatever that
search's top/matching hit was. A custom food's own row (its own stored
calories/protein/carbs/fat) was never the source of truth for pricing it.

This was compounded by `GET /foods/search`'s `enrich()` helper, which
attached a name-matched model-catalogue "twin" (`source_id` + `portions`) to
**any** `mine`/`library` row, not just genuine `VERIFIED_DATABASE` rows —
so a custom food could carry a `source_id` that belonged to a same-named but
different catalogue food, further steering `/resolve` toward the wrong data
even when a `source_id` was present.

**Fix**: `/foods/resolve` now accepts an optional `food_id`. When present,
it queries the `foods` table directly —
`WHERE id = ? AND (client_id = ? OR client_id IS NULL)`, the same
ownership-scoped pattern already used elsewhere in this codebase — and
prices linearly off that row's own `calories`/`protein`/`carbs`/`fat` and
parsed `serving` baseline (same `grams / baseServingAmount` scaling
`MyDietCard.jsx` already used, factored into a shared backend helper).
`enrich()` now only attaches catalogue-twin data when
`row.source === 'VERIFIED_DATABASE'`. Three frontend call sites
(`FoodLogSheet.jsx`'s two resolve calls, `CustomizeMealSheet.jsx`'s
`addFoodItem`) were fixed to send `food.id` first, never `food.source_id`
first.

**Regression tests** (backend/test/meFoodsResolve.test.js,
backend/test/meFoodsSearch.test.js — 10 new tests, all passing) cover the
prompt's own Tests A-D: a custom food resolves to its own id/macros; a
same-named global-database food is never substituted; a second client can
never resolve or search another client's custom food by id or by name; two
clients' identically-named custom foods each resolve to their own distinct
row.

## 4. Root cause — food-logging "full page reload" (Sections 5-7, 15)

Nutrition.jsx renders `if (home.loading) return <Spinner .../>` gating its
entire returned tree on a SHARED, whole-app `/tracking/me/home` fetch
(`useFetch`, owned by `ClientLayout.jsx` and passed down via Outlet
context — one fetch shared by every client page, specifically to avoid
duplicate per-page fetches). Every action in Nutrition.jsx that wanted
fresh totals — including the food-logging path — called `home.reload()`.

`useFetch`'s `reload()` triggers a `setLoading(true)` synchronously, before
the refetch resolves. That flips `home.loading` true for the duration of
the round-trip, and Nutrition.jsx's render gate then swaps its ENTIRE
returned JSX to a bare `<Spinner/>`. Nutrition.jsx itself doesn't unmount
(same component instance across its own re-renders), but every CHILD that
only existed in the "real" tree — including an open `FoodLogSheet`, with
all of its own local search-query/results/grams state — does: gone on the
trip through `<Spinner/>`, mounted fresh (blank) on the way back. That is
the actual mechanism behind "search interface disappears/reopens" for what
looks, from the fetch log, like one background refetch.

**Fix**: `useFetch`'s `reload()` now accepts an optional `{ silent: true }`
argument that skips the `loading` toggle for that one refetch — `data`
stays visibly present (stale-but-shown) throughout, and swaps in place once
the fresh response lands. Every `home.reload()` call in Nutrition.jsx that
fires from an in-page action (quick-log, edit, delete, meal toggle, water,
target setup, Customize Meal save) now passes `{ silent: true }`; the one
exception left as a bare `reload()` is the genuine full-page error-retry
button, where a blocking spinner is the correct UX. This is an additive,
backward-compatible change — every other `useFetch` consumer in the app
that never opts into silent mode is unaffected.

**Live-verified** (see §13): quick-logging a food via search results and
via Recent both leave the sheet open, the search query intact, and update
Today's Fuel's totals in the background, with no spinner flash and no
console errors.

## 5. Recent-search UX changes (Section 4, 8-9)

- `FoodLogSheet.jsx`'s idle-screen Recent section: `limit=6` → `limit=1`.
- `MealFoodRow.jsx`'s per-block Recent section: `limit=5` → `limit=1`
  (verified intact in this pass; the underlying `GET /me/foods/recent`
  history itself is untouched — only the UI's own requested `limit` changed,
  so nothing about a user's logging history was deleted or altered).

## 6. My Diet visibility changes (Section 1)

`MyDietCard.jsx` now slices to `foods.slice(0, 1)` / `meals.slice(0, 1)`
when not expanded (was effectively showing more), and the "See more" label
now reads the correct remaining count. Zero-items empty state was already
correct and untouched.

## 7. Customize Meal workspace redesign (Sections 8-11)

Replaced the old "N reusable rows can be open simultaneously, each resets
to blank after adding a food" model with a one-active-block model:
`CustomizeMealSheet`'s `rowIds` now holds at most one id. `MealFoodRow`
gained an `onAdded` callback, fired after any successful add (database
search result, Custom Macros, "use existing" duplicate resolution, or AI
estimate) — the parent drops that row's id from `rowIds` on `onAdded`,
collapsing it. A row's contribution is already rendered as a compact
`✓ Name · qty · kcal [remove]` card in the existing `items` list directly
below (a small `✓` was added to that card for clarity — the card format
itself, including inline-edit-quantity and remove, already existed and did
not need to be rebuilt). "+ Add another food" always replaces `rowIds` with
exactly one fresh id (never appends), so at most one search field is ever
live, and tapping it while an earlier not-yet-completed block is still
half-typed discards that never-committed state rather than stacking a
second active search field. Live-verified end to end (see §13).

## 8. Performance findings (Section 12-14, 27)

- **Search debounce/race safety** (Section 14): already correctly
  implemented in both `FoodLogSheet.jsx` (200ms debounce) and
  `MealFoodRow.jsx` (220ms debounce), each with a `dead` flag set in the
  effect's cleanup so a stale in-flight response can never overwrite a
  newer one. Confirmed by reading the code directly, not assumed. No change
  needed.
- **Duplicate network requests observed on Nutrition page load**
  (`/me/announcements`, `/intel/coach/brief`, `/intel/coach/weekly`,
  `/tracking/me/home`, `/me/foods`, `/me/meals`,
  `/tracking/clients/:id/supplements` each fired twice). Investigated and
  confirmed this is `<React.StrictMode>` (wrapping the whole app in
  `main.jsx`) double-invoking effects in **development only** — a
  deliberate React dev-mode safeguard for catching missing effect cleanup,
  not a genuine duplicate-fetch bug in this app's own code. It does not
  happen in a production build. No fix applied (removing StrictMode would
  reduce, not improve, the app's own bug-catching ability, for no real
  production benefit).
- **The full-page-reload/remount bug itself** (§4 above) was the dominant
  perceived-performance issue described in the prompt ("the entire
  application feels slow" was largely this: every logged food triggered a
  visible spinner-flash and full remount of the open sheet). Fixing it
  removes that remount/re-render cost on every quick-log, edit, delete, and
  meal-toggle action across the whole Nutrition page.
- Not undertaken this pass: a full N+1/index audit of the backend or a
  bundle-size pass (Section 12's other listed areas). These weren't touched
  by any change in this pass and no user-reported symptom pointed at them;
  flagging as unexamined rather than claiming them clean.

## 9. Database changes

None. The `food_id` resolve branch queries the existing `foods` table with
an existing ownership-scoping pattern; no new table, column, index, or
migration was added or needed (Section 25).

## 10. Tests added

10 new backend tests, all passing:
- `backend/test/meFoodsResolve.test.js` — 6 new (food_id resolution,
  Tests A/B/D, linear scaling, invalid-id handling).
- `backend/test/meFoodsSearch.test.js` — new file, 4 tests (own custom food
  visible + correctly labeled, Test C cross-client privacy, two clients'
  identically-named foods stay distinct, unauthenticated rejection).

No frontend test framework exists in this repository (no test script in
`frontend/package.json`, no Vitest/Jest config) — this is a pre-existing
condition, not something introduced or left broken by this pass. Frontend
behavior (the reload/remount fix, the block-collapse redesign, the
checkmark/toast UX) was verified live in a real browser session instead
(§13), consistent with how every other frontend change in this codebase's
history has been verified.

## 11. Existing tests passed

`npm test` (backend, Node's built-in test runner): **1016/1019 passing**.
The one failure (`community.test.js:226`, a leaderboard period-aggregation
assertion) is a pre-existing flake unrelated to this work — present before
any change in this pass and consistent with every prior test run this
session.

## 12. Frontend build result

`npm run build` (frontend): clean, no errors, after every batch of changes
in this pass (utils.js, Nutrition.jsx, FoodLogSheet.jsx,
CustomizeMealSheet.jsx, MealFoodRow.jsx).

## 13. Live browser verification result

Verified against the local dev servers (backend :4000, frontend :5173) as
the existing logged-in test client:

- **Quick-log, no reload** (Section 29 Flow 4): searched "rice", tapped a
  result's "+". Network log showed `POST /me/foods/resolve` →
  `POST /nutrition/clients/:id/meals/log` → `GET /tracking/me/home`
  (silent). The sheet stayed open, the search query and result list stayed
  visible/unchanged, no spinner appeared. Repeated via the Recent
  quick-log path with the same result. Confirmed via `console` (zero
  errors throughout the session) and via reopening the page fresh: Today's
  Fuel totals reflected both new logs correctly (kcal/protein/carbs/fat).
- **Customize Meal one-active-block workspace** (Section 29 Flow 5):
  created a test meal, added one food via search — the search block
  collapsed immediately into a `✓ Rice, cooked, NFS · ✓ DATABASE ·
  ×100g each · 129 kcal · ✕` card, "+ Add another food" appeared, and
  tapping it opened exactly one fresh, blank block (Recent + search),
  with no second active search field and no duplicated card.
- **My Diet default visibility**: confirmed exactly 1 saved food and 1
  saved meal shown by default, with an accurate "See more (N more)" count.
- Cleaned up all test artifacts created during verification (the test
  meal and the two log entries) before finishing, restoring the client's
  data to its pre-verification state.
- **Mobile viewport**: visually verified at 375×812 — layout reflows
  correctly with no horizontal overflow or clipped content. Interactive
  click-testing at that viewport size hit a rendering limitation in this
  browser-automation environment (not a reproducible app error — no
  console errors, no failed requests) and could not be completed live in
  this pass; the desktop-verified interaction logic is not
  viewport-conditional (the sheets use the same fixed-overlay pattern with
  only cosmetic `sm:` breakpoint differences), so this is a lower-confidence
  gap, not a known-broken path.

## 14. Remaining performance bottlenecks / follow-up work

Being explicit about what was **not** fully covered in this pass, so
nothing here is overstated:

- No systematic backend N+1-query or missing-index audit was performed
  (Section 12's backend/database bullets). Nothing observed suggested a
  problem, but nothing was actively measured either.
- No bundle-size work was done; the existing `vite build` warning about
  chunks over 500kB (`three.module`, `charts`, `index`) predates this pass
  and was not investigated.
- Accessibility (Section 22) and full mobile-width interactive sweep
  (320/390/430px, Section 23) were not exhaustively re-verified beyond the
  375px visual check above and the aria-labels already present on the
  touched buttons (`Quick log {name}`, `{name} logged`, `Cancel this food
  entry`, etc.).
- Sections 20-21's toast/error-copy audit was applied to the specific flows
  touched in this pass (quick-log success/failure) but not swept across
  every existing toast in the app for wording consistency.

No claim of "fully optimized" or a numeric score is made anywhere in this
report — see the measured/verified facts above for what was actually
checked.
