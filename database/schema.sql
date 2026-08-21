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
  started_at    TEXT,          -- set when the client taps START SESSION
  progress_json TEXT,          -- in-flight per-set ticks, so a refresh mid-session does not lose them
  completed_at  TEXT,
  started_at    TEXT,             -- UTC ISO-8601: session start. Backend is the source of truth (set via POST /workouts/:id/start or lazily at completion).
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
  is_global INTEGER NOT NULL DEFAULT 0  -- 1 => GLOBAL library; org_id+!global => GYM FOODS
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
CREATE INDEX IF NOT EXISTS idx_ml_template ON meal_logs(meal_template_id);
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
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

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
