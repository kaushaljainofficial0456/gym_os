// Minimal in-memory fixed-window rate limiter. No external dependency.
// Suitable for a single Node process at the 10-gym / ~2,500-client target.
// (If SK OS later runs multiple API instances, replace this with a shared
// store — e.g. Redis — without changing the middleware interface.)
const buckets = new Map();

// Test hook: clears all windows. Production code never calls this.
export function resetRateLimits() {
  buckets.clear();
}

function cleanup(now, windowMs) {
  for (const [key, b] of buckets) {
    if (now - b.resetAt > windowMs) buckets.delete(key);
  }
}

let instanceSeq = 0;

// Each rateLimit() instance gets its own namespace inside the shared store, so
// a request passing through several limiters (e.g. a general ceiling plus a
// stricter per-endpoint limit) counts against each one independently.
export function rateLimit({ windowMs = 60_000, max = 100, keyFn = (req) => req.ip || 'ip' } = {}) {
  const ns = ++instanceSeq;
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 10_000) cleanup(now, windowMs); // opportunistic sweep
    const key = `${ns}:${keyFn(req)}:${Math.floor(now / windowMs)}`;
    const bucket = buckets.get(key) || { count: 0, resetAt: now };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}
