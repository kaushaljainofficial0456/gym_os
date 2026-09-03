// ============================================================
// F-08 — UPSTASH REDIS RATE-LIMIT STORE
//
// Talks to Upstash's REST API directly via fetch() (no @upstash/redis
// SDK dependency -- matches this codebase's existing preference for
// plain fetch() over vendor SDKs, e.g. emailProvider.js/paymentProvider.js),
// so adding this required zero new npm dependencies.
//
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are the exact two
// env vars Vercel's own "Vercel KV" integration sets automatically when
// a project is connected to it (Vercel KV is Upstash-backed) -- so
// enabling this in production is "add Vercel KV to the project" in the
// dashboard, not a new vendor account or a code change.
//
// ATOMICITY: increment(key, ttlMs) is the one method rateLimit.js's
// middleware actually needs for correctness under real concurrent
// requests (see that file's own comment on why get-then-set is unsafe).
// Implemented as a single Upstash PIPELINE call --
//   [["INCR", key], ["PEXPIRE", key, ttlMs, "NX"]]
// -- one HTTP round trip, two Redis commands. INCR is atomic on its own
// (Redis's per-command guarantee); PEXPIRE ... NX only ever applies the
// TTL if the key doesn't already have one, which is true precisely on
// the request that just created the key (INCR result === 1) and false
// on every subsequent increment within the same window -- so the window
// boundary is set exactly once per key, never pushed forward by later
// requests, matching this module's own fixed-window semantics (the
// SAME semantics the in-memory MemoryStore already has, since its key
// itself embeds the window via `Math.floor(now / windowMs)` in
// rateLimit.js -- PEXPIRE here is purely a memory-cleanup TTL on an
// already-unique-per-window key, not what defines the window).
//
// `resetAt` returned is an approximation (start of the current fixed
// window, derived the same way the key itself is), not read back from
// Redis -- Upstash's PEXPIRE NX doesn't report the remaining TTL, and a
// second round trip just to fetch it would double this store's latency
// for a value the caller only uses to compute a Retry-After header.
// ============================================================

const DEFAULT_TIMEOUT_MS = 2000;

export class UpstashRedisStore {
  constructor({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!url || !token) throw new Error('UpstashRedisStore requires both url and token');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async _pipeline(commands) {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Upstash pipeline ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** Atomic fixed-window increment -- see module header for the exact
   *  INCR + PEXPIRE-NX shape and why it's safe under concurrency.
   *  `ttlMs` is the calling limiter's own windowMs (rateLimit.js always
   *  passes its windowMs here, the same value the key itself already
   *  embeds via Math.floor(now / windowMs)). */
  async increment(key, ttlMs) {
    const now = Date.now();
    const results = await this._pipeline([
      ['INCR', key],
      ['PEXPIRE', key, String(Math.max(1, Math.ceil(ttlMs))), 'NX'],
    ]);
    const count = Number(results?.[0]?.result);
    if (!Number.isFinite(count)) throw new Error(`Upstash INCR returned a non-numeric result: ${JSON.stringify(results)}`);
    // resetAt is derived, not read from Redis -- see module header.
    const resetAt = Math.floor(now / ttlMs) * ttlMs;
    return { count, resetAt };
  }

  // {get,set,delete} kept for interface completeness / test-double
  // compatibility with the generic get-then-set fallback path in
  // rateLimit.js -- production code always takes the increment() path
  // above once this store is wired in, since typeof store.increment ===
  // 'function' is true for every instance of this class.
  async get(key) {
    const results = await this._pipeline([['GET', key]]);
    const raw = results?.[0]?.result;
    return raw ? JSON.parse(raw) : null;
  }

  async set(key, value, ttlMs) {
    await this._pipeline([['SET', key, JSON.stringify(value), 'PX', String(Math.max(1, Math.ceil(ttlMs)))]]);
  }

  async delete(key) {
    await this._pipeline([['DEL', key]]);
  }
}

/** Builds an UpstashRedisStore from UPSTASH_REDIS_REST_URL/_TOKEN if both
 *  are set; returns null otherwise (caller falls back to MemoryStore --
 *  see index.js's own call site). Never throws on missing config -- an
 *  unconfigured deployment must boot exactly as it did before this
 *  feature existed. */
export function upstashStoreFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || '';
  const token = env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return new UpstashRedisStore({ url, token });
}
