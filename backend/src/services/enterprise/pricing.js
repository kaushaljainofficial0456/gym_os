// ============================================================
// SK OS PACKAGE / PRICING ENGINE — fully admin-configurable, versioned.
//
// ALGORITHM (confirmed against the spec's own worked examples, which
// take precedence over its prose where the two read ambiguously):
//   - An EXACT match to a base tier's own capacity pays that tier's
//     exact price (75 clients -> the 75-tier price, no arithmetic).
//   - A capacity AT OR BELOW the smallest configured tier pays that
//     tier's price as a floor (wanting fewer clients than the smallest
//     tier doesn't get a discount).
//   - A capacity ABOVE a tier's own capacity but within that tier's
//     pricing rule's max_capacity: base tier's price + (requested -
//     base tier's capacity) x that rule's additional_client_rate.
//     Example: 80 clients = 75-tier price (Rs.12,000) + 5 x
//     configured rate (Rs.155) = Rs.12,775. NEVER hardcoded -- every
//     number here is read from sk_packages/sk_pricing_rules.
//   - A capacity beyond the largest configured rule's max_capacity is
//     refused outright (spec: "Do NOT silently assume the pricing
//     formula") rather than extrapolated.
//
// PRICING VERSIONING: every sk_packages/sk_pricing_rules row is
// versioned with effective_from/effective_until. "Current" = the row
// for a given name/base_package with effective_until IS NULL. An org's
// own org_subscriptions.price/package_id are captured ONCE at purchase
// time and never recalculated when an admin later changes current
// pricing -- see enterprise.js.
// ============================================================

/** Returns every currently-effective base package, ascending by capacity. */
export async function getCurrentPackages(db) {
  return db.q(`SELECT * FROM sk_packages WHERE status = 'active' AND effective_until IS NULL ORDER BY client_capacity ASC`);
}

/** Returns every currently-effective additional-client pricing rule. */
export async function getCurrentPricingRules(db) {
  return db.q(`SELECT * FROM sk_pricing_rules WHERE status = 'active' AND effective_until IS NULL ORDER BY max_capacity ASC`);
}

export async function getCurrentCapacityAddons(db) {
  return db.q(`SELECT * FROM sk_capacity_addons WHERE status = 'active' AND effective_until IS NULL ORDER BY increment ASC`);
}

/**
 * Calculates the price for a requested client capacity against the
 * CURRENT pricing configuration. Returns
 * { ok: true, capacity, price, currency, basePackage, breakdown } or
 * { ok: false, reason }. Never guesses beyond what's configured.
 */
export async function calculatePackagePrice(db, requestedCapacity) {
  const capacity = Number(requestedCapacity);
  if (!Number.isInteger(capacity) || capacity < 1) return { ok: false, reason: 'invalid_capacity' };

  const packages = await getCurrentPackages(db);
  if (!packages.length) return { ok: false, reason: 'no_packages_configured' };

  // Exact tier match -- pay that tier's own price, no arithmetic.
  const exact = packages.find((p) => p.client_capacity === capacity);
  if (exact) {
    return { ok: true, capacity, price: exact.price, currency: exact.currency, basePackage: exact, breakdown: { base: exact.price, additional: 0, additionalClients: 0, rate: 0 } };
  }

  const smallest = packages[0];
  if (capacity <= smallest.client_capacity) {
    return { ok: true, capacity, price: smallest.price, currency: smallest.currency, basePackage: smallest, breakdown: { base: smallest.price, additional: 0, additionalClients: 0, rate: 0 } };
  }

  const rules = await getCurrentPricingRules(db);
  // The nearest LOWER tier whose rule's max_capacity still covers this
  // request -- i.e. among packages strictly below `capacity`, the one
  // with the largest client_capacity, provided a rule exists for it
  // that reaches this far.
  const candidateBases = packages.filter((p) => p.client_capacity < capacity).sort((a, b) => b.client_capacity - a.client_capacity);
  for (const base of candidateBases) {
    const rule = rules.find((r) => r.base_package_id === base.id && r.max_capacity >= capacity);
    if (rule) {
      const additionalClients = capacity - base.client_capacity;
      const additional = additionalClients * rule.additional_client_rate;
      return {
        ok: true, capacity, price: base.price + additional, currency: base.currency, basePackage: base, pricingRule: rule,
        breakdown: { base: base.price, additional, additionalClients, rate: rule.additional_client_rate },
      };
    }
  }
  return { ok: false, reason: 'capacity_exceeds_configured_range' };
}

/** Effective cost-per-client, for the package UI's "Rs.X/client" line. */
export function effectiveCostPerClient(price, capacity) {
  return capacity > 0 ? Math.round((price / capacity) * 100) / 100 : 0;
}
