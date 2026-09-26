// ============================================================
// PROVIDER ADAPTERS — one shape, many vendors, no pretending.
//
// The gym access market is a long tail: ZKTeco, ESSL, Matrix, Hikvision,
// Suprema, a dozen local attendance packages, and whatever the gym's
// existing software happens to be. Hard-coding any one of them is how
// this feature becomes unshippable to the next customer.
//
// So every integration implements the same interface, and declares which
// parts of it are real. THE CAPABILITY FLAGS ARE LOAD-BEARING: the owner
// UI renders only what the adapter actually implements. A "Sync members"
// button that throws "not supported" when pressed is worse than no
// button, because the owner has already changed their plans around it.
//
// WHAT AN ADAPTER MUST NEVER DO: return, log, or accept biometric
// material. The interface has no method that takes a template and no
// method that returns one. Enrollment stays on the vendor's side; we
// exchange opaque identifiers and events.
// ============================================================

/**
 * The full capability surface. An adapter spreads DEFAULT_CAPABILITIES and
 * turns on only what it has. Everything is off by default, so a new
 * adapter under-promises rather than over-promises.
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  supportsOAuth: false,
  supportsApiKey: false,
  supportsWebhooks: false,
  supportsPolling: false,
  supportsDeviceStatus: false,
  supportsHistoricalImport: false,
  supportsMemberSync: false,
  supportsAccessPermissionSync: false,
  supportsBranchMapping: false,
  supportsEntryExitEvents: false,
  supportsTestConnection: false,
});

/**
 * Every method an adapter MAY implement. None is required; the registry
 * refuses to call one the adapter did not declare a capability for, so an
 * adapter cannot accidentally be relied on for something it stubs.
 *
 *   testConnection(ctx)                 -> { ok, message, details? }
 *   listDevices(ctx)                    -> [{ externalId, name, type, direction }]
 *   getDeviceStatus(ctx, externalId)    -> { online, lastSeenAt }
 *   fetchEvents(ctx, { since, limit })  -> [normalized event]
 *   fetchHistoricalEvents(ctx, { from, to })
 *   fetchMembers(ctx)                   -> [{ externalUserId, name?, email? }]
 *   updateAccessPermission(ctx, { externalUserId, allowed }) -> { ok }
 *   verifyWebhook(ctx, { headers, rawBody }) -> { ok, reason? }
 *   normalizeEvent(ctx, payload)        -> normalized event | null
 *   getProviderHealth(ctx)              -> { state, detail }
 */

const registry = new Map();

export function registerProvider(adapter) {
  if (!adapter?.key) throw new Error('provider adapter needs a key');
  registry.set(adapter.key, {
    ...adapter,
    capabilities: { ...DEFAULT_CAPABILITIES, ...(adapter.capabilities || {}) },
  });
}

/**
 * What THIS connection can actually do.
 *
 * An adapter's flags say what it is capable of in principle; a REST
 * connection without a permission URL still cannot push access changes.
 * `requiresConfig` maps a capability to the config key it depends on, and
 * this turns the flag off when that key is missing -- so the owner UI,
 * which renders from these, never offers a control that would fail.
 */
export function effectiveCapabilities(adapter, config = {}) {
  if (!adapter) return { ...DEFAULT_CAPABILITIES };
  const caps = { ...adapter.capabilities };
  for (const [cap, key] of Object.entries(adapter.requiresConfig || {})) {
    if (!config || !config[key]) caps[cap] = false;
  }
  return caps;
}

export function getProvider(key) {
  return registry.get(key) || null;
}

/** Everything the owner can choose from, with what each one can actually do. */
export function listProviders() {
  return [...registry.values()].map((p) => ({
    key: p.key,
    name: p.name,
    kind: p.kind,
    description: p.description,
    authType: p.authType,
    requiredFields: p.requiredFields || [],
    capabilities: p.capabilities,
    // Set on adapters that exist as a shape but have no vendor
    // implementation behind them yet. The UI shows these as "adapter not
    // yet configured" rather than offering a Connect button that cannot
    // work -- see the master spec's rule about never claiming support for
    // a provider whose adapter does not exist.
    implemented: p.implemented !== false,
    docsUrl: p.docsUrl || null,
  }));
}

/**
 * Call a capability, refusing when the adapter has not declared it.
 *
 * This is the guard that makes the capability flags mean something: a
 * route cannot reach a half-written method by accident, and the error a
 * caller gets names the provider and the capability rather than being a
 * TypeError about undefined.
 */
export async function invoke(providerKey, capability, method, ctx, ...args) {
  const adapter = getProvider(providerKey);
  if (!adapter) throw Object.assign(new Error(`Unknown provider "${providerKey}"`), { status: 404 });
  if (capability && !adapter.capabilities[capability]) {
    throw Object.assign(
      new Error(`${adapter.name} does not support ${capability.replace(/^supports/, '')}`),
      { status: 400, code: 'capability_unsupported' });
  }
  if (typeof adapter[method] !== 'function') {
    throw Object.assign(
      new Error(`${adapter.name} declares ${capability} but does not implement ${method}()`),
      { status: 501, code: 'adapter_incomplete' });
  }
  return adapter[method](ctx, ...args);
}

export default { registerProvider, getProvider, listProviders, invoke, effectiveCapabilities, DEFAULT_CAPABILITIES };
