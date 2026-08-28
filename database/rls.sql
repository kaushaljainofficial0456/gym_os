-- ============================================================
-- SK OS — PostgreSQL ROW LEVEL SECURITY (defense-in-depth)
--
-- Applied ONLY on PostgreSQL (see scripts/init-db.js). Application-level
-- authorization remains the primary control; RLS is an additional layer
-- that makes cross-tenant access impossible even if a query forgets its
-- org filter (e.g. SQL injection or a future miswritten query).
--
-- Design:
--   * The app sets the session variable app.org_id inside transactions
--     (db.tx(..., { orgId })) right after BEGIN via SET LOCAL, so it is
--     automatically reset at COMMIT/ROLLBACK and never leaks across
--     pooled connections.
--   * Policy rule: when app.org_id is NOT set (plain pooled queries), all
--     rows are visible — the app SQL already filters by org_id, and the
--     DB user is shared across tenants. When it IS set (transactional
--     multi-row writes), ONLY that org's rows (plus global library rows
--     where applicable) are visible/insertable.
--   * FORCE ROW LEVEL SECURITY makes the policies apply to the table owner
--     too (Neon app role is typically the owner — without FORCE the owner
--     would bypass RLS entirely).
-- ============================================================

-- Helper: current app org or NULL when unset.
-- (Cannot be a function returning rows in policy, so the pattern is inlined.)

-- ---- tables with a direct org_id column (no global rows) ----
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE trainers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainers           FORCE ROW LEVEL SECURITY;
ALTER TABLE clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients            FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_templates  FORCE ROW LEVEL SECURITY;
ALTER TABLE training_programs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_programs  FORCE ROW LEVEL SECURITY;
ALTER TABLE workouts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE workouts           FORCE ROW LEVEL SECURITY;
ALTER TABLE nutrition_plans    ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_plans    FORCE ROW LEVEL SECURITY;
ALTER TABLE intelligence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_events FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_settings       FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_metrics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_metrics     FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_entries     FORCE ROW LEVEL SECURITY;
ALTER TABLE client_meal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_meal_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workouts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workouts    FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events  FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts             FORCE ROW LEVEL SECURITY;
ALTER TABLE coach_insights     ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_insights     FORCE ROW LEVEL SECURITY;
ALTER TABLE packages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages           FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions      FORCE ROW LEVEL SECURITY;
ALTER TABLE payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments           FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance         ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance         FORCE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      FORCE ROW LEVEL SECURITY;
ALTER TABLE events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE events             FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_memory          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory          FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback        FORCE ROW LEVEL SECURITY;
-- Gym community (added with the community feature; both carry a NOT NULL
-- org_id and are read/written exactly like the org-scoped tables above).
ALTER TABLE community_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_members FORCE ROW LEVEL SECURITY;
ALTER TABLE community_workout_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_workout_shares FORCE ROW LEVEL SECURITY;

-- ---- tables with a direct org_id column that ALSO carry global rows ----
-- (exercise/food libraries: org_id NULL = GLOBAL, visible to everyone)
ALTER TABLE exercise_library   ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_library   FORCE ROW LEVEL SECURITY;
ALTER TABLE exercise_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_aliases   FORCE ROW LEVEL SECURITY;
ALTER TABLE foods              ENABLE ROW LEVEL SECURITY;
ALTER TABLE foods              FORCE ROW LEVEL SECURITY;
ALTER TABLE food_aliases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_aliases       FORCE ROW LEVEL SECURITY;

-- ---- client-scoped tables (no org_id column; org derived via clients) ----
ALTER TABLE client_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profiles    FORCE ROW LEVEL SECURITY;
ALTER TABLE goals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals              FORCE ROW LEVEL SECURITY;
ALTER TABLE weight_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_logs        FORCE ROW LEVEL SECURITY;
ALTER TABLE measurements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurements       FORCE ROW LEVEL SECURITY;
ALTER TABLE progress_photos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_photos    FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_logs       FORCE ROW LEVEL SECURITY;
ALTER TABLE exercise_set_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_set_logs  FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_records   FORCE ROW LEVEL SECURITY;
ALTER TABLE meal_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_logs          FORCE ROW LEVEL SECURITY;
ALTER TABLE water_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_logs         FORCE ROW LEVEL SECURITY;
ALTER TABLE sleep_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_logs         FORCE ROW LEVEL SECURITY;
ALTER TABLE supplements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplements        FORCE ROW LEVEL SECURITY;
ALTER TABLE adherence_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE adherence_records  FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE training_days      ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_days      FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises  ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises  FORCE ROW LEVEL SECURITY;
ALTER TABLE meals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals              FORCE ROW LEVEL SECURITY;
ALTER TABLE meal_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_items         FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workout_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workout_exercises FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workout_schedule   ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workout_schedule   FORCE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES (dropped first so re-runs are idempotent)
-- ============================================================

-- ---- direct org_id, no global rows ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','trainers','clients','workout_templates','training_programs','workouts',
    'nutrition_plans','intelligence_events','gym_settings','custom_metrics','metric_entries',
    'client_meal_templates','client_workouts','attendance_events','alerts','coach_insights',
    'packages','subscriptions','payments','attendance','messages','notifications','events',
    'ai_memory','ai_feedback',
    'community_members','community_workout_shares'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR org_id = current_setting(''app.org_id'', true)
    ) WITH CHECK (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR org_id = current_setting(''app.org_id'', true)
    )', t);
  END LOOP;
END $$;

-- ---- direct org_id WITH global (NULL org) rows ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exercise_library','exercise_aliases','foods','food_aliases'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR org_id IS NULL
      OR org_id = current_setting(''app.org_id'', true)
    ) WITH CHECK (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR org_id IS NULL
      OR org_id = current_setting(''app.org_id'', true)
    )', t);
  END LOOP;
END $$;

-- ---- client-scoped tables (client must belong to the app org) ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client_profiles','goals','weight_logs','measurements','progress_photos','workout_logs',
    'exercise_set_logs','personal_records','meal_logs','water_logs','sleep_logs','supplements',
    'adherence_records','dashboard_preferences','client_workout_schedule'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR client_id IN (SELECT id FROM clients WHERE org_id = current_setting(''app.org_id'', true))
    ) WITH CHECK (
      NULLIF(current_setting(''app.org_id'', true), '''') IS NULL
      OR client_id IN (SELECT id FROM clients WHERE org_id = current_setting(''app.org_id'', true))
    )', t);
  END LOOP;
END $$;

-- ---- parent-scoped tables (org derived via their parent row) ----
DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON training_days;
  CREATE POLICY tenant_isolation ON training_days USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR program_id IN (SELECT id FROM training_programs WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR program_id IN (SELECT id FROM training_programs WHERE org_id = current_setting('app.org_id', true))
  );

  DROP POLICY IF EXISTS tenant_isolation ON workout_exercises;
  CREATE POLICY tenant_isolation ON workout_exercises USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR workout_id IN (SELECT id FROM workouts WHERE org_id = current_setting('app.org_id', true))
    OR template_id IN (SELECT id FROM workout_templates WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR workout_id IN (SELECT id FROM workouts WHERE org_id = current_setting('app.org_id', true))
    OR template_id IN (SELECT id FROM workout_templates WHERE org_id = current_setting('app.org_id', true))
  );

  DROP POLICY IF EXISTS tenant_isolation ON meals;
  CREATE POLICY tenant_isolation ON meals USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR plan_id IN (SELECT id FROM nutrition_plans WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR plan_id IN (SELECT id FROM nutrition_plans WHERE org_id = current_setting('app.org_id', true))
  );

  DROP POLICY IF EXISTS tenant_isolation ON meal_items;
  CREATE POLICY tenant_isolation ON meal_items USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR meal_template_id IN (SELECT id FROM client_meal_templates WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR meal_template_id IN (SELECT id FROM client_meal_templates WHERE org_id = current_setting('app.org_id', true))
  );

  -- client_workout_exercises has NO client_id column — its client/org is
  -- derived via the parent row: workout_id -> client_workouts.org_id.
  DROP POLICY IF EXISTS tenant_isolation ON client_workout_exercises;
  CREATE POLICY tenant_isolation ON client_workout_exercises USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR workout_id IN (SELECT id FROM client_workouts WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR workout_id IN (SELECT id FROM client_workouts WHERE org_id = current_setting('app.org_id', true))
  );
END $$;
