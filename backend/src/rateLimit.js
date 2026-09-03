// Minimal fixed-window rate limiter with a pluggable store.
//
// F-08 hardening: this now HAS a working shared-store implementation --
// see upstashRateLimitStore.js -- auto-wired at startup (index.js) when
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are configured (the
// exact two env vars Vercel's own KV integration sets when a project is
// connected to Upstash-backed Vercel KV, so "add Vercel KV to this
// project" is the entire ops lift, no new vendor to sign up for
// separately). Falls back to the in-memory MemoryStore below when those
// aren't set -- unchanged default behavior, so a deployment that hasn't
// configured KV yet sees no regression, just the same documented
// per-instance ceiling as before.
//
// Default (no shared store configured): in-memory Map — ideal for a
// single Node process at the 10-gym / ~2,500-client target. On Vercel/
// serverless, concurrent requests CAN land on separate function
// instances, each with its own independent MemoryStore -- so the
// effective ceiling under genuine concurrency is max × concurrent-
// instance-count, not max. Accepted tradeoff at the current scale
// WITHOUT Upstash configured; revisit (i.e. actually configure Vercel
// KV) if either traffic grows past the target above, or a specific
// endpoint's abuse risk (e.g. login brute-forcing via deliberately
// concurrent requests) justifies it sooner -- that's a product/infra
// call (whose budget), which is exactly why this stays OPT-IN via env
// var rather than a hard new required dependency.
//
// The store interface -- { get(key), set(key, value, ttlMs), delete(key) },
// all async -- exists so a REAL multi-instance store (Redis, Vercel KV,
// etc.) can be dropped in via setRateLimitStore() without touching the
// middleware below. A store MAY additionally implement an atomic
// `increment(key, ttlMs) -> { count, resetAt }` method -- when present,
// the middleware uses THAT instead of get-then-set, because get-then-set
// is NOT atomic for a real external store (two concurrent requests on
// the same key can both read count:0 before either writes back,
// undercounting -- exactly the race a shared store exists to close, not
// reopen). increment() is the ONLY safe way to correctly rate-limit
// under real concurrent load against a store the middleware doesn't
// control the internals of. Also note for whoever else wires a
// DIFFERENT store in: an earlier version of the code below only
// actually persisted state for a MemoryStore (any other store type got
// a fresh {count:0} on every call and never had it written back -- a
// silent, complete rate-limit bypass). Fixed here so every store type
// goes through a real get/set (or increment) path and actually works.

// ---- Pluggable store interface ----

class MemoryStore {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key) || null; }
  async set(key, value, _ttlMs) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
  get size() { return this.data.size; }
  cleanup(windowMs) {
    const now = Date.now();
    for (const [k, v] of this.data) {
      if (now - v.resetAt > windowMs) this.data.delete(k);
    }
  }
}

let store = new MemoryStore();

// Allow overriding the store at startup (e.g. Redis for multi-instance)
export function setRateLimitStore(externalStore) {
  store = externalStore;
}

// F-08: exposes whichever store is CURRENTLY active so a bespoke
// counter with different semantics than this file's own fixed-window
// limiter -- e.g. routes/auth.js's failed-login counter, which counts
// only FAILURES and resets on success, not "every request" -- can share
// the same shared-store configuration (Upstash when wired in, in-memory
// otherwise) instead of keeping a second, separate, always-in-memory-
// only Map that Upstash's whole point (surviving across serverless
// instances) would never reach.
export function getRateLimitStore() {
  return store;
}

// Test hook: undo setRateLimitStore(), back to a fresh in-memory store.
// Without this, a test that plugs in a fake external store to verify the
// pluggable-store path has no way to hand the default back afterward
// (the MemoryStore class itself is intentionally not exported).
export function resetToMemoryStore() {
  store = new MemoryStore();
}

// Test hook: clears all windows. Production code never calls this.
export function resetRateLimits() {
  if (store instanceof MemoryStore) store.data.clear();
}

let instanceSeq = 0;

// Each rateLimit() instance gets its own namespace inside the shared store, so
// a request passing through several limiters (e.g. a general ceiling plus a
// stricter per-endpoint limit) counts against each one independently.
export function rateLimit({ windowMs = 60_000, max = 100, keyFn = (req) => req.ip || 'ip' } = {}) {
  const ns = ++instanceSeq;
  const respond = (res, next, bucket, now) => {
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
  return (req, res, next) => {
    const now = Date.now();
    const key = `${ns}:${keyFn(req)}:${Math.floor(now / windowMs)}`;

    if (store instanceof MemoryStore) {
      // Stays fully synchronous, no `await` anywhere in this branch:
      // Node's single-threaded execution makes this read-increment-write
      // atomic, with no yield point for a concurrent request on the SAME
      // key to interleave on. An earlier version of this function awaited
      // store.get()/store.set() unconditionally, which reintroduced
      // exactly that race for the in-memory path too (two requests
      // hitting the same key could both read count:0 before either wrote
      // back, undercounting -- caught by prodreadiness.test.js's
      // synchronous 3-calls-in-a-row unit test).
      if (store.size > 10_000) store.cleanup(windowMs);
      const bucket = store.data.get(key) || { count: 0, resetAt: now };
      bucket.count += 1;
      store.data.set(key, bucket);
      return respond(res, next, bucket, now);
    }

    // External store: genuinely async. Atomicity under concurrent
    // requests for the SAME key is the ADAPTER's own responsibility --
    // prefer its atomic increment() when it has one (e.g. a Redis
    // adapter using INCR, never naive get-then-set); only a store with
    // no such method falls back to get-then-set, which is NOT safe
    // under real concurrency and exists purely so a trivial/test store
    // implementing only {get,set,delete} still technically works.
    Promise.resolve()
      .then(async () => {
        const bucket = typeof store.increment === 'function'
          ? await store.increment(key, windowMs)
          : await (async () => {
            const b = (await store.get(key)) || { count: 0, resetAt: now };
            b.count += 1;
            await store.set(key, b, windowMs);
            return b;
          })();
        respond(res, next, bucket, now);
      })
      .catch((e) => {
        // Fail OPEN: a rate-limit store outage (e.g. a Redis blip) must
        // never take the whole endpoint down with it. Availability of
        // the real feature matters more than the abuse guard for the
        // narrow window an external store is unreachable.
        console.error('[rateLimit] store error, failing open:', e?.message || e);
        next();
      });
  };
}
