# Coupon & Discount Management

Founder-issued discount codes for both things Barbell sells:

* **Enterprise**: a gym's own Barbell subscription (package, upgrade or
  downgrade, capacity add-on), bought by the gym owner.
* **Independent**: the Barbell plan (₹59 a month or ₹590 a year), bought by
  an Independent client (someone using Barbell without a gym).

Founders create and manage coupons in the Admin OS (**Coupon Management**).
Gym owners and Independent clients enter them at checkout. The server works
out every discount. The discounted total is the amount the payment gateway is
asked to charge, and nothing the browser sends can change it.

## Architecture: one engine, two checkouts

There is one coupon engine (`backend/src/services/coupons/couponEngine.js`)
and one payment pipeline per checkout that already existed. There is no second
pricing or payment path.

| | Enterprise checkout | Independent checkout |
|---|---|---|
| Routes | `routes/enterprise.js` | `routes/plan.js` |
| Price lock | `billing_quotes` row | `barbell_plan_orders` row |
| Payment record | `payment_orders` → `_finalizeOrder` (`paymentActivation.js`) | `barbell_plan_orders` → `activatePlanOrder` (`barbellPlan.js`) |
| Pricing | `priceWithCoupons()` | `priceWithCoupons()` (kind `BARBELL_PLAN`) |
| Hold | `reserveQuoteCoupons()` (key `quote_id`) | `reservePlanOrderCoupons()` (key `plan_order_id`) |
| Redeem | `redeemOrderCoupons()` | `redeemPlanOrderCoupons()` |
| Release | `releaseOrderCoupons()`, `releaseQuoteReservations()` | `releasePlanOrderCoupons()` |
| The customer | the gym (`org_id`) | the person (`user_id`) |

Both share the eligibility rules, the integer-paise discount maths, the hold
TTL and sweep, the redemption guards and the analytics.

### Who the customer is

The customer **type** always comes from `organizations.type` of the
authenticated org: `gym` is Enterprise and `independent` is Independent.
Nothing in a request can change it.

The customer **identity**, which per-customer limits, first-time-only and
"unique customers" count, depends on what is bought:

* **Gym purchase:** the gym (`org_id`, slot `customer_slot`).
* **Barbell plan:** the person (`user_id`, slot `user_slot`). Every
  Independent client belongs to the one shared `independent` org, so a
  per-org limit would mean one use for all of them.

## Lifecycle

### Enterprise

| Step | Endpoint | What happens to the coupon |
|---|---|---|
| Apply | `POST /api/enterprise/billing/quote { couponCodes }` | Validated, and the discount is locked into the quote (`discount_amount`, `coupons_json`). Nothing is held. |
| Proceed | `POST /api/enterprise/payment/order { quoteId }` | Re-checked, then **held**: a `coupon_redemptions` row in `RESERVED`, and `coupons.reserved_count + 1`. The gateway order is for `quote.total`. |
| Paid | checkout signature, signed webhook, or reconciliation recovery | In `_finalizeOrder`'s SUCCESS transaction, **before** activation: redeemed (see [Redemption](#redemption-and-late-confirmations)). |
| Failed / cancelled / disputed | webhook | `RESERVED → RELEASED`. |
| Abandoned | — | Expires after 30 min (`RESERVATION_TTL_MS`), swept lazily (`EXPIRED`). |

### Independent (Barbell plan)

| Step | Endpoint | What happens to the coupon |
|---|---|---|
| Apply | `POST /api/plan/quote { plan, couponCodes }` | Validated and priced. Nothing is held. |
| Proceed | `POST /api/plan/order { plan, couponCodes }` | Priced **again** on the server (Apply is never trusted). The plan order stores `original_amount`, `discount_amount` and `coupons_json`, every coupon is held, and only then is the gateway order created for the discounted `amount`. If a coupon stopped being valid since Apply, the request fails with `409 coupon_unavailable`, never a silent full price. |
| Checkout closed | `POST /api/plan/order/:id/cancel` | The hold is released at once (`checkout_closed`), so the client can retry. The order stays payable. |
| Paid | `POST /api/plan/verify` (signature) or signed webhook | In the one transaction that moves the plan order `CREATED → SUCCESS`, only for the call whose guarded update won: redeemed. |
| Failed / cancelled / disputed, or wrong amount | webhook | `RESERVED → RELEASED`. The order stays `CREATED`, because Razorpay lets the client retry on the same order. |
| Abandoned | — | Same 30-minute TTL and sweep. |

### Holds

* A hold is created only when a gateway order is about to exist, never at
  Apply.
* **The global limit** is a conditional `UPDATE` on the coupon row, with
  `redemption_count + reserved_count < max_redemptions` in the `WHERE`.
* **The per-customer limit** is the lowest free slot under a `UNIQUE`
  constraint: `(coupon_id, org_id, customer_slot)` or
  `(coupon_id, user_id, user_slot)`. A slot is freed when its hold ends.
* Both are atomic on SQLite and PostgreSQL, so concurrent checkouts cannot
  exceed either limit.
* Holding is all-or-nothing across stacked coupons.

### Redemption and late confirmations

A verified payment redeems its holds inside the transaction that confirms
the purchase, **before** anything is activated. That transaction runs once
per order: `_finalizeOrder`'s guarded `UPDATE`, or the plan's
`CREATED → SUCCESS` update. So duplicate webhooks, and a webhook racing the
checkout return, redeem exactly once.

* **On time** (hold still `RESERVED`): the unit moves from `reserved_count`
  to `redemption_count`.
* **Late** (hold already `RELEASED` or `EXPIRED`): the checkout was closed,
  the attempt failed, or it sat past the TTL, so its unit went back to the
  pool. A late payment **re-claims the coupon within its limits**, with
  exactly the guards a new hold uses: the global counter in the `WHERE`, and
  a free per-customer slot under its `UNIQUE` constraint, in a `SAVEPOINT`.
  * **It fits:** the coupon is `REDEEMED` with `late_confirmation = 1`, and
    the purchase activates.
  * **It doesn't fit** (the last use, or the customer's own allowance, was
    taken meanwhile): **nothing is redeemed and the purchase is not
    activated.** It is *held for review*:
    * A gym order becomes `DISPUTED` (money received, not activated, the
      same state an amount mismatch gets). The verify call answers `409
      payment_held_for_review`.
    * A plan order keeps `status = 'CREATED'` with `review_reason` set, and
      no time is granted. `/plan/verify` answers `409
      payment_held_for_review`.
    * Every hold on the purchase gets `release_reason = 'held_for_review'`.
    * An `OPEN` reconciliation issue is opened (Admin OS → Reconciliation,
      note `COUPON_LIMIT_AFTER_PAYMENT: …`).
    * The decision is **sticky**: every later callback for that payment
      (another webhook, a repeated verify) gets the same answer without
      re-checking limits. Nothing can activate it except a founder.

**Reconciliation policy for a held payment.** A founder either:

1. **Refunds** the payment through Razorpay (Admin OS → Refunds for a gym
   order), then resolves the issue, or
2. **Honours** it by hand: activates the purchase manually and accepts the
   coupon going one past its limit, then resolves the issue with a note.

The customer was told *"Your payment went through, but the coupon was used up
before the payment was confirmed, so your purchase is on hold. We'll refund
it or honour it shortly. Please don't pay again."*

**A coupon limit is never exceeded automatically.** The earlier behaviour,
recording a late payment even when it took the coupon past its limit, is
gone.

A **refunded** gym order is never re-activated by a later callback for its
payment. `_finalizeOrder` will not move `REFUNDED` or `PARTIALLY_REFUNDED` to
`SUCCESS`.

### Coupons never make a purchase free

Percentages must be below 100%, and no discount can take a total below ₹1.
A ₹0 Enterprise quote would otherwise go down the no-payment "free change"
activation path. All discount maths is in integer paise.

## Rules enforced server-side

The checks run in this order:

1. The code exists.
2. The coupon is enabled.
3. The start/expiry window.
4. Customer type.
5. Purchase type, capacity tier and billing duration.
6. Minimum purchase.
7. Total and per-customer limits.
8. First-time-only.
9. Stacking.

* **Customer type**: `ENTERPRISE`, `INDEPENDENT` or `BOTH`.
* **Purchase types** (`applicable_kinds`): `ORG_PACKAGE`, `ORG_UPGRADE`,
  `ORG_CAPACITY_ADDON` and `BARBELL_PLAN`. No restriction means every type,
  the plan included. An Enterprise-only coupon cannot name `BARBELL_PLAN`:
  the form leaves it out and the server refuses it.
* **Capacity tiers** are `sk_packages.name`. A custom capacity belongs to the
  tier it is priced from, and an add-on follows the gym's current tier. The
  Barbell plan has no tier, so a tier-limited coupon never applies to it.
* **Billing durations**: the gym packages' durations, plus the plan's 30 days
  (monthly) and 365 days (yearly).
* **First-time-only**: a gym that has never completed a paid package
  purchase, or a person who has never paid for a plan.
* **Stacking**: up to 3 codes, and only if every one allows stacking. Each
  applies to what is left after the previous one.
* **Rate limits** on coupon attempts:
  * Gym checkout: 8 per 10 minutes per user, and 30 per hour per gym.
  * Plan checkout: 8 per 10 minutes per person. There is no per-org limit,
    which on the shared org would let a few people use up everyone's
    attempts.
  * Rejections are logged as `coupon_rejected` events (code and reason
    only).
* Customer responses never include founder notes, internal names, usage
  counts or internal coupon ids.

## Admin OS

`/api/console/coupons` is mounted inside `routes/console.js`, behind its
router-level `requireAuth + requireRole('SUPER_ADMIN')` and rate limit. Every
endpoint is founder-only on the server; the Admin OS hiding links is not the
control. Every mutation writes `admin_audit_logs` in the same transaction.

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | Dashboard: counts, verified redemptions split Enterprise / Independent, discount given, gross / refunded / net revenue (gym and plan orders) |
| GET | `/options` | Purchase types (with `BARBELL_PLAN`), tiers, durations, the plan's prices for the preview, timezones |
| GET | `/` | List: `search`, `status`, `customerType`, `createdFrom`, `createdTo`, `sort`, `dir`, `limit`, `offset` |
| GET | `/export` | All coupons as CSV |
| POST | `/` | Create |
| GET | `/:id` | Coupon + analytics |
| POST | `/:id` | Edit (full form) |
| POST | `/:id/disable`, `/:id/enable` | Kill switch, and turning it back on |
| DELETE | `/:id` | Only while the coupon has never been held or redeemed |
| GET | `/:id/redemptions`, `/:id/redemptions/export` | History and CSV (`status=REDEEMED` by default, or `ALL`) |

**The form** creates, edits and duplicates coupons (`/coupons/new?from=:id`).
It covers percentage or fixed discounts, an optional cap and minimum,
validity in the coupon's timezone, total and per-customer limits,
first-time-only, stacking, Enterprise / Independent / Both, purchase types
(including the Barbell plan), tiers and durations. Its live preview works on
a gym tier or the Barbell plan. Once a coupon has any activity, its code,
discount type and value, cap and customer type are locked; to change those,
duplicate it.

**Analytics** come from `REDEEMED` rows only (verified payments):

* Redemptions, split into Enterprise and Independent.
* Unique customers, counting gyms by org and Independent clients by person.
* Total original value, total discount and revenue collected.
* Refunded revenue.
* Late confirmations.
* Separately and never counted: in-flight holds, failed or abandoned
  checkouts, and payments held for review.

**Redemption history** lists each row's gym or client, customer type,
purchase (package, add-on or Barbell plan, and its id), original amount,
discount, amount paid, the payment reference and invoice / `BBL-…` receipt
number, and status ("Paid — held for review" included).

## Data model

* **`coupons`**: platform-level, with no `org_id` and no RLS (like
  `sk_packages`). Codes are stored uppercase and `UNIQUE`, so they are
  case-insensitive. Status is derived, never stored.
* **`coupon_redemptions`**: org-scoped, with RLS `tenant_isolation`. One row
  per (coupon, purchase).
  * The hold key is `quote_id` (gym) or `plan_order_id` (plan), so both are
    nullable.
  * `user_id` and `user_slot` are set only on plan purchases.
  * `subject_type` is `ORG_PACKAGE`, `ORG_CAPACITY_ADDON` or `BARBELL_PLAN`.
  * `release_reason = 'held_for_review'` marks a held payment.
  * `ON DELETE SET NULL` on `user_id` and `plan_order_id`: deleting an
    account keeps the redemption snapshot.
* **`billing_quotes.discount_amount`, `.coupons_json`**: guarded columns.
* **`barbell_plan_orders.original_amount`, `.discount_amount`,
  `.coupons_json`, `.review_reason`**: guarded columns. `amount` stays what
  the gateway is asked for.

## Deployment requirements

### Why the 5 Nov `gym-os` production deploy failed

Commit `824d7b3` (the Enterprise coupons) was pushed to `main`, which deploys
production. On Vercel, **Admin OS deployed** (its build has no database
gate), and **`gym-os` failed**.

* **Exact cause:** reproduced locally; the Vercel log itself needs a Vercel
  login.
  * `gym-os` builds with `npm run db:check && npm run build`, and nothing
    else in the build changed since the last successful deploy (`90a9b55`):
    the dependencies, lockfiles, `vercel.json` and `api/` entry are
    identical.
  * Locally, at `824d7b3`, `npm run build` passes and the serverless
    module graph loads.
  * What changed is what `db:check` requires of the production database: two
    new tables (`coupons`, `coupon_redemptions`) and two new columns
    (`billing_quotes.discount_amount`, `billing_quotes.coupons_json`).
  * The migration (`npm run db:init`) had not been run against production,
    so `db:check` refused the deploy, exactly as it is designed to.
* **Effect:** production `gym-os` kept serving `90a9b55`. Production Admin OS
  shows Coupon Management, but its `/api/console/coupons` calls have no
  backend route until `gym-os` deploys.
* **Resolution:** the code needs no fix. The resolution is the deploy order
  below.

### Deploy order (founder approval required)

1. **Migrate production first**, with a DDL-capable role and never the
   restricted runtime role:
   ```bash
   DATABASE_URL=<migration-role URL> npm run db:init
   ```
   * **Idempotent.** On today's production it creates `coupons` and
     `coupon_redemptions` in their final shape, adds `billing_quotes`'
     two columns and `barbell_plan_orders`' four, and re-applies `rls.sql`
     (the `coupon_redemptions` policy). Existing rows are untouched.
   * **Existing `coupon_redemptions`.** On a database that already has one
     from the first coupon release, `scripts/lib/couponRedemptionsUpgrade.js`
     adds `plan_order_id`, `user_id` and `user_slot`, makes `quote_id`
     nullable and lets `subject_type` accept `BARBELL_PLAN`. PostgreSQL does
     this in place, in one implicit transaction. SQLite rebuilds the table in
     one transaction, copying every row.
2. **Deploy** (merge to `main`). `db:check` passes once step 1 has run.
3. No new environment variables.

### Rollback

* **Code:** redeploy the previous production deployment in Vercel. The
  schema changes only add columns and relax constraints, so older code runs
  unchanged on the migrated database. Rolling the code back never requires
  rolling the schema back.
* **Schema:** not recommended, and never needed for a code rollback. To stop
  coupons without a deploy, disable them in the Admin OS (the kill switch
  takes effect on the next Apply and the next order).

## Known limitations

* PostgreSQL migration of an existing `coupon_redemptions` has an automated
  test (`couponsBarbellPlan.test.js`, run with `TEST_DATABASE_URL`) but has
  not been run against a real PostgreSQL yet. Production takes the fresh path
  (the tables don't exist there yet).
* A held-for-review payment has no "honour" button: honouring it is a manual
  activation.
* A refund does not give the coupon use back. A plan order counts as
  refunded only if its status is `REFUNDED`, and nothing sets that today:
  plan refunds are made by hand in Razorpay.
* Money columns follow the existing `REAL` convention (`float4` on
  PostgreSQL), which is exact to the paisa below roughly ₹1,00,000. This is
  pre-existing and applies to every amount column.
