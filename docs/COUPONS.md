# Coupon & Discount Management

Founder-issued discount codes for a gym's own Barbell subscription. Founders
create and manage coupons in the Admin Console (**Coupon Management**); gym
owners enter them at checkout. The server works out the discount, and the
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

**Concurrency.** The global limit is a conditional `UPDATE` on the coupon row
(`redemption_count + reserved_count < max_redemptions` in the `WHERE`). The
per-gym limit is a `UNIQUE (coupon_id, org_id, customer_slot)` slot. Both are
atomic on SQLite and PostgreSQL. Duplicate callbacks are no-ops because
`_finalizeOrder` only runs its success path once per order.

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
* **Capacity tiers** are `sk_packages.name`. A custom capacity belongs to the
  tier it is priced from, and an add-on follows the gym's current tier.
* **Stacking**: up to 3 codes, and only if every one allows stacking. Each
  discount applies to what is left after the previous one.
* **Rate limits** on coupon attempts: 8 per 10 min per user and 30 per hour
  per gym. Rejections are logged as `coupon_rejected` events.
* Customer responses never include founder notes, internal names or usage counts.

## Admin Console API (`/api/console/coupons`, SUPER_ADMIN only)

This router is mounted inside `routes/console.js`, so it sits behind that
router's `requireAuth + requireRole('SUPER_ADMIN')` check and rate limit.
Every mutation writes `admin_audit_logs` in the same transaction.

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | Dashboard counts and money (verified redemptions only) |
| GET | `/options` | Purchase types, tiers, durations and timezones for the form |
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
  One row per (coupon, quote).
* `billing_quotes.discount_amount`, `billing_quotes.coupons_json`: guarded
  migration columns.

## Deploying

1. Run the migration **before** deploying the code. It must use a
   DDL-capable role, never the restricted runtime role:
   ```bash
   DATABASE_URL=<migration-role URL> npm run db:init
   ```
   This is idempotent. It creates the two tables and adds the two
   `billing_quotes` columns, and existing rows are untouched. It also
   re-applies `rls.sql`, which adds the `coupon_redemptions` policy.
2. Deploy. The `db:check` build step refuses to deploy until step 1 has run.
3. No new environment variables.

## Known limitations

* **The Independent clients' Barbell plan doesn't take coupons yet.** That
  checkout (`routes/plan.js`, `barbell_plan_orders`) is separate from the
  gym billing quotes and has its own confirm path, so coupons aren't wired
  into it. The engine fully supports `INDEPENDENT`/`BOTH` coupons and the
  form warns about this, but an Independent-only coupon can't be redeemed
  until that checkout prices through `priceWithCoupons()` and holds/redeems
  the same way.
* A refund does not give the coupon use back. Refunded revenue is shown
  separately in the analytics.
* Money columns follow the existing `REAL` convention, which is `float4` on
  PostgreSQL. That is exact to the paisa below roughly ₹1,00,000. This is
  pre-existing and applies to every amount column, not just coupons.
