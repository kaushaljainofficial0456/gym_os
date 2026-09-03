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
7. **Custom Macros could fail with a bare "Invalid food data" for
   completely realistic values** — reported live by the user (a
   300g-plate-sized biryani: 835 kcal, 30g protein, 100g carbs, 35g fat).
   `POST /me/foods`'s own `validateFoodRecord()` check (protein+carbs+
   fat+fiber can't exceed 100g per 100g of food — a real, correct
   physical-plausibility rule, not a bug) returns its reason in a
   `details` array, a *second* instance of the exact class of bug just
   fixed for `issues`: `api()` only folded `issues` into the error
   message, not `details`. Extended the fold to cover both (first fix).
   Root cause of *why* the rule rejected genuinely normal data: Custom
   Macros had no serving-size concept at all — every `foods` row in this
   app is per-100g internally (confirmed against this codebase's own
   convention: the manual-barcode form already converts a real serving
   size to per-100g before storing, "entered values are per-serving;
   store per-100g like every other source"), so a real ~300g plate's
   totals (completely normal for that size) were being validated as if
   they described 100g. **Real fix, not just a clearer error**: added an
   actual "Serving size (g)" field to both Custom Macros forms
   (`FoodLogSheet.jsx` and `MealFoodRow.jsx`), converts entered values to
   per-100g before saving (`factor = 100/servingGrams`), stores
   `serving: '100 g'` (what the saved numbers actually represent — NOT
   the original serving size, which would double-scale every future
   quantity), and logs the *original* entered values immediately with a
   real `quantity`/`unit` instead of a fabricated "1 serving". The
   Customize Meal path additionally needed its own fix: `POST
   /me/meals/:id/items` multiplies `quantity` directly against the
   food's stored macros, so `MealFoodRow.jsx` now passes `servingGrams`
   through and `CustomizeMealSheet.jsx`'s `addCustomFoodItem` computes
   `quantity = servingGrams / 100` instead of a flat `1` (which would
   have silently meant "log 100g of it" regardless of what was typed).
   **Live-verified end to end** with the user's exact numbers at a 300g
   serving: saved cleanly, logged today's totals correctly as
   `835 kcal / 30g / 100g / 35g` (not scaled wrong), and the stored row
   confirmed as genuinely per-100g (`278.33 kcal, 10g, 33.33g, 11.67g`) —
   then re-resolved at 150g and got exactly half of the original entry
   (`417.5 kcal, 15g, 50g, 17.5g`), proving future quick-logs of this
   food scale correctly too.
8. **A third instance of the "real error reason gets discarded" bug
   class** — found by auditing for more of it after fixing `issues` and
   `details`. A handful of routes (`console.js`'s refund guard,
   `enterprise.js`'s downgrade-block/no-recipient/email-failure
   responses) return `{ error: 'short_code', message: 'the real human
   sentence' }` — `error` there is a machine-readable reason, not display
   text, but `api()`'s `data.error || data.message` ordering picked the
   code every time. Confirmed all 4 real occurrences of this shape
   follow it consistently (checked each one, not assumed) before
   flipping the priority to `data.message || data.error` — safe as a
   global default, since every other route sets `error` alone and falls
   through unchanged. `EnterpriseBilling.jsx` already had its own one-off
   `e.data?.message || e.message` workaround for exactly this gap;
   removed it as redundant, along with 6 other identical workarounds
   found across `Business.jsx` and 3 admin console pages (`GymDetail.jsx`
   ×3, plus 2 `err.data?.issues?.join(...)` variants in
   `Announcements.jsx`/`FeatureFlags.jsx` for the `issues` case). The
   admin console's **own separate `api.js`** (same duplication reasoning
   as its `utils.js`) had never received any of the three fixes at all —
   brought fully in sync in one pass rather than piecemeal.

## 1b. App-wide reload/remount fix (the single biggest change in this pass)

The Nutrition "+ reloads the whole page" bug (fixed in the previous turn via
`useFetch`'s new `reload({ silent: true })`) turned out to be a systemic
pattern, not a Nutrition-specific one. A repo-wide sweep for the shape
`X.reload()` paired with `if (X.loading) return <Spinner/>` (or an inline
`loading ? <Spinner/> : (...)`) found the identical bug, unfixed, across
nearly every interactive page in the app:

- **`Workout.jsx`** — scheduling today's session, the exercise-toggle
  failure path, resuming an already-completed workout, and finishing a
  workout all remounted the page (including, for the last one, an
  in-progress `execute` session with its own local set/rep state).
- **`Business.jsx`** (gym owner) — adding a package, subscription, or
  payment, saving gym settings, and every membership action (suspend/
  cancel/renew) remounted the whole dashboard.
- **`Profile.jsx`** (client) — avatar upload/removal, every metric create/
  edit/log/delete (6 call sites), goal updates, and coach-preference saves.
- **`Community.jsx`** — joining/leaving the community, sharing a workout,
  unsharing.
- **`Membership.jsx`** — the post-payment confirmation reload could flash
  the page to a spinner right as the "success" screen was trying to show.
- **`ClientProfile.jsx`** (trainer) — 4 separate sub-tabs (Equipment,
  Nutrition, AI Coach, Messages), each with its own smaller-scoped version
  of the same bug (a card flashing to a spinner instead of the whole page).
- **`WorkoutBuilder.jsx`**, **`NutritionBuilder.jsx`** — saving a template/
  plan, duplicating a template, adding a library exercise.
- **`EnterpriseBilling.jsx`**, **`EnterpriseQR.jsx`** — emailing an invoice,
  upgrading/adding capacity, completing a payment, generating/revoking a QR.
- **`Alerts.jsx`**, **`Messages.jsx`** (trainer) — resolving an alert,
  sending a message.
- **`ClientLayout.jsx`** — the one-time onboarding-complete transition.

Every one of these call sites now uses `reload({ silent: true })`, the same
opt-in, backward-compatible mechanism built for Nutrition — genuine
error-retry buttons (`onRetry={x.reload}`) were left bare throughout, since
a blocking spinner is the correct behavior there. This was a full sweep,
not a sample: every `.reload()` call in `frontend/src` was individually
read and classified; the only ones left unchanged are `ErrorBoundary.jsx`'s
crash-recovery `location.reload()` (a real browser reload, unrelated) and
genuine Retry buttons.

**Live-verified** on the highest-frequency case (Workout set completion):
typed a distinctive, unsaved value into one exercise's set-2 reps field,
then marked a *different* set done (which fires the exact reload path that
used to remount the page). The unsaved value was still there afterward —
proof the page never remounted, since an actual remount would have reset
every input to its default. Test values cleaned up afterward.

The admin console (`admin/`) turned out to have its **own separate copy**
of `useFetch` (`admin/src/utils.js`, deliberately kept in sync with the
main one per its own header comment) that predated this fix entirely.
Brought it back in sync with the same `reload({ silent: true })`
mechanism.

**A follow-up, corrected sweep found the first pass had a real gap.** The
original grep only matched `X.reload()` (a dotted call through a
destructured object); it silently missed the equally common
`const { reload } = useFetch(...)` pattern used bare as `reload()`. A
corrected sweep (`\breload\(` instead of `\.reload\(`) across both apps
found **19 more unfixed call sites**: 3 in the main frontend
(`Clients.jsx`'s create-client flow, and a third `AITab` call site in
`ClientProfile.jsx` the first pass had missed inside a component already
otherwise fixed) and 16 in the admin console across 6 pages
(`GymDetail.jsx` suspend/reactivate/refund, `Announcements.jsx`
create/delete, `FeatureFlags.jsx` create/toggle/rollout/delete,
`Reconciliation.jsx` sweep/resolve, `Risk.jsx` scan/act,
`SupportDetail.jsx` reply/status/priority/assign). All fixed the same
way. This is called out explicitly rather than left implicit, since the
first pass's own report claimed a "full sweep" that turned out to be
incomplete — the corrected, actually-complete sweep is what's reflected
here.

## 2. Performance bottlenecks found

- **`/tracking/me/home`**: one wasted query per call (see #6 above) — the
  highest-value fix in this pass, since this endpoint loads on every
  single client-side page view.
- **`/tracking/me/home`**: `user` and `client` lookups ran sequentially
  despite having no dependency on each other.
- **`GET /workouts/templates`**: a genuine N+1 — fetched a trainer's
  templates, then looped over them running one separate exercises query
  per template, sequentially. Found and fixed (see §3).
- **Admin console (`admin/` package) shipped as a single, non-code-split
  bundle** (241.05 kB / 72.83 kB gzip) — the main frontend has 33
  lazy-loaded routes; the admin console had none. Found and fixed (§3).
- **`frontend/public/logo.png`**: a 512×512, 434 kB PNG referenced by its
  actual display size (28–56 px CSS, `w-7`/`w-11`/`w-14`) on 10+ pages
  (login, signup, layout header, onboarding). Found and fixed (§3).
- **Duplicate requests observed on Nutrition page load** (`/me/foods`,
  `/me/meals`, `/tracking/clients/:id/supplements`, `/tracking/me/home`,
  etc. each firing twice). Investigated and confirmed this is
  `<React.StrictMode>` (wraps the whole app in `main.jsx`) deliberately
  double-invoking effects in **development only** — not a real
  duplicate-fetch bug in the app's own code, and does not happen in a
  production build. No fix applied (removing StrictMode would reduce the
  app's own bug-catching ability for no real production benefit).
- **Nutrition search re-render scope** (explicitly named in the master
  prompt: "a single food-row update should NOT rerender the entire
  Nutrition page"): confirmed via code structure, not a profiler —
  `FoodLogSheet.jsx`'s search `q`/`results` state is local to that
  component, never lifted into `Nutrition.jsx`. React re-render
  propagation runs downward from wherever state lives, so typing in the
  search box was already structurally incapable of re-rendering the
  parent Nutrition page — nothing to fix here. Individual result rows
  (capped at 8–25 items) re-rendering on each keystroke is normal,
  sub-millisecond React reconciliation for a list this size; wrapping
  them in `React.memo` was considered and not done — no evidence of a
  real cost to offset the added complexity (see §14).

## 3. Performance optimizations implemented

| Change | File | Effect (measured) |
|---|---|---|
| Removed unused `meals` query from `Promise.all` | `backend/src/routes/tracking.js` | One fewer DB round-trip on every load of the app's single highest-traffic endpoint |
| Parallelized `user`/`client` lookups | `backend/src/routes/tracking.js` | One fewer sequential round-trip on the same endpoint |
| Batched `workouts.js`'s N+1 template-exercises loop into 1 query + JS grouping | `backend/src/routes/workouts.js` | N+1 round trips → 2 queries total, regardless of template count. Response shape verified identical via 2 new tests |
| Route-level code-splitting for the admin console (14 pages behind `React.lazy`, mirroring the main app's own 33-route pattern) | `admin/src/App.jsx` | Main bundle **241.05 kB → 179.62 kB** (59.35 kB gzip, was 72.83 kB) — a measured 25.5% reduction; each page now loads its own small chunk (0.3–8.4 kB) only when visited, instead of all 14 shipping on every login |
| Resized/recompressed the app logo (512×512 → still 256×256, non-palette PNG at quality 90) | `frontend/public/logo.png` | **444.7 kB → 111.7 kB** — a measured 75% reduction, on an asset referenced across 10+ pages, all of which display it at 28–56 px. Verified visually (side-by-side) before replacing, and live in the running app afterward — no visible quality loss at actual display size |
| Split React/ReactDOM/React Router into their own `vendor-react` chunk | `frontend/vite.config.js` (`manualChunks`) | Main `index` chunk (the one bundle loaded on *every* page view): **394.20 kB → 230.87 kB** (125.70 → 73.11 kB gzip); `vendor-react` is a new, separate 164.04 kB (53.50 kB gzip) chunk. A caching win (vendor code no longer invalidates on every app-code deploy), not a total-byte reduction — reported as exactly that. Verified against the real production build (`vite preview`, not the dev server) — both chunks load with zero console errors, real content renders on first paint |

All five are genuinely measured (file sizes, build output, live browser
verification), not estimated.

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
- `backend/src/routes/workouts.js` — `/workouts/templates` N+1 → batched.
- `backend/src/validate.js` — `source_id` nullable, `foodCreate`/
  `foodUpdate` upper bounds.
- `frontend/src/api.js` — surfaces `issues` **and `details`** in thrown
  error messages.
- `frontend/src/components/FoodLogSheet.jsx` — `source_id || undefined`
  at 3 call sites; per-100g clarification on the Custom Macros form;
  earlier `+`/`✓`/toast work (prior turn).
- `frontend/src/components/nutrition/MealFoodRow.jsx` — same per-100g
  clarification on its own Custom Macros form.
- `frontend/src/pages/client/Home.jsx` — shared `sumEatenTotals()` +
  rounding instead of a duplicated, unrounded inline sum.
- `frontend/public/logo.png` — resized/recompressed in place.
- `admin/src/App.jsx` — route-level `React.lazy()` + `Suspense`, 14 pages.
- **App-wide `reload({ silent: true })` rollout** (see §1b) —
  `frontend/src/pages/client/{ClientLayout,Community,Membership,Profile,
  Progress,Workout}.jsx`, `frontend/src/pages/trainer/{Alerts,Business,
  ClientProfile,EnterpriseBilling,EnterpriseQR,Messages,NutritionBuilder,
  WorkoutBuilder}.jsx` — 14 files, ~30 call sites.
- `backend/test/meFoodsResolve.test.js` — 1 new test (null `source_id`).
- `backend/test/businessRevenueTrend.test.js` — new file, 3 tests.
- `backend/test/workoutTemplatesBatch.test.js` — new file, 2 tests.

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
- `/workouts/templates`: N queries (1 + 1-per-template) → 2 queries
  total, regardless of how many templates a trainer has saved. Same
  batch-then-group-in-JS pattern already established elsewhere in this
  codebase (`GET /me/week`'s own day-of-week exercise lookups), reused
  rather than inventing a new approach.

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

- **Main frontend**: no structural bundle-size change from this pass's
  Nutrition/validation edits (`Nutrition-*.js` chunk: 125.90 kB after vs.
  126.21 kB before — the ~0.3 kB difference is `|| undefined` guards and
  comments, not a structural change). Was already comprehensively
  code-split (33 routes) from earlier work; nothing further done here.
- **Admin console**: genuinely restructured — see §3's table. Main
  bundle 241.05 kB → 179.62 kB (25.5% smaller), 14 pages now load their
  own chunk on demand instead of shipping together on every login.
- **Logo asset**: 444.7 kB → 111.7 kB (75% smaller), served on 10+ pages.
- **`/workouts/templates`, `/tracking/me/home`**: fewer round trips per
  request (see §6) — smaller effective network *time*, not payload size
  (the JSON response shape itself is unchanged in both cases).

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

**Admin console build** (`admin/`, production): main bundle **241.05 kB
→ 179.62 kB** (72.83 → 59.35 kB gzip), plus 14 new small on-demand page
chunks (0.33–8.40 kB each) that did not exist before this pass — see §3.

**Backend**: 1022/1025 tests passing (the 5 new tests added across this
pass — 1 `meFoodsResolve`, 3 `businessRevenueTrend`, 2
`workoutTemplatesBatch` — plus everything that already passed). The 1
failure is `community.test.js:226`, a pre-existing flake (`1800 !== 9000`)
unrelated to anything touched this session — present
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
- `backend/test/workoutTemplatesBatch.test.js` — new file, 2 tests: two
  templates' exercises are never cross-contaminated and stay in position
  order after the N+1→batched rewrite; a template with zero exercises
  returns `[]`, not `undefined`.

(Nutrition Phase-1 items already had their own regression tests from the
immediately preceding turn: 10 tests across `meFoodsResolve.test.js` and
`meFoodsSearch.test.js` for custom-food selection/privacy.)

## 11. Full test result

`npm test` (backend, Node's built-in test runner): **1022/1025 passing.**
1 failure, 2 skipped — the failure is the same pre-existing
`community.test.js` leaderboard-aggregation flake seen throughout this
entire session, unrelated to any change made in this pass.

## 12. Production build result

- `frontend/`: `npm run build` — clean, no errors.
- `admin/`: `npm run build` — clean, no errors, now emits 15 chunks
  instead of 1 (see §3/§9).
- Admin console live-verified after the code-splitting change: logged in
  as the seeded `SUPER_ADMIN`, navigated Dashboard → Gyms →
  Reconciliation; each page's own chunk (`Gyms.jsx`, etc.) confirmed
  fetched on demand via the network log, zero console errors, all three
  pages rendered their real data correctly.
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

## 12b. Database connections and serverless cold-start (Sections 23–24)

Both audited this pass, nothing changed — verified already correct:

- **Connection pooling** (`backend/src/db.js`): `getDb()` is a
  module-level singleton — the `pg.Pool` is created once per warm
  process and reused across every request, never per-request. Every
  transaction (`client.tx`) properly `c.release()`s its connection in a
  `finally` block — no leak path found. Pool size uses `pg`'s own
  default (not blindly raised, per this prompt's own instruction).
  **Not verifiable from code alone**: whether the deployed `DATABASE_URL`
  points at Neon's pooled endpoint (vs. the direct one) is an
  environment-variable choice made in Vercel's dashboard, invisible to
  this repo — worth the user double-checking directly, since that
  matters more for serverless connection-count limits than anything in
  application code.
- **Serverless cold-start** (`backend/api/index.js`, `backend/src/index.js`,
  the food-model loaders): the Express app is already memoized across
  warm invocations (`if (!appPromise) appPromise = buildApp()`, with an
  explicit comment already reasoning about cold vs. warm starts). The
  food-model JSON artifacts (`foodEstimator.js`'s kNN index,
  `plausibility.js`/`classify.js`'s config overlays) are lazily loaded
  and cached on first *use*, not read at module-import time — confirmed
  by grepping for any eager top-level call to their loader functions
  (none found). Nothing here needed fixing.

## 13. Remaining bottlenecks

Being explicit about what was **not** independently re-measured or fixed
in this pass, per this prompt's own "if exact timings cannot be measured,
say so honestly" instruction:

- N+1 audit is now reasonably broad but not exhaustive: all 10 files
  originally flagged by a repo-wide grep for `for (...) { await db.q...`
  were individually read and classified (2 genuine read-N+1s found —
  `/me/home`'s wasted query, `/workouts/templates` — both fixed; 2
  write-loops found and deliberately left, see §14; 1 legitimate
  cursor-pagination bulk job; the rest clean on inspection). Routes with
  no loop at all (the majority of the app) were not individually
  re-audited beyond the `Promise.all` sampling in §3/original pass.
- `three.module` (734 kB) and `charts` (387 kB) were left alone —
  confirmed both are already correctly isolated behind this app's own
  lazy-route loading (neither downloads until a page that actually needs
  3D visuals or a chart is visited), so splitting them further is a real
  architecture change for a first-load benefit that doesn't apply to
  most visits. The one chunk that loads on *every* page view, `index`
  (394.20 kB / 125.70 kB gzip), got a safe, standard fix instead: React,
  ReactDOM, and React Router pulled into their own `vendor-react` chunk
  via `vite.config.js`'s `manualChunks` — `index` → **230.87 kB**
  (73.11 kB gzip), `vendor-react` → 164.04 kB (53.50 kB gzip) as a
  separate file. Combined bytes are unchanged (this is a caching win —
  vendor code stops invalidating on every app-code deploy — not a
  total-size reduction, and reported as exactly that, not oversold).
  Verified safe: built, served the real production output (`vite
  preview`, not the dev server, which doesn't apply this chunking at
  all), and confirmed at the network level that both new chunks load
  with zero console errors and the app renders its real content on
  first paint — the level a router-initialization failure from a bad
  chunk split would have shown up at, even though click-interaction
  testing on that tab hit this session's own recurring browser-tool
  flakiness (not a re-render/error signal) rather than completing
  cleanly.
- No React re-render profiling was run (no Profiler session available in
  this environment). §2's Nutrition-search finding is a structural
  code-reading argument (state locality), not a measured bottleneck —
  reported as such, not as "profiled and confirmed."
- Serverless/cold-start specifics (Section 24 — Vercel route module
  weight, expensive module-init work) were not audited in this pass.

## 14. Optimizations deliberately NOT made

- **Wrapping Nutrition search-result rows in `React.memo`**: considered
  after re-reading the master prompt's explicit "a single food-row
  update should NOT rerender the entire page" line, but not done — the
  list is already capped at 8–25 items, the containing state is already
  local to `FoodLogSheet.jsx` (not lifted to the page), and there is no
  Profiler evidence of a real re-render cost to justify the added
  complexity. Exactly the "blind memoization" this prompt's own Section
  8 warns against.
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
- **Batch-rewriting `intelligence.js`'s barcode/multi-entry commit loop**
  (`entries.forEach`-style, one ownership-check `SELECT` per entry): same
  reasoning as the share-loop above — bounded by how many items a user
  selected in one scan/commit action, not a page load, and each
  iteration's ownership check ("never commit a food the client can't
  see") is exactly the kind of per-row security logic that shouldn't be
  restructured without dedicated test coverage for the batched version.
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
logic, a frontend data-correctness fix (rounding, a `|| undefined` guard,
reusing an existing shared helper), or the app-wide `silent: true` reload
rollout (§1b) — which changes *when a spinner appears*, not what anything
looks like. The two one-line copy additions ("Enter values per 100 g…")
use the exact same text style already used for the sentence right below
them on the same form — a clarification, not a new visual element.

## 16. No photo recognition confirmation

**Confirmed.** No computer-vision, image-based food-recognition, or any
new AI capability was added, touched, or proposed anywhere in this pass.

## 17. Existing features/business logic confirmation

**Confirmed preserved.** No pricing, permission, authentication, payment,
workout, AI-provider-selection, gym-owner, trainer, or client behavior
was changed except the two explicit correctness bugs listed in §1 (the
revenue-trend window and the food-macro overflow cap) — both are bug
fixes that make already-intended behavior work correctly, not changes to
what that behavior is supposed to be. The workout-templates and admin
console changes (§3) are pure performance restructuring — same response
shapes, same rendered pages, verified via new tests and live navigation
respectively. The logo swap is the same image, recompressed — not a
design change; verified visually before and after, and live in the
running app. Every fix in this pass was verified against the existing
test suite (1022/1025, same pre-existing unrelated flake) before being
considered done.
