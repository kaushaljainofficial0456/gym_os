# Rollback runbook

**Status:** written 2026-09-07 as part of a remediation pass; the restore
drill in §3 has **not** been run — it needs a live Neon console session,
which was not available in the environment this was written in. Treat §3
as untested until someone with Neon access runs it once and updates this
line.

This is the "something just broke in production, what do I do in the next
five minutes" document. Longer investigation belongs elsewhere; this file
only covers getting back to a known-good state.

## 1. Application rollback (Vercel)

SK OS deploys as a single Vercel project (root `vercel.json`, combined
frontend + API). Every deploy is immutable and keeps its own URL, so
rolling back does not require a new commit or a revert:

1. Vercel dashboard → the `gym-os` project → **Deployments**.
2. Find the last deployment known to be good (check its commit SHA
   against `git log` if unsure which one that is).
3. Click **⋯ → Promote to Production** on that deployment.
4. Confirm the production domain now serves it: `curl -s
   https://gym-os-nikhaar-fashions-connect.vercel.app/api/health` and check
   the response is healthy, then spot-check the actual app in a browser.

This reverts *code and static assets only*. It does **not** undo a
database migration or reverse any data written by the bad deploy while it
was live — see §2 and §4 for those.

## 2. Database migration rollback

Migrations here are additive and idempotent by design
(`backend/scripts/init-db.js`'s guarded `ALTER TABLE ... ADD COLUMN`
pattern, schema.sql's `CREATE TABLE IF NOT EXISTS`) — there is
deliberately **no automated "down" migration**. If a migration itself is
the problem (wrong column, wrong default):

1. **Do not hand-edit the production database.** Reproduce the fix in
   `database/schema.sql` / `scripts/init-db.js` first, exactly as the
   README's own "Migrations" section already says.
2. Apply the FIX to a disposable copy first: create a throwaway Neon
   branch from the production branch (Neon dashboard → **Branches** →
   **Create branch** from `production` → pick a recent point in time if
   you need pre-migration data), point a local `DATABASE_URL`/`PG_ADMIN_URL`
   at that branch, and run `npm run db:init` there.
3. Only once verified on the throwaway branch, apply the same
   `init-db.js` run against production with the **admin** role
   (`neondb_owner`) — never the runtime role (`skos_app`).
4. If the migration already ran in production and can't simply be
   re-applied forward (e.g. it needs an actual column drop or type
   change), that's a hand-written, reviewed migration of its own —
   not a rollback shortcut. Do not `DROP COLUMN` on production without a
   second person reviewing it first; a column drop is the one kind of
   schema change this codebase's additive-migration convention has no
   safety net for.

## 3. Full data restore (Neon point-in-time recovery) — UNTESTED, run the drill before trusting this

Neon retains point-in-time recovery for a configurable window (check the
current retention setting in the Neon console — README says this should
be enabled and verified with a restore drill, which is exactly this
section).

1. Neon dashboard → the project → **Backups / Restore**.
2. Pick the timestamp to restore to (immediately before the incident).
3. Restore to a **new branch**, never directly over `production` — this
   gives you a inspectable copy first.
4. Validate the restored branch: `DATABASE_URL=<restored branch, skos_app
   role> PG_ADMIN_URL=<restored branch, neondb_owner role> npm run
   pg:validate` should still pass 8/8.
5. Only after validating, either point production's `DATABASE_URL` at the
   restored branch (fast, but means the branch naming/URL changes) or use
   Neon's own "restore this branch" action if the console offers restoring
   `production` in place to that point in time (check current Neon UI —
   this has changed across Neon product versions).
6. **Run this drill once against a disposable branch, outside of a real
   incident, and update this file's status line with the date and result.**
   An unrehearsed restore procedure is not a real safety net.

## 4. Payments-specific rollback

Because payments are gated behind `config.js`'s boot-time check
(`PAYMENT_PROVIDER=razorpay` requires all three Razorpay env vars, or the
app reports `provider: 'none'` and every payment route returns a
controlled 503 — see `services/payments/paymentProvider.js`), the fastest
"stop the bleeding" action for a payments-specific incident is:

1. Vercel dashboard → the project's **Environment Variables**.
2. Unset `PAYMENT_PROVIDER` (or set it to anything other than `razorpay`)
   for the Production environment.
3. Redeploy (or trigger a redeploy from the same commit — no code change
   needed).
4. Payments are now cleanly disabled (`503 payments_not_configured` on
   every payment route) instead of possibly processing against a
   misbehaving integration. Nothing else in the app depends on payments,
   so this does not take down the rest of the product.
5. Restore the three Razorpay env vars once the underlying issue is
   understood and fixed.

## 5. Who to notify / what to record

This repo has no external error-tracking or on-call/alerting tool wired
in as of this writing (see `docs/RLS-BOUNDARY.md`-adjacent remediation
notes) — a production incident is only visible via Vercel function logs
and the `events` table's `server_error` rows today. Until that's in
place: check both of those first when something is reported broken, and
record what happened and the fix in a dated entry at the bottom of this
file so the next person (or the next incident) has a real precedent to
work from.

---

*No incidents recorded yet.*
