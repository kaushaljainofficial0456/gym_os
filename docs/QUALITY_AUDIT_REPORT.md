# GymOS (Barbell) — production quality audit

Branch `quality/production-audit`, started from `origin/main` at `7e04359` on 2026-09-14.
Nothing on this branch has been merged or deployed.

> **Production decision pending.** Commit `8666b17` fixes a bug that is live on
> production: a signed-out visitor cannot stay on `/signup`, `/privacy`, `/terms`,
> or any shared-workout, shared-meal or invite link — each redirects to `/login`.
> Confirmed on the live site, and re-confirmed at the end of this audit; `main` (now
> `860da14`) still contains it. It is a one-file change (`frontend/src/unitsContext.jsx`)
> and merges onto `main` without conflicts.

## 1. Executive summary

**Before.** The product was feature-rich and the code carried unusually careful
comments, but quality was enforced by nothing automated in the browser. The
frontend had 81 pure-function tests that ran nowhere in CI; there were no component,
end-to-end, accessibility, visual or performance checks. Each modal handled Escape
its own way — or not at all — and none managed focus. Several screens rendered "you
have nothing" when their data had simply failed to load. And one shipped change had
made every public page unreachable for signed-out visitors, with nothing to catch it.

**After.** A browser suite runs against the real production build and a real,
reseeded backend: sign-in and routing guards, public pages, onboarding, dialogs and
confirmations, failed-load states, WCAG 2.2 AA scans of 24 screens in both themes,
layout stability, request order, overflow at eight widths, tap-target size, and 26
visual baselines. Writing it surfaced and fixed the production bug above, a
sign-out that could fail silently, an onboarding screen that could freeze, a 0.31
layout shift, and failed loads masquerading as empty states on 16 fetches. First-paint
JavaScript is down 40%, with a CI budget holding it there.

**Readiness:** 62/100 before → **74/100** on this branch. Production stays nearer the
"before" figure until the branch — at minimum `8666b17` — is merged.

## 2. Architecture assessment

**Strengths.** Route-level code splitting was already in place, with three.js and
recharts isolated in lazy chunks. A shared UI module (`components/UI.jsx`) and design
tokens (`theme.css`, `design/tokens.js`) existed and most screens used them. One
data-fetching primitive (`useFetch`) is used consistently rather than competing
libraries. The backend has broad test coverage (156 files). Comments record *why*,
which made root causes findable.

**Duplicate systems found, and what was consolidated**

| Found | Consolidated into |
|---|---|
| Escape handling written separately in 9 places; focus managed in none; scroll lock in 2 | `useDialog(open, onClose)` in `UI.jsx` — focus in, Tab wrap, topmost-only Escape, ref-counted scroll lock, focus return. Used by `Modal`, `Sheet` and 29 hand-rolled overlays across 24 files |
| 14 `window.confirm` + 3 `window.alert`, beside a separate hand-rolled confirm | `useConfirm()` in `UI.jsx`, built on `Modal`; every call migrated |
| `.light .text-mute/.text-faint` repeating token values (and drifting from them once already) | Overrides now reference `var(--mute)` / `var(--faint)` |
| The trainer-role list written in `auth.jsx` and needed again for preloading | `isTrainerRole()` exported from `auth.jsx` |
| Per-action analytics that could not answer activation questions | `trackOnce()` beside `track()` in `services/events.js` |
| Failed loads rendered through each screen's empty state | The existing `ErrorState` (no new component) |

**Remaining risks.**
- God components: `pages/client/Workout.jsx` (~2,900 lines) and
  `components/FoodLogSheet.jsx` (~2,300) mix data, state and presentation.
- Two theming systems coexist: CSS tokens, and inline `t.*` objects in Nutrition and
  onboarding screens that bypass them.
- 27 responsive grid wrappers still have no base column template (`grid lg:grid-cols-N`).
  The two that overflowed at 320px were fixed; the pattern remains elsewhere.
- CI runs only on pushes to `main` and on pull requests, so this branch's CI has not
  run. The browser suite is not in CI.

## 3. Quality scorecard

| Area | Before | After | Status |
|---|---:|---:|---|
| Architecture consolidation | 5 | 7 | Dialog, confirm, token and role logic single-sourced; god components remain |
| Component testing | 3 | 6 | 81 → 111 tests, now in CI; page components still untested in jsdom |
| Visual regression | 0 | 5 | 26 screens, Windows baselines only, not in CI; month labels roll over monthly |
| E2E testing | 0 | 6 | Auth, public routes, onboarding, confirmations, error states; no food-search or workout-builder journey |
| Accessibility testing | 1 | 7 | 48 axe scans (both themes), keyboard dialog tests, target size; no screen-reader testing |
| Performance | 5 | 7 | First-paint JS 140.3 → 84.6 kB gzip (final build), CI budget, CLS and request-order checks; no real-device metrics |
| Interaction consistency | 4 | 7 | One dialog behaviour, one confirmation; duplicate "Add cardio" controls remain on Workout |
| Information density | 6 | 6 | Assessed, not redesigned |
| Visual hierarchy | 6 | 6 | Assessed, not redesigned |
| Empty states | 6 | 7 | Empty states no longer shown for failures |
| Error states | 4 | 8 | 16 failed-load paths now explain and retry; 2 lower-impact fetches remain |
| Contrast | 6 | 8 | Light-theme tokens fixed on measured surfaces; 48/48 scans clean |
| Responsive behavior | 6 | 8 | 18 screens × 8 widths without overflow; phone tap targets checked |
| Animation restraint | 6 | 6 | Wizard now honours reduced motion; not audited further |
| Onboarding conversion | 4 | 7 | Signup reachable again (once merged), wizard freeze removed, activation now measurable |
| Task completion | 6 | 6 | Assessed (onboarding: 11 taps minimum), not optimised |

## 4. Files changed

`7e04359..HEAD`, the 20 commits before this report: 99 files changed, 3573 insertions(+), 297 deletions(-). The important ones:

- `frontend/src/components/UI.jsx` — `useDialog`, `useConfirm`; Modal/Sheet use them and stop scrim clicks propagating.
- `frontend/src/unitsContext.jsx` — fetch keyed on the signed-in user (the production bug).
- `frontend/src/api.js` — the session probe no longer POSTs logout.
- `frontend/src/App.jsx`, `frontend/src/auth.jsx` — lazy signed-in shells, preloaded for returning users; `isTrainerRole`.
- `frontend/src/theme.css` — light `--mute`, `--faint`, `--good`, `--warn`; overrides reference tokens.
- `frontend/src/components/OnboardingWizard.jsx` — enter-only step animation; focus containment.
- 24 files holding 29 hand-rolled overlays — `useDialog`; 11 files — `useConfirm`; 13 files — `ErrorState` on 16 failed-load paths.
- `frontend/src/pages/trainer/Dashboard.jsx` — `pulse` in the load gate (layout shift).
- `frontend/src/components/EnergyBalanceChart.jsx` — day stepper (WCAG 2.5.8), `role="group"`.
- `backend/src/services/events.js` + `routes/{me,nutrition,workouts,intelligence}.js` — activation milestones.
- `frontend/scripts/check-bundle.mjs`, `.github/workflows/test.yml` — frontend tests and bundle budget in CI.
- `frontend/playwright.config.js`, `frontend/e2e/*` — the browser suite.

## 5. Tests added

- **Unit/component (Vitest + jsdom):** `uiPrimitives.test.jsx` (17), `dialog.test.jsx` (8), `confirm.test.jsx` (5).
- **Browser (Playwright, production build, reseeded SQLite):**
  `auth.setup.js`; `auth.spec.js` (public routes, logout budget, guards, wrong password, sign-out);
  `onboarding.spec.js` (including focus and Escape); `dialogs.spec.js` (food log sheet, drawer, three confirmations, scanner layering, nutrition targets);
  `a11y.spec.js` (24 screens × 2 themes); `performance.spec.js` (request order, CLS on 7 screens);
  `error-states.spec.js` (8 network-failure paths); `responsive.spec.js` (18 screens × 8 widths, target size on 9);
  `progress.spec.js`; `visual.spec.js` (26 screens).
- **Backend (node:test):** `activationEvents.test.js` (5); `enrollmentToken.test.js` de-flaked.

## 6. Git history

In order. "Verified" is what was run on that state, not a claim about later states.

| Commit | Message | Purpose | Verified |
|---|---|---|---|
| `aebc139` | test: component testing for shared UI primitives, frontend tests in CI | Vitest + jsdom for components; frontend tests join CI | 98 frontend tests |
| `4cecff0` | a11y: one shared dialog behaviour for Modal and Sheet | `useDialog` | 106 tests, build |
| `8666b17` | fix(app): signed-out visitors were bounced off every public page to /login | The production bug | Browser run 68/69 (the one failure an unrelated badge contrast, fixed in `9950aa9`) |
| `e4bbbbb` | fix(auth): the session probe spent the logout rate limit on every signed-out page view | Sign-out could be refused | Zero logout POSTs across four signed-out pages |
| `155e258` | a11y: every hand-rolled dialog now uses the shared dialog behaviour | 17 files of overlays | Food log sheet and drawer keyboard tests; 106 tests |
| `c94f8ae` | test: browser suite for the critical journeys, on the production build | Playwright harness, auth, onboarding, dialogs | Browser run 69/69 |
| `9950aa9` | a11y: automated WCAG 2.2 AA scans of 24 screens in both themes | Scans + contrast tokens, labels, roles | 48/48 scans; 69/69 |
| `30a89da` | fix(onboarding): the profile wizard could freeze on a stale question | Remove the stall mechanism | Onboarding journey and setup pass; stall not reproducible on demand |
| `0d73258` | fix(ui): failed loads no longer masquerade as empty states | First 6 paths | 3/3 network-failure tests |
| `a8aa7af` | perf: the login screen no longer downloads the signed-in app | Lazy shells, preload, CLS gate, CI budget | Browser run 109/109; budgets met |
| `2f4af8a` | fix(responsive): no screen scrolls sideways from 320 to 1440px | Overflow fixes, chart day stepper | Browser run 109/109 |
| `e8d71a8` | ui: the app's own confirmation dialog replaces every window.confirm and window.alert | `useConfirm` | 111 unit tests, build (browser checks in `2fb57eb`) |
| `6c89968` | test: visual regression for 26 key screens (Windows baselines) | Visual suite | 26/26 compare (baselines later regenerated) |
| `2fb57eb` | test: browser checks for the confirmation dialogs | Confirmations in a real browser | Full suite 109/109 before, 7/7 after |
| `efd4e9a` | fix(ui): the rest of the failed loads that were shown as empty states | 10 more paths | Dialogs + error-states specs 16/16; 111 unit |
| `61e1a6c` | ui: removing a logged food asks through the shared confirmation dialog | Last hand-rolled confirmation | 16/16 |
| `6ac4aeb` | feat(analytics): activation milestones | `trackOnce`; three milestones | 0/5 → 5/5; backend 1631/1634 (one unrelated flake, fixed next) |
| `a1ff616` | test: the QR payload privacy check failed about one run in 82, by chance | De-flake a leak check | 11/11 three times; full browser suite 117/117 |
| `dbbf1bc` | a11y: the last modal overlays hold focus -- onboarding, scanners, targets, prompts | Focus management for the 6 remaining overlays; FoodLogSheet Escape guard | Full browser suite 117/117 (build including the components); dialogs + onboarding 11/11 on a fresh production build; 111 unit |
| `7a2fcd7` | test: visual masks cover only dates and times, never the screen under test | Mask fix; 10 baselines regenerated and individually reviewed | Regeneration 29/29; comparison 29/29 |
| (next) | docs: quality audit report | This report | — |

## Security launch gate: NO-GO

Not reopened by this audit, and not changed by it. On this branch the backend suite
passes (1634 tests: 1632 passed, 2 skipped, 0 failed), including 16 security-related
test files (144 tests: 143 passed, 1 skipped, 0 failed). But:

- The distributed rate-limit store work (`pgRateLimitStore.js`, `rateLimitStores.js`,
  `clientIp.js`, `passwordPolicy.js`, `securityHardening.test.js`, `rateLimitStore.test.js`)
  exists only as **uncommitted changes in the primary checkout**. It is on no branch, local
  or remote, and not on `main`, so none of it was tested here.
- On `main`, rate limiting uses an in-memory store unless `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` are set, and nothing reports which store production uses. On
  more than one instance, in-memory limits are per instance.

Until that work is committed, tested and the production store is verified, the security
launch gate stays NO-GO regardless of the frontend results above.

## 7. Remaining weaknesses (below 8/10)

- **Production still has the public-page redirect** until `8666b17` is merged (re-confirmed live at the end of the audit).
- **`main` moved.** Two commits by another contributor (`52be152`, `860da14`) landed after this branch started. The branch merges without conflicts (`git merge-tree`), but has not been re-tested on top of them.
- **Nothing here has run in CI.** CI triggers only for `main` and pull requests, and the browser suite is not a CI job. Opening a PR would run the unit, backend and build jobs.
- **Visual regression** has Windows baselines only; Linux baselines are needed for CI. Month names in the analytics axis and history header are deliberately unmasked, so those two baselines need regenerating at each new month.
- **AskSK** is not rendered anywhere in the app (dead code); its dialog change is compile-verified only.
- **E2E gaps:** food search and logging through the sheet, the workout builder, and live workout logging are not covered end to end.
- **Component tests** cover shared primitives, not page components.
- **Architecture:** `Workout.jsx` and `FoodLogSheet.jsx` need splitting; inline `t.*` theming duplicates the token system; 27 grid wrappers keep the overflow pattern.
- **Information density, visual hierarchy, task completion** were reviewed, not changed. Examples: duplicate "Add cardio" and "+ Add Cardio" on Workout; an unlabeled "+ Add" on Nutrition.
- **Error states:** `Community.jsx` challenges and `Workout.jsx` week still default a failure to empty.
- **Onboarding wizard freeze** was observed once and removed by mechanism; it could not be reproduced on demand, so no regression test claims it.
- **Automated accessibility** catches a fraction of real issues; no screen-reader pass was done.

## 8. Final industry readiness

**74 / 100 — good, with meaningful gaps** (on this branch, for product quality). The
security launch gate is separate and remains **NO-GO** (see above).

The foundation is now defensible: shared behaviour where it matters, measured
accessibility and performance, and browser tests that already caught real production
bugs. It is held back from the 80s by the untriggered CI, the missing journeys, the
two largest components, and — until merge — a production bug on the signup path.
