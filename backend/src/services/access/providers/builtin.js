// ============================================================
// THE ADAPTERS THAT ACTUALLY EXIST.
//
// Three, and they are chosen so that a gym can be running today without
// waiting for anyone to write vendor code:
//
//   demo             — a sandbox with no hardware. Owner-only, clearly
//                      labelled, and its events are tagged source='demo'
//                      so they can be told apart from real ones forever.
//   generic_webhook  — anything that can POST JSON at a URL. This covers
//                      most modern access panels and every gym-software
//                      integration that offers outbound hooks, and it is
//                      the path a vendor adapter would use anyway.
//   generic_rest     — anything with a pollable HTTP endpoint, with the
//                      owner mapping its field names onto ours.
//
// WHAT IS DELIBERATELY ABSENT: named vendor adapters. ZKTeco, ESSL,
// Matrix, Hikvision and Suprema each need real credentials, a real device
// on a bench and their actual API documentation to build against. Listing
// them here with a Connect button, backed by a guess at their payload
// shape, would be claiming support this codebase does not have -- so they
// are advertised through listProviders() as unimplemented, with the
// generic paths offered instead. That is a product decision, not an
// oversight.
//
// No adapter here touches biometric data. The demo one invents opaque
// member ids; the generic ones read whatever identifier the vendor sends.
// ============================================================
import { createHmac, timingSafeEqual } from 'node:crypto';
import { registerProvider } from './index.js';
import { readSecret } from '../secrets.js';
import { safeFetch } from '../safeUrl.js';

/* ── demo ──────────────────────────────────────────────────────────── */

registerProvider({
  key: 'demo',
  name: 'Demo / Sandbox',
  kind: 'sandbox',
  authType: 'none',
  description:
    'Simulated entries and exits for trying the feature without hardware. '
    + 'Demo events are permanently tagged as demo data and never mix with real attendance.',
  requiredFields: [],
  capabilities: {
    supportsWebhooks: false,
    supportsPolling: false,
    supportsAccessPermissionSync: true,
    supportsDeviceStatus: true,
    supportsEntryExitEvents: true,
    supportsTestConnection: true,
    supportsBranchMapping: true,
  },
  async testConnection() {
    // Honest: there is nothing to reach, and saying so is the point.
    return { ok: true, message: 'Demo provider is always available. No device is contacted.' };
  },
  async getDeviceStatus() {
    return { online: true, lastSeenAt: new Date().toISOString(), simulated: true };
  },
  /* Lets an owner watch the membership-to-door sync flow end to end
     without hardware. Always succeeds and always says it is simulated --
     the result is recorded as a sync to a demo connection, never as proof
     that a real door was updated. */
  async updateAccessPermission(_ctx, { externalUserId, allowed }) {
    return { ok: true, simulated: true, message: `Demo: ${externalUserId} would be ${allowed ? 'allowed' : 'denied'}.` };
  },
});

/* ── generic webhook ───────────────────────────────────────────────── */

/**
 * Timing-safe HMAC comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak
 * whether the length was right -- so lengths are compared first and an
 * early return is the same in both cases.
 */
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/* How long a signed webhook stays valid. Beyond this a captured request
   cannot be replayed, which is the other half of signature verification
   -- a valid signature on a request from last Tuesday is still a replay. */
export const WEBHOOK_MAX_SKEW_SEC = 300;

registerProvider({
  key: 'generic_webhook',
  name: 'Webhook (any provider)',
  kind: 'webhook',
  authType: 'hmac',
  description:
    'Any access system or gym software that can POST a JSON event to a URL. '
    + 'SK OS gives you an endpoint and a signing secret; you map your fields to ours.',
  requiredFields: [
    { key: 'webhook_secret', label: 'Signing secret', secret: true, generated: true,
      help: 'Used to sign each request. Generated for you — copy it once; it is never shown again.' },
  ],
  capabilities: {
    supportsWebhooks: true,
    supportsEntryExitEvents: true,
    supportsBranchMapping: true,
    supportsTestConnection: true,
  },

  async testConnection(ctx) {
    /* A webhook provider cannot be "tested" by calling out -- traffic
       flows the other way. So this reports readiness honestly rather than
       inventing a success: configured, and whether anything has ever
       arrived. Returning ok:true with "no events yet" would let an owner
       believe a broken integration is working. */
    const hasSecret = !!(await readSecret(ctx.db, { providerId: ctx.provider.id, kind: 'webhook_secret' }));
    if (!hasSecret) {
      return { ok: false, message: 'No signing secret is set. Generate one before pointing your device at this URL.' };
    }
    if (!ctx.provider.last_event_at) {
      return {
        ok: false,
        message: 'Endpoint is ready and signed, but no event has arrived yet. '
          + 'Send a test event from your access system to finish setup.',
        details: { awaitingFirstEvent: true },
      };
    }
    return { ok: true, message: `Last event received ${ctx.provider.last_event_at}.` };
  },

  /**
   * Verify signature AND freshness.
   *
   * Signed over `${timestamp}.${rawBody}` rather than the body alone, so
   * the timestamp cannot be edited without breaking the signature -- which
   * is what makes the replay window enforceable at all.
   */
  async verifyWebhook(ctx, { headers, rawBody }) {
    const secret = await readSecret(ctx.db, { providerId: ctx.provider.id, kind: 'webhook_secret' });
    if (!secret) return { ok: false, reason: 'no signing secret configured' };

    const sig = headers['x-skos-signature'] || headers['X-SKOS-Signature'];
    const ts = headers['x-skos-timestamp'] || headers['X-SKOS-Timestamp'];
    if (!sig || !ts) return { ok: false, reason: 'missing signature or timestamp header' };

    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > WEBHOOK_MAX_SKEW_SEC) {
      return { ok: false, reason: 'timestamp outside the accepted window (possible replay)' };
    }

    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    if (!safeEqualHex(sig, expected)) return { ok: false, reason: 'signature mismatch' };
    return { ok: true };
  },

  normalizeEvent: normalizeWithFieldMap,
});

/* ── generic REST (polling) ────────────────────────────────────────── */

/** Pull the event list out of whatever envelope the vendor uses. */
function extractEvents(json, path) {
  if (Array.isArray(json)) return json;
  if (path) {
    const v = String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
    if (Array.isArray(v)) return v;
  }
  for (const k of ['events', 'data', 'items', 'results', 'records', 'logs']) {
    if (Array.isArray(json?.[k])) return json[k];
  }
  return null;
}

async function authHeaders(ctx) {
  const key = await readSecret(ctx.db, { providerId: ctx.provider.id, kind: 'api_key' });
  return key ? { Authorization: `Bearer ${key}` } : {};
}

registerProvider({
  key: 'generic_rest',
  name: 'REST API (polling)',
  kind: 'rest',
  authType: 'api_key',
  description:
    'Any access system with an HTTP endpoint that lists events. SK OS polls it on a schedule '
    + 'and maps its fields onto ours. Use this when your provider cannot send webhooks.',
  requiredFields: [
    { key: 'base_url', label: 'Events endpoint URL', secret: false,
      help: 'Full URL SK OS should call, e.g. https://panel.example.com/api/v1/events' },
    { key: 'api_key', label: 'API key', secret: true,
      help: 'Sent as a bearer token. Stored encrypted and never shown again.' },
  ],
  capabilities: {
    supportsApiKey: true,
    supportsPolling: true,
    supportsEntryExitEvents: true,
    supportsHistoricalImport: true,
    supportsTestConnection: true,
    supportsBranchMapping: true,
    // Real only when the owner has configured a permission endpoint --
    // see effectiveCapabilities in ./index.js.
    supportsAccessPermissionSync: true,
  },
  /* Which capabilities depend on configuration rather than on the
     adapter. A REST connection with no permission URL cannot push access
     changes, and must not be shown a button that claims it can. */
  requiresConfig: {
    supportsPolling: 'baseUrl',
    supportsHistoricalImport: 'baseUrl',
    supportsAccessPermissionSync: 'permissionUrl',
  },

  async testConnection(ctx) {
    const url = ctx.provider?.config?.baseUrl;
    if (!url) return { ok: false, message: 'No endpoint URL is configured.' };
    try {
      const res = await safeFetch(url, { headers: await authHeaders(ctx) });
      if (res.redirected) {
        return { ok: false, message: `The endpoint answered with a redirect (HTTP ${res.status}). Use the final URL; SK OS does not follow redirects.` };
      }
      if (!res.ok) return { ok: false, message: `The endpoint answered ${res.status}. Check the URL and the API key.` };
      const events = extractEvents(res.json, ctx.provider.config.eventsPath);
      if (!events) {
        return { ok: false, message: 'The endpoint answered, but not with a list of events SK OS can read. Set the path to the event list.' };
      }
      return { ok: true, message: `Endpoint reachable. It returned ${events.length} event${events.length === 1 ? '' : 's'}.` };
    } catch (e) {
      return { ok: false, message: e.code === 'unsafe_url' ? e.message : `Could not reach the endpoint: ${e?.cause?.code || e?.name || 'network error'}.` };
    }
  },

  /**
   * One page of events newer than `since`.
   *
   * The vendor is asked with a `since` query parameter (name configurable)
   * and the caller filters again locally, because some vendors ignore the
   * parameter and return everything.
   */
  async fetchEvents(ctx, { since = null, until = null, limit = 500 } = {}) {
    const cfg = ctx.provider.config || {};
    const u = new URL(cfg.baseUrl);
    if (since) u.searchParams.set(cfg.sinceParam || 'since', since);
    if (until) u.searchParams.set(cfg.untilParam || 'until', until);
    if (cfg.limitParam) u.searchParams.set(cfg.limitParam, String(limit));
    const res = await safeFetch(u.toString(), { headers: await authHeaders(ctx), timeoutMs: 10000 });
    if (res.redirected) throw Object.assign(new Error('Endpoint redirected; SK OS does not follow redirects.'), { code: 'redirect' });
    if (!res.ok) throw Object.assign(new Error(`Endpoint answered ${res.status}.`), { code: 'http_error', status: res.status });
    const raw = extractEvents(res.json, cfg.eventsPath);
    if (!raw) throw Object.assign(new Error('Response did not contain an event list.'), { code: 'bad_shape' });
    return raw.slice(0, limit);
  },

  /* Push "this person may / may not enter" to the vendor. Only runs when
     the owner configured permissionUrl; the body shape is fixed and
     documented, because a free-form template would be a way to make SK OS
     send arbitrary requests. */
  async updateAccessPermission(ctx, { externalUserId, allowed }) {
    const url = ctx.provider.config?.permissionUrl;
    if (!url) return { ok: false, notConfigured: true, message: 'No permission endpoint is configured for this connection.' };
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders(ctx)) },
      body: JSON.stringify({ external_user_id: externalUserId, access: allowed ? 'allow' : 'deny' }),
    });
    if (!res.ok) return { ok: false, message: `The access system answered ${res.status}.` };
    return { ok: true, message: 'Access updated at the provider.' };
  },

  normalizeEvent: normalizeWithFieldMap,
});

/* ── CSV import ───────────────────────────────────────────────────────
   For gyms whose attendance software can only export a file. No live
   feed -- which is why this adapter declares no webhook and no polling,
   and why a gym on CSV alone is never reported as having a live crowd:
   its freshness is the age of the last imported row. */
registerProvider({
  key: 'csv_import',
  name: 'CSV import',
  kind: 'import',
  authType: 'none',
  description:
    'Upload an export from your existing attendance software. Good for history and for gyms '
    + 'without a live feed. Imported data is only as current as the last file.',
  requiredFields: [],
  capabilities: {
    supportsHistoricalImport: true,
    supportsEntryExitEvents: true,
    supportsBranchMapping: true,
  },
  normalizeEvent: normalizeWithFieldMap,
});

/* ── shared helpers ────────────────────────────────────────────────── */

function getPath(obj, path) {
  if (!path || obj == null) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const nullable = (v) => (v === undefined ? null : v);

/**
 * Map a vendor payload onto our event shape, using the owner's field
 * mapping where they configured one and a set of common vendor spellings
 * where they did not.
 *
 * Shared by the webhook and REST adapters -- the same gym may move from
 * one to the other, and a field mapping that behaved differently after
 * the switch would be a support call nobody could diagnose.
 *
 * Returns null when there is no identifiable person or no time. The
 * caller records that as a rejected event rather than guessing: an event
 * we cannot attribute or order is not an event we can count.
 */
export function normalizeWithFieldMap(ctx, payload) {
  const map = ctx?.provider?.config?.fieldMap || {};
  const pick = (ourKey, ...fallbacks) => {
    const path = map[ourKey];
    const direct = path ? getPath(payload, path) : undefined;
    if (direct !== undefined && direct !== null) return direct;
    for (const f of fallbacks) {
      const v = getPath(payload, f);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  };
  const externalUserId = pick('externalUserId', 'user_id', 'employee_code', 'person_id', 'member_id', 'badge_id');
  const occurredAt = pick('occurredAt', 'timestamp', 'punch_time', 'event_time', 'occurred_at', 'time');
  if (externalUserId == null || occurredAt == null) return null;
  return {
    externalUserId: String(externalUserId),
    externalEventId: nullable(pick('externalEventId', 'event_id', 'id', 'transaction_id')),
    deviceIdentifier: nullable(pick('deviceIdentifier', 'device_id', 'device_serial', 'terminal_id')),
    eventType: nullable(pick('eventType', 'direction', 'event_type', 'punch_type', 'in_out')),
    occurredAt: String(occurredAt),
  };
}


/* ── vendors we do NOT claim to support ────────────────────────────── */

/**
 * Advertised so an owner can see their system is recognised and be routed
 * to the generic path, WITHOUT a Connect button that cannot work.
 * `implemented: false` makes listProviders() mark them accordingly.
 *
 * Building any of these for real needs the vendor's API documentation,
 * credentials and a device to test against. Until then, saying so is the
 * only honest option.
 */
for (const [key, name] of [
  ['zkteco', 'ZKTeco'],
  ['essl', 'eSSL'],
  ['matrix', 'Matrix COSEC'],
  ['hikvision', 'Hikvision'],
  ['suprema', 'Suprema BioStar'],
]) {
  registerProvider({
    key,
    name,
    kind: 'vendor',
    authType: 'api_key',
    implemented: false,
    description:
      `${name} devices are commonly used in gyms, but SK OS does not ship a ${name}-specific `
      + 'adapter yet. If your panel can send webhooks or expose a REST endpoint, connect it '
      + 'through the generic options above — that works today.',
    requiredFields: [],
    capabilities: {},
  });
}

export default { WEBHOOK_MAX_SKEW_SEC, normalizeWithFieldMap };
