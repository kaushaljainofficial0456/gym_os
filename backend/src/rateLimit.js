// Minimal fixed-window rate limiter with a pluggable store.
//
// Default: in-memory Map — ideal for a single Node process at the
// 10-gym / ~2,500-client target. On Vercel/serverless, concurrent
// requests CAN land on separate function instances, each with its own
// independent MemoryStore -- so the effective ceiling under genuine
// concurrency is max × concurrent-instance-count, not max. Accepted
// tradeoff at the current scale; revisit if either traffic grows past
// the target above, or a specific endpoint's abuse risk (e.g. login
// brute-forcing via deliberately concurrent requests) justifies it
// sooner -- that's a product/infra call (which provider, whose budget),
// not a code change to make unilaterally.
//
// The store interface -- { get(key), set(key, value, ttlMs), delete(key) },
// all async -- exists so a REAL multi-instance store (Redis, Vercel KV,
// etc.) can be dropped in via setRateLimitStore() without touching the
// middleware below. Nothing reads a RATE_LIMIT_STORE/REDIS_URL env var
// today, and no such store is implemented anywhere in this codebase --
// this is a prepared extension point, not a working feature flag. Also
// note for whoever wires one up: an earlier version of the code below
// only actually persisted state for a MemoryStore (any other store type
// got a fresh {count:0} on every call and never had it written back --
// a silent, complete rate-limit bypass). Fixed here so every store type
// goes through the same get/set path and actually works.

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
    // requests for the SAME key is the ADAPTER's own responsibility
    // (e.g. a Redis adapter should use INCR or a Lua script, never naive
    // get-then-set) -- this generic path can't provide it for a store it
    // knows nothing about.
    Promise.resolve()
      .then(async () => {
        const bucket = (await store.get(key)) || { count: 0, resetAt: now };
        bucket.count += 1;
        await store.set(key, bucket, windowMs);
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
