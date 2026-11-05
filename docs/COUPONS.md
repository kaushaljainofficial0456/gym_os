# Coupon & Discount Management

Founder-issued discount codes for what Barbell sells: a gym's own Barbell
subscription (Enterprise) and an Independent client's Barbell plan
(₹59 a month or ₹590 a year). Founders create and manage coupons in the
Admin Console (**Coupon Management**); gym owners and Independent clients
enter them at checkout. The server works out the discount, and the
discounted total is the amount the payment gateway is asked to charge.

## How it fits the existing payment flow

Coupons ride on the existing pipeline (`billing_quotes` → `payment_orders` →
Razorpay → `_finalizeOrder`). There is no second pricing or payment path.

| Step | Endpoint | What happens to the coupon |
|---|---|---|
| Apply | `POST /api/enterprise/billing/quote { couponCodes }` | Server validates the code(s) and takes the discount off the **locked quote** (`discount_amount`, `coupons_json`). Nothing is reserved or consumed. |
| Proceed to payment | `POST /api/enterprise/payment/order { quoteId }` | Every coupon is re-checked, then **held**: one `coupon_redemptions` row in `RESERVED`, and `coupons.reserved_count + 1`. The gateway order is for `quote.total`. |
| Payment verified | checkout signature / signed webhook / reconciliation | Inside the same transaction that marks the order `SUCCESS`: `RESERVED → REDEEMED`, `redemption_count + 1`. This is the only status any metric counts. |
| Payment failed / cancelled / disputed | webhook | `RESERVED → RELEASED`, the hold is returned. |
| Abandoned | — | The hold expires 30 min after the order (`RESERVATION_TTL_MS`) and is swept lazily (`EXPIRED`). |

### The Barbell plan (Independent clients)

The plan checkout (`routes/plan.js`, `services/plans/barbellPlan.js`) has no
billing quote: its own `barbell_plan_orders` row is the price lock. It goes
through the same engine functions, keyed on the plan order instead of a quote.

| Step | Endpoint | What happens to the coupon |
|---|---|---|
| Apply | `POST /api/plan/quote { plan, couponCodes }` | Prices the plan (kind `BARBELL_PLAN`) and returns the summary. Nothing is reserved or consumed. |
| Proceed to payment | `POST /api/plan/order { plan, couponCodes }` | Prices it **again** on the server (Apply is never trusted), stores `original_amount`, `discount_amount` and `coupons_json` on the plan order, **holds** every coupon (`coupon_redemptions.plan_order_id`), then creates the gateway order for the discounted `amount`. A coupon that stopped being valid since Apply fails with `409 coupon_unavailable`, never a silent full price. |
| Checkout closed | `POST /api/plan/order/:id/cancel` | The hold is released straight away (`checkout_closed`), so the client can try again. The order stays payable. |
| Payment verified | checkout signature (`/plan/verify`) or signed webhook | Inside the one transaction that moves the plan order `CREATED → SUCCESS`, and only for the call whose guarded update won: `RESERVED → REDEEMED`. |
| Payment failed / cancelled / disputed, or wrong amount | webhook | `RESERVED → RELEASED`. The order stays `CREATED`, because Razorpay lets the client retry on it; a later success is recorded as a late confirmation. |
| Abandoned | — | Expires on the same 30-minute TTL and lazy sweep. |

**Who the customer is.** Every Independent client belongs to the one shared
`independent` org, so a per-customer limit keyed on the org would mean one use
for all of them. On a plan purchase the customer is the **person**: the hold
records `user_id`, the limit is a `UNIQUE (coupon_id, user_id, user_slot)`
slot, "first-time only" means they have never paid for a plan, and the
analytics count unique people. Gym purchases are unchanged (`org_id`,
`customer_slot`). The customer *type* still comes from `organizations.type`,
so an Independent client is always `INDEPENDENT` and an Enterprise-only coupon
is refused.

**What a plan coupon can be limited to.** The purchase type `BARBELL_PLAN`,
and the plan's billing durations (30 days monthly, 365 days yearly). The plan
has no capacity tier, so a coupon limited to tiers never applies to it. An
Enterprise-only coupon cannot name `BARBELL_PLAN` (the form leaves it out and
the server refuses it).

**Rate limits.** The plan checkout's coupon attempts are limited to 8 per 10
minutes per person. It does not use the gym checkout's per-org limit, which on
the shared org would let a few people use up everyone's attempts.

**Receipts.** A plan receipt (`BBL-…`, in the app and as a PDF) shows the
plan's price, a line per coupon and the amount paid, from the order's own
snapshot.

**Concurrency.** The global limit is a conditional `UPDATE` on the coupon row
(`redemption_count + reserved_count < max_redemptions` in the `WHERE`). The
per-customer limit is a `UNIQUE` slot: `(coupon_id, org_id, customer_slot)`
for a gym, `(coupon_id, user_id, user_slot)` for a person buying the plan.
Both are atomic on SQLite and PostgreSQL. Duplicate callbacks are no-ops
because `_finalizeOrder`, and the plan's own `CREATED → SUCCESS` update, only
run their success path once per order.

**Late payments.** If a payment verifies after its hold has already ended,
the customer still paid the discounted price, so the redemption is recorded
with `late_confirmation = 1`. That can take a coupon one past its limit; the
founder sees it in the redemption history.

**Coupons never make a purchase free.** Percentages must be below 100%, and
no discount can take a total below ₹1. A ₹0 quote would otherwise go down the
no-payment "free change" activation path.

## Rules enforced server-side

The checks run in this order: the code exists → the coupon is enabled → the
start/expiry window → customer type → purchase type / capacity tier / billing
duration → minimum purchase → total and per-gym limits → first-time-only → stacking.

* **Customer type** comes from `organizations.type` of the authenticated org
  (`gym` = Enterprise, `independent` = Independent). Nothing in the request
  can change it.
* **Purchase types** (`applicable_kinds`): `ORG_PACKAGE`, `ORG_UPGRADE`,
  `ORG_CAPACITY_ADDON`, and `BARBELL_PLAN` for the Independent clients' plan.
  No restriction means every purchase type, the plan included.
* **Capacity tiers** are `sk_packages.name`. A custom capacity belongs to the
  tier it is priced from, and an add-on follows the gym's current tier.
* **Stacking**: up to 3 codes, and only if every one allows stacking. Each
  discount applies to what is left after the previous one.
* **Rate limits** on coupon attempts: 8 per 10 min per user and 30 per hour
  per gym (per user only on the plan checkout, see above). Rejections are
  logged as `coupon_rejected` events.
* Customer responses never include founder notes, internal names or usage counts.

## Admin Console API (`/api/console/coupons`, SUPER_ADMIN only)

This router is mounted inside `routes/console.js`, so it sits behind that
router's `requireAuth + requireRole('SUPER_ADMIN')` check and rate limit.
Every mutation writes `admin_audit_logs` in the same transaction.

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | Dashboard counts and money (verified redemptions only) |
| GET | `/options` | Purchase types (including `BARBELL_PLAN`), tiers, durations (gym packages and the plan), the plan's prices for the preview, and timezones for the form |
| GET | `/` | List: `search`, `status`, `customerType`, `createdFrom`, `createdTo`, `sort`, `dir`, `limit`, `offset` |
| GET | `/export` | All coupons as CSV |
| POST | `/` | Create |
| GET | `/:id` | Coupon + analytics |
| POST | `/:id` | Edit (full form) |
| POST | `/:id/disable`, `/:id/enable` | Kill switch, and turning it back on |
| DELETE | `/:id` | Only allowed while the coupon has never been held or redeemed |
| GET | `/:id/redemptions`, `/:id/redemptions/export` | History and CSV (`status=REDEEMED` by default, or `ALL`) |

**Editing:** once a coupon has any activity, its code, discount type/value,
cap and customer type are locked. To change those, duplicate it. Past
redemptions are snapshots (original/discount/final) and an edit never
touches them.

## Data model

* `coupons`: platform-level, with no `org_id` and no RLS (like `sk_packages`).
  The code is stored uppercase with `UNIQUE`, which makes it
  case-insensitive. Status is derived, never stored: Active / Scheduled /
  Expired / Exhausted come from the clock and the counters, and Disabled
  from `is_enabled`.
* `coupon_redemptions`: org-scoped, with an RLS `tenant_isolation` policy.
  One row per (coupon, purchase). The hold key is `quote_id` for a gym
  purchase or `plan_order_id` for a Barbell plan, so both are nullable.
  `user_id` and `user_slot` are set only on a plan purchase, whose customer
  is a person. `subject_type` is `ORG_PACKAGE`, `ORG_CAPACITY_ADDON` or
  `BARBELL_PLAN`. A plan redemption's `org_id` is the shared `independent`
  org, so the RLS policy applies to it unchanged.
* `billing_quotes.discount_amount`, `billing_quotes.coupons_json`: guarded
  migration columns.
* `barbell_plan_orders.original_amount`, `.discount_amount`, `.coupons_json`:
  guarded migration columns. `amount` stays what the gateway is asked for (the
  discounted price).

## Deploying

1. Run the migration **before** deploying the code. It must use a
   DDL-capable role, never the restricted runtime role:
   ```bash
   DATABASE_URL=<migration-role URL> npm run db:init
   ```
   This is idempotent. It creates the two tables and adds the two
   `billing_quotes` columns and the three `barbell_plan_orders` columns, and
   existing rows are untouched. On a database that already has
   `coupon_redemptions` from before the plan took coupons,
   `scripts/lib/couponRedemptionsUpgrade.js` adds `plan_order_id`, `user_id`
   and `user_slot` and relaxes two constraints: `quote_id` becomes nullable,
   and `subject_type` also accepts `BARBELL_PLAN`. PostgreSQL does this in
   place. SQLite cannot, so it rebuilds the table in one transaction, copying
   every row. Both runs are guarded, so a second run changes nothing. It also
   re-applies `rls.sql`, which adds the `coupon_redemptions` policy.
2. Deploy. The `db:check` build step refuses to deploy until step 1 has run.
3. No new environment variables.

## Known limitations

* A refund does not give the coupon use back. Refunded revenue is shown
  separately in the analytics. A plan order counts as refunded only if its
  status is `REFUNDED`, and nothing sets that today: plan refunds are made
  by hand in Razorpay.
* A failed payment releases a plan coupon's hold while the plan order stays
  payable. If the client then retries on the same order and it succeeds, the
  redemption is recorded as a late confirmation, which can take a coupon one
  past its limit. Gym checkouts behave the same way.
* Money columns follow the existing `REAL` convention, which is `float4` on
  PostgreSQL. That is exact to the paisa below roughly ₹1,00,000. This is
  pre-existing and applies to every amount column, not just coupons.
