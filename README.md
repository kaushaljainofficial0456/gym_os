# SK OS — B2B Fitness Coaching SaaS (formerly Physique OS)

**Tagline:** Train smarter. Coach better. Prove progress.

SK OS is a gym-owned, client-first fitness operating system:

```
GYM OWNER → buys SK OS → provides it to members → TRAINER (optional) coaches → CLIENT personalizes
```

The client is not a passive recipient of a trainer's plan. Clients can customize workouts, meals, foods, personal metrics, and their dashboard within the permissions the gym/trainer configure. Predefined meal plans and training splits are optional starting templates, not the foundation.

> Train smarter. Coach better. Prove progress.

Multi-tenant platform for personal trainers, fitness coaches, and gyms: client management, workout & nutrition program builders, adherence scoring, at-risk detection, AI coach insights, weekly reports, messaging, and a mobile-first client portal.

## Database Policy

**Official production database: PostgreSQL hosted on Neon.** SQLite is retained
for local development and testing convenience — it is **NOT** the production
database and is never used in staging or production.

| Environment | Allowed database(s) | Behavior |
|---|---|---|
| **Development** | SQLite (default) · PostgreSQL optional | `DATABASE_URL` unset → local SQLite, zero setup |
| **Testing** | SQLite (unit/regression) · PostgreSQL/Neon (integration & production-parity validation) | `npm test` uses in-memory SQLite; `npm run pg:validate` validates live PostgreSQL |
| **Staging** | PostgreSQL / Neon **only** | App **refuses to start** if `DATABASE_URL` is missing |
| **Production** | PostgreSQL / Neon **only** | App **refuses to start** if `DATABASE_URL` is missing |

**Guards (enforced in `backend/src/config.js`, keyed on `NODE_ENV`):**

- `NODE_ENV=staging` or `NODE_ENV=production` with no `DATABASE_URL` → the app
  exits at startup with a FATAL error. It never silently falls back to SQLite.
- The runtime connection must use the dedicated app role (`skos_app`, `NOBYPASSRLS`
  — RLS enforced). Using the admin role (`neondb_owner`, which Neon creates with
  `BYPASSRLS`) as `DATABASE_URL` → the app exits at startup.

**Connection roles (keep separate — see "Local dev (SQLite) vs Neon" below):**

| Role | Purpose | Used by |
|---|---|---|
| `skos_app` | Runtime application connection (`DATABASE_URL`) — `NOBYPASSRLS`, DML-only, no DDL | Running app + `pg:validate` checks |
| `neondb_owner` | Admin: migrations, schema, RLS policies | `PG_ADMIN_URL` / `npm run db:init` — never the app runtime connection |

## Requirements

- **Node.js ≥ 22** (uses built-in `node:sqlite` — no Postgres needed for local dev)
- **npm** (comes with Node)

## Quick Start

```bash
# 1. Install dependencies (from project root)
npm install --prefix backend
npm install --prefix frontend

# 2. Create database + seed demo data
node backend/scripts/init-db.js
node backend/scripts/seed.js

# (Or reset everything: node backend/scripts/init-db.js --force && node backend/scripts/seed.js)

# 3. Start both servers (two terminals, or use the root package.json):
# Terminal 1 — Backend API (http://localhost:4000)
PORT=4000 node backend/src/index.js

# Terminal 2 — Frontend dev server (http://localhost:5173)
cd frontend && npx vite
```

Or from the root (requires `concurrently` — install with `npm install` first):

```bash
npm run dev
```

## Open the App

**http://localhost:5173**

## Demo Login Credentials

All passwords: **`demo1234`**

| Role | Email | What you'll see |
|---|---|---|
| Trainer | `trainer1@ironforge.in` | Dashboard, clients, workout/nutrition builders, alerts, reports, messages |
| Gym Owner | `owner@ironforge.in` | Everything above + **Business** tab (members, packages, revenue, subscriptions) |
| Client | `client1@ironforge.in` | Mobile portal: today's session with animated exercises, meal logging, AI food estimates, water tracking, progress, coach messages |

The login page also has one-tap demo buttons for all three roles.

## Database

- **Location:** `backend/data/physique.db` (created on first init)
- **Engine:** SQLite via Node 22's built-in `node:sqlite` (no separate install)
- **Schema:** `database/schema.sql` (relational, 20+ tables with FKs and indexes)
- **Prod path:** Activate PostgreSQL/Neon by setting `DATABASE_URL` to the **runtime role** connection (see "Local dev (SQLite) vs Neon" below). SQLite stays the default whenever `DATABASE_URL` is unset.

### Database commands

```bash
npm run db:init      # Create tables (safe — uses IF NOT EXISTS)
npm run db:seed      # Insert demo data
npm run db:reset     # Drop + recreate + reseed (caution: deletes all data)
```

### Local dev (SQLite) vs Neon (PostgreSQL)

The backend is dual-engine. SQLite is the zero-setup default; PostgreSQL is
activated **only** when `DATABASE_URL` is set.

| Mode | Setup | Role used |
|---|---|---|
| **SQLite (local dev / tests)** | `DATABASE_URL` unset → `backend/data/physique.db` via Node 22 `node:sqlite` | — |
| **Neon (production)** | `DATABASE_URL` = **runtime role** connection | `skos_app` (runtime) |
| **Migrations / RLS / validation init** | run `npm run db:init` / `pg:validate` with the **admin** connection | `neondb_owner` (admin) |

**Runtime vs admin roles — keep them separate:**

- **`skos_app` (runtime):** least-privilege — `NOBYPASSRLS` (RLS enforced),
  `SELECT/INSERT/UPDATE/DELETE` on all tables, no DDL. This is the only role the
  running backend connects as (`DATABASE_URL`).
- **`neondb_owner` (admin):** schema, migrations, RLS policies only. Neon creates
  this role with `BYPASSRLS`, so connecting the app as it would **silently
  disable Row-Level Security** — never use it as the runtime connection.

**Credentials policy:** never commit `.env` files or connection strings
(`.gitignore` covers `.env`, `backend/.env`, `*.env.local`). Pass connection
strings via your environment / secrets store and use `sslmode=verify-full`.

#### PostgreSQL validation (live)

`npm run pg:validate` smoke-tests a real PostgreSQL instance (use a **disposable**
Neon database — it creates tables and seeds rows; `--clean` drops them after):

```bash
DATABASE_URL="postgresql://skos_app:...@<host>/neondb?sslmode=verify-full" \
PG_ADMIN_URL="postgresql://neondb_owner:...@<host>/neondb?sslmode=verify-full" \
npm run pg:validate
```

- `DATABASE_URL` → the **runtime** role (validates its privileges + RLS posture)
- `PG_ADMIN_URL` → the **admin** role (runs schema + migrations + RLS first)
- Expected result: **8/8 checks pass** (transactions, upserts, RLS isolation,
  workout completion, calorie persistence, nutrition)

## NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` (root) | Start both backend + frontend concurrently |
| `npm run dev:backend` | Backend with watch mode |
| `npm run dev:frontend` | Frontend Vite dev server |
| `npm run build` | Build frontend for production |
| `npm run start` | Start backend only (production) |
| `npm run db:init` | Initialize database tables |
| `npm run db:seed` | Seed demo data |
| `npm run db:reset` | Force re-initialize + reseed |
| `npm run pg:validate` | Live PostgreSQL validation against a real Neon DB (needs `DATABASE_URL` + `PG_ADMIN_URL`) |
| `npm test` (backend) | Run business-logic test suite (`node --test`) |

## Environment Variables

Copy `.env.example` to `.env` (optional — safe defaults apply):

```
PORT=4000
JWT_SECRET=change-me-to-a-long-random-string-in-production
TIMEZONE=Asia/Kolkata
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | No | 4000 | Backend API port |
| `JWT_SECRET` | Prod: **yes** | `dev-secret-change-me` | Token signing secret. In `NODE_ENV=production` the app **refuses to start** unless this is set to a strong secret (16+ chars) — the dev default is never used in prod |
| `DATABASE_URL` | No | (none → SQLite) | **Runtime** PostgreSQL connection string — must use the `skos_app` role (`NOBYPASSRLS`, RLS enforced). Leave unset for local SQLite dev |
| `PG_ADMIN_URL` | Only for `pg:validate` | (none) | **Admin** connection (`neondb_owner`) — schema/migrations/RLS + validation init only; never used by the running app |
| `TIMEZONE` | No | `Asia/Kolkata` | Default timezone for daily boundaries |
| `NODE_ENV` | No | development | Set "production" for prod behavior (strong-secret gate + minimal error messages) |
| `CORS_ORIGINS` | No | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allow-list. Never `*` — unlisted origins are rejected |
| `AI_PROVIDER` | No | `ollama` | `ollama` (local, default) \| `openai` \| `gemini` \| `mock` |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Local Ollama endpoint (when `AI_PROVIDER=ollama`) |
| `OLLAMA_MODEL` | No | `llama3.2` | Local model name, e.g. `qwen2.5:7b`, `llama3.2` |
| `LLM_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | No | (none) | For hosted providers (when `AI_PROVIDER=openai|gemini`) |

> **Ollama setup (local AI coaching):** `ollama pull llama3.2` (or `qwen2.5:7b` for a stronger small model), then start Ollama. SK OS detects availability at runtime via `GET /api/tags` — **if Ollama is down or not installed, everything keeps working**: the coach falls back to its deterministic engine and the UI shows `deterministic` instead of `OLLAMA`; nutrition is always calculated by SK OS itself, never by the model.
| `VITE_API_TARGET` | No | `http://localhost:4000` | Vite dev proxy target |

## Architecture

```
database/schema.sql       → Full relational schema
backend/src/
  db.js                  → SQLite/PostgreSQL dual adapter
  auth.js                → JWT + bcrypt + RBAC + tenant isolation
  config.js              → Env-based configuration
  ids.js                 → ID generator
  index.js               → Express app + routes
  routes/                → 12 route modules (incl. /api/me client personalization)
  services/              → 14 service modules (trainingProgram, progressiveOverload,
                           personalRecords, volumeAnalysis, muscles, equipment, adherence,
                           atRisk, aiCoach, alerts, insights, reports, messaging, analytics)
  test/business.test.js  → 10 tests: split validation, set logging, PRs, overload,
                           alert dedup, timezone day boundaries, tenant isolation

## Client Personalization (SK OS core)

Client portal (`/api/me/*`, all scoped to org_id + client_id):

| Feature | Endpoints | Notes |
|---|---|---|
| My goal & setup | `GET/PUT /me/profile` | goal, target weight/date, experience, equipment |
| My metrics | `GET/POST /me/metrics`, `PUT /me/metrics/:id`, `POST .../entries`, `DELETE .../entries/:id` | any personal metric (waist, steps, bench…) — types: number / count / duration / boolean; edit metric, edit/delete entries, sparkline |
| My foods | `GET/POST /me/foods`, `DELETE` | client-owned foods; separate from GYM + GLOBAL library scopes (28 global Indian foods seeded) |
| My meals | `GET/POST /me/meals`, `POST /me/meals/:id/log`, `DELETE` | client's own meal structure (any slots/times); logging drives the calorie ring |
| Meal composer | `GET/POST/PUT/DELETE /me/meals/:id/items` | meal → foods → quantity: pick any food (global / gym / mine), scale macros, meal totals auto-recompute |
| My workout | `GET/POST /me/workouts`, `DELETE` | build today's session from the library → becomes `today` with `source=client_custom` |
| My workout planner | `GET/POST /me/planner/workouts`, `PUT/DELETE .../:id`, `POST .../duplicate`, `PUT /me/planner/schedule` | reusable workouts (Push A / Pull A / Legs A…), edit/duplicate/delete, weekly schedule per weekday, "Do today" |
| My dashboard | `GET/PUT /me/dashboard` | show / hide / reorder home cards (workout, goal, fuel, water, sleep, coach, adherence, crowd) |
| Permissions | `GET /me/permissions` | effective workout mode + permission flags from gym settings (enforced server-side) |
| Gym crowd | `GET /me/crowd` | occupancy engine → current / peak / average / busiest hour + LOW/MODERATE/HIGH/VERY_HIGH |

Workouts carry a `source` column: `program | trainer | gym_template | client_custom | ai`.
Workout modes (gym-configurable default): **prescribed** (trainer controls), **custom** (client builds), **hybrid** (trainer prescribes, client personalizes). Gym owner sets defaults + permissions in the Business page → Gym settings (branding, crowd capacity, permission toggles).

Workout + nutrition templates (PPL splits, meal plans) remain as **optional starting templates** — they are never forced on a client.

## SK Intelligence Engine

A deterministic, explainable natural-language layer on top of the same databases — **no LLM writes to the DB**. Every commit goes through `/api/intel/*` after confirmation, with provenance + confidence labels, and every action is recorded in `intelligence_events`.

```
USER INPUT → parsing (units.js / parseFoods.js / parseWorkout.js) →
  domain resolution (foodSearch / exerciseSearch against the DB) →
  calculation (nutrition.js: per-100g scaling, rounding) →
  STRUCTURED RESULT → user confirms → commit + traceable event
```

| Endpoint | What it does |
|---|---|
| `POST /api/intel/parse-food` | `"220g paneer"`, `"2 rotis + 150g rice"`, `"100g oats + 250ml milk"` → items with food_id, quantity, computed macros, provenance (VERIFIED_DATABASE / ESTIMATED), confidence (HIGH / MEDIUM / LOW), scope (GLOBAL / GYM / MY), unresolved list |
| `POST /api/intel/confirm-food` | commits confirmed entries to today's `meal_logs` (re-validates each food is visible to this client — never a cross-org food). The server **re-parses quantity+unit** and recomputes all nutrition from the DB row — the client submits only `{food_id, quantity, unit}`, never totals. Units are preserved (`220g paneer` → g/gram, `2 rotis` → rotis/piece, `250ml milk` → ml/ml) and stored on the log row |
| `POST /api/intel/parse-workout` | `"Bench press 60x8, 65x6, 65x5"`, `"3 sets lat pulldown at 50kg for 10"` → sets + resolved exercise (id, muscles, equipment) |
| `POST /api/intel/confirm-workout` | transactional: creates the workout, workout_exercises, set-by-set logs, PR evaluation, all in one `db.tx` |
| `GET /api/intel/foods?q=` | scope-aware autocomplete (global + gym + my foods, aliases incl. "cottage cheese" → Paneer) |
| `GET /api/intel/exercises?q=&muscle=&equipment=` | intent-aware search: `"chest dumbbells"` → chest + dumbbell; plural-tolerant equipment; alias expansion (`"flat bench"` → Bench Press) |
| `POST /api/intel/generate-workout` | constraint-based program generator: goal, days, equipment, exclusions (`"no barbell squats"`), experience → a weekly structure **built only from exercises that exist in the DB and match the constraints**; labeled TEMPLATE |
| `POST /api/intel/label-scan` | nutrition-label photo: MIME/5MB/dimension validation, private tmp storage (served only to the owning client via an authenticated route — never a public `/uploads` mount), editable fields, provenance LABEL_SCANNED. With an AI provider configured, OCR extracts product/serving/macros for review (confidence flagged, every value editable); without one, values are entered + confirmed by the user |
| `POST /api/intel/meal-photo` | photo of actual food → **ESTIMATED ranges only** (e.g. 450–550 kcal, Medium confidence). Never exact; without a vision provider it says so and returns an empty range |
| `POST /api/intel/foods/label` | saves a confirmed scanned/entered packaged food to My Foods (client-scoped, source PACKAGING_LABEL) |
| `POST /api/intel/ask` | context-aware questions: "How much protein have I eaten today?", "What should I train today?", "What did I bench last week?", "Why is my weight stuck?" → answers computed from **real DB rows** (meal_logs, planner schedule, workout_logs, weight_logs) with provenance MEASURED / CALCULATED — never invented data |

The Ask SK OS bar also has **voice input** (🎙️, Web Speech API): clients can say what they ate or trained — "two hundred twenty grams paneer" or "bench press sixty kilos eight reps" — and the transcript is filled into the same review-before-commit flow. Unsupported browsers / denied mic access fall back to typing with a clear toast; nothing is ever committed from raw audio.

## Local AI Coach (SK Coach)

A **personal fitness intelligence engine**, not a chatbot. SK Coach reads the client's actual rows and decides what matters most, what to do next, why, and which SK OS action helps — with the LLM only ever *framing* the deterministic data.

```
client data (DB) → buildClientAIContext (compact, tenant-scoped)
  → coachEngine (deterministic insights: protein gap, sleep gap, water gap,
                  workout due, weight trend, goal progress, gym crowd)
  → structured recommendation {type, title, message, reason, priority,
                               confidence, data_sources, action}
  → optional Ollama framing (conversational summary) — never the numbers
```

| Endpoint | What it does |
|---|---|
| `GET /api/intel/coach/status` | provider + Ollama availability (UI shows "AI Coach unavailable" instead of breaking) |
| `GET /api/intel/coach/brief` | **Today's Coach Brief**: 3–5 data-driven insights + today's single priority (deterministic; Ollama-framed when available) |
| `GET /api/intel/coach/weekly` | **Weekly Coach Review**: what went well / needs attention / next week's priority |
| `POST /api/intel/coach/chat` | context-aware answer; food requests search the **real food DB** (respects diet type + exclusions); medical/emergency topics are answered by a safety gate referring to a qualified professional, never the model |
| `POST /api/intel/coach/feedback` | "helpful / not helpful / don't recommend / not relevant / already done" stored per client |
| `GET/PUT /api/intel/coach/memory` | structured long-term preferences (`equipment_pref`, `disliked_exercises`, `liked_foods`, `workout_duration`, `training_time`, `note`) — **never raw conversation text**, org+client scoped, allow-list keys only |

Design rules:
- **The AI never calculates authoritative nutrition or progression.** Food values come from the food DB + nutrition engine; workout targets come from the progressive-overload engine. AI is for understanding, reasoning, explanation and recommendation only.
- **Context is compact and scoped.** Only the authenticated client's rows are retrieved (profile/training/nutrition/progress/recovery/gym/memory), only the domains a question needs — never the whole database, never another tenant.
- **Honest fallback.** Without Ollama (or with insufficient data), the coach says so and returns LOW-confidence insights like "I don't have enough logged data yet" — it never invents conclusions.
- **Safety.** Model-level and route-level gates: no diagnoses, no medication advice, no extreme recommendations; fitness guidance only, medical topics → "consult a qualified professional".
- **Cost control.** Every deterministic calculation (nutrition, search, PR, overload, adherence, trends) runs without the LLM. Ollama is called only for ambiguous NL, coaching framing, vision and complex recommendations.

Design rules:
- Common inputs (`"220g paneer"`, `"Bench press 60x8"`) are handled **deterministically** — regex + unit engine + DB search + arithmetic, no AI needed. AI is reserved for genuinely ambiguous interpretation (optional OCR / vision / coaching).
- Every food row has a `source` (`VERIFIED_DATABASE | USER_ENTERED | PACKAGING_LABEL | OCR_EXTRACTED | ESTIMATED`); estimates are always labelled, never presented as exact.
- **Food-aware units**: each food defines its own base (`100 g`, `200 ml`, `1 pc`, `1 scoop`) via its `serving` column. There is **no universal 1ml = 1g assumption** — ml scaling uses the food's ml base; cross-unit conversions (ml↔g, pieces↔grams) are always flagged ESTIMATED with LOW/MEDIUM confidence.
- **Food-specific piece weights**: `piece_g` (egg ≈ 52 g, roti ≈ 35 g, banana ≈ 118 g, scoop ≈ 33 g…) — food metadata beats generic defaults, and where the weight is approximate the calculation is labelled ESTIMATED.
- **Server-authoritative nutrition**: the client submits `{food_id, quantity, unit}`; the server re-parses the unit, resolves the food from its own DB (org-scoped), and recomputes every macro. Client-sent calorie/macro totals are ignored.
- Scaling is `nutrient = per_base_qty × (qty / base_qty)` with consistent 1-decimal rounding; totals are sums.
- **AI provider abstraction** (`aiProvider.js`): `interpret()` / `visionLabel()` / `estimateMeal()` / `coach()` with `AI_PROVIDER=mock|openai|gemini` implementations. Without an API key the mock provider never fabricates data — it returns "requires key" guidance. Deterministic parsing/search/calculation never goes through the LLM.
- Global food library (~156 items, Indian + international, 41 with food-specific piece weights), global exercise library (**207 exercises** with aliases, muscles, equipment, movement, difficulty, animation_key where an SVG animation exists) — both seeded and easy to extend.
- Search hits the backend with limits — thousands of foods/exercises are never shipped to the browser.
  scripts/               → Database init + seed
frontend/src/
  pages/trainer/         → 9 pages (dashboard, clients, builders, alerts, reports, messages, business)
  pages/client/          → 6 mobile-first pages (home, workout, nutrition, progress, profile)
  components/            → UI kit, charts, MuscleMap.jsx, SVG exercise animation library (11 animations)
```

### Training Programs (split-driven sessions)

A client's `training_programs` maps days of the week to workout templates
(`training_days`). When the client opens the workout page, the backend
(`services/trainingProgram.js`) resolves **today's session** from the program
— e.g. Mon = Push Day (Chest · Shoulders · Triceps), Tue = Pull Day — and
materializes it as a real scheduled workout on first view. That keeps history,
progressive-overload suggestions, PR detection, and adherence working exactly
as they do for trainer-assigned workouts.

- **Trainer side:** Workout builder → *Training programs* — pick a client,
  choose a split preset (PPL / Upper-Lower / Full Body / Custom), map each day
  to a template, assign.
- **Client side:** Workout page shows today's training header, muscle-focus
  distribution, filterable muscle map (front/back silhouette), per-exercise
  detail with NEXT TARGET (from `progressiveOverload.js`), a focused execution
  mode with set-by-set tracking, a rest timer (with ±30s / skip), and a
  completion summary with volume + personal records.
- **Seed:** Rahul (PPL), Neha (Full Body), Vikram (PPL) get programs; the rest
  use trainer-assigned workouts.

### Workout Execution & Set Logging

- **Per-set logging:** completing a workout accepts per-set rows
  (`exercise_set_logs`: set number, prescribed vs actual reps/weight, rest
  seconds, optional RIR 0–5, completed). A legacy aggregate shape is still
  accepted and backfilled from existing history on init. Completing with zero
  logs is rejected (400).
- **Personal records** (`services/personalRecords.js`): computed only from
  completed sets with real weight/reps — heaviest weight, best reps at a
  weight, estimated 1RM (Epley), best set volume. Existing workout history is
  used as the baseline, so lighter sessions don't trigger false PRs.
- **Progressive overload** (`services/progressiveOverload.js`): suggests the
  next weight/reps from actual per-set performance; holds steady on the first
  session and only suggests weight increases when the prescribed rep range was
  hit across sets.
- **Rest timer:** exercise-aware defaults (compound 120–180s, isolation
  60–90s, core 30–60s); trainer-configured rest overrides.

### Muscle Model, Volume & Equipment

- **Normalized muscles:** `muscles` + `exercise_muscles` (role PRIMARY /
  SECONDARY) alongside the legacy string columns for compatibility.
- **Weekly volume** (`services/volumeAnalysis.js`): estimated training-volume
  contribution per muscle — PRIMARY sets count 1.0, SECONDARY 0.5 (an
  estimate, clearly labeled, with configurable min/max targets per muscle).
  Statuses: UNDERTRAINED / BALANCED / HIGH VOLUME.
- **Equipment profiles:** each client has an equipment list (dumbbells,
  barbell, cable, bench, machine, bodyweight, resistance bands, pull-up bar).
  Today's session flags missing equipment and computes compatible
  alternatives from the library by primary muscle + movement pattern.
- **Client goal signal:** goal (fat loss / muscle gain / recomposition /
  strength / general fitness) and experience level inform program presets and
  overload suggestions — trainer retains full control.

### Adherence Score

Weights (defined in `backend/src/services/adherence.js`):

| Component | Weight | Source |
|---|---|---|
| Workout completion | 35% | Completed / scheduled workouts (7-day window) |
| Nutrition adherence | 20% | Meals eaten / meals planned |
| Protein adherence | 15% | Protein eaten / protein target (capped at 100%) |
| Water adherence | 10% | Avg litres / daily target |
| Sleep adherence | 10% | Avg hours / sleep target |
| Check-in consistency | 10% | Weight log or measurement in window |

### Architecture diagram

```
database/schema.sql       → Full relational schema
backend/src/
  db.js                  → SQLite/PostgreSQL dual adapter
  auth.js                → JWT + bcrypt + RBAC + tenant isolation
  config.js              → Env-based configuration
  ids.js                 → ID generator
  index.js               → Express app + routes
  routes/                → 13 route modules (incl. /api/me client personalization + /api/intel intelligence)
  services/              → 18 service modules (trainingProgram, progressiveOverload,
                           personalRecords, volumeAnalysis, muscles, equipment, adherence,
                           atRisk, aiCoach, alerts, insights, reports, messaging, analytics,
                           occupancy, intelligence/{units, parseFoods, parseWorkout, nutrition,
                           foodSearch, exerciseSearch, generateProgram, context, aiProvider,
                           aiContext, coachEngine})
  test/business.test.js   → 10 tests: split validation, set logging, PRs, overload,
                            alert dedup, timezone day boundaries, tenant isolation
  test/hardening.test.js  → 10 tests: permissions, planner, meal items, occupancy,
                            ownership, cross-org exercise id
  test/intelligence.test.js → 14 tests: food parsing, unit conversions, nutrient
                            scaling, workout parsing, alias/intent search, program
                            constraints, tenant isolation, plural-equipment
  test/intelligence2.test.js → 19 tests: confirm-food unit preservation (g/piece/ml),
                            server-authoritative nutrition (client totals ignored),
                            exercise-search SQL for every filter combo, whole-word
                            classifier, ml-vs-gram scaling, food-specific piece weights,
                            /intel/ask context from real rows, meal-photo estimation,
                            cross-org food rejection, prod JWT gate, CORS
  test/coach.test.js       → 9 tests: AI context engine (real rows, compact, scoped),
                            7-day nutrition averages, deterministic insights + priority,
                            insufficient-data honesty, daily brief + weekly review shapes,
                            DB-backed food suggestions honoring diet type, safety gate,
                            memory tenant isolation
frontend/src/
  pages/trainer/         → 9 pages (dashboard, clients, builders, alerts, reports, messages, business)
  pages/client/          → 6 mobile-first pages (home, workout, nutrition, progress, profile)
  components/            → UI kit, charts, MuscleMap.jsx, SVG exercise animation library,
                           AskSK.jsx (natural-language bar + review/confirm flows)
```

## Security & Hardening

- **Production startup gate:** `NODE_ENV=production` fails fast (exit 1) unless
  `JWT_SECRET` is a strong, non-default secret — the dev fallback can never run in prod.
- **CORS allow-list:** `CORS_ORIGINS` defaults to localhost dev origins only;
  wildcard origins are never accepted.
- **Private uploads:** label/progress images are never served from a public
  static mount. They live under `data/uploads` and are served only through an
  authenticated route that authorizes the requester (client themselves,
  same-org owner/admin, or the client's assigned trainer — mirroring
  `resolveClient`). The frontend previews them via an authenticated fetch →
  blob URL.
- **Storage abstraction:** progress photos are no longer stored as base64 in
  the DB. `src/storage.js` validates the image (MIME whitelist, 5 MB cap,
  dimension sanity), writes it as a private file, and stores `storage_key`
  metadata (`photos/<client_id>/<id>.png`). Old `data_url` rows are still
  readable (back-compat). `STORAGE_DRIVER=s3` is the documented object-storage
  slot (R2/S3/Supabase) with the same DB/API contract.
- **File validation:** label-scan and photo uploads reject non-image MIME
  types, payloads over 5 MB, and images smaller than 32 px; dimensions are
  checked from the PNG/JPEG headers before anything is written.
- **Tenant isolation:** all client/workout/alert/insight routes resolve the
  client through `resolveClient()` which checks org membership server-side
  (tested).
- **Ownership scoping on every /me entity:** metrics, entries, foods, meals,
  meal items, planner workouts and schedules are always filtered by
  `org_id + client_id` server-side — a client cannot log or delete another
  client's metric entries, add another gym's private food to a meal, or inject
  another gym's exercise id into a workout (all tested).
- **Permission enforcement:** gym settings (`workout_mode_default`,
  `allow_add_exercise`, `allow_edit_targets`) are enforced in the backend —
  e.g. `prescribed` mode returns 403 on workout creation, not just a hidden
  button (tested).
- **Transactions:** `db.tx()` on both engines; planner create/edit/duplicate,
  schedule saves, and meal-item mutations run atomically (rollback on error).
- **PostgreSQL adapter:** `DATABASE_URL` enables `pg` with automatic
  `?` → `$n` placeholder translation (`db.js` `translateSql`), so the same
  business queries run on both engines. The schema DDL is portable (no
  SQLite-only syntax — the previous `COLLATE NOCASE` index definitions were
  removed; searches use `LOWER()` for case-insensitivity on both engines).
  NOTE: the pg path is unit-tested but not exercised against a live Postgres
  in CI — see Known Limitations.
- **Health/readiness:** `GET /health` + `GET /ready` (also under `/api/*`)
  verify the process is up and the database answers; `NODE_ENV=production`
  fails startup without a strong `JWT_SECRET`; error responses never expose
  stack traces, SQL, or secrets in production.
- **Pagination / N+1:** trainer client list capped (default 500), workout
  history capped (default 60) with exercises fetched in one bulk query, and
  metric entries fetched per-client in one query (grouped in memory).
- **Bulk client evaluation (the big one):** the client list and alert
  evaluation used to run ~13 queries **per client**. They now bulk-load last
  workout dates, 35-day weights, adherence (one query per table), activity,
  user meta, last completed workout and 7-day weight change for all clients in
  ~13 queries **total**. Verified by `node backend/scripts/scale-benchmark.js`:
  evaluating 250 clients dropped from **2,500 queries → 10 queries** (113 ms
  vs 425 ms), and a 10-gym / 2,500-client dataset seeds in ~66 s.
- **Portable SQL everywhere:** no `rowid` orderings remain (replaced with
  `date DESC, created_at DESC, id DESC` and a stable `muscle_id` tiebreak),
  no `COLLATE NOCASE`, no SQLite-only functions — verified by a regression
  test that scans the schema, the RLS file and application SQL.
- **Rate limiting:** in-memory fixed-window limiters (no new deps) — 30/min
  per IP on login, 10/min on org setup, 240/min per client on the intelligence
  engine with a stricter 30/min for AI/parse endpoints and 10/min for
  upload/vision endpoints. Each limiter instance has its own bucket. (Single
  instance is fine for 10 gyms / ~2,500 clients; a shared store is only needed
  if you later run multiple API instances.)
- **PostgreSQL RLS (defense-in-depth):** `database/rls.sql` enables RLS with
  `FORCE ROW LEVEL SECURITY` on every tenant-owned table (direct `org_id`,
  global-library, client-scoped, and parent-scoped policies). The app sets the
  `app.org_id` session variable per transaction (`SET LOCAL` inside `db.tx()`,
  scoped via AsyncLocalStorage in `requireAuth`) so multi-row writes can only
  see/touch the authenticated org's rows. When the variable is unset (plain
  reads) the policies stay permissive and application-level org filters govern.
  Applied automatically on PostgreSQL in `npm run db:init`; SQLite unaffected.
- **Request IDs + access log:** every request gets a UUID logged with method,
  path, status and duration (never bodies/tokens); the error handler tags
  diagnostics with the same id. Production responses never expose stack
  traces, SQL, or secrets.
- **JSON body limits:** ordinary API calls are capped at 1 MB; only the
  upload-carrying routes (`/api/intel`, `/api/clients`) accept up to 8 MB for
  base64 data-URL images, and those images are validated (MIME, ≤5 MB, dims)
  before anything is written.
- **Alert deduplication:** alerts carry a deterministic `client + type +
  condition` identity; evaluation refreshes on request and marks alerts
  resolved when the condition clears (no duplicate spam).
- **Timezone:** the org timezone is resolved **inside `requireAuth`** — after
  the token is verified — so `req.tz` always reflects the authenticated org,
  never a pre-auth default (bug fixed; regression-tested). Daily boundaries
  use `utils/time.js` `dayKey`/`getOrgTz`.
- **Validation:** zod schemas on every mutating endpoint; training programs
  validate day counts, day-of-week uniqueness, template references, sets/reps
  ranges, and duplicate day identifiers (`services/programValidation.js`).

## Occupancy Engine

Attendance events from the gym's access-control system are normalized to
`member_id / direction (entry|exit) / timestamp` (never biometric data).
`services/occupancy.js` replays a day's events and handles duplicate entries,
duplicate exits, exits without an entry, midnight rollover (org timezone), and
manual corrections — then reports current occupancy, today's peak, average,
and busiest hour, plus a LOW/MODERATE/HIGH/VERY_HIGH status against the gym's
capacity. Integration providers (API / webhook / local connector / CSV import)
can push normalized events without changing the engine.

## Production Readiness (10 gyms / ~2,500 clients)

Target architecture — a modular Node.js backend; **no microservices** at this
scale. Frontend (React/Vite) → SK OS API → Neon PostgreSQL + (optional)
Ollama/vision provider + object storage.

### Deploying to Neon PostgreSQL

1. Create a Neon project. Neon's default owner role has `BYPASSRLS`, which
   silently disables Row-Level Security — so create a dedicated **runtime role**
   (`skos_app`) with `NOBYPASSRLS` plus `USAGE` on schema `public` and
   `SELECT/INSERT/UPDATE/DELETE` on all tables. Keep `neondb_owner` as the
   **admin** role for schema/migrations only.
2. Apply schema + migrations + RLS with the **admin** role:
   `DATABASE_URL=postgres://neondb_owner:... npm run db:init` (idempotent
   `IF NOT EXISTS`, portable DDL). Add `?sslmode=verify-full` per Neon.
3. `DATABASE_URL=postgres://neondb_owner:... npm run db:seed` **only for demo
   data** — real tenants start empty and create their own gym via
   `/api/auth/setup-org`.
4. Run the app with the **runtime** role:
   `DATABASE_URL=postgres://skos_app:... NODE_ENV=production JWT_SECRET=<strong-secret> CORS_ORIGINS=<frontend domain> npm start`.
5. Validate the live setup:
   `DATABASE_URL=<skos_app> PG_ADMIN_URL=<neondb_owner> npm run pg:validate` (expect 8/8).

`pg` uses a connection pool internally (connections are released on every
query/tx) — appropriate for the 2,500-client target; raise `PGPOOL_MAX` if
needed. Multi-step writes use `db.tx()` (real `BEGIN/COMMIT/ROLLBACK` on PG,
`BEGIN/COMMIT` on SQLite).

### Migrations

Migrations are idempotent: `schema.sql` (full DDL, `IF NOT EXISTS`) plus a
**guarded ALTER block** in `scripts/init-db.js` that adds columns only when
missing (e.g. `progress_photos.storage_key`). Never hand-edit the production
DB — apply changes through `init-db.js` on a copy first, then to prod.

### Backups / recovery (Neon)

- Neon provides point-in-time recovery and automated backups — enable
  retention on the Neon console and verify a restore drill once.
- Every tenant's data is recoverable by restoring the DB to a point in time;
  uploaded images live outside the DB (local driver in dev, object storage in
  prod) and must be backed up alongside.

### Storage (production)

`STORAGE_DRIVER=local` (default) writes private files under `backend/data/
uploads/` served via the authenticated route — fine for staging. For prod set
`STORAGE_DRIVER=s3` and implement the S3-compatible driver in
`src/storage.js` (R2/S3/Supabase); the DB keeps storing `storage_key`
metadata either way, so nothing else changes. Private images are never
publicly served.

### Observability

`/ready` checks DB connectivity. All failures (auth, DB, AI, vision, uploads)
log with `[error]` tags; production responses return safe messages only.
Rate limiting protects login, org setup, and all AI/upload endpoints.

### Environment variables for production

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string — **runtime role `skos_app`** (`NOBYPASSRLS`); sets PG mode |
| `PG_ADMIN_URL` | Admin connection (`neondb_owner`) — used only by `npm run pg:validate` for schema/migrations/RLS |
| `JWT_SECRET` | **Required in production** — 16+ chars; startup fails without it |
| `CORS_ORIGINS` | Comma-separated frontend domain(s) — never `*` |
| `NODE_ENV` | `production` enables the secret gate + safe error messages |
| `STORAGE_DRIVER` | `local` (default) or `s3` (object storage) |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | Optional local AI provider |

## Known Limitations

- **Payments:** Package/subscription system tracks amounts but accepts no real payment processor. Manual/cash records only.
- **WhatsApp:** Messages channel column is ready for WhatsApp Business API integration but not wired.
- **Wearables:** Sleep data must be entered manually or via a future wearable integration.
- **Photos:** New uploads use the private-file storage abstraction (local driver; S3-compatible slot documented). Legacy base64 rows remain readable for back-compat.
- **PostgreSQL:** verified against a live Neon instance — `npm run pg:validate` passes **8/8** (schema, migrations, transactions, ON CONFLICT upserts, RLS tenant isolation, workout completion, calorie persistence). SQLite remains the default for local dev/tests.
- **RLS live behavior:** verified — org isolation is enforced when the app connects as the `NOBYPASSRLS` runtime role (`skos_app`). Neon's default owner (`neondb_owner`) has `BYPASSRLS` and must never be used as the runtime connection.
- **Real LLM / OCR / coaching:** All intelligence is deterministic by default. `AI_PROVIDER=ollama` (default) uses a local model when available; `openai|gemini` use hosted APIs (`LLM_API_KEY`). Without any provider, OCR label values are entered + confirmed by the user (LABEL_SCANNED), meal photos return "no vision provider" with an empty range, and SK Coach stays deterministic. **Meal-photo calories are always ESTIMATED ranges; the AI never calculates nutrition itself.**
- **Ollama is optional for development.** If it isn't running, the app is fully functional: `GET /api/intel/coach/status` reports `available: false` and every coach surface uses the deterministic engine.
- **Vision** needs a provider with vision support (Ollama multimodal models like `llava`, or a hosted vision API) — the provider abstraction makes this a config choice, not a rewrite.
- **Super Admin:** `SUPER_ADMIN` role exists for platform-level access but has no dedicated UI.