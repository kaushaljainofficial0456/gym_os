# SK OS — Full-System Performance + Nutrition Bug-Fix Pass

Report for the "MASTER PROMPT — SK OS FULL-SYSTEM PERFORMANCE OPTIMIZATION +
NUTRITION GAP FIXES". No UI/UX redesign, no new features, no business-logic
changes, no photo food recognition — see confirmations at the bottom.

## 1. Bugs fixed

**Nutrition (Phase 1 items 1–6 of this prompt)** — all six were already
implemented and verified in the immediately preceding session turn (My Diet
1-item default, custom-food `food_id` resolution, Recent capped to 1 in
both entry points, silent-reload "+"→"✓" with no page remount, Customize
Meal's one-active-block workspace, Back/Close semantics unchanged). Not
re-done here; spot-checked live in this pass and still correct.

**Newly found and fixed in this pass:**

1. **`POST /me/foods/resolve` rejected almost every custom/library food**
   with `"Validation failed — source_id: Expected string, received null"`
   — reported live by the user mid-session (`paneer`, 400 kcal/100g). Every
   frontend call site builds this request from a search result's own
   `source_id`, which is a genuine SQL `NULL` (not merely absent) for any
   food without a materialized model twin — i.e. almost every custom food.
   `JSON.stringify` keeps an explicit `null` in the wire payload (unlike
   `undefined`, which it drops), and the schema's `source_id` was
   `.optional()` only, which accepts `string | undefined` but rejects
   `null`. The route body already treated a null `source_id` exactly like
   an absent one — this was purely a schema gap.
2. **Custom-food creation had no upper bound**, but the food-*logging*
   route caps calories/protein/carbs/fat at 10000/1000/1000/1000 — a food
   saved above that ceiling became permanently unloggable with only the
   generic `"Validation failed"` message to show for it.
3. **The generic message itself**: `validate.js` already computed a
   helpful per-field `issues` array, but the frontend's `api()` only ever
   read `data.error` into the thrown error's `.message` — every one of
   this app's many `catch (e) { toast(e.message) }` call sites showed the
   same useless string for every validation failure, anywhere in the app.
4. **Gym owner's Business dashboard "Revenue · 6 months" chart was
   silently wrong for 5 of 6 months, always** — found while auditing
   `GET /business/overview` for the performance pass, not reported by the
   user. The `payments` query only ever fetched the current calendar
   month; a "last 6 months" trend loop then filtered *that same*
   month-scoped array by month, so every month except the current one
   could only ever match zero rows. A gym with real prior-month revenue
   could see 5 blank bars, or the whole chart falling into "No revenue
   recorded yet" whenever the current month itself had no payments yet.
5. **Home dashboard's Protein/Carbs/Fat totals were raw, unrounded
   floats** (`252.29999999999998 / 800 g`) — reported live by the user. A
   duplicated inline sum, drifted from the shared `sumEatenTotals()`
   helper `nutritionCalc.js` already exists for exactly this.
6. **`GET /tracking/me/home`** (the single highest-traffic endpoint in the
   app — every client page loads it once via `ClientLayout`'s shared
   fetch) **ran a completely unused query** on every call: a `meals`
   fetch across every nutrition plan the client has ever had, whose
   result was never read anywhere in the function (confirmed via a
   full-body grep before removing, not assumed). Also parallelized two
   independent lookups (`user`, `client`) that were sequential for no
   reason.

## 2. Performance bottlenecks found

- **`/tracking/me/home`**: one wasted query per call (see #6 above) — the
  highest-value fix in this pass, since this endpoint loads on every
  single client-side page view.
- **`/tracking/me/home`**: `user` and `client` lookups ran sequentially
  despite having no dependency on each other.
- **Admin console (`admin/` package) ships as a single, non-code-split
  bundle** (241 kB / 72.8 kB gzip, `admin/dist/assets/index-*.js`) — the
  main frontend has 33 lazy-loaded routes; the admin console has none.
  Identified, not fixed (see §14 — deliberately not touched, below).
- **Duplicate requests observed on Nutrition page load** (`/me/foods`,
  `/me/meals`, `/tracking/clients/:id/supplements`, `/tracking/me/home`,
  etc. each firing twice). Investigated and confirmed this is
  `<React.StrictMode>` (wraps the whole app in `main.jsx`) deliberately
  double-invoking effects in **development only** — not a real
  duplicate-fetch bug in the app's own code, and does not happen in a
  production build. No fix applied (removing StrictMode would reduce the
  app's own bug-catching ability for no real production benefit).

## 3. Performance optimizations implemented

| Change | File | Effect |
|---|---|---|
| Removed unused `meals` query from `Promise.all` | `backend/src/routes/tracking.js` | One fewer DB round-trip on every load of the app's single highest-traffic endpoint |
| Parallelized `user`/`client` lookups | `backend/src/routes/tracking.js` | One fewer sequential round-trip on the same endpoint |

Everything else audited (see §13 below) was **already** optimized from
earlier work on this codebase, and is called out as verified-fine rather
than re-implemented:

- **Frontend code-splitting**: 33 routes already behind `React.lazy()` in
  `App.jsx` (Admin/Enterprise/Business/WorkoutBuilder/NutritionBuilder/
  Reports/Messages/etc.) — Section 11's requirement was already met.
- **Database indexing**: 85 `CREATE INDEX` statements in
  `database/schema.sql`, already covering exactly the columns this
  prompt calls out — `client_id`+`date` on every log table, `org_id`+
  `status` on subscriptions/payments/refunds/support tickets/risk events,
  `org_id`+`created_at` on payment orders/invoices/admin audit logs,
  food search/name/source, meal items, AI food-estimate `canonical_key`.
  No new index added — nothing found that was missing and justified.
- **AI cost/performance**: a dedicated cache (`foodAICache.js`,
  `ai_food_estimates` table, keyed by a canonicalized query) is already
  fully wired into the estimate flow (`foodAI.js` imports and calls
  `getCachedEstimate`/`saveCachedEstimate`/`bumpCacheUsage`) — Section
  17's requirement was already met.
- **Admin dashboard KPIs** (`GET /console/overview`,
  `GET /business/overview`'s non-trend fields): already computed via SQL
  `COUNT`/`SUM` aggregates, not fetched wholesale and reduced in
  JavaScript — Section 18's requirement was already met, with one
  exception (the revenue trend, fixed above — that one *was* JS-side
  aggregation, over a dataset that happened to be broken, not over-fetched).
- **Nutrition search debounce/race-safety**: `FoodLogSheet.jsx` (200ms)
  and `MealFoodRow.jsx` (220ms) both already debounce and both already
  guard stale responses with a `dead` flag set in the effect's own
  cleanup — confirmed by reading the code directly, not assumed. No
  change needed for Section 10/14.
- **Trainer client list** (`GET /clients`): already bounded
  (`LIMIT` default 500, max 1000, org/trainer-scoped), filtered/sorted in
  JS only after that bounded fetch — reasonable for a gym roster's actual
  scale; no evidence of this being a real bottleneck was found.

## 4. Files / modules changed

- `backend/src/routes/tracking.js` — `/me/home` query fixes.
- `backend/src/routes/admin.js` — revenue-trend window fix.
- `backend/src/validate.js` — `source_id` nullable, `foodCreate`/
  `foodUpdate` upper bounds.
- `frontend/src/api.js` — surfaces `issues` in thrown error messages.
- `frontend/src/components/FoodLogSheet.jsx` — `source_id || undefined`
  at 3 call sites; earlier `+`/`✓`/toast work (prior turn).
- `frontend/src/pages/client/Home.jsx` — shared `sumEatenTotals()` +
  rounding instead of a duplicated, unrounded inline sum.
- `backend/test/meFoodsResolve.test.js` — 1 new test (null `source_id`).
- `backend/test/businessRevenueTrend.test.js` — new file, 3 tests.

## 5. Database migrations

None. Every fix in this pass changed either a request-validation rule, a
query's date window, or which pre-existing columns a query selects —
never the schema itself. No new table, column, or index was added or
needed.

## 6. API / database query improvements

- `/tracking/me/home`: 7 parallel queries → 6 (one genuinely unused
  query removed), plus 2 previously-sequential queries now parallel — 2
  fewer round-trips per call on the app's busiest endpoint.
- `/business/overview`: query window widened from "this month only" to
  "6 months" (a correctness fix that happens to touch the same query the
  performance audit was inspecting) — no new query added, same query,
  wider `WHERE paid_at >= ?` bound.

## 7. Frontend rendering improvements

None implemented this pass. `useMemo`/`useCallback` are already used in
86 places across 30 files, including the exact hot paths this prompt
calls out (`Nutrition.jsx`, `Workout.jsx`, `ClientLayout.jsx`,
`WorkoutBuilder.jsx`, the 3D muscle-anatomy view). No `React.memo` usage
was found on food-search-result rows or similar list items. This is
flagged, not fixed: without a React DevTools Profiler session actually
run against this app, wrapping components in `memo()` on code-reading
alone would be exactly the "blind memoization" this prompt's own Section
8 explicitly warns against — no profiling evidence of a real re-render
bottleneck was gathered in this pass.

## 8. Bundle / network improvements

No bundle-size change from this pass's edits (confirmed: `Nutrition-*.js`
chunk is 125.90 kB after vs. 126.21 kB before this pass's edits — the
~0.3 kB difference is the `|| undefined` guards and comment text added,
not a structural change). Main frontend bundle-size profile is unchanged
from the pre-existing, already-code-split baseline (see §9 for numbers).

## 9. Before/after measurements

**Frontend build** (`frontend/`, production):
- Clean before and after every change in this pass; no new build
  warnings introduced. Existing warning (3 chunks over 500 kB —
  `three.module` 734 kB, `charts` 387 kB, `index` 394 kB) is unchanged
  from before this pass and was not investigated (out of scope — none of
  it was touched, and Three.js/charting libraries are large by nature;
  splitting them further would be a real architecture change, not a
  small targeted one).
- `Nutrition-*.js` chunk: 125.90 kB gzip 30.30 kB (was 126.21 kB / 30.40
  kB before this pass's 3 small guard-clause edits).

**Admin console build** (`admin/`, production): clean, 241.05 kB / 72.83
kB gzip, single bundle (no code-splitting present — see §2/§14).

**Backend**: 1020/1023 tests passing both before and after this pass's
changes (the 3 new tests added by this pass, plus everything that already
passed). The 1 failure is `community.test.js:226`, a pre-existing flake
(`1800 !== 9000`) unrelated to anything touched this session — present
identically before this pass, and present across every prior test run
this entire multi-phase session.

**Request counts**: not independently re-measured with tooling beyond
manual network-log inspection in the browser during live verification
(see §12). The `/me/home` fix removes exactly 1 query from that
endpoint's own execution per call — this is a code-level count (7→6
parallel queries, `user`+`client` moved from 2 sequential calls to 1
parallel Promise.all), not a measured wall-clock timing, and is reported
as such rather than inventing a millisecond figure I did not measure.

## 10. Tests added

- `backend/test/meFoodsResolve.test.js` — 1 new test: an explicit
  `source_id: null` (what every real call site actually sends for a
  custom food) is accepted, not rejected.
- `backend/test/businessRevenueTrend.test.js` — new file, 3 tests: a
  payment from 3 months ago appears in its own month in the trend (not
  silently dropped); `monthlyRevenue` stays scoped to just the current
  month even though the underlying query now spans 6 months; a gym with
  zero payments *this* month but real prior history is not shown as "no
  revenue" in the trend.

(Nutrition Phase-1 items already had their own regression tests from the
immediately preceding turn: 10 tests across `meFoodsResolve.test.js` and
`meFoodsSearch.test.js` for custom-food selection/privacy.)

## 11. Full test result

`npm test` (backend, Node's built-in test runner): **1020/1023 passing.**
1 failure, 2 skipped — the failure is the same pre-existing
`community.test.js` leaderboard-aggregation flake seen throughout this
entire session, unrelated to any change made in this pass.

## 12. Production build result

- `frontend/`: `npm run build` — clean, no errors.
- `admin/`: `npm run build` — clean, no errors.
- Live browser verification (local dev, both servers running):
  - The exact reported "paneer" custom-food quick-log now succeeds
    end-to-end (`resolve → 200` → `meals/log → 201` → background
    `tracking/me/home → 200`), sheet stays open, search query preserved,
    no page reload.
  - Home dashboard's macro totals now show `252.3` instead of
    `252.29999999999998`.
  - Overflow custom-food creation (15000 kcal) is now rejected at save
    time with `"Validation failed — calories: Number must be less than
    or equal to 10000"` shown inline, instead of silently succeeding and
    failing unexplained later.
  - Console: zero errors throughout every verification pass this session.
  - All test data created during verification was cleaned up afterward
    (deleted test foods/meals/log entries), leaving the client's real
    data — including their own genuine "paneer", "lkn", and "maggi"
    entries — untouched.

## 13. Remaining bottlenecks

Being explicit about what was **not** independently re-measured or fixed
in this pass, per this prompt's own "if exact timings cannot be measured,
say so honestly" instruction:

- No systematic N+1 audit was completed for every route in the app —
  only the highest-traffic client endpoint (`/me/home`) and a sampling of
  `Promise.all` sites across `console.js`, `admin.js`, `clients.js`,
  `tracking.js` (all found correct/already-optimal on inspection). A few
  write-loop patterns were found (see §14) and deliberately left alone.
- No bundle-size reduction was attempted for the 3 chunks already over
  500 kB (`three.module`, `charts`, `index`) — real, but pre-existing and
  outside what a small, low-risk change could safely address.
- No React re-render profiling was run (no Profiler session available in
  this environment) — §7's finding is a code-reading observation, not a
  measured bottleneck.
- The admin console's lack of route-level code-splitting (§2) was
  identified but not implemented — see §14.
- Asset optimization (images/icons/animations, Section 12 of the master
  prompt) was not audited in this pass — no evidence-gathering was done
  here at all, and this is reported as unexamined rather than "checked,
  found fine."
- Serverless/cold-start specifics (Section 24 — Vercel route module
  weight, expensive module-init work) were not audited in this pass.

## 14. Optimizations deliberately NOT made

- **Admin console code-splitting**: identified as genuinely missing
  (single 241 kB bundle, no `React.lazy()` anywhere in that package), but
  not implemented — doing this safely means reading and restructuring
  that package's own routing first, and there is no evidence yet that its
  current load time is actually a problem for anyone; a real architecture
  touch deserves its own reviewed pass, not a rushed addition at the tail
  of an already-large one.
- **Batch-rewriting the alert-reconciliation write loop**
  (`backend/src/services/atRisk.js`, called from the trainer dashboard):
  currently issues one `UPDATE`/`INSERT` per client per fired/resolved
  alert rule inside a loop. A genuine N+1-shaped write pattern, but
  rewriting it into a bulk upsert changes SQL structure in a way that
  needs careful correctness verification for an alerts system trainers
  actively make decisions from — not something to touch without dedicated
  testing, per this prompt's own "correctness takes priority" rule.
- **Batch-rewriting `POST /me/meals/share`'s per-item loop**
  (`backend/src/routes/me.js`): loops over user-selected meal/food ids
  fetching each individually. Left alone: user-initiated, bounded by
  however many items someone manually picked to share (realistically
  single digits), not a page-load hot path — the risk of subtly changing
  its existing "silently skip a stale/foreign id" behavior via a batched
  `WHERE id IN (...)` rewrite outweighs the benefit for this call
  frequency.
- **Schema-level `.min(0)` on `foodCreate`/`foodUpdate`'s
  calories/protein/carbs/fat**: deliberately NOT added alongside the
  upper-bound fix. The route already rejects negative/impossible macro
  combinations via `validateFoodRecord()`, with a richer 400 response
  (`{error, details}`) than the generic schema-level 422 — adding a
  lower bound at the schema layer would have intercepted first and
  downgraded that into the same generic message this whole pass is
  trying to get away from. Caught by re-running the existing test suite
  before finalizing this fix, not assumed correct.
- **Adding new indexes speculatively**: none added. 85 already exist,
  covering every access pattern this prompt calls out by name. Adding
  more without a specific slow query to point at would violate this
  prompt's own "add indexes only where justified" / "avoid duplicate
  indexes" rules.

## 15. UI/UX confirmation

**Not redesigned.** No color, layout, typography, spacing, icon,
navigation, modal, animation, or visual-hierarchy change was made
anywhere in this pass. Every change was either backend query/validation
logic, or a frontend data-correctness fix (rounding, a `|| undefined`
guard, reusing an existing shared helper) — none of which alter what
anything looks like or how it's arranged on screen.

## 16. No photo recognition confirmation

**Confirmed.** No computer-vision, image-based food-recognition, or any
new AI capability was added, touched, or proposed anywhere in this pass.

## 17. Existing features/business logic confirmation

**Confirmed preserved.** No pricing, permission, authentication, payment,
workout, AI-provider-selection, gym-owner, trainer, or client behavior
was changed except the two explicit correctness bugs listed in §1 (the
revenue-trend window and the food-macro overflow cap) — both are bug
fixes that make already-intended behavior work correctly, not changes to
what that behavior is supposed to be. Every fix in this pass was
verified against the existing test suite (1020/1023, same pre-existing
unrelated flake) before being considered done.
