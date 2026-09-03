-- ============================================================
-- SK OS — PostgreSQL ROW LEVEL SECURITY (defense-in-depth)
--
-- Applied ONLY on PostgreSQL (see scripts/init-db.js). Application-level
-- authorization (orgScope/resolveClient/getClient + every route's own
-- WHERE org_id = ? clauses) is the PRIMARY and, for most of the codebase,
-- the ONLY control -- read the scope note below before assuming otherwise.
--
-- SCOPE (read this before relying on RLS for anything): app.org_id is set
-- via SET LOCAL ONLY inside db.tx(..., { orgId }) -- see db.js's client.tx.
-- SET LOCAL requires an explicit transaction on a checked-out connection,
-- which is exactly what db.tx() does and what db.q()/db.q1()/db.run() do
-- NOT do (they call pool.query() directly -- a single pooled round trip,
-- no explicit BEGIN, no connection held long enough to scope a session
-- variable to it). db.q()/db.q1()/db.run() are what the large majority of
-- this codebase's reads and single-row writes use; db.tx() is reserved
-- for genuinely multi-statement atomic writes. So in practice RLS
-- narrows cross-tenant exposure for that multi-row-write minority of
-- call sites, plus PostgreSQL-native protection against a future
-- miswritten query INSIDE one of those transactions -- it does NOT
-- backstop the ordinary db.q()/db.run() path, where app.org_id is never
-- set and the "unset -> all rows visible" branch below always applies.
-- That is intentional, not a bug: community.js, the admin console and
-- reconciliation all depend on cross-org visibility on a shared DB role
-- for exactly this reason, and financialRls.test.js /
-- communityPg.test.js assert it explicitly ("unset app.org_id keeps the
-- application working") so a future policy tightening can't silently
-- break it. A real, safe fix would mean every db.q()/db.q1()/db.run()
-- call checking out its own connection to SET LOCAL app.org_id before
-- each query and resetting it before release (pool.query()'s single
-- round trip can't do this: two separate pool.query() calls are not
-- guaranteed the same underlying connection) -- a change to this
-- adapter's entire connection-handling model, not a local one, and
-- risks a WORSE bug than today's gap (a stale app.org_id leaking onto a
-- later, unrelated tenant's query on a reused pooled connection) if the
-- reset-before-release step is ever missed on an error path. Left
-- alone deliberately rather than attempted speculatively; see
-- docs/RLS-BOUNDARY.md for the concrete remediation plan.
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
-- Share-link snapshots (routes/workoutShare.js, me.js's workout-share
-- endpoints). org_id is always populated from the sharing client's own
-- org at INSERT (me.js passes c.org_id), so the plain direct-org_id
-- policy below applies with no NULL branch needed. Every read path is a
-- primary-key lookup through db.q1(), which never sets app.org_id, so
-- the "unset -> visible" branch keeps public share links working exactly
-- as before -- this closes the tenant gap for any future query that runs
-- inside db.tx() without changing the feature's behaviour.
ALTER TABLE shared_workouts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_workouts     FORCE ROW LEVEL SECURITY;

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
    'community_members','community_workout_shares','shared_workouts'
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

-- ============================================================
-- PRODUCTION-READINESS PASS -- 20 org/client-scoped tables that were
-- added across several later features (enterprise billing, refunds/
-- reconciliation, support tickets, multi-gym membership) without ever
-- being added here. Every one of them already has correct app-level
-- org scoping (req.orgId, derived from the JWT via orgScope -- see
-- auth.js -- never client-controlled), so none of this is closing a
-- live IDOR; it's the SAME defense-in-depth this file exists for
-- everywhere else, extended to cover financial/billing/membership data
-- that had been missed.
--
-- Verified safe against every CURRENT write path before writing these
-- policies (not just asserted): every write into these tables is
-- either (a) a plain db.run()/db.q() call outside any db.tx() --
-- app.org_id is never set for these, so RLS stays fully dormant for
-- them exactly like it already does for most of the tables above -- or
-- (b) inside a db.tx() where the org_id being written always equals
-- the transaction's own app.org_id (traced through paymentActivation.js
-- and its registered per-subject-type activation handlers, and
-- support/tickets.js). The one path that looked risky at first --
-- CLIENT_MEMBERSHIP's fresh-join activation, which sets a NEW org_id on
-- an existing user inside a transaction -- is provably safe because
-- enrollment.js's own /client/join guard (`if (req.user.org) return
-- 409 'already_in_a_gym'`) means a user can only be mid-join while
-- their token's org claim is NULL, so app.org_id is unset (RLS
-- dormant) for that entire transaction, the same way it already is for
-- the pre-existing `users`/`clients`/`subscriptions`/`payments` writes
-- that same handler makes today.
-- ============================================================

-- ---- direct org_id, NOT NULL, no global rows ----
ALTER TABLE billing_quotes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_quotes          FORCE ROW LEVEL SECURITY;
ALTER TABLE branches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches                FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens       FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_memberships         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_memberships         FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_onboarding          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_onboarding          FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices                ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_status_history FORCE ROW LEVEL SECURITY;
ALTER TABLE org_billing_state       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_billing_state       FORCE ROW LEVEL SECURITY;
ALTER TABLE org_capacity_purchases  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_capacity_purchases  FORCE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions       FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_accounts        FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders          FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues   FORCE ROW LEVEL SECURITY;
ALTER TABLE refunds                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds                 FORCE ROW LEVEL SECURITY;
-- risk_events.org_id is nullable (an entity_type='user' event may have
-- none) -- treated the same as this bucket rather than the "global
-- rows" bucket below: a null-org_id row is platform-level, not
-- everyone's-tenant-data, so it should stay invisible (not universally
-- visible) under an org-scoped transaction. It's only ever read via
-- SUPER_ADMIN admin-console routes, which run with no org context
-- (app.org_id unset), where it stays visible exactly as it is today.
ALTER TABLE risk_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_events             FORCE ROW LEVEL SECURITY;
ALTER TABLE support_tickets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets         FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing_quotes','branches','enrollment_tokens','gym_memberships','gym_onboarding',
    'invoices','membership_status_history','org_billing_state','org_capacity_purchases',
    'org_subscriptions','payment_accounts','payment_orders','reconciliation_issues',
    'refunds','risk_events','support_tickets'
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

-- ---- direct org_id, NULLABLE, genuinely global-when-null ----
-- shared_meals.org_id/client_id are both nullable (ON DELETE SET NULL /
-- kept nullable so a deleted sender never breaks an outstanding link --
-- see its own schema comment). The public preview route (share.js)
-- reads with no auth and no transaction at all, so it's unaffected by
-- this either way; this only matters for any future org-scoped
-- transactional read, where a null-org_id row (a share whose org was
-- since deleted) should stay visible rather than vanish.
ALTER TABLE shared_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_meals FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON shared_meals;
  CREATE POLICY tenant_isolation ON shared_meals USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR org_id IS NULL
    OR org_id = current_setting('app.org_id', true)
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR org_id IS NULL
    OR org_id = current_setting('app.org_id', true)
  );
END $$;

-- ---- parent-scoped (org derived via a parent row) ----
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events       FORCE ROW LEVEL SECURITY;
ALTER TABLE support_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages     FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON payment_transactions;
  CREATE POLICY tenant_isolation ON payment_transactions USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR order_id IN (SELECT id FROM payment_orders WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR order_id IN (SELECT id FROM payment_orders WHERE org_id = current_setting('app.org_id', true))
  );

  -- payment_events.order_id is nullable (a webhook that never resolved
  -- to a known order) -- such a row stays invisible under an org-scoped
  -- transaction, same reasoning as risk_events above; reconciliation/
  -- admin reads run with no org context and are unaffected.
  DROP POLICY IF EXISTS tenant_isolation ON payment_events;
  CREATE POLICY tenant_isolation ON payment_events USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR order_id IN (SELECT id FROM payment_orders WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR order_id IN (SELECT id FROM payment_orders WHERE org_id = current_setting('app.org_id', true))
  );

  DROP POLICY IF EXISTS tenant_isolation ON support_messages;
  CREATE POLICY tenant_isolation ON support_messages USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR ticket_id IN (SELECT id FROM support_tickets WHERE org_id = current_setting('app.org_id', true))
  ) WITH CHECK (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    OR ticket_id IN (SELECT id FROM support_tickets WHERE org_id = current_setting('app.org_id', true))
  );
END $$;

-- ============================================================
-- INTENTIONALLY NOT RLS'd -- reviewed and excluded, not overlooked:
--
--   organizations, users*                    -- *users already has RLS above;
--                                                organizations is the tenant
--                                                root itself, resolved by id/
--                                                slug pre-auth (setup, login,
--                                                enrollment-token preview) with
--                                                no org context to scope by,
--                                                and carries no field more
--                                                sensitive than name/slug/
--                                                currency/timezone.
--   admin_audit_logs                         -- platform-admin action log,
--                                                not tenant data; every read
--                                                path is SUPER_ADMIN-only.
--   feature_flags                            -- platform config, admin-managed.
--   sk_packages, sk_pricing_rules,
--   sk_capacity_addons                       -- SK's own SaaS catalog/pricing,
--                                                identical for every org by
--                                                design (no org_id column at
--                                                all).
--   muscles, exercise_muscles                -- global exercise-library
--                                                reference/join data, no
--                                                tenant column.
--   ai_provider_cost_state                   -- singleton per provider
--                                                (PRIMARY KEY = provider),
--                                                platform-wide cost-safety
--                                                state, no tenant column.
--   ai_food_estimates, ai_food_feedback      -- food-estimation domain,
--                                                out of scope for this pass
--                                                (see phase1-foundational-
--                                                architecture's own audit).
-- ============================================================
