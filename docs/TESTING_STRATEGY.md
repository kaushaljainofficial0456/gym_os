# Testing strategy

What exists, what runs where, what this branch added, and the gaps — as of
`eng/production-overhaul`, 2026-11-09.

## Layers

| Layer | Tool | Location | Runs in CI | Count |
|---|---|---|---|---|
| Backend unit + integration (SQLite) | `node --test` | `backend/test/*.test.js` (186 files; 184 before) | yes — `unit` job | 2,051 tests (2,038 before this branch) |
| Database integration (real PostgreSQL + RLS) | `node --test` + `TEST_DATABASE_URL` | `communityPg`, `financialRls`, `couponsBarbellPlan` | yes — `postgres` job (Postgres 16 service) | self-skip locally without a database |
| Frontend unit + component | Vitest + jsdom + Testing Library | `frontend/test/` | yes — `build` job | 205 (199 before) |
| Production build + bundle budget | Vite, `scripts/check-bundle.mjs` | — | yes — `build` job | 5 budgets |
| Browser (E2E, a11y, responsive, visual, CLS) | Playwright + axe | `frontend/e2e/` | **no** (run locally against a reseeded backend) | 11 specs |
| Request profile (round trips, simulated latency) | `backend/scripts/request-profile.mjs` | — | no (manual, comparative) | 35 requests across 9 screens |
| Load test | autocannon | `backend/scripts/loadtest.mjs` | no | — |
| Food estimation benchmark gate | `scripts/food-benchmark.js` | — | via `foodBenchmarkGate.test.js` | — |

There is no linter and no type checker in this repository (no ESLint config,
no TypeScript). "Lint" and "type check" from the audit brief cannot be run;
adding ESLint is recommended (P2) but would surface a large backlog at once and
is a change of its own.

## What this branch added

| Test file | What it protects |
|---|---|
| `backend/test/sessionRevocation.test.js` (9) | A password change ends other sessions and keeps this one (on the same gym); reset ends all; logout-everywhere; per-user isolation; un-migrated databases keep working; requireAuth's gate order is unchanged after its lookups became concurrent |
| `backend/test/uploadsPath.test.js` (4) | `/uploads` refuses `..`, `.`, empty and encoded-separator segments; real keys pass |
| `frontend/test/fetchCache.test.jsx` (6) | Revisits render cached data then refresh; no key = unchanged; scoped per user and gym; cleared on sign-out; `reload()` bypasses the cache; dependency changes use the new key's cache |

Existing suites that cover the changed code and were re-run: the coach and
AI-context tests, client home/tracking tests, adherence, training program,
plan gate (`barbellPlan.test.js`, `couponsBarbellPlan.test.js`), tenant
isolation (`admin-tenant-isolation`, `clientDataAccess`), demo session gating
(`demoSystem.test.js`), account recovery, multi-gym access, and
`prodreadiness.test.js` (which caught a backtick this branch put in a
`schema.sql` comment — SQLite-only quoting is forbidden there).

## Results on this branch

| Suite | Result |
|---|---|
| Backend (`npm test`) | 2,051 tests: 2,048 pass, 0 fail, 3 skipped (the Postgres-only suites) |
| Frontend (`npm test --prefix frontend`) | 205 / 205 |
| Build + bundle budget | pass; initial JS 90.3 kB gzip (budget 95) |
| Postgres RLS suites | not run locally (no PostgreSQL or Docker on this machine); CI runs them |
| Playwright | not run on this branch |

### Known flaky tests

`foodSearchBenchmark.test.js` and `foodBenchmarkGate.test.js` assert wall-clock
latency ceilings. In the baseline run they failed while a production build ran
in parallel (580 ms vs a 500 ms ceiling); alone they pass (49 ms). They are
correct gates for a quiet machine and flaky on a busy one. Leave them, but run
the suite without parallel CPU-heavy work before trusting a failure.

## Gaps, in priority order

1. **Browser suite not in CI.** The Playwright specs caught real production
   bugs before; they need a CI job with a seeded backend and Linux baselines.
2. **Multi-tenant isolation is tested per route family, not exhaustively.**
   There is no generated "every org-scoped endpoint refuses another org's id"
   test. The IDOR scan in `docs/SECURITY_AUDIT.md` is manual; turning it into a
   test that boots the app with two seeded gyms and walks every `:id` route
   would make tenant isolation a regression gate.
3. **Real-device performance** (LCP/INP/CLS on a mid-range Android over 4G) is
   not measured anywhere; Playwright's CLS check runs on desktop Chromium.
4. **E2E journeys missing**: food search and logging, the workout builder, live
   workout logging (from the September quality audit, still open).
5. **No lint/type gate** (see above).
