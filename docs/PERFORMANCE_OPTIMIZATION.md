# Performance optimisation

Branch `eng/production-overhaul` vs `origin/main` `45d68a7`. Every number here
was measured on the same machine in one session, base and branch runs
interleaved. Nothing is projected or estimated unless it says so.

## Why the app felt slow — what the measurements showed

Production runs the API as a Vercel function talking to Neon over the network,
so **every SQL statement costs a network round trip**. Locally the database is
in-process SQLite and costs microseconds, which hides exactly what users feel.
So the method was to count statements per request and model the round trip.

`backend/scripts/request-profile.mjs` (added on this branch):

- builds a throwaway SQLite database (init-db + the deterministic demo seed);
- signs in as a client, an owner and a trainer;
- replays the requests each main screen makes on first load (read from the page
  components), one at a time (statement counts) and in parallel like the
  browser does (screen time = slowest request);
- adds a simulated delay to every statement (`--rtt`), and with
  `--trace=<path>` prints a request's statements in order with start offsets.

Its numbers are a **model**: they show how many round trips a request waits on
in sequence and how that scales with latency. They are not production
latencies. 8 ms is a same-region Vercel→Neon round trip; 30 ms models a slower
link or a cross-region database.

What the traces showed (before):

| Request | Problem |
|---|---|
| `/intel/coach/brief`, `/intel/coach/weekly` (both on every client Home visit) | ~16 independent reads awaited one after another |
| `/tracking/me/home` (every client screen, via the layout) | ~12 sequential levels; the adherence score computed twice (8 duplicate queries) |
| `/tracking/me/today`, `/me/home` | progressive-overload suggestions and equipment alternatives looked up one exercise at a time |
| `/tracking/me/week` | the programme chain and the planner chain run in series |
| every client request | plan gate: one uncached org lookup before the route |
| every request on a cold instance | `requireAuth`: four sequential lookups before the route |
| revisiting any tab | page remounts, `useFetch` has no memory: loading state and full refetch again |

Bundle size was **not** the problem: first-paint JS was already 90 kB gzip with
three.js and recharts lazy and CI budgets in place.

## Results

### Screens (all of a screen's first-load requests in parallel; median of 5, averaged over 2 interleaved sessions)

| Screen | Requests | 8 ms model: before | after | change | 30 ms model: before | after |
|---|---:|---:|---:|---:|---:|---:|
| Client shell + Home | 9 | 389 ms | 159 ms | **−59%** | 794 ms | 334 ms |
| Client Workout | 4 | 288 ms | 128 ms | **−56%** | 606 ms | 272 ms |
| Client Progress | 2 | 50 ms | 32 ms | −36% | 110 ms | 80 ms |
| Client Nutrition | 1 | 97 ms | 80 ms | −18% | 195 ms | 171 ms |
| Client Community | 5 | 96 ms | 79 ms | −18% | 194 ms | 175 ms |
| Owner shell + Dashboard | 6 | 89 ms | 89 ms | unchanged | 178 ms | 165 ms |
| Owner Clients | 1 | 64 ms | 73 ms | unchanged* | 140 ms | 135 ms |
| Owner Business | 3 | 34 ms | 32 ms | unchanged | 79 ms | 67 ms |
| Trainer shell + Dashboard | 7 | 53 ms | 58 ms | unchanged* | 131 ms | 129 ms |

\* Owner and trainer endpoints were not changed and issue exactly the same
statements before and after; differences of ±15% are run-to-run noise (the 30 ms
column moves the other way). No improvement is claimed for them.

### Requests (8 ms model)

| Request | Statements (warm) | Time before → after |
|---|---|---|
| `/intel/coach/brief` | 17 → 16 | 274 → 48 ms |
| `/intel/coach/weekly` | 17 → 16 | 272 → 48 ms |
| `/tracking/me/home` (a day with a programmed workout) | 42 → 33 | 383 → 164 ms |
| `/tracking/me/today` | 18 → 17 | 287 → 130 ms |
| `/tracking/me/week` | 8 → 7 | 130 → 64 ms |
| any other client request | −1 (plan gate cached) | −16 ms each |

Total statements across all 35 profiled requests: **283 → 256**.

### In-process cost (no simulated latency) — checked for regressions

With `--rtt=0` the work is CPU only. Interleaved runs: Client Home 25/20 →
19/17 ms, Owner Dashboard 54/56 → 58/45 ms, Owner Clients 28/28 → 24/23 ms —
equal within noise. Running reads concurrently did not add CPU cost.

### Revisits (frontend)

Opted-in screens now render the last response at once on an in-app revisit and
refresh it in the background. Verified in a browser against a seeded local
backend with a DOM observer: a cold visit to Progress inserted the loading
skeleton; the revisit inserted none, showed content, and still sent the
refresh requests. The time saved on a revisit is the whole screen load above
(network included), because nothing waits on it.

### Bundle

| | Before | After | Budget |
|---|---:|---:|---:|
| First-paint JS (gzip) | 90.0 kB | 90.3 kB | 95 kB |
| First-paint CSS | 20.2 kB | 20.2 kB | 21 kB |
| Largest route chunk | 46.9 kB | 46.9 kB | 50 kB |

## What changed, and why each change is safe

| Change | Files | Why the output is unchanged |
|---|---|---|
| Coach context domains and their reads run concurrently | `services/intelligence/aiContext.js` | All seven readers are pure reads (checked for writes); the context object is assembled in the original key order, which matters because it is serialised into LLM prompts |
| Client home reuses its adherence score for the coach line; meals, today's session and the coach line fetched together | `routes/tracking.js`, `services/aiCoach.js` | Today's session still runs after the adherence reads because it can materialise a workout (a write). One visible difference, on the one request per day that materialises the workout: the coach's "Workout completion" figure now matches the adherence numbers in the same response instead of briefly counting the new workout |
| Per-exercise suggestions and alternatives concurrently | `services/trainingProgram.js` | Both helpers are read-only; results keep exercise order |
| Week view's two chains concurrently | `routes/tracking.js` | Same queries, same grouping |
| Plan gate org lookup cached 5 min per org (and per DB handle) | `services/plans/barbellPlan.js` | An org's type and slug are never updated by the app; a failed lookup is not cached and still fails open in the gate |
| `requireAuth` lookups concurrently | `auth.js` | Evaluated in the original order; each keeps its failure posture (tested in `sessionRevocation.test.js`) |
| Six indexes | `database/schema.sql` | Indexes cannot change results; all `IF NOT EXISTS` |
| `useFetch({ key })` stale-while-revalidate | `frontend/src/api.js`, `utils.js`, 5 pages | Opt-in; scoped per user and gym; never used for payments, plans, live crowd or logging screens; `reload()` bypasses it (`fetchCache.test.jsx`) |
| AI ping bounded at 2 s | `services/intelligence/aiProvider.js` | Only bounds a failure case |

Index details (all match a filter the request path already runs):
`nutrition_plans(client_id, created_at)` — client's current plan, on Home,
coach and every adherence score; `workout_logs(workout_id)` — correlated
"log count per workout" subqueries on the largest table;
`subscriptions(client_id, end_date)`; `attendance(client_id, date)`;
`payments(external_ref)`; `users(org_id, role)`. SQLite's planner at seed scale
does not show the difference; the benefit grows with table size on Postgres.
`EXPLAIN ANALYZE` against production data was not run (no access; and it would
be a production query).

## Not measured, and why

| Metric | Status |
|---|---|
| LCP, INP, CLS on real devices | Not measured. Needs a real device against a deployed preview. The browser pane was hidden during this session, which throttles timers and makes in-browser timing meaningless. The existing Playwright `performance.spec.js` checks CLS on desktop Chromium; it was not run on this branch |
| Production API latency | Not measured — no access to production logs. The access log line (`[req] id METHOD path status ms`) has the raw data |
| Database query latency on Postgres | Not measured locally (no PostgreSQL here) |
| Memory consumption | Not measured |
| Build time | Not comparable: the baseline build (128 s) ran cold alongside the test suite; the branch build (26 s) ran warm and alone |

## Remaining opportunities (measured, not done)

1. `ensureTodayWorkout` is a conditional chain of up to four dependent reads on
   every client Home load. Caching "today's workout id" per client for the day
   would remove most of it; it needs invalidation on assign/complete.
2. Owner `/dashboard/overview` (14 statements) and `/clients` (16) are already
   batched; their remaining cost is breadth, not depth.
3. The Workout and Nutrition screens were left out of the response cache on
   purpose (live logging state). Revisits there still show a loading state.
