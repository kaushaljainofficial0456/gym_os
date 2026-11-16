-- ============================================================
-- MIGRATION 2026-11-16_rls_fail_closed -- UP
--
-- Replaces every row-level-security policy with the fail-closed model in
-- database/rls.sql (this file is that file, verbatim, between the BEGIN
-- and the self-check -- backend/test/rlsTenantIsolation.test.js fails if
-- the two ever drift apart).
--
-- PREREQUISITE: the application code from the same change must already be
-- deployed. These policies show a statement NOTHING unless it carries
-- app.org_id or app.platform, which only the new backend/src/db.js sets.
--
-- Apply with the ADMIN role, in ONE session (pg_temp helpers):
--   psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f up.sql
-- Equivalent: `npm run db:init` with DATABASE_URL=<admin url> (it applies
-- database/rls.sql itself). Idempotent. Atomic: any error, including the
-- self-check at the end, rolls the whole thing back.
-- Roll back with down.sql. Runbook: docs/security/RLS_DEPLOYMENT_RUNBOOK.md
-- ============================================================
BEGIN;
-- >>> database/rls.sql
-- ============================================================
-- SK OS / BARBELL -- PostgreSQL ROW LEVEL SECURITY
--
-- Applied ONLY on PostgreSQL, by scripts/init-db.js (idempotent; re-run on
-- every `npm run db:init`) and, for an existing database, by the versioned
-- migration database/migrations/2026-11-16_rls_fail_closed/up.sql (a
-- snapshot of this file). Read docs/security/RLS_SECURITY_AUDIT.md first.
--
-- THE MODEL -- FAIL CLOSED
--   Every statement the backend runs carries a TRANSACTION-LOCAL context,
--   set by backend/src/db.js on the connection that runs it:
--     app.org_id   = <org>   a tenant: requireAuth, for a user with an org
--     app.platform = 'on'    cross-tenant work authorised in application code
--                            (unauthenticated routes, signed webhooks, the
--                            scheduler, the SUPER_ADMIN console, and the
--                            named cross-gym features -- grep runAsPlatform /
--                            platformScope for every one of them)
--   A statement with NEITHER sees no tenant rows and can write none. There
--   is no "unset means everything" branch any more: that branch is what let
--   every plain query bypass these policies (docs/RLS-BOUNDARY.md).
--
--   set_config(..., true) is LOCAL to the transaction, so PostgreSQL itself
--   drops the context at COMMIT/ROLLBACK: a pooled connection never carries
--   one tenant's context into the next request. Session-level settings are
--   never used.
--
-- THE CATEGORIES (each table is in exactly one -- see the lists below)
--   org       Gym-owned and financial records. Visible to, and writable
--             by, the owning org only. A row that names a client must name
--             one of the org's OWN clients (no references into another gym).
--   personal  A member's own training/nutrition/AI history. Rows keep the
--             org they were created in, but members MOVE (independent ->
--             gym on joining, gym -> independent on leaving), and their
--             history moves with them ("BRING YOUR ACCOUNT WITH YOU",
--             enrollment.js). Visible to the owning org AND to the org the
--             member belongs to now. New rows: own org, own client only.
--   personal_user   The same rule for per-USER rows (wearables, settings),
--             following the user's current org.
--   client    No org column: visible when the client belongs to the org.
--   parent    No org column: visible when the parent row is -- the parent
--             subquery is itself filtered by the parent's own policy.
--   global    Library tables whose NULL-org rows are shared reference data
--             (and share snapshots whose org was deleted). Everyone reads
--             NULL-org rows; only platform may write them.
--   demo      demo_sessions, keyed on demo_org_id.
--   platform  Cross-gym-by-design data (friend communities, gym-wars
--             tournaments). No gym owns it, so no gym context may touch it:
--             only an explicit platform scope (routes/communities.js,
--             routes/tournaments.js, the public invite/QR routes) reads or
--             writes it, and that code authorises per community/tournament.
--             A tenant route that forgets a filter sees none of it.
--   shares    app_shares: one row links two gyms (sender_org_id,
--             recipient_org_id). Either side reads it; a gym may only send
--             from itself, as one of its own members.
--
-- FORCE ROW LEVEL SECURITY makes every policy apply to the table owner too.
-- The runtime role must still be NOBYPASSRLS, not a superuser, not the
-- owner, and not a member of the owner role -- backend/scripts/rls-verify.js
-- checks all of that against a live database.
-- ============================================================

-- ---- every table this file protects: enabled AND forced ----
-- (Listed explicitly so a reviewer -- and prodreadiness.test.js's schema
--  sweep -- can see the full set. pg_temp.rls_apply() below re-asserts both
--  for each table before writing its policies.)
ALTER TABLE users                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                    FORCE ROW LEVEL SECURITY;
ALTER TABLE trainers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainers                 FORCE ROW LEVEL SECURITY;
ALTER TABLE clients                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients                  FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_templates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_templates        FORCE ROW LEVEL SECURITY;
ALTER TABLE training_programs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_programs        FORCE ROW LEVEL SECURITY;
ALTER TABLE nutrition_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_plans          FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_settings             FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts                   FORCE ROW LEVEL SECURITY;
ALTER TABLE coach_insights           ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_insights           FORCE ROW LEVEL SECURITY;
ALTER TABLE packages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages                 FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions            FORCE ROW LEVEL SECURITY;
ALTER TABLE payments                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments                 FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance               ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance               FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE messages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages                 FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications            FORCE ROW LEVEL SECURITY;
ALTER TABLE events                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                   FORCE ROW LEVEL SECURITY;
ALTER TABLE community_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_members        FORCE ROW LEVEL SECURITY;
ALTER TABLE community_workout_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_workout_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE community_reactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_reactions      FORCE ROW LEVEL SECURITY;
ALTER TABLE community_comments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_comments       FORCE ROW LEVEL SECURITY;
ALTER TABLE community_challenges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_challenges     FORCE ROW LEVEL SECURITY;
ALTER TABLE community_follows        ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_follows        FORCE ROW LEVEL SECURITY;
ALTER TABLE trainer_attendance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_attendance       FORCE ROW LEVEL SECURITY;
ALTER TABLE trainer_shifts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_shifts           FORCE ROW LEVEL SECURITY;
ALTER TABLE trainer_attendance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_attendance_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE client_gym_periods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_gym_periods       FORCE ROW LEVEL SECURITY;
ALTER TABLE access_providers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_providers         FORCE ROW LEVEL SECURITY;
ALTER TABLE access_provider_secrets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_provider_secrets  FORCE ROW LEVEL SECURITY;
ALTER TABLE access_devices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_devices           FORCE ROW LEVEL SECURITY;
ALTER TABLE access_member_mappings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_member_mappings   FORCE ROW LEVEL SECURITY;
ALTER TABLE access_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_events            FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_presence_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_presence_sessions    FORCE ROW LEVEL SECURITY;
ALTER TABLE occupancy_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE occupancy_snapshots      FORCE ROW LEVEL SECURITY;
ALTER TABLE access_sync_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_sync_jobs         FORCE ROW LEVEL SECURITY;
ALTER TABLE access_audit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_audit_logs        FORCE ROW LEVEL SECURITY;
ALTER TABLE access_alerts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_alerts            FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_quotes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_quotes           FORCE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions       FORCE ROW LEVEL SECURITY;
ALTER TABLE branches                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches                 FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens        FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_memberships          ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_memberships          FORCE ROW LEVEL SECURITY;
ALTER TABLE gym_onboarding           ENABLE ROW LEVEL SECURITY;
ALTER TABLE gym_onboarding           FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                 FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_status_history FORCE ROW LEVEL SECURITY;
ALTER TABLE org_billing_state        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_billing_state        FORCE ROW LEVEL SECURITY;
ALTER TABLE org_capacity_purchases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_capacity_purchases   FORCE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions        FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_accounts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_accounts         FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders           FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues    FORCE ROW LEVEL SECURITY;
ALTER TABLE refunds                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds                  FORCE ROW LEVEL SECURITY;
ALTER TABLE risk_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_events              FORCE ROW LEVEL SECURITY;
ALTER TABLE support_tickets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets          FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_settings        FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_numbers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_numbers         FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_line_terms      ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_line_terms      FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_scripts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_scripts         FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_script_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_script_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_templates       FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_sms_templates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_sms_templates   FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_agents          FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_agent_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_agent_versions  FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_voices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_voices          FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_rules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_rules           FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_member_prefs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_member_prefs    FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_consent_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_consent_log     FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_jobs            FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_callbacks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_callbacks       FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_audio           ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_audio           FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_balances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_balances        FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_ledger          FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_orders          FORCE ROW LEVEL SECURITY;
ALTER TABLE followup_audit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_audit           FORCE ROW LEVEL SECURITY;
ALTER TABLE workouts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE workouts                 FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workouts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workouts          FORCE ROW LEVEL SECURITY;
ALTER TABLE cardio_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cardio_sessions          FORCE ROW LEVEL SECURITY;
ALTER TABLE client_meal_templates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_meal_templates    FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_entries           FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_metrics           ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_metrics           FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_memory                ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory                FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback              FORCE ROW LEVEL SECURITY;
ALTER TABLE intelligence_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_events      FORCE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_adjustments FORCE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_prompts FORCE ROW LEVEL SECURITY;
ALTER TABLE health_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE health_records           ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_records           FORCE ROW LEVEL SECURITY;
ALTER TABLE health_canonical_workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_canonical_workouts FORCE ROW LEVEL SECURITY;
ALTER TABLE health_energy_intervals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_energy_intervals  FORCE ROW LEVEL SECURITY;
ALTER TABLE health_daily_summaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_daily_summaries   FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE client_profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profiles          FORCE ROW LEVEL SECURITY;
ALTER TABLE goals                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals                    FORCE ROW LEVEL SECURITY;
ALTER TABLE weight_logs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_logs              FORCE ROW LEVEL SECURITY;
ALTER TABLE measurements             ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurements             FORCE ROW LEVEL SECURITY;
ALTER TABLE progress_photos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_photos          FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_logs             FORCE ROW LEVEL SECURITY;
ALTER TABLE exercise_set_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_set_logs        FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_records         ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_records         FORCE ROW LEVEL SECURITY;
ALTER TABLE meal_logs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_logs                FORCE ROW LEVEL SECURITY;
ALTER TABLE water_logs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_logs               FORCE ROW LEVEL SECURITY;
ALTER TABLE sleep_logs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_logs               FORCE ROW LEVEL SECURITY;
ALTER TABLE supplements              ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplements              FORCE ROW LEVEL SECURITY;
ALTER TABLE adherence_records        ENABLE ROW LEVEL SECURITY;
ALTER TABLE adherence_records        FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_preferences    ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_preferences    FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workout_schedule  ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workout_schedule  FORCE ROW LEVEL SECURITY;
ALTER TABLE training_days            ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_days            FORCE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_exercises        FORCE ROW LEVEL SECURITY;
ALTER TABLE meals                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals                    FORCE ROW LEVEL SECURITY;
ALTER TABLE meal_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_items               FORCE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_adjustment_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_balance_adjustment_days FORCE ROW LEVEL SECURITY;
ALTER TABLE client_workout_exercises ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_workout_exercises FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions     FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events           FORCE ROW LEVEL SECURITY;
ALTER TABLE support_messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages         FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_events              FORCE ROW LEVEL SECURITY;
ALTER TABLE exercise_library         ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_library         FORCE ROW LEVEL SECURITY;
ALTER TABLE exercise_aliases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_aliases         FORCE ROW LEVEL SECURITY;
ALTER TABLE foods                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE foods                    FORCE ROW LEVEL SECURITY;
ALTER TABLE food_aliases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_aliases             FORCE ROW LEVEL SECURITY;
ALTER TABLE shared_meals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_meals             FORCE ROW LEVEL SECURITY;
ALTER TABLE shared_workouts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_workouts          FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sessions            FORCE ROW LEVEL SECURITY;
ALTER TABLE communities              ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities              FORCE ROW LEVEL SECURITY;
ALTER TABLE community_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_memberships    FORCE ROW LEVEL SECURITY;
ALTER TABLE community_invites        ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_invites        FORCE ROW LEVEL SECURITY;
ALTER TABLE community_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_events         FORCE ROW LEVEL SECURITY;
ALTER TABLE community_event_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_event_reactions FORCE ROW LEVEL SECURITY;
ALTER TABLE community_event_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_event_comments FORCE ROW LEVEL SECURITY;
ALTER TABLE community_group_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_group_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE tournaments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments              FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_hosts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_hosts         FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_entrants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_entrants      FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_entries       FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_results       FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_teams         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_teams         FORCE ROW LEVEL SECURITY;
ALTER TABLE tournament_audit         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_audit         FORCE ROW LEVEL SECURITY;
ALTER TABLE app_shares               ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_shares               FORCE ROW LEVEL SECURITY;

-- ============================================================
-- POLICY BUILDER. Session-temporary (pg_temp): it leaves no object behind
-- in the database and cannot collide with a concurrent run.
-- ============================================================

-- Drops EVERY policy on the table, whatever its name, before the new ones
-- are written. Permissive policies are OR'd together, so a single leftover
-- from an older version of this file (the fail-open `tenant_isolation`,
-- say) would silently reopen the table.
CREATE OR REPLACE FUNCTION pg_temp.rls_reset(t text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE pol name;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  FOR pol IN SELECT polname FROM pg_policy WHERE polrelid = to_regclass(t) LOOP
    EXECUTE format('DROP POLICY %I ON %I', pol, t);
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.rls_policy(t text, pname text, cmd text, using_expr text, check_expr text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR %s TO PUBLIC%s%s', pname, t, cmd,
    CASE WHEN using_expr IS NULL THEN '' ELSE format(' USING (%s)', using_expr) END,
    CASE WHEN check_expr IS NULL THEN '' ELSE format(' WITH CHECK (%s)', check_expr) END);
END $fn$;

-- kind: org | personal | personal_user | client | parent | global | demo | platform | shares
-- arg:  for 'parent', the predicate tying a row to its (RLS-filtered) parent.
CREATE OR REPLACE FUNCTION pg_temp.rls_apply(t text, kind text, arg text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  -- The two contexts. NULLIF turns an empty app.org_id into NULL, and
  -- `org_id = NULL` is never true: no context, no rows.
  p constant text := $x$current_setting('app.platform', true) = 'on'$x$;
  o constant text := $x$NULLIF(current_setting('app.org_id', true), '')$x$;
  has_client  boolean;
  own_org     text;
  mine_client text;
  mine_user   text;
  ref_ok      text;
  readable    text;
BEGIN
  IF to_regclass(t) IS NULL THEN
    RAISE EXCEPTION 'rls.sql: table % does not exist (schema.sql / init-db.js migrations must run first)', t;
  END IF;
  PERFORM pg_temp.rls_reset(t);
  SELECT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass(t) AND attname = 'client_id' AND NOT attisdropped)
    INTO has_client;
  own_org     := format('org_id = %s', o);
  mine_client := format('client_id IN (SELECT c.id FROM clients c WHERE c.org_id = %s)', o);
  mine_user   := format('user_id IN (SELECT u.id FROM users u WHERE u.org_id = %s)', o);
  -- A row may only point at a client of the org writing it.
  ref_ok      := CASE WHEN has_client THEN format('(client_id IS NULL OR %s)', mine_client) ELSE 'true' END;

  IF kind = 'org' THEN
    PERFORM pg_temp.rls_policy(t, 'tenant_isolation', 'ALL',
      format('%s OR %s', p, own_org),
      format('%s OR (%s AND %s)', p, own_org, ref_ok));

  ELSIF kind = 'personal' THEN
    readable := format('%s OR %s OR %s', p, own_org, mine_client);
    PERFORM pg_temp.rls_policy(t, 'tenant_select', 'SELECT', readable, NULL);
    PERFORM pg_temp.rls_policy(t, 'tenant_insert', 'INSERT', NULL,
      format('%s OR (%s AND %s)', p, own_org, ref_ok));
    PERFORM pg_temp.rls_policy(t, 'tenant_update', 'UPDATE', readable,
      format('%s OR %s OR (%s AND client_id IS NULL)', p, mine_client, own_org));
    PERFORM pg_temp.rls_policy(t, 'tenant_delete', 'DELETE', readable, NULL);

  ELSIF kind = 'personal_user' THEN
    readable := format('%s OR %s OR %s', p, own_org, mine_user);
    PERFORM pg_temp.rls_policy(t, 'tenant_select', 'SELECT', readable, NULL);
    PERFORM pg_temp.rls_policy(t, 'tenant_insert', 'INSERT', NULL,
      format('%s OR (%s AND %s)', p, own_org, mine_user));
    PERFORM pg_temp.rls_policy(t, 'tenant_update', 'UPDATE', readable,
      format('%s OR %s', p, mine_user));
    PERFORM pg_temp.rls_policy(t, 'tenant_delete', 'DELETE', readable, NULL);

  ELSIF kind = 'client' THEN
    PERFORM pg_temp.rls_policy(t, 'tenant_isolation', 'ALL',
      format('%s OR %s', p, mine_client),
      format('%s OR %s', p, mine_client));

  ELSIF kind = 'parent' THEN
    IF arg IS NULL THEN RAISE EXCEPTION 'rls.sql: parent table % needs its parent predicate', t; END IF;
    PERFORM pg_temp.rls_policy(t, 'tenant_isolation', 'ALL',
      format('%s OR %s', p, arg),
      format('%s OR %s', p, arg));

  ELSIF kind = 'global' THEN
    -- Reads: shared (NULL-org) rows, own rows, and -- for tables with a
    -- client -- the member's own rows from before they moved.
    readable := format('%s OR org_id IS NULL OR %s%s', p, own_org,
                       CASE WHEN has_client THEN ' OR ' || mine_client ELSE '' END);
    PERFORM pg_temp.rls_policy(t, 'tenant_select', 'SELECT', readable, NULL);
    -- Writes: never a NULL-org (shared) row outside platform.
    PERFORM pg_temp.rls_policy(t, 'tenant_insert', 'INSERT', NULL,
      format('%s OR (%s AND %s)', p, own_org, ref_ok));
    PERFORM pg_temp.rls_policy(t, 'tenant_update', 'UPDATE',
      format('%s OR %s%s', p, own_org, CASE WHEN has_client THEN ' OR ' || mine_client ELSE '' END),
      format('%s OR (%s AND %s)%s', p, own_org, ref_ok, CASE WHEN has_client THEN ' OR ' || mine_client ELSE '' END));
    PERFORM pg_temp.rls_policy(t, 'tenant_delete', 'DELETE',
      format('%s OR %s%s', p, own_org, CASE WHEN has_client THEN ' OR ' || mine_client ELSE '' END), NULL);

  ELSIF kind = 'platform' THEN
    PERFORM pg_temp.rls_policy(t, 'platform_only', 'ALL', p, p);

  ELSIF kind = 'shares' THEN
    readable := format('%s OR sender_org_id = %s OR recipient_org_id = %s', p, o, o);
    PERFORM pg_temp.rls_policy(t, 'tenant_select', 'SELECT', readable, NULL);
    PERFORM pg_temp.rls_policy(t, 'tenant_insert', 'INSERT', NULL,
      format('%s OR (sender_org_id = %s AND (sender_client_id IS NULL OR sender_client_id IN (SELECT c.id FROM clients c WHERE c.org_id = %s)))', p, o, o));
    PERFORM pg_temp.rls_policy(t, 'tenant_update', 'UPDATE', readable, readable);
    PERFORM pg_temp.rls_policy(t, 'tenant_delete', 'DELETE', readable, NULL);

  ELSIF kind = 'demo' THEN
    PERFORM pg_temp.rls_policy(t, 'tenant_isolation', 'ALL',
      format('%s OR demo_org_id = %s', p, o),
      format('%s OR demo_org_id = %s', p, o));

  ELSE
    RAISE EXCEPTION 'rls.sql: unknown category % for %', kind, t;
  END IF;
END $fn$;

-- ============================================================
-- org -- gym-owned and financial records (strict to the owning org)
-- ============================================================
SELECT pg_temp.rls_apply(t, 'org') FROM unnest(ARRAY[
  -- identity and gym configuration
  'users','trainers','clients','gym_settings','branches','gym_memberships','gym_onboarding',
  'enrollment_tokens','packages',
  -- gym-authored programming (a member who leaves loses the gym's plan:
  -- "WHAT ACTUALLY STOPS ... a coach, assigned programmes", gymExit.js)
  'workout_templates','training_programs','nutrition_plans',
  -- staff-facing records
  'alerts','coach_insights','messages','notifications','events',
  'trainer_attendance','trainer_shifts','trainer_attendance_audit',
  -- attendance and doors (access_provider_secrets holds door credentials)
  'attendance','attendance_events','client_gym_periods',
  'access_providers','access_provider_secrets','access_devices','access_member_mappings','access_events',
  'gym_presence_sessions','occupancy_snapshots','access_sync_jobs','access_audit_logs','access_alerts',
  -- the gym's own community
  'community_members','community_workout_shares','community_reactions','community_comments',
  'community_challenges','community_follows',
  -- FINANCIAL
  'subscriptions','payments','payment_orders','invoices','refunds','reconciliation_issues',
  'billing_quotes','coupon_redemptions','membership_status_history','org_billing_state',
  'org_capacity_purchases','org_subscriptions','payment_accounts','risk_events','support_tickets',
  -- AI COMMUNICATION (followup_price_versions / followup_platform are the
  -- founder's platform-level price book and switches: no org, no policy)
  'followup_settings','followup_numbers','followup_line_terms','followup_scripts','followup_script_versions',
  'followup_templates','followup_sms_templates','followup_agents','followup_agent_versions','followup_voices',
  'followup_rules','followup_member_prefs','followup_consent_log','followup_jobs','followup_callbacks',
  'followup_audio','followup_balances','followup_ledger','followup_orders','followup_audit'
]) AS t;

-- ============================================================
-- personal -- a member's own history; follows the member between orgs
-- ============================================================
SELECT pg_temp.rls_apply(t, 'personal') FROM unnest(ARRAY[
  'workouts','client_workouts','cardio_sessions','client_meal_templates','metric_entries','custom_metrics',
  'ai_memory','ai_feedback','intelligence_events','nutrition_balance_adjustments','nutrition_balance_prompts'
]) AS t;

SELECT pg_temp.rls_apply(t, 'personal_user') FROM unnest(ARRAY[
  -- wearable data and the OAuth connection that syncs it, keyed per user
  -- (UNIQUE (user_id, ...)): a member's sync must keep working after they
  -- join a gym, so these follow the user's current org.
  'health_provider_connections','health_records','health_canonical_workouts',
  'health_energy_intervals','health_daily_summaries',
  -- PRIMARY KEY (user_id): strict org scoping would hide the row after a
  -- move and turn the next save into a conflict on a row nobody can see.
  'notification_preferences'
]) AS t;

-- ============================================================
-- client -- no org column; the client must belong to the org
-- ============================================================
SELECT pg_temp.rls_apply(t, 'client') FROM unnest(ARRAY[
  'client_profiles','goals','weight_logs','measurements','progress_photos','workout_logs',
  'exercise_set_logs','personal_records','meal_logs','water_logs','sleep_logs','supplements',
  'adherence_records','dashboard_preferences','client_workout_schedule'
]) AS t;

-- ============================================================
-- parent -- visible exactly when the parent row is. The subquery runs
-- under the parent's own policy, so a child can never be seen, written or
-- attached to a parent the context cannot see.
-- ============================================================
SELECT pg_temp.rls_apply('training_days', 'parent',
  'program_id IN (SELECT tp.id FROM training_programs tp)');
SELECT pg_temp.rls_apply('workout_exercises', 'parent',
  '(workout_id IN (SELECT w.id FROM workouts w) OR template_id IN (SELECT wt.id FROM workout_templates wt))');
SELECT pg_temp.rls_apply('meals', 'parent',
  'plan_id IN (SELECT np.id FROM nutrition_plans np)');
SELECT pg_temp.rls_apply('meal_items', 'parent',
  'meal_template_id IN (SELECT m.id FROM client_meal_templates m)');
SELECT pg_temp.rls_apply('nutrition_balance_adjustment_days', 'parent',
  'adjustment_id IN (SELECT a.id FROM nutrition_balance_adjustments a)');
SELECT pg_temp.rls_apply('client_workout_exercises', 'parent',
  'workout_id IN (SELECT cw.id FROM client_workouts cw)');
-- payment_events.order_id is NULL for a webhook that never resolved to an
-- order: such a row is platform-only (NULL IN (...) is never true).
SELECT pg_temp.rls_apply('payment_transactions', 'parent',
  'order_id IN (SELECT po.id FROM payment_orders po)');
SELECT pg_temp.rls_apply('payment_events', 'parent',
  'order_id IN (SELECT po.id FROM payment_orders po)');
SELECT pg_temp.rls_apply('support_messages', 'parent',
  'ticket_id IN (SELECT st.id FROM support_tickets st)');
SELECT pg_temp.rls_apply('demo_events', 'parent',
  'session_id IN (SELECT ds.id FROM demo_sessions ds)');

-- ============================================================
-- global -- shared library rows (org_id NULL) are readable by every org and
-- writable only by platform; a gym's own rows are its own. shared_meals /
-- shared_workouts are here because a share whose org was deleted keeps a
-- NULL org (ON DELETE SET NULL) and must stay openable.
-- ============================================================
SELECT pg_temp.rls_apply(t, 'global') FROM unnest(ARRAY[
  'exercise_library','exercise_aliases','foods','food_aliases','shared_meals','shared_workouts'
]) AS t;

-- ============================================================
-- demo -- a demo session is a GRANT of access to demo_org_id, not a row
-- belonging to it; same fail-closed rule.
-- ============================================================
SELECT pg_temp.rls_apply('demo_sessions', 'demo');

-- ============================================================
-- platform -- cross-gym by design; no tenant context reaches these rows.
-- ============================================================
SELECT pg_temp.rls_apply(t, 'platform') FROM unnest(ARRAY[
  'communities','community_memberships','community_invites','community_events',
  'community_event_reactions','community_event_comments','community_group_challenges',
  'tournaments','tournament_hosts','tournament_entrants','tournament_entries',
  'tournament_events','tournament_results','tournament_teams','tournament_audit'
]) AS t;

-- ============================================================
-- shares -- a row belongs to both the sending and the receiving gym.
-- ============================================================
SELECT pg_temp.rls_apply('app_shares', 'shares');

DROP FUNCTION pg_temp.rls_apply(text, text, text);
DROP FUNCTION pg_temp.rls_policy(text, text, text, text, text);
DROP FUNCTION pg_temp.rls_reset(text);

-- ============================================================
-- INTENTIONALLY NOT RLS'd -- reviewed and excluded, not overlooked
-- (backend/test/rlsTenantIsolation.test.js fails if a table with an org_id
--  or client_id column is neither protected above nor listed here):
--
--   organizations                  the tenant root, resolved by id/slug
--                                  before auth (setup, login, enrollment
--                                  preview); name/slug/currency/timezone.
--   admin_audit_logs, feature_flags, platform_announcements, demo_requests,
--   sk_packages, sk_pricing_rules, sk_capacity_addons, coupons,
--   followup_price_versions, followup_platform, ai_provider_cost_state
--                                  platform-level: no tenant column; read
--                                  and written by SUPER_ADMIN routes or the
--                                  platform itself.
--   muscles, exercise_muscles, exercise_relations
--                                  global exercise reference data.
--   ai_food_estimates, ai_food_feedback
--                                  the shared food-estimation cache and its
--                                  feedback (keyed by canonical food, not
--                                  by gym).
--   account_tokens, health_reconciliation_log, barbell_plan_orders
--                                  per-USER rows with no tenant column
--                                  (password/verify tokens, a wearable
--                                  audit trail, a person's own Barbell plan
--                                  purchase); every read is keyed by the
--                                  authenticated user id.
-- ============================================================
-- <<< database/rls.sql

-- ---- self-check: abort the whole migration unless the result is fail-closed ----
DO $verify$
DECLARE bad text;
BEGIN
  -- 1. No policy may keep the old "app.org_id unset => every row" escape.
  SELECT string_agg(format('%s.%s', c.relname, p.polname), ', ') INTO bad
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~* 'nullif\(current_setting\(''app\.org_id''::text, true\), ''''::text\) IS NULL'
       OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'nullif\(current_setting\(''app\.org_id''::text, true\), ''''::text\) IS NULL');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'rls migration: fail-open policy still present: %', bad; END IF;
  -- 2. Every table with a policy has RLS enabled AND forced.
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'rls migration: RLS not enabled+forced on: %', bad; END IF;
  -- 3. Every table carrying a tenant id (org_id, client_id, sender_org_id,
  --    host_org_id, ...) is protected, except the reviewed exemption list.
  --    A table added by a later feature (and not yet in rls.sql) stops the
  --    migration here instead of shipping unprotected.
  SELECT string_agg(DISTINCT c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE n.nspname = current_schema() AND c.relkind = 'r'
     AND a.attname ~ '(^|_)(org|client)_id$'
     AND c.relname NOT IN ('ai_food_feedback')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'rls migration: tenant table without RLS (add it to database/rls.sql): %', bad; END IF;
END $verify$;

COMMIT;
