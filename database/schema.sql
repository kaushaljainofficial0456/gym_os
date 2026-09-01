-- ============================================================
-- PHYSIQUE OS — relational schema
-- Portable across PostgreSQL (production) and SQLite (dev):
--   * TEXT primary keys generated in application code (nanoid)
--   * TEXT ISO-8601 UTC timestamps (msec precision)
--   * INTEGER / REAL numerics
-- No PG-only or SQLite-only syntax is used.
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL DEFAULT 'gym',            -- gym | independent
  currency    TEXT NOT NULL DEFAULT 'INR',
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','GYM_OWNER','TRAINER','CLIENT')),
  name          TEXT NOT NULL,
  phone         TEXT,
  avatar        TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  terms_accepted_at TEXT,
  terms_version     TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trainers (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  specialization  TEXT,
  bio             TEXT,
  max_clients     INTEGER NOT NULL DEFAULT 50
);

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,
  user_id         TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trainer_id      TEXT REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'ON_TRACK' CHECK (status IN ('ON_TRACK','NEEDS_ATTENTION','AT_RISK','INACTIVE')),
  goal            TEXT NOT NULL DEFAULT 'FAT_LOSS' CHECK (goal IN ('FAT_LOSS','MUSCLE_GAIN','RECOMP','STRENGTH','GENERAL')),
  start_weight    REAL,
  current_weight  REAL,
  target_weight   REAL,
  goal_date       TEXT,
  height_cm       REAL,
  age             INTEGER,
  sex             TEXT,
  last_checkin_at TEXT,
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id);
CREATE INDEX IF NOT EXISTS idx_clients_trainer ON clients(trainer_id);

CREATE TABLE IF NOT EXISTS client_profiles (
  client_id        TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  medical_notes    TEXT,
  injuries         TEXT,
  movements_to_avoid TEXT,
  food_exclusions  TEXT,          -- e.g. "paneer, eggs"
  cuisine          TEXT,
  diet_type        TEXT,          -- VEG | NON_VEG | VEGAN | EGGETARIAN
  meals_per_day    INTEGER DEFAULT 5,
  sleep_target_h   REAL DEFAULT 8,
  water_target_l   REAL DEFAULT 3,
  equipment        TEXT,          -- JSON array: ["dumbbells","bench","bands"] (full_gym = everything)
  experience       TEXT,          -- BEGINNER | INTERMEDIATE | ADVANCED
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  goal_type    TEXT NOT NULL,
  start_weight REAL,
  target_weight REAL,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weight_logs (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  weight    REAL NOT NULL,
  source    TEXT NOT NULL DEFAULT 'manual',   -- manual | scale | estimate
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weight_client_date ON weight_logs(client_id, date);

CREATE TABLE IF NOT EXISTS measurements (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  taken_at  TEXT NOT NULL,
  weight    REAL,
  waist     REAL,
  chest     REAL,
  arms      REAL,
  thighs    REAL,
  hips      REAL,
  neck      REAL
);
CREATE INDEX IF NOT EXISTS idx_meas_client ON measurements(client_id, taken_at);

CREATE TABLE IF NOT EXISTS progress_photos (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  view       TEXT NOT NULL CHECK (view IN ('front','side','back')),
  taken_at   TEXT NOT NULL,
  data_url   TEXT,                -- legacy rows only (pre-storage-abstraction); NULL for new uploads
  storage_key TEXT,               -- object-storage key (e.g. photos/<client_id>/<id>.jpg) for new uploads
  storage    TEXT NOT NULL DEFAULT 'data_url',  -- data_url (legacy) | local | s3
  is_before  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_photos_client ON progress_photos(client_id, view, taken_at);

CREATE TABLE IF NOT EXISTS exercise_library (
  id               TEXT PRIMARY KEY,
  org_id           TEXT REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL => global library
  name             TEXT NOT NULL,
  primary_muscle   TEXT NOT NULL,
  secondary_muscles TEXT,
  equipment        TEXT NOT NULL,
  movement         TEXT NOT NULL DEFAULT 'compound',  -- horizontal_push | vertical_push | horizontal_pull | vertical_pull | squat | hinge | lunge | core | carry | isolation
  ex_type          TEXT NOT NULL DEFAULT 'compound',  -- compound | isolation | machine | free_weight | bodyweight | cable | cardio | mobility
  difficulty       TEXT NOT NULL DEFAULT 'BEGINNER',
  instructions     TEXT,
  cues             TEXT,
  mistakes         TEXT,
  alternatives     TEXT,
  animation_key    TEXT,
  is_global        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exlib_org ON exercise_library(org_id);
CREATE INDEX IF NOT EXISTS idx_exlib_name ON exercise_library(name);

-- Alias lookup for exercise search ("flat bench" → Bench Press).
CREATE TABLE IF NOT EXISTS exercise_aliases (
  id      TEXT PRIMARY KEY,
  org_id  TEXT REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL => global alias
  exercise_id TEXT NOT NULL REFERENCES exercise_library(id) ON DELETE CASCADE,
  alias   TEXT NOT NULL,
  UNIQUE (org_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_exercise_aliases ON exercise_aliases(alias);

CREATE TABLE IF NOT EXISTS workout_templates (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trainer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT,               -- push | pull | legs | full_body | cardio | custom
  notes      TEXT,
  is_global  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_programs (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id     TEXT REFERENCES users(id),
  name           TEXT NOT NULL,
  split          TEXT NOT NULL DEFAULT 'CUSTOM',  -- PPL | UPPER_LOWER | FULL_BODY | CUSTOM
  goal           TEXT,
  experience     TEXT,
  equipment      TEXT,
  days_per_week  INTEGER NOT NULL DEFAULT 3,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_program_client ON training_programs(client_id, active);

CREATE TABLE IF NOT EXISTS training_days (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
  day_of_week   INTEGER NOT NULL,        -- 0=Sun..6=Sat
  name          TEXT NOT NULL,           -- "Push Day"
  focus_muscles TEXT,                    -- "CHEST, SHOULDERS, TRICEPS"
  template_id   TEXT REFERENCES workout_templates(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tday_program ON training_days(program_id, day_of_week);

CREATE TABLE IF NOT EXISTS workouts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id   TEXT REFERENCES workout_templates(id) ON DELETE SET NULL,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id    TEXT REFERENCES users(id),
  name          TEXT NOT NULL,
  day_label     TEXT,            -- "Monday" | "Push A" | ...
  scheduled_date TEXT,
  status        TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed','missed','draft')),
  started_at    TEXT,             -- UTC ISO-8601: session start. Backend is the source of truth (set via POST /workouts/:id/start or lazily at completion).
  progress_json TEXT,          -- in-flight per-set ticks, so a refresh mid-session does not lose them
  completed_at  TEXT,
  duration_min  REAL,             -- backend-computed actual duration: completed_at - started_at (minutes). Never computed authoritatively by the frontend.
  -- Calorie estimate — produced ONLY by services/intelligence/calorieModel.js and persisted here.
  estimated_active_kcal REAL,     -- active calories burned this session (range midpoint)
  lower_kcal            REAL,     -- low end of the estimate range
  upper_kcal            REAL,     -- high end of the estimate range
  model_version         TEXT,     -- calorie model version (e.g. 'skos-cal-baseline-v1')
  schema_version        TEXT,     -- calorie input contract version (e.g. '0.1')
  calorie_provider      TEXT,     -- baseline | mock | ml — which provider produced the estimate (never exposed to the frontend)
  calorie_estimated_at  TEXT,     -- UTC ISO-8601 when the estimate was computed
  source        TEXT NOT NULL DEFAULT 'program',  -- program | trainer | gym_template | client_custom | ai
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workouts_client ON workouts(client_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_workouts_status ON workouts(client_id, status);
-- Community leaderboards filter completed workouts by client over a date
-- range (streaks look back 365 days, completed-workout boards use the
-- selected period). Neither idx_workouts_client (client_id, scheduled_date)
-- nor idx_workouts_status (client_id, status) covers all three columns.
CREATE INDEX IF NOT EXISTS idx_workouts_client_status_date ON workouts(client_id, status, scheduled_date);

CREATE TABLE IF NOT EXISTS workout_exercises (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT REFERENCES workouts(id) ON DELETE CASCADE,      -- assigned workout
  template_id TEXT REFERENCES workout_templates(id) ON DELETE CASCADE, -- or template
  exercise_id TEXT REFERENCES exercise_library(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,                 -- denormalized snapshot
  sets        INTEGER NOT NULL DEFAULT 3,
  reps        TEXT NOT NULL DEFAULT '10',    -- "8" or "8-12" or "45 sec"
  weight      TEXT NOT NULL DEFAULT 'BW',
  rest_sec    INTEGER NOT NULL DEFAULT 90,
  tempo       TEXT,
  notes       TEXT,
  done        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wx_workout ON workout_exercises(workout_id);
CREATE INDEX IF NOT EXISTS idx_wx_template ON workout_exercises(template_id);

CREATE TABLE IF NOT EXISTS workout_logs (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  workout_id   TEXT REFERENCES workouts(id) ON DELETE SET NULL,
  exercise_id  TEXT REFERENCES exercise_library(id) ON DELETE SET NULL,
  date         TEXT NOT NULL,
  sets_done    INTEGER,
  reps         REAL,
  weight       REAL,
  rir          INTEGER,
  notes        TEXT,
  is_pr        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT            -- deterministic ordering tiebreak (insertion order on PG)
);
CREATE INDEX IF NOT EXISTS idx_wlogs_client ON workout_logs(client_id, date);
CREATE INDEX IF NOT EXISTS idx_wlogs_ex ON workout_logs(client_id, exercise_id, date);

-- Per-set detail rows. workout_logs keeps the session-level summary for
-- backward compatibility; set rows hold the real performance data.
CREATE TABLE IF NOT EXISTS exercise_set_logs (
  id               TEXT PRIMARY KEY,
  workout_log_id   TEXT NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  exercise_id      TEXT REFERENCES exercise_library(id) ON DELETE SET NULL,
  set_number       INTEGER NOT NULL,
  prescribed_reps  REAL,
  actual_reps      REAL,
  prescribed_weight REAL,
  actual_weight    REAL,
  rest_seconds     INTEGER,
  rir              INTEGER,
  completed        INTEGER NOT NULL DEFAULT 1,
  is_synthesized   INTEGER NOT NULL DEFAULT 0   -- 1 => derived from a legacy aggregate log, NOT user-entered per-set data. ML training must filter these.
);
CREATE INDEX IF NOT EXISTS idx_setlogs_log ON exercise_set_logs(workout_log_id);
CREATE INDEX IF NOT EXISTS idx_setlogs_client ON exercise_set_logs(client_id, exercise_id, workout_log_id);

-- Personal records: heaviest weight / best reps at weight / est 1RM / best volume.
CREATE TABLE IF NOT EXISTS personal_records (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercise_library(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- heaviest_weight | best_reps | est_1rm | best_volume
  value       REAL NOT NULL,
  weight      REAL,
  reps        REAL,
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (client_id, exercise_id, type)
);
CREATE INDEX IF NOT EXISTS idx_pr_client ON personal_records(client_id, exercise_id);

-- Normalized muscle model (strings on exercise_library remain for compat;
-- exercise_muscles is the authoritative relationship for targeting/volume).
CREATE TABLE IF NOT EXISTS muscles (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,      -- canonical display name, e.g. "CHEST"
  region   TEXT,                      -- chest | back | shoulders | arms | legs | core
  view     TEXT NOT NULL DEFAULT 'front',  -- front | back
  target_sets_min INTEGER,
  target_sets_max INTEGER            -- weekly training-guidance range (sets)
);
CREATE TABLE IF NOT EXISTS exercise_muscles (
  exercise_id TEXT NOT NULL REFERENCES exercise_library(id) ON DELETE CASCADE,
  muscle_id   TEXT NOT NULL REFERENCES muscles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('PRIMARY','SECONDARY')),
  PRIMARY KEY (exercise_id, muscle_id, role)
);
CREATE INDEX IF NOT EXISTS idx_exmuscle ON exercise_muscles(muscle_id);

CREATE TABLE IF NOT EXISTS nutrition_plans (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trainer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT REFERENCES clients(id) ON DELETE CASCADE,  -- NULL => template
  name       TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein    REAL NOT NULL,
  carbs      REAL NOT NULL,
  fat        REAL NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meals (
  id       TEXT PRIMARY KEY,
  plan_id  TEXT NOT NULL REFERENCES nutrition_plans(id) ON DELETE CASCADE,
  slot     TEXT NOT NULL,         -- breakfast | lunch | pre_workout | post_workout | dinner | before_bed
  name     TEXT NOT NULL,
  time     TEXT,
  calories REAL NOT NULL,
  protein  REAL NOT NULL,
  carbs    REAL NOT NULL,
  fat      REAL NOT NULL,
  foods    TEXT,                  -- human-readable food list
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meals_plan ON meals(plan_id);

CREATE TABLE IF NOT EXISTS foods (
  id       TEXT PRIMARY KEY,
  org_id   TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE, -- set => "MY FOODS" (client-owned)
  name     TEXT NOT NULL,
  unit     TEXT,
  serving  TEXT,          -- base serving, e.g. "100 g", "200 ml", "1 pc", "1 scoop"
  piece_g  REAL,          -- food-specific grams per piece/scoop/slice (egg ≈ 52, roti ≈ 35, scoop ≈ 33)
  calories REAL, protein REAL, carbs REAL, fat REAL,
  fiber    REAL,          -- per serving (label scans)
  sugar    REAL,          -- per serving (label scans)
  sodium   REAL,          -- per serving (label scans)
  brand    TEXT,          -- packaged food brand (label scans)
  source   TEXT NOT NULL DEFAULT 'USER_ENTERED', -- VERIFIED_DATABASE | USER_ENTERED | PACKAGING_LABEL | OCR_EXTRACTED | ESTIMATED
  category TEXT,
  cuisine  TEXT DEFAULT 'INDIAN',
  is_global INTEGER NOT NULL DEFAULT 0, -- 1 => GLOBAL library; org_id+!global => GYM FOODS
  -- Barcode scan cache (org_id/client_id NULL, is_global=1): one row per
  -- physical product, shared by every client who scans it, populated from
  -- either a live external lookup or a manual "add product" save. See
  -- backend/src/services/barcodeLookup.js.
  barcode  TEXT,
  ingredients_text TEXT,
  image_url TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_foods_scope ON foods(org_id, client_id, is_global);
 CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);
 CREATE INDEX IF NOT EXISTS idx_foods_source ON foods(source);

-- Alias lookup for food search ("cottage cheese" → Paneer). Aliases are global unless org-scoped.
CREATE TABLE IF NOT EXISTS food_aliases (
  id      TEXT PRIMARY KEY,
  org_id  TEXT REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL => global alias
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  alias   TEXT NOT NULL,
  UNIQUE (org_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_food_aliases ON food_aliases(alias);

-- Every intelligent action is traceable (input → resolution → calculation → result).


CREATE TABLE IF NOT EXISTS intelligence_events (
  id        TEXT PRIMARY KEY,
  org_id    TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  domain    TEXT NOT NULL,            -- nutrition | workout | exercise | program | label
  input     TEXT,                     -- raw user input
  resolution TEXT,                    -- JSON: resolved entities + provenance + confidence
  result    TEXT,                     -- JSON: structured result
  source    TEXT NOT NULL DEFAULT 'parser', -- parser | search | generator | ocr | manual
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intel_events ON intelligence_events(client_id, created_at);

-- Gym-level configuration (branding, crowd capacity, default permission policy)
CREATE TABLE IF NOT EXISTS gym_settings (
  org_id       TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  brand_name   TEXT NOT NULL DEFAULT 'SK OS',
  tagline      TEXT DEFAULT 'Your fitness OS.',
  crowd_capacity INTEGER NOT NULL DEFAULT 150,
  crowd_enabled  INTEGER NOT NULL DEFAULT 1,
  workout_mode_default TEXT NOT NULL DEFAULT 'hybrid' CHECK (workout_mode_default IN ('prescribed','custom','hybrid')),
  allow_substitute  INTEGER NOT NULL DEFAULT 1,
  allow_add_exercise INTEGER NOT NULL DEFAULT 1,
  allow_edit_targets INTEGER NOT NULL DEFAULT 1,
  community_enabled INTEGER NOT NULL DEFAULT 1,
  community_leaderboard_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT
);

-- Client-customizable dashboard preferences (which cards show, in what order)
CREATE TABLE IF NOT EXISTS dashboard_preferences (
  client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  order_list TEXT NOT NULL DEFAULT '[]',   -- JSON array of card keys
  hidden     TEXT NOT NULL DEFAULT '[]',   -- JSON array of hidden card keys
  updated_at TEXT
);

-- Client-created personal metrics (waist, steps, bench press, ...)
CREATE TABLE IF NOT EXISTS custom_metrics (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  unit      TEXT,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  target    REAL,
  type      TEXT NOT NULL DEFAULT 'number',  -- number | count | duration | boolean
  color     TEXT DEFAULT '#FF6A3D',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_metrics_client ON custom_metrics(client_id);

CREATE TABLE IF NOT EXISTS metric_entries (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric_id TEXT NOT NULL REFERENCES custom_metrics(id) ON DELETE CASCADE,
  value     REAL NOT NULL,
  date      TEXT NOT NULL,
  notes     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_entries ON metric_entries(metric_id, date);

-- Client-owned meal templates (their own structure: any slots/times they want)
CREATE TABLE IF NOT EXISTS client_meal_templates (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  slot      TEXT NOT NULL DEFAULT 'Meal',
  name      TEXT NOT NULL,
  time      TEXT,
  calories  REAL NOT NULL DEFAULT 0,
  protein   REAL NOT NULL DEFAULT 0,
  carbs     REAL NOT NULL DEFAULT 0,
  fat       REAL NOT NULL DEFAULT 0,
  foods     TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_client_meals ON client_meal_templates(client_id);

-- Client's own reusable workout library + weekly schedule (the personal planner)
CREATE TABLE IF NOT EXISTS client_workouts (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_workouts ON client_workouts(client_id);

CREATE TABLE IF NOT EXISTS client_workout_exercises (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT NOT NULL REFERENCES client_workouts(id) ON DELETE CASCADE,
  exercise_id TEXT REFERENCES exercise_library(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  sets        INTEGER NOT NULL DEFAULT 3,
  reps        TEXT NOT NULL DEFAULT '10',
  weight      TEXT NOT NULL DEFAULT 'BW',
  rest_sec    INTEGER NOT NULL DEFAULT 90,
  tempo       TEXT,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cwe_workout ON client_workout_exercises(workout_id);

CREATE TABLE IF NOT EXISTS client_workout_schedule (
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,   -- 0=Monday .. 6=Sunday
  workout_id  TEXT NOT NULL REFERENCES client_workouts(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, day_of_week)
);

-- Meal composition: a client meal template is built from foods (meal → items → food)
CREATE TABLE IF NOT EXISTS meal_items (
  id               TEXT PRIMARY KEY,
  meal_template_id TEXT NOT NULL REFERENCES client_meal_templates(id) ON DELETE CASCADE,
  food_id          TEXT REFERENCES foods(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  quantity         REAL NOT NULL DEFAULT 1,   -- servings (scales per-food macros)
  unit             TEXT,
  calories         REAL NOT NULL DEFAULT 0,
  protein          REAL NOT NULL DEFAULT 0,
  carbs            REAL NOT NULL DEFAULT 0,
  fat              REAL NOT NULL DEFAULT 0,
  position         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meal_items ON meal_items(meal_template_id);
CREATE INDEX IF NOT EXISTS idx_meal_items_food ON meal_items(food_id);

-- Attendance events from the gym's access-control system (entry/exit), never biometrics
CREATE TABLE IF NOT EXISTS attendance_events (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry','exit'))
);
CREATE INDEX IF NOT EXISTS idx_att_events_org ON attendance_events(org_id, ts);
CREATE INDEX IF NOT EXISTS idx_att_events_client ON attendance_events(client_id, ts);

CREATE TABLE IF NOT EXISTS meal_logs (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  meal_id   TEXT REFERENCES meals(id) ON DELETE SET NULL,
  date      TEXT NOT NULL,
  slot      TEXT,
  name      TEXT NOT NULL,
  calories  REAL NOT NULL,
  protein   REAL NOT NULL,
  carbs     REAL NOT NULL,
  fat       REAL NOT NULL,
  eaten     INTEGER NOT NULL DEFAULT 0,
  source    TEXT NOT NULL DEFAULT 'plan',   -- plan | ai | manual
  estimate  INTEGER NOT NULL DEFAULT 0,     -- 1 => AI-estimated nutrition
  quantity  REAL,                           -- original parsed quantity (for provenance)
  unit      TEXT,                           -- original parsed unit, e.g. 'g' | 'rotis' | 'ml'
  unit_type TEXT,                           -- original parsed unitType, e.g. 'gram' | 'piece' | 'ml'
  meal_template_id TEXT                      -- FK to client_meal_templates (used for delete-cascade of today's log)
);
CREATE INDEX IF NOT EXISTS idx_meal_logs_client ON meal_logs(client_id, date);
-- idx_ml_template intentionally NOT created here: meal_template_id is also a
-- guarded migration column (see init-db.js MIGRATIONS) added via ALTER TABLE
-- on databases that predate it. CREATE TABLE IF NOT EXISTS is a no-op on an
-- existing table, so this index would fail with "column does not exist" on
-- any such database if created here, before the migration runs. It's created
-- instead in applySqliteMigrations/applyPgMigrations, after the column is
-- guaranteed to exist either way.
CREATE INDEX IF NOT EXISTS idx_ml_eaten ON meal_logs(client_id, date, eaten);

CREATE TABLE IF NOT EXISTS water_logs (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  litres    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_water_client ON water_logs(client_id, date);

CREATE TABLE IF NOT EXISTS sleep_logs (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  bed_time   TEXT,
  wake_time  TEXT,
  duration_h REAL NOT NULL,
  target_h   REAL NOT NULL DEFAULT 8,
  source     TEXT NOT NULL DEFAULT 'manual'   -- manual | wearable
);
CREATE INDEX IF NOT EXISTS idx_sleep_client ON sleep_logs(client_id, date);

CREATE TABLE IF NOT EXISTS supplements (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  dose      TEXT,
  schedule_time TEXT,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS adherence_records (
  id        TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  score     REAL NOT NULL,
  workout   REAL, nutrition REAL, protein REAL, water REAL, sleep REAL, checkin REAL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_adherence_client ON adherence_records(client_id, date);

CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,     -- NO_WORKOUT | PLATEAU | LOW_PROTEIN | LOW_NUTRITION | MISSED_CHECKIN | POOR_SLEEP | LOW_ADHERENCE
  severity    TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high
  title       TEXT NOT NULL,
  detail      TEXT,
  data_json   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',     -- open | read | dismissed | followed_up
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id, status);
-- Every alerts query that isn't the org-wide list (trainer.js's client
-- dashboard, dashboard.js's per-trainer view, atRisk.js's evaluateOrg)
-- filters by client_id + status, which idx_alerts_org above doesn't cover
-- at all -- found auditing atRisk.js's N+1 fix, where the batched
-- client_id IN (...) AND status = 'open' query has no index to use.
CREATE INDEX IF NOT EXISTS idx_alerts_client ON alerts(client_id, status);

CREATE TABLE IF NOT EXISTS coach_insights (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  trainer_id    TEXT REFERENCES users(id),
  type          TEXT NOT NULL,    -- plateau | nutrition | adherence | sleep | overload | weekly
  summary       TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  data_json     TEXT,             -- measured/calculated/estimated data the insight used
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | modified | dismissed
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insights_client ON coach_insights(client_id, status);

CREATE TABLE IF NOT EXISTS packages (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  period_days INTEGER NOT NULL DEFAULT 30,
  features    TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id     TEXT REFERENCES packages(id),
  plan_name      TEXT NOT NULL,
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  renewal_date   TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','overdue','expired','cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid','pending','overdue','failed'))
);
CREATE INDEX IF NOT EXISTS idx_subs_org ON subscriptions(org_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount          REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  method          TEXT,
  status          TEXT NOT NULL DEFAULT 'paid',
  paid_at         TEXT,
  external_ref    TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id, paid_at);

CREATE TABLE IF NOT EXISTS attendance (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  present   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_att_org ON attendance(org_id, date);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_user TEXT NOT NULL REFERENCES users(id),
  to_user   TEXT REFERENCES users(id),
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  type      TEXT NOT NULL DEFAULT 'message' CHECK (type IN ('message','workout_update','nutrition_update','checkin_reminder')),
  body      TEXT NOT NULL,
  channel   TEXT NOT NULL DEFAULT 'inapp',   -- inapp | whatsapp_pending (WhatsApp Business API = future integration)
  read      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT,
  read      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- idx_notif_user intentionally NOT created here: same reason as idx_ml_template
-- above -- the read column is also a guarded migration column (init-db.js
-- MIGRATIONS), so this index is created in applySqliteMigrations/
-- applyPgMigrations instead, after the column is guaranteed to exist on
-- databases that predate it.

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  org_id    TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id   TEXT REFERENCES users(id),
  type      TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, created_at);

-- AI coach: structured long-term preferences scoped per org + client.
-- NEVER store raw conversation content — only structured keys.
CREATE TABLE IF NOT EXISTS ai_memory (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,              -- e.g. equipment_pref | disliked_exercises | liked_foods | workout_duration | training_time
  value      TEXT NOT NULL,              -- JSON value
  source     TEXT NOT NULL DEFAULT 'ai', -- ai | manual | feedback
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, client_id, key)
);
CREATE INDEX IF NOT EXISTS idx_ai_memory_client ON ai_memory(client_id);

-- Recommendation feedback ("Helpful" / "Not helpful" / "Don't recommend this")
CREATE TABLE IF NOT EXISTS ai_feedback (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  feedback    TEXT NOT NULL,             -- helpful | not_helpful | dont_recommend | not_relevant | already_done
  target_type TEXT,                      -- brief | weekly | chat | recommendation
  target_id   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_client ON ai_feedback(client_id, created_at);

-- Food-AI Tier 4 GLOBAL cache -- one row per canonical dish CONCEPT
-- ("chicken chettinad biryani"), never per user and never per raw query
-- string. NOT org/client-scoped on purpose: a reusable dish estimate is
-- product knowledge, not any one gym's or client's data (contrast with
-- the "foods" table, which IS scoped, for client-owned/gym-owned entries). Rows for
-- personal-possessive queries ("my mom's curry") are never written here --
-- see isPersonalQuery() in backend/src/services/intelligence/foodAICache.js.
CREATE TABLE IF NOT EXISTS ai_food_estimates (
  id                      TEXT PRIMARY KEY,
  canonical_key           TEXT NOT NULL UNIQUE,  -- sorted, noise-stripped word set; see foodAICache.js
  canonical_name          TEXT NOT NULL,          -- display name, title-cased from the first query that created this row
  cuisine                 TEXT,
  component_template_json TEXT NOT NULL DEFAULT '[]', -- AI-proposed {name, estimated_weight_g, ...}[]
  nutrition_json          TEXT NOT NULL DEFAULT '{}', -- deterministic totals computed from component_template + measured DB
  uncertainty_json        TEXT NOT NULL DEFAULT '{}', -- {calories_low, calories_high, ...} -- always present, see foodAI.js
  assumptions_json        TEXT NOT NULL DEFAULT '[]', -- human-readable assumption strings shown to the user
  source                  TEXT NOT NULL DEFAULT 'ai_estimated', -- ai_estimated | ai_estimated_user_adjusted
  ai_provider             TEXT,                    -- which provider produced this (ollama | groq | openai | gemini)
  ai_model                TEXT,
  confidence              TEXT NOT NULL DEFAULT 'low', -- high | medium | low | unreliable -- backend-derived, never AI-chosen; see foodAI.js
  times_used              INTEGER NOT NULL DEFAULT 0,
  user_confirmation_count INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_food_estimates_key ON ai_food_estimates(canonical_key);

-- Share Meals: a point-in-time SNAPSHOT of one or more saved foods/meals
-- packaged into one shareable link. Deliberately NOT a live reference to
-- client_meal_templates/foods -- the sender editing or deleting the
-- original afterward must never change what a recipient previews or
-- saves, and the recipient must see exactly what they'll get before
-- saving (never a stale join at view time). id doubles as the token in
-- the public /share/:id URL -- same high-entropy id() generator every
-- other table's PK uses, no separate token column needed.
CREATE TABLE IF NOT EXISTS shared_meals (
  id             TEXT PRIMARY KEY,
  org_id         TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  client_id      TEXT REFERENCES clients(id) ON DELETE SET NULL, -- sender; kept NULL-able so a deleted account doesn't break outstanding links
  shared_by_name TEXT,                     -- denormalized sender display name at share time
  items_json     TEXT NOT NULL,            -- JSON array: [{type:'food'|'meal', name, quantity, unit, calories, protein, carbs, fat, components:[{name,quantity,unit,calories,protein,carbs,fat}]|null}]
  created_at     TEXT NOT NULL
);

-- Community feedback on a shared AI food estimate (ai_food_estimates).
-- ONE row per correction event, never an in-place overwrite of the
-- estimate itself -- a single user's edit must never silently become the
-- new global value (see foodFeedback.js). Values are normalized to
-- per-100g at write time so corrections logged at different quantities
-- (100g vs 300g of the same dish) are actually comparable before they're
-- ever aggregated together.
CREATE TABLE IF NOT EXISTS ai_food_feedback (
  id                  TEXT PRIMARY KEY,
  canonical_key       TEXT NOT NULL REFERENCES ai_food_estimates(canonical_key) ON DELETE CASCADE,
  original_calories   REAL, original_protein REAL, original_carbs REAL, original_fat REAL,   -- per 100g, what the AI said at feedback time
  adjusted_calories   REAL, adjusted_protein REAL, adjusted_carbs REAL, adjusted_fat REAL,    -- per 100g, what the user corrected it to
  quantity_g          REAL,                 -- the actual logged amount this feedback came from (context/audit only)
  ai_provider         TEXT,
  ai_model            TEXT,
  -- Kept for anti-abuse (rate-limiting one account flooding feedback for
  -- one dish) -- NEVER joined/exposed when reading feedback for another
  -- user; aggregation reads only the numeric columns above.
  client_id           TEXT REFERENCES clients(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_food_feedback_key ON ai_food_feedback(canonical_key);

-- Durable, cross-instance backing store for foodAI.js's cost-safety
-- mechanisms (rate-limit cooldown + optional daily call budget per
-- provider). These were originally in-process memory only -- correct for
-- a single persistent Node process, but this app runs on Vercel
-- serverless, where every cold start gets fresh memory and concurrent
-- requests can land on entirely separate instances with nothing shared.
-- Without a real backing store, "back off after a 429" and "stop at N
-- calls/day" were unreliable exactly when they mattered most (sustained
-- load). One row per provider name (groq/gemini/openrouter/...).
CREATE TABLE IF NOT EXISTS ai_provider_cost_state (
  provider          TEXT PRIMARY KEY,
  cooldown_until    TEXT,              -- ISO timestamp; NULL or in the past = not on cooldown
  daily_count       INTEGER NOT NULL DEFAULT 0,
  daily_count_date  TEXT,              -- UTC date key (YYYY-MM-DD) daily_count applies to; a new day resets it
  updated_at        TEXT NOT NULL
);

-- ============================================================
-- GYM COMMUNITY — opt-in participation, leaderboards, workout sharing
-- ============================================================

-- Per-client opt-in to gym community (privacy-first: default OFF)
CREATE TABLE IF NOT EXISTS community_members (
  client_id   TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_members_org ON community_members(org_id, enabled);

-- Workout shares visible within a gym's community feed
CREATE TABLE IF NOT EXISTS community_workout_shares (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  workout_id   TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  workout_name TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cws_org_feed ON community_workout_shares(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cws_client ON community_workout_shares(client_id);

-- ============================================================
-- SK OS ENTERPRISE — gym-owner SaaS billing, QR enrollment, payments
-- ============================================================
-- NAMING, so this never collides with the EXISTING client-facing
-- billing system (packages/subscriptions/payments above, which is the
-- GYM billing its OWN members and is reused as-is for that purpose --
-- see membership_plans note below):
--   sk_*      = SK OS's OWN product catalog (what SK OS sells to a gym)
--   org_*     = one organization's purchase/state against that catalog
--   payment_* = the generic, gateway-agnostic payment engine, shared by
--               BOTH gym-package purchases (org billing) and client
--               membership purchases (member billing) via subject_type
--
-- The existing packages table (org_id, name, amount, currency,
-- period_days) is REUSED AS-IS as "membership_plans" -- it already IS a
-- gym's own client-membership-plan catalog; no new table for that.
-- The existing subscriptions table (org_id, client_id, package_id,
-- ...) is REUSED AS-IS as "client_memberships" for the same reason.
-- Neither is touched by anything below.
-- ============================================================

-- SK OS's own package tiers (75/100/200 clients, etc.) -- admin-
-- configurable, versioned. A gym's org_subscription always references
-- the EXACT version it purchased (see org_subscriptions.package_id),
-- so an admin changing "current" pricing never retroactively rewrites
-- what an existing gym already agreed to pay -- new purchases pick up
-- whichever row currently has effective_until IS NULL for that name.
CREATE TABLE IF NOT EXISTS sk_packages (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,               -- "75 Clients", "100 Clients", "200 Clients"
  client_capacity INTEGER NOT NULL,
  price           REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  duration_days   INTEGER NOT NULL DEFAULT 365,
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from  TEXT NOT NULL,
  effective_until TEXT,                        -- NULL = this is the current version of name
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sk_packages_current ON sk_packages(name, effective_until);

-- Additional-client-above-base-tier pricing, ALSO versioned the same
-- way, and ALSO never retroactive (org_capacity_purchases locks in the
-- rate actually charged at purchase time, same pattern as above).
CREATE TABLE IF NOT EXISTS sk_pricing_rules (
  id                      TEXT PRIMARY KEY,
  base_package_id         TEXT NOT NULL REFERENCES sk_packages(id),
  additional_client_rate  REAL NOT NULL,       -- price per client above base_package's own capacity
  max_capacity            INTEGER NOT NULL,    -- this rule applies for custom capacity up to (and including) this ceiling
  version                 INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from          TEXT NOT NULL,
  effective_until         TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sk_pricing_rules_current ON sk_pricing_rules(base_package_id, effective_until);

-- Post-purchase "buy more capacity" add-on packs (+10/+25/+50 clients).
-- Deliberately separate from sk_packages: an add-on extends an EXISTING
-- org_subscription's capacity, it never stands alone as a base tier.
CREATE TABLE IF NOT EXISTS sk_capacity_addons (
  id            TEXT PRIMARY KEY,
  increment     INTEGER NOT NULL,
  price         REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from TEXT NOT NULL,
  effective_until TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sk_addons_current ON sk_capacity_addons(increment, effective_until);

-- One row per organization: SK OS's own subscription state for that
-- gym (SETUP -> PAYMENT_PENDING -> ACTIVE -> ...). Kept OFF the
-- organizations table itself (rather than adding a status column
-- there) because this is a 1:1 extension with its own lifecycle
-- timestamps and FKs -- see org_status view below for the single
-- column callers actually want most often.
CREATE TABLE IF NOT EXISTS org_billing_state (
  org_id     TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'SETUP' CHECK (status IN ('SETUP','PAYMENT_PENDING','ACTIVE','SUSPENDED','EXPIRED','CANCELLED')),
  -- Client-capacity slots claimed by an IN-FLIGHT client join (token
  -- consumed, payment_order created, outcome not yet known) -- see
  -- subscriptionLifecycle.js's reserveCapacitySlot/releaseCapacitySlot.
  -- Two joins racing for the same last slot must not both succeed;
  -- reserved_slots is the atomic guard that makes that a single
  -- conditional UPDATE instead of a check-then-act race. Released back
  -- to 0 the moment the order resolves either way (success: the slot
  -- becomes a real clients-table row instead; failure: the slot returns to
  -- the pool for a future join).
  reserved_slots INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- The gym's OWN purchased SaaS subscription(s) -- one row per purchase/
-- renewal/upgrade, so history is never overwritten. "Current" = the
-- most recent row for this org_id ordered by created_at desc.
CREATE TABLE IF NOT EXISTS org_subscriptions (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  package_id      TEXT NOT NULL REFERENCES sk_packages(id),   -- exact version purchased -- see sk_packages comment
  client_capacity INTEGER NOT NULL,     -- TOTAL purchased capacity (base + any custom/addon at purchase time)
  price           REAL NOT NULL,        -- what was actually agreed/paid -- locked, independent of later price changes
  currency        TEXT NOT NULL DEFAULT 'INR',
  status          TEXT NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED','SUPERSEDED')),
  start_date      TEXT,
  end_date        TEXT,
  payment_order_id TEXT,                -- FK to payment_orders once payment starts (nullable: set at order-creation time)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_subs_org ON org_subscriptions(org_id, created_at);

-- Capacity add-on purchases against an existing org_subscription.
-- TOTAL PURCHASED CAPACITY for an org at any moment = its current
-- org_subscription.client_capacity + SUM of org_capacity_purchases
-- rows against that subscription (see enrollment.js's capacity view).
CREATE TABLE IF NOT EXISTS org_capacity_purchases (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES org_subscriptions(id) ON DELETE CASCADE,
  addon_id        TEXT REFERENCES sk_capacity_addons(id),
  increment       INTEGER NOT NULL,
  price           REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  payment_order_id TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_capacity_purchases ON org_capacity_purchases(subscription_id);

-- Structured gym-onboarding-wizard answers (one row per org) -- explicit
-- typed columns, not a JSON blob, so future analytics can query them
-- directly ("how many gyms use RFID access control" etc.)
CREATE TABLE IF NOT EXISTS gym_onboarding (
  org_id                    TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  gym_type                  TEXT,     -- commercial | studio | crossfit | personal_training | sports_academy | other
  gym_type_other            TEXT,
  client_count_range        TEXT,     -- 0-25 | 26-50 | 51-75 | 76-100 | 101-200 | 201-500 | 500+
  trainer_count             INTEGER,
  branch_count              INTEGER,
  access_fingerprint        INTEGER NOT NULL DEFAULT 0,
  access_face                INTEGER NOT NULL DEFAULT 0,
  access_rfid                 INTEGER NOT NULL DEFAULT 0,
  access_qr                    INTEGER NOT NULL DEFAULT 0,
  access_manual                 INTEGER NOT NULL DEFAULT 0,
  access_none                    INTEGER NOT NULL DEFAULT 0,
  wants_access_integration        INTEGER NOT NULL DEFAULT 0,
  billing_cycle              TEXT,    -- monthly | quarterly | half_yearly | yearly | mixed
  offers_personal_training   INTEGER NOT NULL DEFAULT 0,
  offers_group_classes       INTEGER NOT NULL DEFAULT 0,
  offers_membership_plans    INTEGER NOT NULL DEFAULT 0,
  offers_nutrition_plans     INTEGER NOT NULL DEFAULT 0,
  offers_workout_plans       INTEGER NOT NULL DEFAULT 0,
  offers_other               TEXT,
  uses_other_software        INTEGER NOT NULL DEFAULT 0,
  other_software_name        TEXT,
  improvement_notes          TEXT,
  active_clients_estimate    INTEGER,
  avg_membership_price       REAL,
  expected_sk_os_users       INTEGER,
  preferred_contact_method   TEXT,
  completed_at               TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

-- Cryptographically-signed, single-use QR enrollment tokens -- for BOTH
-- client and trainer onboarding. The QR image itself encodes a signed,
-- short-lived token (see services/enrollmentToken.js); NOTHING sensitive
-- (gym id, role, price) is trusted from the QR at scan time -- every one
-- of those is re-resolved server-side from this row via token_hash.
-- The raw token is NEVER stored, only its sha256 hash, so a DB read
-- alone can never reconstruct a valid, still-usable QR.
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by          TEXT NOT NULL REFERENCES users(id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('CLIENT','TRAINER')),
  token_hash          TEXT NOT NULL UNIQUE,
  membership_plan_id  TEXT REFERENCES packages(id),   -- CLIENT purpose only; which membership offer this QR enrolls into
  status              TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','CONSUMED','EXPIRED','REVOKED')),
  expires_at          TEXT NOT NULL,
  consumed_by         TEXT REFERENCES users(id),
  consumed_at         TEXT,
  revoked_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_org ON enrollment_tokens(org_id, purpose, status);

-- Generic payment engine -- shared by gym-package purchases (SK OS
-- billing the org) and client-membership purchases (member billing the
-- gym) via subject_type/subject_id, so the SAME idempotent
-- order->transaction->webhook machinery backs both instead of two
-- parallel implementations. Amount/currency are ALWAYS resolved
-- server-side from the subject at order-creation time -- see
-- services/payments/paymentOrders.js -- never trusted from the client.
CREATE TABLE IF NOT EXISTS payment_orders (
  id             TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('ORG_PACKAGE','ORG_CAPACITY_ADDON','CLIENT_MEMBERSHIP')),
  subject_id     TEXT,               -- org_subscriptions.id | org_capacity_purchases.id (pre-row) | enrollment_tokens.id, depending on subject_type
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id      TEXT REFERENCES clients(id) ON DELETE SET NULL,   -- set only for CLIENT_MEMBERSHIP
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  provider       TEXT NOT NULL DEFAULT 'mock',    -- mock | razorpay
  provider_order_id TEXT,            -- the gateway's own order id, once created there
  status         TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','PROCESSING','SUCCESS','FAILED','CANCELLED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','DISPUTED')),
  idempotency_key TEXT UNIQUE,       -- caller-supplied, prevents double order-creation on a client retry
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_org ON payment_orders(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_subject ON payment_orders(subject_type, subject_id);

-- One verified (or failed/refunded) attempt against a payment_order.
-- An order can have more than one transaction row (a failed attempt
-- followed by a successful retry) -- the order's OWN status reflects
-- the latest authoritative outcome.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  provider_payment_id TEXT,          -- the gateway's own payment/transaction id
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  status            TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','PROCESSING','SUCCESS','FAILED','CANCELLED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED','DISPUTED')),
  failure_reason    TEXT,
  verified_at       TEXT,            -- set only once server-side signature/amount/currency verification passes
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_txns_order ON payment_transactions(order_id);

-- Raw webhook/callback event log -- idempotency + reconciliation source
-- of truth. provider_event_id is UNIQUE so the exact same webhook
-- delivered twice (every provider's own docs warn this happens) can
-- only ever be processed once; a duplicate delivery is detected here
-- and short-circuited BEFORE it can create a second transaction/
-- membership.
CREATE TABLE IF NOT EXISTS payment_events (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,    -- payment.created | payment.pending | payment.success | payment.failed | payment.refunded | payment.disputed
  order_id          TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
  payload_json      TEXT NOT NULL,    -- the verified webhook body, for reconciliation/audit -- never raw card/UPI data (the provider never sends that)
  processed_at      TEXT,             -- NULL until successfully handled; a crash mid-handling leaves this NULL so a retry is safe
  created_at        TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id);

-- Invoice/receipt metadata (the PDF itself is generated on demand from
-- these fields, never stored as a blob in the DB).
CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  order_id       TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_type   TEXT NOT NULL,
  amount         REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  tax_amount     REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','VOID')),
  issued_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- Set on a successful "Email Invoice" send (see emailProvider.js);
  -- NULL means never emailed, or every attempt so far failed. Informational
  -- only -- re-sending is always allowed, this just lets the UI show
  -- "Emailed Aug 28" instead of nothing.
  emailed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id, issued_at);

-- Gym owner's payout/settlement account state (e.g. Razorpay Route
-- linked account). Deliberately stores ONLY the provider's own account
-- reference + a status enum -- never raw bank/UPI credentials, which
-- stay entirely inside the payment provider's own hosted KYC/onboarding
-- flow per the provider's compliance requirements.
CREATE TABLE IF NOT EXISTS payment_accounts (
  org_id                TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'razorpay',
  provider_account_id   TEXT,          -- the gateway's own linked/connected account id, once created
  -- LIMITED = payout account active but constrained by the provider.
  -- Deliberately not the synonym this repo's schema.sql portability
  -- test (prodreadiness.test.js) greps for as a banned SQLite-only
  -- keyword substring -- see that test before reusing this word choice
  -- elsewhere in this file.
  status                TEXT NOT NULL DEFAULT 'NOT_CONNECTED' CHECK (status IN ('NOT_CONNECTED','KYC_PENDING','ACTIVE','LIMITED')),
  business_name         TEXT,
  legal_name            TEXT,
  updated_at            TEXT NOT NULL
);

-- Enterprise notifications (client_joined, payment_success,
-- membership_expiring, trainer_revoked, etc.) reuse the EXISTING
-- notifications table (messages.js/reports.js already write to it --
-- see line ~688 above) rather than a competing new one. It gained
-- data_json/channel via a guarded migration (init-db.js) for
-- structured payloads and future delivery channels; client_id/read
-- are its own pre-existing columns, untouched.

-- ============================================================
-- HARDENING PASS 2 -- billing quotes + membership lifecycle history.
-- (org_billing_state.reserved_slots, added the same pass as the
-- capacity-race fix, lives up near org_billing_state's own CREATE
-- TABLE above, not here.)
-- ============================================================

-- A SERVER-SIDE, PRICE-LOCKED quote created before every gym-level
-- payment (initial package purchase, upgrade/downgrade, capacity
-- add-on). The frontend never computes or sends a price -- it asks for
-- a quote, gets back a locked total + a short expiry, and that quote
-- id is the ONLY thing /payment/order accepts. This is what makes a
-- later admin price change never retroactively change a checkout that
-- was already in progress (see quotes.js's comment on why).
CREATE TABLE IF NOT EXISTS billing_quotes (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('ORG_PACKAGE','ORG_UPGRADE','ORG_CAPACITY_ADDON')),
  package_id     TEXT REFERENCES sk_packages(id),
  addon_id       TEXT REFERENCES sk_capacity_addons(id),
  capacity       INTEGER,           -- resolved target client_capacity (ORG_PACKAGE/ORG_UPGRADE) or increment (ORG_CAPACITY_ADDON)
  base_price     REAL NOT NULL DEFAULT 0,
  credit         REAL NOT NULL DEFAULT 0,   -- prorated credit applied (ORG_UPGRADE only, from the unused remainder of the current period)
  total          REAL NOT NULL,             -- what /payment/order will actually charge -- floored at 0, never negative
  currency       TEXT NOT NULL DEFAULT 'INR',
  breakdown_json TEXT,               -- full calculation detail for the receipt/UI (never re-derived from "today's" pricing later)
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED','CANCELLED')),
  created_by     TEXT REFERENCES users(id),
  expires_at     TEXT NOT NULL,      -- 10-minute validity by default -- see quotes.js
  created_at     TEXT NOT NULL,
  consumed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_quotes_org ON billing_quotes(org_id, status);

-- Immutable audit trail of every client-membership lifecycle
-- transition (see membershipLifecycle.js's transition graph). Additive
-- alongside the pre-existing subscriptions.status column, which stays
-- exactly as every other route already reads it -- see subscriptions'
-- own new lifecycle_status column (added via guarded migration, not
-- here, since subscriptions already has real rows) for how the two
-- relate.
CREATE TABLE IF NOT EXISTS membership_status_history (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status      TEXT NOT NULL,
  reason          TEXT,
  changed_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_membership_history_sub ON membership_status_history(subscription_id, created_at);

-- ============================================================
-- PHASE 1 PRODUCTION HARDENING -- refunds + reconciliation.
-- ============================================================

-- Refund engine. ONE row per refund ATTEMPT against a payment_order --
-- a single order can accumulate several PARTIAL refund rows over time;
-- the refundable remainder is always DERIVED (order.amount minus the
-- SUM of this table's own SUCCESS rows for that order, see refunds.js),
-- never stored as a separate counter that could drift out of sync.
-- payment_orders.amount itself is NEVER mutated by a refund.
CREATE TABLE IF NOT EXISTS refunds (
  id                  TEXT PRIMARY KEY,
  payment_order_id    TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           TEXT REFERENCES clients(id),
  type                TEXT NOT NULL CHECK (type IN ('FULL','PARTIAL')),
  amount              REAL NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','SUCCESS','FAILED','CANCELLED')),
  provider_refund_id  TEXT,
  reason              TEXT,
  failure_reason      TEXT,
  initiated_by        TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(payment_order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_org ON refunds(org_id, created_at);

-- Payment reconciliation. One row per DETECTED mismatch between SK OS's
-- own records and the payment provider's -- never a mechanism for
-- silently correcting either side (see reconciliation.js's own header
-- comment). A sweep that finds nothing wrong creates no rows at all.
CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id                TEXT PRIMARY KEY,
  payment_order_id  TEXT REFERENCES payment_orders(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_type        TEXT NOT NULL CHECK (issue_type IN ('STATUS_MISMATCH','AMOUNT_MISMATCH','CURRENCY_MISMATCH','MISSING_LOCALLY','STUCK_NON_TERMINAL','RECOVERED')),
  expected_json     TEXT,             -- SK OS's own recorded state at detection time
  actual_json       TEXT,             -- the provider's reported state at detection time
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  note              TEXT,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_org ON reconciliation_issues(org_id, status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_order ON reconciliation_issues(payment_order_id);

-- ============================================================
-- PHASE 2 PRODUCTION HARDENING -- multi-gym identity + branches.
--
-- users.org_id/trainers/clients are UNCHANGED and remain the PRIMARY
-- (single, default) org relationship every existing route already
-- reads -- see auth.js's own header comment on why rewriting that
-- everywhere at once would be a big-bang rewrite this pass explicitly
-- avoids. gym_memberships is ADDITIVE: a user can hold further
-- memberships at OTHER orgs (a trainer working two gyms, a manager
-- helping run a second location) without ever needing a second user
-- account -- see services/enterprise/gymMemberships.js.
-- ============================================================

-- A gym organization's physical locations. Single-branch orgs are
-- completely unaffected -- nothing existing reads or requires this
-- table; it exists so the architecture can grow into multi-branch
-- without a later redesign, per the hardening spec's own instruction
-- not to force this into the UI before it's needed.
CREATE TABLE IF NOT EXISTS branches (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  timezone      TEXT,
  settings_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_branches_org ON branches(org_id, status);

-- One row per (user, org) the user has ANY relationship with -- the
-- user's role AT THAT SPECIFIC GYM, which can differ from their
-- primary users.role (e.g. a TRAINER at their home gym who also holds
-- a MANAGER membership helping run a second location). Deliberately
-- NOT named anything with "membership" alone -- that word already
-- means a client's paid billing plan in this schema (packages/
-- subscriptions) -- "gym_memberships" is unambiguous alongside it.
-- MANAGER/STAFF are introduced HERE rather than widening users.role's
-- existing CHECK constraint: every prior hardening pass in this
-- codebase adds a NEW column/table for a NEW enum rather than
-- rewriting an existing CHECK on a live NOT NULL column (see
-- subscriptions.lifecycle_status for the established precedent) --
-- gym_memberships.role is also the architecturally correct home for a
-- PER-GYM role in a multi-gym system, since users.role alone becomes
-- ambiguous the moment a user belongs to more than one gym.
CREATE TABLE IF NOT EXISTS gym_memberships (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id   TEXT REFERENCES branches(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','GYM_OWNER','MANAGER','STAFF','TRAINER','CLIENT')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','PAUSED','SUSPENDED','EXPIRED','CANCELLED','TRANSFERRED')),
  joined_at   TEXT NOT NULL,
  left_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_gym_memberships_user ON gym_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_gym_memberships_org ON gym_memberships(org_id, status);

-- ============================================================
-- PHASE 3 PRODUCTION HARDENING -- Admin Console audit log.
--
-- Every SENSITIVE action taken through the separate Admin Console
-- (suspend/reactivate a gym, resolve a reconciliation issue, etc.)
-- writes one immutable row here -- see routes/console.js's own
-- writeAuditLog() helper, the only thing that ever inserts into this
-- table. Append-only from the Admin Console UI by construction: no
-- route in this codebase updates or deletes a row here.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_logs(admin_id, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_logs(entity_type, entity_id);

-- ============================================================
-- PHASE 3B -- Support tickets. Confirmed complete blank slate before
-- this pass (no placeholder table, no partial route) -- built from
-- scratch, gym-owner-facing (their own org's tickets) and platform-
-- wide (Admin Console) both read/write the SAME two tables.
-- ============================================================
CREATE TABLE IF NOT EXISTS support_tickets (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by        TEXT NOT NULL REFERENCES users(id),
  category          TEXT NOT NULL CHECK (category IN ('PAYMENT','SUBSCRIPTION','QR','CLIENT','TRAINER','ACCOUNT','TECHNICAL','BILLING','OTHER')),
  priority          TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_FOR_GYM','RESOLVED','CLOSED')),
  subject           TEXT NOT NULL,
  assigned_admin_id TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(org_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, priority);

-- The internal messages (admin-only notes) are the one field this whole
-- subsystem exists to keep safely separate -- see tickets.js's own
-- comment: the gym-owner-facing read path filters these out at the
-- QUERY level, not just in the UI.
CREATE TABLE IF NOT EXISTS support_messages (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  internal   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at);

-- ============================================================
-- PHASE 3B -- Fraud/risk monitoring. Confirmed complete blank slate
-- before this pass. Scoped to detectors this codebase can honestly run
-- from data it already collects (see riskEngine.js) -- no IP/device
-- fingerprinting exists anywhere here, so "multiple accounts from the
-- same device/IP" is deliberately NOT one of them; inventing that
-- signal from data that doesn't exist would be exactly the kind of
-- fabrication the hardening spec forbids elsewhere.
-- ============================================================
CREATE TABLE IF NOT EXISTS risk_events (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,   -- 'user' | 'org'
  entity_id   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('RAPID_QR_GENERATION', 'MULTIPLE_FAILED_PAYMENTS', 'UNUSUAL_REFUND_VOLUME')),
  risk_score  INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_risk_events_org ON risk_events(org_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_events_entity ON risk_events(entity_type, entity_id);

-- ============================================================
-- PHASE 3C -- feature flags + platform announcements. Both confirmed
-- complete blank slates before this pass.
-- ============================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  id                   TEXT PRIMARY KEY,
  key                  TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  description          TEXT,
  enabled              INTEGER NOT NULL DEFAULT 0,
  rollout_percentage   INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percentage BETWEEN 0 AND 100),
  enabled_org_ids_json TEXT,   -- JSON array of org ids always-on regardless of rollout %
  created_by           TEXT REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_announcements (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  audience   TEXT NOT NULL DEFAULT 'ALL' CHECK (audience IN ('ALL', 'OWNERS', 'TRAINERS', 'CLIENTS')),
  priority   TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  starts_at  TEXT,
  ends_at    TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_window ON platform_announcements(starts_at, ends_at);
