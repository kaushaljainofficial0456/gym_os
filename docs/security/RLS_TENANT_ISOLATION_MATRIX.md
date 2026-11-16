# RLS Tenant Isolation Matrix

Generated on 2026-11-16 from the **live PostgreSQL catalog** after applying `database/rls.sql` through the real `init-db.js` path. It shows what PostgreSQL enforces, not what was intended. **123 tables protected** (RLS enabled **and forced** on every one), **192 policies**, 36 tables deliberately unprotected.

**Every protected table fails closed:** a statement with neither `app.org_id` nor `app.platform = 'on'` sees **zero** tenant rows and can write none. Verified for all 123 tables by `rlsTenantIsolation.test.js` test 6 and by `rls-verify.js`'s live probe. `app.platform = 'on'` (explicit, see the audit §2) sees and writes everything. "Tested" means the table is attacked directly by name in the adversarial suite (cross-gym SELECT/UPDATE/DELETE/INSERT); every table is covered by the no-context probe.

| Table | Category | Sensitivity | Tenant can read | Tenant can write | Forced | Policies | Attacked by name |
|---|---|---|---|---|---|---|---|
| `access_alerts` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_audit_logs` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_devices` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_events` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_member_mappings` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_provider_secrets` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_providers` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `access_sync_jobs` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `adherence_records` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `ai_feedback` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `ai_memory` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `alerts` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `attendance` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `attendance_events` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `billing_quotes` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `branches` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `cardio_sessions` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `client_gym_periods` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `client_meal_templates` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `client_profiles` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `client_workout_exercises` | parent via `workout_id → client_workouts` |  | parent visible | parent visible | yes | 1 |  |
| `client_workout_schedule` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `client_workouts` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `clients` | org | Identity / PII | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `coach_insights` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `community_challenges` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `community_comments` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `community_follows` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `community_members` | org |  | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `community_reactions` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `community_workout_shares` | org |  | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `coupon_redemptions` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `custom_metrics` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `dashboard_preferences` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `demo_events` | parent via `session_id → demo_sessions` |  | parent visible | parent visible | yes | 1 |  |
| `demo_sessions` | demo |  | demo_org_id = own | demo_org_id = own | yes | 1 |  |
| `enrollment_tokens` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `events` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `exercise_aliases` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 |  |
| `exercise_library` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 |  |
| `exercise_set_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `followup_agent_versions` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_agents` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_audio` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_audit` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_balances` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_callbacks` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_consent_log` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_jobs` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_ledger` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_line_terms` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_member_prefs` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_numbers` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_orders` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_rules` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_script_versions` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_scripts` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_settings` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `followup_sms_templates` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_templates` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `followup_voices` | org | AI Communication | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `food_aliases` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 |  |
| `foods` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 | yes |
| `goals` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `gym_memberships` | org |  | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `gym_onboarding` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `gym_presence_sessions` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `gym_settings` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `health_canonical_workouts` | personal_user | Health (wearables) | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 |  |
| `health_daily_summaries` | personal_user | Health (wearables) | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 |  |
| `health_energy_intervals` | personal_user | Health (wearables) | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 |  |
| `health_provider_connections` | personal_user | Health (wearables) | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 |  |
| `health_records` | personal_user | Health (wearables) | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 | yes |
| `intelligence_events` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `invoices` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `meal_items` | parent via `meal_template_id → client_meal_templates` |  | parent visible | parent visible | yes | 1 |  |
| `meal_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `meals` | parent via `plan_id → nutrition_plans` |  | parent visible | parent visible | yes | 1 |  |
| `measurements` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `membership_status_history` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `messages` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `metric_entries` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `notification_preferences` | personal_user |  | own org, or user now in own org | insert: own org + own user; update/delete: readable rows | yes | 4 |  |
| `notifications` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `nutrition_balance_adjustment_days` | parent via `adjustment_id → nutrition_balance_adjustments` |  | parent visible | parent visible | yes | 1 |  |
| `nutrition_balance_adjustments` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `nutrition_balance_prompts` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 |  |
| `nutrition_plans` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `occupancy_snapshots` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `org_billing_state` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `org_capacity_purchases` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `org_subscriptions` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `packages` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `payment_accounts` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `payment_events` | parent via `order_id → payment_orders` | Financial | parent visible | parent visible | yes | 1 |  |
| `payment_orders` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `payment_transactions` | parent via `order_id → payment_orders` | Financial | parent visible | parent visible | yes | 1 | yes |
| `payments` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `personal_records` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `progress_photos` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `reconciliation_issues` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `refunds` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `risk_events` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `shared_meals` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 | yes |
| `shared_workouts` | global |  | shared (NULL-org) + own (+ own member's) | own only; shared rows platform-only | yes | 4 |  |
| `sleep_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `subscriptions` | org | Financial | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `supplements` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `support_messages` | parent via `ticket_id → support_tickets` |  | parent visible | parent visible | yes | 1 | yes |
| `support_tickets` | org |  | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `trainer_attendance` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `trainer_attendance_audit` | org | Attendance / doors | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `trainer_shifts` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `trainers` | org | Identity / PII | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `training_days` | parent via `program_id → training_programs` |  | parent visible | parent visible | yes | 1 |  |
| `training_programs` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `users` | org | Identity / PII | own org | own org; client_id ∈ own clients | yes | 1 | yes |
| `water_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `weight_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 | yes |
| `workout_exercises` | parent via `(workout_id → workouts OR template_id → workout_templates)` |  | parent visible | parent visible | yes | 1 | yes |
| `workout_logs` | client |  | client ∈ own org | client ∈ own org | yes | 1 |  |
| `workout_templates` | org |  | own org | own org; client_id ∈ own clients | yes | 1 |  |
| `workouts` | personal |  | own org, or member now in own org | insert: own org + own client; update/delete: readable rows | yes | 4 | yes |

## Deliberately not protected (36)

Reviewed one by one; the reasons are in the closing comment of `database/rls.sql`. None holds one gym's data keyed by an `org_id` or `client_id` except the friend-community tables (cross-gym by design, enforced in `services/friendCommunities`) and `ai_food_feedback` (the shared food-estimation cache). `rlsTenantIsolation.test.js` fails if a new table with `org_id`/`client_id` is added to either list's blind spot.

`account_tokens`, `admin_audit_logs`, `ai_food_estimates`, `ai_food_feedback`, `ai_provider_cost_state`, `app_shares`, `barbell_plan_orders`, `communities`, `community_event_comments`, `community_event_reactions`, `community_events`, `community_group_challenges`, `community_invites`, `community_memberships`, `coupons`, `demo_requests`, `exercise_muscles`, `exercise_relations`, `feature_flags`, `followup_platform`, `followup_price_versions`, `health_reconciliation_log`, `muscles`, `organizations`, `platform_announcements`, `sk_capacity_addons`, `sk_packages`, `sk_pricing_rules`, `tournament_audit`, `tournament_entrants`, `tournament_entries`, `tournament_events`, `tournament_hosts`, `tournament_results`, `tournament_teams`, `tournaments`

## Indirect (parent-child) relationships

Child tables carry no org column. Their policy is `parent_id IN (SELECT id FROM parent)`, and that subquery runs **under the parent's own policy**, so a child is visible, writable or attachable only when its parent is. Tests: inserting a `workout_exercises` row under Gym B's workout, a `support_messages` reply on Gym B's ticket and a `payment_transactions` row on Gym B's order are all rejected; a member's `workout_exercises` follow their workouts when they change gym.
