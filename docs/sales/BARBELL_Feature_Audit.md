# BARBELL — Feature Audit (verified inventory)

**Snapshot:** `main` @ `643e19f` (merge of PR #18 *razorpay-checkout*, committed 2026-11-04 09:35 IST)
**Audit date:** 2026-11-04
**Purpose:** the single source of truth for what the shipped product actually does. It feeds the sales catalogue and later product-documentation updates. Every feature has a status, the evidence behind it, and code references.

> This replaces an earlier audit that was never committed and was based on an older working copy. Since then, `main` has gained tournaments, Enterprise billing, QR onboarding, access control, wearables and Razorpay checkout. Nothing below is carried over from the earlier audit without being re-checked.

---

## 1. Method

| Step | What was done |
|---|---|
| Endpoint map | Every route in `backend/src/routes/*.js` was extracted (**509 endpoint registrations across 31 files**). Each was matched against the frontend source to find its caller. Endpoints with no caller are treated as backend-only and are **not** sales features. |
| Live app | Throwaway SQLite DB (`init-db.js` + `seed.js`, gym *IRONFORGE FITNESS*: 1 owner, 3 trainers, 25 clients). API on :4200, Vite on :5175. The user's own `physique.db` was not touched. |
| Screen crawl | Playwright, dark theme, signed in as each role. **Pass 1: 42 primary screens** (owner 18, trainer 9, client 15). Passes 2–3: sheets, modals, all 8 client-profile tabs, all 8 access-control tabs, secondary workout/nutrition/progress screens, onboarding wizard, and 11 public/anonymous pages. **126 screen-state captures in total.** |
| Behaviour tests | **298 logged API actions** (plus unlogged probes) run as Owner, Trainer, Client, a second gym owner, and anonymous visitors. DB rows were checked where it mattered (set logs, PRs, calorie ranges, sleep writers, billing state, payment orders). Log: `audit-evidence/api-test-log.txt`. |
| Permissions | Cross-role, cross-trainer and cross-gym access attempts (Section 8). |
| Integrations | Every `process.env.*` switch identified. Each integration probed unconfigured; code status notes (live-tested or not) recorded. |
| Backend tests | `npm test` in `backend/` — result in Section 11. |

Test evidence IDs (for example `C.workout.complete`) refer to lines in `docs/sales/audit-evidence/api-test-log.txt`. Every failing line was resolved: either a request-shape error on my side (retried and passed), an intentional business rule, or a finding recorded in Section 9.

## 2. Status legend

| Mark | Meaning | Sales use |
|---|---|---|
| **●** | **Fully implemented.** Reachable in the UI, behaviour verified live. | Primary feature list |
| **◇** | **Configuration-dependent.** Built and working, but needs a key, provider account, hardware or a native app to be live. | List with a "requires setup" marker |
| **◐** | **Partially implemented.** Works in part, has no UI entry point for a key step, or has accuracy/enforcement defects. | Not in the primary list (or only the working part, described precisely) |
| **✕** | **Not shipped.** Code exists but is unreachable, or explicitly "not yet available". | Never claim |

## 3. Summary

| Area | ● Full | ◇ Config | ◐ Partial | ✕ Not shipped |
|---|---|---|---|---|
| Client (C1–C77) | 67 | 6 | 4 | — |
| Gym Owner (O1–O32) | 27 | 2 | 3 | — |
| Trainer (T1–T20) | 20 | — | — | — |
| Shared / all roles (S1–S14) | 12 | 2 | — | — |
| **Total (143 IDs)** | **126** | **10** | **7** | 9 groups in §7.1 |

Mixed rows are counted by their base capability, with the setup-dependent part noted in the row. C72: base intelligence ●, wearable fields ◇. O22: invoice PDF ●, email ◇.

Owners have every trainer capability gym-wide (O24), so the owner's real feature set is O1–O32 + T1–T18 + S1–S14.

---

## 4. Client features (member app — mobile-first)

### 4.1 Joining and onboarding
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C1 | Self sign-up with the gym's sign-up code — joins the gym automatically | ● | `Auth.client-signup.gym-code` 201, role CLIENT | `routes/auth.js:173`, `pages/SignUp.jsx` |
| C2 | Join a gym by scanning the owner's one-time QR: preview gym + plan → pay → membership active | ◇ | `C.qr.preview`, `C.qr.join`, `C.qr.membership-payment`, `C.qr.membership-active` (Pulse Studio). Online payment needs Razorpay live keys (mock in dev). | `routes/enrollment.js:327`, `pages/JoinGym.jsx`, `components/QrScanner.jsx` |
| C3 | First-run onboarding wizard ("six quick questions") that builds calorie/macro targets from the member's own body and goal | ● | crawl3 `client_onboarding-wizard` | `components/OnboardingWizard.jsx`, `routes/me.js:283` |
| C4 | Guided app tour, replayable from Help | ● | Help "Replay app tour" | `components/AppTour.jsx` |

### 4.2 Home and daily guidance
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C5 | Home "your day": today's session + Start, calories left/over with macros, today's burn, goal %, live gym crowd, community card | ● | crawl `client_home` | `pages/client/Home.jsx`, `routes/tracking.js` `/me/home` |
| C6 | Customisable Home — show/hide and reorder the six cards | ● | `C.home-layout.save`; crawl2 `p-home` | `routes/me.js:573`, `pages/client/Profile.jsx` |
| C7 | Coach Brief — daily prioritised insights (nutrition, protein, water, session, weight) with Helpful / Not helpful feedback. Deterministic, no AI key needed. | ● | `C.coach-brief` provider `deterministic`; crawl3 `coachbrief` | `routes/intelligence.js:737`, `components/CoachBriefDrawer.jsx` |
| C8 | In-app reminders in the notification bell: workout today, tomorrow's session, unfinished session, rest day, meal logging, water, daily recap | ● | `C.notif.generate` → water/workout/daily_summary | `routes/notifications.js:186`, `services/notificationGenerator.js`, `components/NotificationBell.jsx` |
| C9 | System (OS) notifications while Barbell is open in a background tab. **Not** delivered when the app is fully closed — no push provider. | ● | `reminders.js:1-30` | `frontend/src/reminders.js`, `public/sw.js` |
| C10 | Reminder preferences: per-type switches, water interval, daily-recap time, quiet hours | ● | `C.notif.prefs.update` | `routes/notifications.js` (prefs), `pages/client/Settings.jsx` |

### 4.3 Training
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C11 | Today's Training: program day, muscle focus, exercise list with targets, sets, estimated minutes, this-week strip | ● | crawl `client_workout` | `components/workout/TodayView.jsx`, `routes/tracking.js:378` |
| C12 | Assigned weekly program serves the right session each day automatically | ● | `C.program.visible-to-client` (MON Push / WED Pull / FRI Legs) | `routes/clients.js:573`, `services/trainingProgram.js` |
| C13 | Progressive-overload targets per lift ("Last time 82.5 kg × 8 · today try 85 kg × 8", "4 lifts are ready to progress today") | ● | crawl2 `w-start`; crawl `client_workout` | `services/progressiveOverload.js` |
| C14 | Live workout session: running timer, per-set reps/kg, "Use" last values, add/remove set, add exercise, end session; progress autosaved and resumable | ● | `C.workout.start`, `C.workout.progress-save`, `C.workout.complete`; DB: 5 logs / 15 sets | `routes/workouts.js:400,429,457`, `components/workout/SessionView.jsx` |
| C15 | Effort rating after a session; calorie burn stored as an estimate **with a range** (e.g. 221 kcal, 156–286) | ● | `C.workout.effort` | `routes/workouts.js:646`, `services/burnEstimator.js` |
| C16 | Automatic personal records — heaviest weight, estimated 1RM, best set volume | ● | `C.workout.complete` returned PRs; DB `is_pr` | `services/personalRecords.js` |
| C17 | Session recap after finishing | ● (code) | rendered by `Workout.jsx` on completion | `components/workout/SessionRecap.jsx` |
| C18 | **Build today** — member builds their own session from the exercise library, filtered by muscle and equipment | ● | `C.build-today`; crawl3 `w-build` | `routes/me.js:1535` |
| C19 | **My workouts** planner — saved sessions, weekly schedule, Do today / Edit / Copy / Delete | ● | `C.planner.create/duplicate/schedule`; crawl3 `w-mine` | `routes/me.js:1913,2030` |
| C20 | **Log past workout** — date, start/end time, overlap warning, effort; estimated calories | ● | `C.log-past.create/complete`, `C.day-history.shows-retro` | `routes/me.js:1535` (`source: manual_retroactive`), `pages/client/LogPastWorkout.jsx` |
| C21 | Cardio and sports — live session or log past; 40+ activities (machines, outdoor, sports incl. cricket, kabaddi, badminton, yoga) | ● | `C.cardio.log`, `C.cardio.log-past`; crawl3 `w-cardio`, `w-logcardio` | `routes/me.js:1709`, `components/workout/CardioLive.jsx`, `cardioActivities.js` |
| C22 | Training history (completed / not done, paging) and per-day history (workouts + nutrition) | ● | crawl `client_history`, crawl2 `day` | `pages/client/SessionHistory.jsx`, `routes/tracking.js:157` |
| C23 | Exercise library — **287 exercises** with primary/secondary muscles, equipment, difficulty; animated exercise visual | ● | `C.exercise-library` count=287 | `routes/workouts.js` `/exercises`, `components/ExerciseVisual.jsx` |
| C24 | Share a workout as a link (public preview, 30-day expiry); another member imports it to today or their planner | ● | `C.workout-share.create`, `.public-preview(no auth)`, `.import-by-other` | `routes/me.js:2358,2451`, `pages/public/SharedWorkout.jsx` |
| C25 | My PRs and "Where your strength is moving" (per-lift % change over weeks) | ● | crawl3 `w-prs` | `pages/client/Workout.jsx`, `routes/tracking.js:252` |

### 4.4 Nutrition
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C26 | Today's Fuel — calories left/over, protein/carbs/fat, planned meals, logged items | ● | crawl `client_nutrition` | `pages/client/Nutrition.jsx` |
| C27 | Type a meal in plain words ("2 roti, dal and chai" → 3 items, 469 kcal) with Indian portions (katori, roti, piece weights) | ● | `C.nutri.describe` | `routes/me.js:1172`, `services/food/*` |
| C28 | Speak a meal (browser speech recognition, en-IN; Chrome/Edge/Safari) | ● | browser-native; no vendor key | `components/nutrition/logger/useSpeech.js` |
| C29 | Food search over a **21,000+ item** database (IFCT 2017, INDB 1,014 Indian dishes, USDA, Canadian CNF, Open Food Facts India) with portion picker and cooking-oil level | ● | `/me/foods/search`: Pesarattu [indb], Quinoa [usda], Oreo [off]; `C.nutri.resolve-portion` (1 katori paneer butter masala = 156.8 g) | `routes/me.js:706,937`, `ml/data/processed/unified_food_db.json` |
| C30 | Barcode scan for packaged foods (local cache → bundled snapshot → live Open Food Facts) | ● | `C.barcode.lookup` → "maggi", OPEN_FOOD_FACTS | `routes/intelligence.js:351`, `services/barcodeLookup.js`, `components/BarcodeScanner.jsx` |
| C31 | Nutrition-label photo scan → values extracted for review | ◇ | `I.label-scan(no key)`: image saved, "OCR unavailable… enter values manually" | `routes/intelligence.js:474`, `components/FoodLogSheet.jsx:1195` |
| C32 | "Estimate with AI" for a dish the database can't match | ◇ | `I.food-ai.estimate(no key)` 502. Chain Groq → Gemini → OpenRouter → Ollama. | `routes/me.js:869`, `components/nutrition/logger/ai.js` |
| C33 | Usuals per meal slot, recent meals, one-tap repeat of a past meal | ● | `C.nutri.usuals`, `C.nutri.repeat-meal` | `routes/me.js:1237,1292` |
| C34 | Custom foods (own macros, units) and saved meals; log a saved meal | ● | `C.nutri.custom-food`, `.saved-meal`, `.log-saved-meal` | `routes/me.js:1045,1340` |
| C35 | Share meals/foods as a link; recipient saves them to their diet | ● | `C.nutri.share-link`, `.share-public(no auth)` | `routes/me.js:2199`, `pages/public/SharedMeal.jsx` |
| C36 | Daily targets — recommended from BMR, activity and goal; or set your own | ● | `C.targets.get(recommended)` (BMR 1258 × 1.55) | `routes/me.js:531`, `components/NutritionTargetSetup.jsx` |
| C37 | Calorie rebalancing after an over-target day — choose Easy / Moderate / Aggressive / Intense / Custom; spreads the surplus over the coming days | ● | `C.calorie-balance.eligible` 1,270 kcal → `preview` 4 days × −320 → `apply` ACTIVE | `routes/me.js:2665-2720`, `components/nutrition/CalorieBalance.jsx` |
| C38 | Water tracking (+250 / +500 ml) against a target | ● | `C.water.log` | `routes/tracking.js:18` |
| C39 | Supplements list (name, dose, time) | ● | `C.supplement.add`; crawl3 `n-supp` | `routes/tracking.js:58` |
| C40 | Net energy card (intake − burn) and energy-balance history | ● | `C.energy-balance` | `routes/me.js:1660`, `components/nutrition/NetEnergyCard.jsx` |
| C41 | Nutrition Tracker — browse any date, target vs actual, history 7D/30D/3M/6M/custom with averages and chart | ● | crawl `client_nutrition-tracker` | `pages/client/NutritionTracker.jsx` |
| C42 | "My day starts at" (midnight–6 am) so late meals count to the right day | ● | `C.profile.units+day-start` | `routes/me.js:283` |

### 4.5 Progress and body
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C43 | Progress overview — weight trend headline, sessions, adherence, PRs; 7D/30D/90D/6M/1Y | ● | crawl `client_progress` | `pages/client/Progress.jsx` |
| C44 | Explore your data — Body / Training / Nutrition / Energy, compare with previous period, touch-to-read charts | ● | crawl3 `p-body/p-training/p-energy` | `pages/client/ProgressSections.jsx` |
| C45 | Goal ETA ("about 13 weeks from your target") labelled as an estimate | ● | crawl `client_progress` | `pages/client/Progress.jsx` |
| C46 | Weight logging feeding trend and goal | ● | `C.weight.log` | `routes/clients.js:49` |
| C47 | Body measurements (waist, chest, arms, thighs, hips, neck), back-dating, history edit/delete, out-of-range warning | ● | `C.measurement.log`; PATCH/DELETE routes used by UI | `routes/clients.js:82`, `ProgressSections.jsx` |
| C48 | Custom metrics ("anything else you track") with targets and entries | ● | `C.custom-metric.create/entry` | `routes/me.js:612` |
| C49 | Where the work went — weekly sets per muscle group | ● | crawl `client_progress` | `services/volumeAnalysis.js` |
| C50 | Milestones — **120** in 5 categories (Training 38, Strength 17, Consistency 25, Nutrition 19, Body 21), "closest to earning" | ● | crawl3 `p-milestones` | `frontend/src/achievements.js` |
| C51 | Progress photos — before/after comparison of photos the coach uploads (view only for members) | ● | `/tracking/me/progress` returns photos; client upload 403 by design | `pages/client/Progress.jsx:1437` |
| C52 | Today's burn breakdown — resting + workouts + cardio, each labelled measured or estimated | ● | `C.burn-breakdown`; crawl `client_burn` | `routes/health.js:574`, `pages/client/BurnDetail.jsx` |

### 4.6 Profile, settings, data rights
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C53 | Profile journey card (start → now → target, % of the way, adherence) | ● | crawl `client_profile` | `pages/client/Profile.jsx` |
| C54 | Goal & setup (goal, target weight/date, experience, height, weight, age, sex) | ● | crawl2 `p-goal` | `routes/me.js:283` |
| C55 | My Equipment (9 equipment types) | ● | crawl2 `p-equip` | `Profile.jsx`, `services/equipment.js` |
| C56 | Coach preferences — training time, session length, kit, foods you eat, exercises to avoid, notes | ● | crawl2 `p-coach`; `C.coach-prefs.get` | `routes/intelligence.js:864` |
| C57 | Message your coach (thread inside Profile) | ● | `C.message.to-coach` 201; `T.messages.unread` | `routes/messages.js:44` |
| C58 | Account: name/phone, change password (requires current), profile photo | ● | `C.change-password`, `C.avatar.upload` | `routes/auth.js:673`, `routes/me.js:249` |
| C59 | Appearance (system/light/dark) and units (metric/imperial, display-only conversion) | ● | `C.profile.units+day-start`; crawl `client_settings` | `themeContext.jsx`, `unitsContext.jsx` |
| C60 | Privacy — who sees my PRs (everyone / followers / nobody), feed scope; health data never shared | ● | `C.community.pr-privacy` | `routes/community.js:353` |
| C61 | Cookie preferences (essential always on; preferences/analytics/marketing off by default) | ● | crawl3 `settings-full` | `components/CookieConsent.jsx` |
| C62 | Download my data (one JSON file) | ● | `C.data-export` | `routes/me.js:114` |
| C63 | Delete account (type email to confirm; staff accounts refused) | ● | `C.delete-account` 200, then login 401; `T.delete-account.refused` 403 | `routes/me.js:172` |
| C64 | Membership page — plan, real status, dates, renew, payment history | ◇ | `C.membership.view`, `C.membership.renew-order`; online renewal needs Razorpay. Defect D6. | `routes/enrollment.js:492,561`, `pages/client/Membership.jsx` |

### 4.7 Community
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C65 | Gym community — opt in / leave; overview of active today, workouts and PRs this week, participation | ● | `C.community.join`; crawl `client_community-gym` | `routes/community.js:64`, `pages/client/Community.jsx` |
| C66 | Gym leaderboards — today / week / month; workouts and streaks | ● | `C.community.leaderboards` | `routes/community.js:77` |
| C67 | Activity feed (everyone / people I follow): share a workout, react (like/fire/clap/strong), comment, copy someone's workout | ● | `C.community.share-workout`, `.feed`, `.react`, `.comment`, `.copy-workout` | `routes/community.js:157,386,430` |
| C68 | Members directory and follow | ● | `C.community.follow` | `routes/community.js:323` |
| C69 | Weekly consistency, streak, community activity calendar, your last 4 weeks | ● | crawl `client_community-gym` | `Community.jsx` |
| C70 | **Private friend communities** across gyms (or no gym): create with colour/mark, invite code (7-day, 25 uses) and link, join, leaderboards, activity, members, member challenges (workouts/volume/PRs), leave/transfer | ● | `C.friend-community.*` (create, invite-code, public preview, join-by-code, challenge, leaderboard); crawl3 `friend` | `routes/communities.js`, `pages/client/FriendCommunity.jsx`, `pages/public/CommunityInvite.jsx` |

### 4.8 Wearables and health intelligence
| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| C71 | Connected devices — **WHOOP** (OAuth, workouts/recovery/sleep; live-verified 2026-09-09) and **Oura** (implemented, not live-verified) | ◇ | `I.health.connect.whoop/oura` → 503 NOT_CONFIGURED | `routes/health.js:460`, `services/health/providers/whoopProvider.js`, `ouraProvider.js` |
| C72 | Daily health intelligence — training load, energy, readiness/recovery when a wearable supplies them; burn works without one | ● (base) / ◇ (wearable fields) | `C.daily-intelligence` | `routes/health.js:525`, `services/health/dailyIntelligence.js` |
| C73 | Recovery panel (sleep vs training days) | ◇ | renders only when sleep/recovery data exists (wearable) | `pages/client/ProgressRecovery.jsx:26` |

### 4.9 Partial — excluded from the primary client list
| ID | Feature | St. | Why |
|---|---|---|---|
| C74 | Weekly Review ("what went well / needs attention") | ◐ | Works, but counts are wrong: "26 workouts this week" counts exercise-log rows (6 real sessions), and the "14-day" weight trend uses the last 14 entries, not 14 days (D1, D2). Don't quote until fixed. |
| C75 | Gym challenges (view progress) | ◐ | Members see challenges and progress, but **no staff screen creates them** — `POST /community/challenges` is called by no UI (`Community.jsx:93` only reads). |
| C76 | Help centre | ◐ | Searchable sections work, but the content claims a rest timer, Ask Barbell, meal-photo estimates, member photo upload and sleep logging — none reachable (D8). |
| C77 | Sleep adherence and "Sleep below target" alerts | ◐ | `sleep_logs` is written only by `POST /tracking/clients/:id/sleep`, which no screen calls; wearable sync doesn't write it. In production these will usually be empty. Demo data only. |

---

## 5. Gym Owner features (web dashboard)

| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| O1 | Owner dashboard — "Your gym today" (active members, check-ins, collected this month, outstanding), Needs your attention, Start something shortcuts, 30-day check-ins, revenue by month, memberships active/lapsed/overdue, attention list, 14-day adherence trend, where adherence comes from, member health | ● | crawl `owner_home`; `O.dashboard.pulse/overview` | `routes/dashboard.js:24,34,113`, `pages/trainer/Dashboard.jsx` |
| O2 | All clients — filter by trainer, membership state, coaching status; sort by status/name/adherence/weight change; goal, Δ7d, adherence, last workout, last check-in | ● | crawl `owner_clients` | `routes/clients.js:275`, `pages/trainer/Clients.jsx` |
| O3 | Add a client and assign a trainer | ● | `O.client.create+assign-trainer` | `routes/clients.js:300` |
| O4 | Trainers — workload %, active clients vs capacity, flagged clients, attendance this week; sort | ● | crawl `owner_trainers`; `O.trainers.list` | `routes/admin.js:466`, `pages/trainer/Trainers.jsx` |
| O5 | Business — active members, monthly revenue, renewals due, overdue, attendance today, 6-month revenue chart | ● | crawl `owner_business` | `pages/trainer/Business.jsx` |
| O6 | Membership packages (name, price, period) | ● | `O.package.create` | `routes/admin.js:193` |
| O7 | New subscription for a member (auto-records the payment) | ● | `O.subscription.create` | `routes/admin.js:209` |
| O8 | Record payment (cash, UPI, …) with duplicate-payment guard | ● | `O.payment.record` 409 "identical payment… moments ago" | `routes/admin.js:262` |
| O9 | Members table — filter overdue/due/paid, sort by renewal or payment, renewal countdown, Suspend / Resume / Cancel | ● | `O.membership.suspend/resume` | `routes/admin.js:634` |
| O10 | CSV export — members and payments | ● | `O.export.members-csv`, `.payments-csv` | `routes/admin.js:587,605` |
| O11 | Mark member attendance (feeds check-ins and the gym crowd number) | ● | `O.member-attendance.mark`; `/admin/crowd` source `manual_checkin` | `routes/admin.js:321` |
| O12 | Gym settings — sign-up code, branding, show live crowd, community and leaderboard switches | ● | `O.settings.get` | `routes/admin.js:749` |
| O13 | Analytics — joined vs left, churn %, revenue by month, gym visits; 6/12/24 months | ● | crawl `owner_analytics`; `O.analytics` | `routes/admin.js:353`, `pages/trainer/Analytics.jsx` |
| O14 | Trainer attendance roster — present / late / not in / needs attention; set shifts or "hours as worked"; grace minutes; scan-required or self check-in | ● | `O.attendance.roster`, `.set-shift`, `.policy` | `routes/attendance.js:259,339,375`, `pages/trainer/GymAttendance.jsx` |
| O15 | Rotating attendance QR codes (Arriving / Leaving, 90-second expiry, text fallback) for the gym display | ● | `O.attendance.rotating-qr`; `T.attendance.forged-qr-rejected` | `routes/attendance.js:395` |
| O16 | Attendance corrections — approve/reject trainer requests, full audit trail per record | ● | `O.attendance.correction-approve`, `.record-audit` | `routes/attendance.js:272` |
| O17 | Gym Crowd Live — occupancy %, inside/entries/exits, capacity, device health, busiest hour, arrivals by hour vs yesterday, typical week (after 7 days), people inside, recent door activity | ● | crawl `owner_crowd` | `pages/trainer/GymCrowd.jsx`, `services/access/liveCrowd.js` |
| O18 | Access control — connect a door/turnstile system: **Demo sandbox**, **Webhook** (HMAC-signed), **REST polling**, **CSV import**, **eSSL/ZKTeco ADMS terminal (beta)**; devices per branch; member mapping; event log by outcome; sync jobs; health alerts (e.g. "lapsed member may still open the door"); crowd settings (capacity, hours, thresholds, who sees exact numbers); audit log. No biometrics stored. | ◇ | `O.access.connect-demo`, `.demo-entry` (+1), `.unmatched-event`, `.connect-webhook`, `.unimplemented-vendor-refused`; crawl3 `acc-*` | `routes/access.js`, `services/access/providers/builtin.js`, `components/access/*` |
| O19 | Client permission defaults — Prescribed / Hybrid / Custom, plus substitute / add exercise / edit targets | ● (UI) | `C.permissions.reflect-gym-setting`. Server enforcement partial (D3). | `routes/me.js:1750`, `Business.jsx` |
| O20 | Barbell Enterprise onboarding wizard (gym type, size, trainers, branches, billing cycle) | ● | `O.enterprise.onboarding` | `routes/enterprise.js:127`, `pages/trainer/EnterpriseOnboarding.jsx` |
| O21 | Barbell subscription — capacity packages (75 / 100 / 200 clients, annual), custom-capacity pricing, add-on capacity, renew/upgrade, capacity used vs available | ◇ | `O.enterprise.packages`, `.price-calc` (120 → ₹18,100), `.quote`, `.order`, `.payment-verify` → ACTIVE. Live checkout needs Razorpay keys (order creation tested in Razorpay test mode; checkout widget + webhook not live-tested). | `routes/enterprise.js:193-273`, `services/payments/paymentProvider.js` |
| O22 | Invoices — numbered, downloadable PDF, email to accountant | ● PDF / ◇ email | `O.enterprise.invoice-pdf` `%PDF-1.3`; `.invoice-email(mock)` | `routes/enterprise.js:292,328`, `services/payments/invoicePdf.js` |
| O23 | QR onboarding — one-time client QR tied to a membership plan (capacity-checked), trainer QR, revoke, history | ● | `O2.qr.client-generate` cap=75, `T.qr.join-gym`, `O2.qr.revoke`, `O.qr.history` | `routes/enrollment.js:241,252,301`, `pages/trainer/EnterpriseQR.jsx` |
| O24 | Owner sees and coaches **every** client: messages, weekly reports, alerts, builders, client profiles (all of T2–T13 gym-wide) | ● | crawl `owner_messages/reports/alerts` list all 25 | role checks in each route |
| O25 | Gym sign-up: create gym + owner account (with contact, city, address) | ● | `Auth.gym-owner-setup-org` | `routes/auth.js:580`, `pages/SetupOrg.jsx` |
| O26 | Owner-recorded payments are excluded from trainer view ("Payment history is visible to the gym owner only") | ● | crawl3 `trainer_cp-membership` | `components/trainer/MembershipTab.jsx` |
| O27 | Tournament hosting at gym level (see S1–S8) | ● | `O.tournament.*` | `routes/tournaments.js` |
| O28 | Live crowd thresholds and member visibility enforced on the server | ● | crawl3 `acc-settings` ("Enforced on the server") | `routes/access.js` settings |
| O29 | Branch selector when adding access devices | ◐ | UI reads `/admin/branches`, but no screen can create a branch (see O31), so in practice the list is empty. *Downgraded from ● during catalogue preparation.* | `components/access/DevicesPanel.jsx:164` |
| O30 | Payment-account record for settlements | ◐ | Stores business/legal name only; Razorpay Route settlement not wired (`enterprise.js` PUT `/payment-account` comment). **Don't claim automatic payouts of online member payments to the gym.** | `routes/enterprise.js` |
| O31 | Multi-branch management | ◐ | Branch API exists (`admin.js:874`), but no screen creates or edits branches. | `routes/admin.js:874` |
| O32 | Staff tick a client's planned meals as eaten (or un-tick) from the client's Nutrition tab | ● | `T.client.plan-meal-toggle` 200 | `routes/nutrition.js:164`, `pages/trainer/ClientProfile.jsx:576` |

## 6. Trainer features (web dashboard, scoped to own roster)

| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| T1 | Trainer dashboard — today's check-in card with **Scan to check in**, gym now + "your clients in", active / on track / needs attention / at risk, attention required list with reasons, adherence trend, roster today (sessions, completion %, adherence), roster health | ● | crawl `trainer_home`; `T.dashboard` | `routes/dashboard.js:171`, `components/trainer/AttendanceCard.jsx` |
| T2 | My clients — only own roster, same filters and statuses as owner; add a client (auto-assigned to self) | ● | `T.clients.scoped-to-own` (10 of 27) | `routes/clients.js:275,306` |
| T3 | Client profile · Overview — adherence score, 7-day score, weight trend chart, measurements, "why this client needs attention" | ● | crawl3 `trainer_cp-overview` | `pages/trainer/ClientProfile.jsx`, `routes/trainer.js:91` |
| T4 | Client profile · Training — program week, **weekly muscle balance** vs target ranges (high / balanced / undertrained), movement patterns | ● | crawl3 `cp-training`; `T.client.weekly-volume` | `routes/clients.js:525`, `services/volumeAnalysis.js` |
| T5 | Client profile · Workouts — full history with status; assign a workout | ● | crawl3 `cp-workouts` | `routes/workouts.js:270` |
| T6 | Client profile · Nutrition — today's plan, logged items, plan targets, assign plan; 30-day history | ● | crawl3 `cp-nutrition`; `T.client.nutrition-history` | `routes/nutrition.js:120,284` |
| T7 | Client profile · Photos — front/side/back upload, before/after compare slider | ● | `T.progress-photo.upload` 201 (real JPEG; tiny images rejected) | `routes/clients.js:490`, `ClientProfile.jsx:654` |
| T8 | Client profile · Membership — status (lapsed/expiring), attendance last 90 days and last visit (payments hidden from trainers) | ● | crawl3 `cp-membership` | `components/trainer/MembershipTab.jsx` |
| T9 | Client profile · AI Coach — Analyze client → data-derived insight (e.g. overload next target) with Accept / Modify / Dismiss; deterministic, no key needed | ● | `T.insights.analyze` 201; crawl3 `cp-ai` | `routes/insights.js:21` |
| T10 | Client profile · Messages thread | ● | crawl3 `cp-messages` | `routes/messages.js` |
| T11 | Workout builder — templates, type filter, sort (recent/A–Z/longest), duplicate, assign to a client on a chosen date, delete; exercise picker; sets × reps · weight · rest; reorder; preview; 3D muscle body | ● | `T.template.create`, `O.template.duplicate`, `O.workout.assign-template(future date)` | `routes/workouts.js:123,140,270`, `pages/trainer/WorkoutBuilder.jsx`, `components/anatomy/MuscleBody3D.jsx` |
| T12 | Custom exercises added to the gym's library | ● | `T.exercise.custom-create` | `routes/workouts.js:64` |
| T13 | Training programs — assign a weekly split (PPL 3–6, Upper/Lower, Full Body 2–3, Custom) mapping days to templates | ● | `O.program.assign-weekly-split` → visible to client | `routes/clients.js:573` |
| T14 | Nutrition builder — calorie-targeted plans with meals per slot (breakfast → before bed), time, kcal and macros; Indian meal examples; assign to a client | ● | `T.nutrition-plan.create`, `O.nutrition.assign-plan` | `routes/nutrition.js:99,120`, `pages/trainer/NutritionBuilder.jsx` |
| T15 | Alerts — 8 risk signals from real data (plateau, low protein, no workout, low workout adherence, missed check-in, low nutrition, poor sleep, inactive), severity, Mark read / Follow up / Dismiss, filters. **Gym-wide by design**; each alert names whose client it is. | ● | crawl `trainer_alerts`; `T.alerts.scope` (9 foreign, labelled) | `routes/alerts.js:10,37`, `services/atRisk.js` |
| T16 | Weekly reports — weight Δ, workouts, water, sleep, adherence breakdown, coach summary, next-week action, 7-day log; **Send to client** (bell + message thread) | ● | `T.report.send-to-client` 201; crawl2 `owner_rep` | `routes/reports.js:11,19`, `services/weeklyReport.js` |
| T17 | Messages — per-client threads, quick templates (workout update, nutrition update, check-in reminder), unread counts | ● | `T.messages.unread` | `routes/messages.js:44,99`, `pages/trainer/Messages.jsx` |
| T18 | My attendance — scan Arriving/Leaving QR, history 7/30/90 days, total hours, average day, late count, **request a correction** for owner approval | ● | `T.attendance.check-in(scan)`, `.check-out(scan)`, `.correction-request`, `.my-history` | `routes/attendance.js:155,207,221`, `pages/trainer/MyAttendance.jsx` |
| T19 | Trainer sign-up, then join a gym by scanning its trainer QR | ● | `Auth.trainer-signup`, `T.qr.join-gym` | `routes/auth.js:249`, `routes/enrollment.js:589` |
| T20 | Live gym crowd for trainers | ● | `T.crowd.view` | `routes/trainer.js:41` |

*T3–T10 are the eight tabs of one "client 360° profile" screen. They are listed separately because each tab is a distinct capability.*

## 7. Shared features (all roles)

| ID | Feature | St. | Evidence | Code |
|---|---|---|---|---|
| S1 | **Tournaments** — host in a 5-step wizard (name, tagline, colours, venue, prize → pick events → …); 16 built-in events (reps, hold time, heaviest lift with attempts, distance, sprint/row times, team tug-of-war and relay) plus "your own"; gym-only or open to everyone | ● | `O.tournament.create`; crawl3 `t-host2` | `routes/tournaments.js:146`, `services/tournaments/catalog.js` |
| S2 | Enter events; join by code or QR; public tournament page for anyone with the link | ● | `C.tournament.join`, `Public.tournament.page(no auth)` | `routes/tournaments.js:280`, `pages/public/TournamentPublic.jsx` |
| S3 | Live scoring by hosts, automatic ranking | ● | `O.tournament.score-entry` (ranks recalculated) | `routes/tournaments.js:227`, `pages/tournaments/Scorer.jsx` |
| S4 | Results — overall podium, points (10/7/5/4/3/2/1), gold/silver/bronze, gym-vs-gym standings | ● | `C.tournament.results+podium` | `routes/tournaments.js:248`, `services/tournaments/scoring.js` |
| S5 | Personal trophy cabinet (played, gold, silver, bronze, titles, history) and @username identity, searchable for invites | ● | `C.tournament.trophy-cabinet` | `routes/tournaments.js:113` |
| S6 | Co-hosts, code rotation, tournament audit log | ● | `O.tournament.rotate-codes`, `.audit-log` | `routes/tournaments.js` |
| S7 | Big-screen display mode for the gym TV | ● | crawl3 `anon_t-public` "Big screen" | `pages/public/TournamentScreen.jsx` |
| S8 | Discover open tournaments from other gyms | ● | Hub tabs Live / Discover / Mine / Results | `pages/tournaments/Hub.jsx` |
| S9 | Role chooser at sign-in (Enterprise / Gym ecosystem / Independent) and email/password login | ● | crawl3 `anon_login` | `pages/Login.jsx` |
| S10 | Forgot / reset password by email | ◇ | `Auth.forgot-password` 200. Email defaults to a **mock** sender; Resend supported but not live-tested. | `routes/auth.js:817`, `services/notifications/emailProvider.js` |
| S11 | Google sign-in (independent members) | ◇ | needs `GOOGLE_CLIENT_ID` + `VITE_GOOGLE_CLIENT_ID` (page says so) | `routes/auth.js:538`, `pages/IndependentLogin.jsx` |
| S12 | Light / dark / system theme across all apps | ● | owner header switcher; client Settings | `themeContext.jsx` |
| S13 | Legal pages (About, Contact, Terms, Privacy, Refunds, Shipping) and terms acceptance at first sign-in | ● | crawl3 public footers; `/auth/terms/accept` | `pages/legal/*`, `pages/LegalConsent.jsx` |
| S14 | Prospect demo — request form, hand-approved 30-minute live demo of a real gym | ● (platform) | crawl3 `anon_demo` | `routes/demo.js:92`, `pages/public/DemoRequest.jsx` |

### 7.1 Not shipped — never claim
| Item | Evidence |
|---|---|
| Rest timer between sets | "no per-set or rest timers — a settled product decision" (`components/workout/SessionView.jsx:5`) |
| Ask Barbell / AskSK assistant, coach chat, meal-photo calorie estimate, AI workout generation, NL workout parsing | Only reachable from `components/AskSK.jsx`, which is **not mounted** anywhere. Endpoints (`/intel/coach/chat`, `/intel/meal-photo`, `/intel/generate-workout`, `/intel/parse-workout`, `/intel/ask`) have no reachable UI. |
| Member QR check-in at the gym door | QR is used for trainer attendance, gym joining and tournaments only; member entry counts come from access-control hardware or owner-marked attendance. |
| Apple Health, Health Connect, Samsung Health | "Requires the Barbell iOS/Android app" — no native app in the repo (409 `REQUIRES_NATIVE_APP`). |
| Garmin, Fitbit, Polar, COROS, Ultrahuman | Listed as "Not yet available". |
| Matrix COSEC, Hikvision, Suprema, ZKTeco BioTime door adapters | "Coming soon"; connect refused with `adapter_not_implemented`. |
| Push notifications with the app closed | No push provider (`reminders.js` header). |
| Owner support tickets, membership refunds/revoke, payment reconciliation, gym switching for multi-gym users, email verification | Backend endpoints only (`admin.js:681-937`, `auth.js:707-801`), no UI caller. |
| Platform admin console (`/admin` app, `/api/console/*`) | Internal SUPER_ADMIN tool for Barbell staff, not part of the three customer roles. |

## 8. Role and permission matrix (tested)

| Attempt | Result | Test |
|---|---|---|
| Trainer lists clients | Own roster only (10 of 27) | `T.clients.scoped-to-own` |
| Trainer opens another trainer's client (overview / dashboard / report / message) | 403 / 404 / 403 / 403 | `T.other-trainer-client.*` |
| Trainer views alerts | **All gym alerts, labelled by owning trainer; can act on them** (design, see `alerts.js` comment) | `T.alerts.scope`, `T.alerts.can-act-on-foreign` |
| Trainer → owner endpoints (overview, payments, analytics, CSV, enterprise, roster, settings, access) | 403 on all | `T.owner-only *`, `T.access.refused` |
| Trainer sees member payments | Hidden in UI ("owner only") | crawl3 |
| Client → staff endpoints (clients, admin, alerts, dashboard, another client, templates) | 403 on all | `C.blocked *` |
| Client writes to another client's data | 403 | `C.cannot-write-other-client-water` |
| Client creates gym challenge | 403 "Only gym staff" | `C.community.challenge-create` |
| Client uploads progress photo | 403 (coach-only) | `C.progress-photo.self-upload` |
| Client records trainer attendance | 403 | `C.attendance.client-refused` |
| Owner of gym B reads gym A's client | 403 | `X.cross-gym-owner-blocked` |
| Forged attendance QR | 422 rejected | `T.attendance.forged-qr-rejected` |
| Re-using a consumed enrolment QR | 422 `already_consumed` | `T.qr.one-time-reuse-refused` |
| Unimplemented door vendor | 400 refused | `O.access.unimplemented-vendor-refused` |
| Staff self-delete | 403 | `T.delete-account.refused` |
| Prescribed mode, client creates workout | **200 — not blocked server-side** (D3) | `C.permissions.server-blocks-custom-workout` |

## 9. Defects and discrepancies found (for engineering)

| # | Severity | Finding | Where |
|---|---|---|---|
| D1 | Medium | Weekly Review / Coach Brief count **exercise-log rows as workouts** ("26 workouts this week" vs 6 sessions; capped at 30). | `services/intelligence/aiContext.js:98` (`week_workouts: recent.length`) |
| D2 | Medium | "14-day weight trend" uses the **last 14 weight entries**, not 14 days — with weekly weigh-ins it spans ~3 months ("7.3 kg down over 14 days"). Same for 7d/30d. | `services/intelligence/aiContext.js:108-127` |
| D3 | Medium | Prescribed mode / "may add exercises" / "may substitute" are enforced in the UI and planner only. `POST /me/workouts` (Build today, Log past), share-import to *today*, and in-session add/substitute exercise don't check them. | `routes/me.js:1535`, `routes/me.js:2586`, `routes/workouts.js` |
| D4 | Low | Trainer's client Nutrition tab labels **every** non-plan log "· AI estimate", including manual, parsed and custom items. | `pages/trainer/ClientProfile.jsx:614` |
| D5 | Low | A failed trainer QR join (e.g. `gym_not_active`) still **consumes** the one-time code. | `routes/enrollment.js:589-597` (consume before activity check) |
| D6 | Low | The first membership payment made at QR sign-up is stored with `client_id = NULL` and never backfilled, so it is **missing from the member's payment history**. Renewals are fine. | `routes/enrollment.js` client join → `payment_orders` |
| D7 | Low | Invalid body on `POST /admin/access/providers` returns **500** (raw Zod error) instead of 422. | `routes/access.js:166` (`connectSchema.parse`) |
| D8 | Low (copy) | Help centre claims unshipped features: rest timer, Ask Barbell, meal-photo estimates, member photo upload, sleep tracking; mentions "SK food database". | `pages/client/Help.jsx` |
| D9 | Low (data) | Sleep adherence and Poor-sleep alerts have no production data source (no UI writes `sleep_logs`, wearables don't either). | `routes/tracking.js:32`, `services/adherence.js` |
| D10 | Low | Gym challenges have no creation UI for staff. | `routes/community.js:518` |
| D11 | Cosmetic | Old brand strings visible: "SK Coach AI" on the trainer AI tab, "SK food database" in Help. | `ClientProfile.jsx`, `Help.jsx` |
| D12 | Cosmetic | Coach Brief protein figure (260.6 g) differs from Home ring (250.6 g) on the same day. | `services/intelligence/*` vs `nutritionCalc.js` |
| D13 | Note | "2 eggs" parses to 100 g (≈ 1.9 eggs) where piece weight is 52 g; roti counts are correct. | `services/food/*` |
| D15 | Medium | `POST /me/nutrition/log-batch` (the type-a-meal / plate logging path) **stores the calories and macros the client sends** without recalculating them, so the README's "client-sent calorie/macro totals are ignored" doesn't hold for this path. Values normally come from the server's own `/describe` result, but a modified client could log arbitrary numbers. | `routes/me.js:1187-1212`, `README.md` ("Server-authoritative nutrition") |
| D14 | Seed only | `seed.js` creates the demo gym without an `org_billing_state` row, so Enterprise activation can't flip the gym to ACTIVE and QR joins fail on the demo gym. Gyms created by real sign-up are fine. | `backend/scripts/seed.js` |

## 10. Integrations

| Integration | Switch (env) | Unconfigured behaviour (observed) | Verification status (per code notes) |
|---|---|---|---|
| Razorpay (Barbell subscription, member QR join/renew) | `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`, `VITE_RAZORPAY_KEY_ID` | Mock provider; full flow works end to end | Order creation live-tested (test mode, 2026-08-26); checkout widget and webhook **not** live-tested |
| Gym settlements (Razorpay Route) | — | Records business name only | **Not wired** |
| Email (password reset, invoices, demo) | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` | Mock sender, returns ok | Resend **not** live-tested |
| Google sign-in | `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID` | Independent page shows "isn't set up" | — |
| Food AI (unmatched dish, label OCR) | `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`, `ALLOW_PAID_AI`, `FOOD_AI_*` | 502 / manual-entry fallback; never fabricates | — |
| Coach chat (Ollama) | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `available:false`; no UI anyway | — |
| WHOOP | `WHOOP_CLIENT_ID/SECRET` | 503 NOT_CONFIGURED | **Live-verified 2026-09-09** (OAuth + sync); webhook delivery not tested |
| Oura | `OURA_CLIENT_ID/SECRET` | 503 NOT_CONFIGURED | Not live-verified |
| Open Food Facts barcodes | none (optional `FOOD_DATABASE_API_*`) | Works (cache → bundled snapshot → live API) | Verified |
| Object storage for photos | `STORAGE_DRIVER=s3`, `STORAGE_S3_*` | Local disk; warns that local storage doesn't persist in production | — |
| Door/turnstile systems | per-connection secrets, `ACCESS_SECRET_KEY`, `CRON_SECRET` | Demo sandbox works; webhook/REST/CSV ready; eSSL beta | Demo verified; real hardware not tested |
| Rate limiting (Upstash) | Upstash env | In-memory store | — |

## 11. Backend test suite

`cd backend && npm test` on this snapshot (2026-11-04): **1,942 tests — 1,940 pass, 0 fail, 2 skipped** (exit 0). The earlier audit reported 1,865 tests on the older working copy.

Live behaviour tests run for this audit: **298 logged API actions** (256 PASS lines). All defects found are in §9; every other failure was a malformed request on the tester's side, retried and passed, or an intentional business rule (§8).

## 12. Reconciliation against the 42 crawled screens

| # | Screen (role · route) | Features shown | Notes / discrepancies |
|---|---|---|---|
| 1 | Owner · Dashboard `/app/trainer` | O1 | — |
| 2 | Owner · Clients | O2, O3 | — |
| 3 | Owner · Workouts | T11, T13 | — |
| 4 | Owner · Nutrition | T14 | — |
| 5 | Owner · Alerts | T15 | 18 open; includes sleep alerts from seed data (D9) |
| 6 | Owner · Reports | T16 | — |
| 7 | Owner · Messages | T17 | — |
| 8 | Owner · Tournaments | S1–S8 | empty until hosted; verified by API |
| 9 | Owner · Trainers | O4 | — |
| 10 | Owner · Analytics | O13 | — |
| 11 | Owner · Attendance | O14–O16 | — |
| 12 | Owner · Gym Crowd | O17 | — |
| 13 | Owner · Access control | O18, O28, O29 | 8 tabs verified in crawl3 |
| 14 | Owner · Business | O5–O12, O19 | — |
| 15 | Owner · Enterprise | O21 | Before purchase shows "Let's get your gym set up"; after, capacity/subscription/payment-account (O30) |
| 16 | Owner · Enterprise onboarding | O20 | **Hero shows illustrative sample figures (248 members, ₹4.0L)** — not real data; don't screenshot as a real dashboard |
| 17 | Owner · Enterprise QR | O23 | needs active package and capacity |
| 18 | Owner · Enterprise billing | O21, O22 | — |
| 19 | Trainer · Dashboard | T1, T20 | — |
| 20 | Trainer · Clients | T2 | own roster only |
| 21 | Trainer · Workouts | T11, T13 | client picker scoped |
| 22 | Trainer · Nutrition | T14 | — |
| 23 | Trainer · Alerts | T15 | shows other trainers' clients, labelled — design |
| 24 | Trainer · Reports | T16 | scoped |
| 25 | Trainer · Messages | T17 | scoped |
| 26 | Trainer · Tournaments | S1–S8 | — |
| 27 | Trainer · My attendance | T18 | — |
| 28 | Client · Home | C5–C9 | — |
| 29 | Client · Workout | C11–C25 | — |
| 30 | Client · Nutrition | C26–C40 | — |
| 31 | Client · Nutrition tracker | C41 | — |
| 32 | Client · Progress | C43–C51 | — |
| 33 | Client · Profile | C53–C57, C6 | — |
| 34 | Client · Membership | C64 | D6 |
| 35 | Client · Settings | C10, C42, C58–C63 | — |
| 36 | Client · Community hub | C65, C70, S1 | — |
| 37 | Client · Gym community | C65–C69, C75 | challenges view-only |
| 38 | Client · Help | C76, C4 | D8 |
| 39 | Client · Training history | C22 | — |
| 40 | Client · Connected devices | C71, C72 | 10 devices listed; only WHOOP/Oura connectable (◇); rest ✕ |
| 41 | Client · Today's burn | C52 | — |
| 42 | Client · Tournaments | S1–S8 | — |

**Reconciliation result:** every crawled screen maps to inventoried features. Every ● feature was seen on a screen and/or exercised through the API the screen calls. Discrepancies found while reconciling: D1, D2, D4, D6, D8, D9, D11 and the illustrative onboarding figures (row 16). No screen exposes a feature missing from this inventory.

## 13. Sales catalogue

`BARBELL_Complete_Feature_Catalogue.pdf` (25 pages, A4) is generated from `BARBELL_Feature_Catalogue_Source.html` using `catalogue-src/render-pdf.js`. Screenshots come from `catalogue-src/capture-screens.js` against a throwaway seeded database.

- Every catalogue entry carries `data-covers` with the IDs above. The coverage check (`catalogue-src/check-coverage.py`) confirms that **all 136 ● / ◇ IDs appear** and that **no ◐ ID appears**.
- Catalogue counts: Client 73 (67 ● + 6 ◇), Gym Owner 29 (27 ● + 2 ◇, plus every trainer tool gym-wide), Trainer 20 (●), Shared 14 (12 ● + 2 ◇).
- Screens deliberately not used: the trainer AI tab (shows the old "SK Coach AI" label, D11) and the Enterprise overview (shows the unwired payment-account alert, O30).
- Copy corrected against code while writing the catalogue: the nutrition "server-authoritative" claim was dropped (D15), and O29 was downgraded.

## 14. Guidance for sales copy

- Only ● items go in the primary list. ◇ items carry a "requires setup" marker and name what's needed (Razorpay, AI key, WHOOP/Oura developer app, door hardware, email provider).
- Don't claim: rest timer, Ask Barbell / chat coach, meal-photo estimates, AI workout generation, closed-app push notifications, member QR door check-in, Apple Health / Health Connect / Samsung / Garmin / Fitbit, named door vendors other than eSSL (beta), automatic payouts to the gym, multi-branch management, support ticketing.
- Describe AI honestly: Coach Brief, client analysis and alerts are **deterministic and data-driven** (no AI key). Generative AI is limited to optional food estimation and label reading.
- Calories burned are **estimates with a range**; say so.
- Alerts are gym-wide by design; trainers see whose client each alert belongs to.
- Don't quote Weekly Review numbers until D1/D2 are fixed.
