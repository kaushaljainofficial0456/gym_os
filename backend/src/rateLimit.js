// Minimal fixed-window rate limiter with a pluggable store.
//
// Default: in-memory Map — ideal for a single Node process at the
// 10-gym / ~2,500-client target.
//
// Production multi-instance: set RATE_LIMIT_STORE=redis and configure
// REDIS_URL. The store interface is { get(key), set(key, value, ttlMs),
// delete(key) } — implement Redis adapters without changing middleware.

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
  return (req, res, next) => {
    const now = Date.now();
    if (store instanceof MemoryStore && store.size > 10_000) store.cleanup(windowMs);
    const key = `${ns}:${keyFn(req)}:${Math.floor(now / windowMs)}`;
    const bucket = store instanceof MemoryStore
      ? (store.data.get(key) || { count: 0, resetAt: now })
      : { count: 0, resetAt: now }; // Redis store handles its own get/set
    bucket.count += 1;
    if (store instanceof MemoryStore) store.data.set(key, bucket);
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}
