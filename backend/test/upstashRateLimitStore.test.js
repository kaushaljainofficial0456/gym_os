// ============================================================
// F-08 REGRESSION: UpstashRedisStore adapter + rateLimit.js's use of
// its atomic increment().
//
// No real Upstash instance is available in this environment (no
// credentials configured anywhere in this session) -- these tests mock
// global.fetch to verify the adapter constructs the RIGHT request
// (pipeline shape: INCR then PEXPIRE ... NX, correct URL/auth header)
// and correctly interprets Upstash's documented response shape, plus
// that rateLimit.js's middleware actually calls increment() (not the
// unsafe get-then-set fallback) when a store provides one. This is
// request/response-contract testing, not a substitute for testing
// against a real Upstash instance -- see the security verification
// report for that caveat stated plainly.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstashRedisStore, upstashStoreFromEnv } from '../src/upstashRateLimitStore.js';
import { rateLimit, setRateLimitStore, resetToMemoryStore } from '../src/rateLimit.js';

function mockFetchPipeline(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const body = JSON.parse(opts.body);
    const result = handler(body, calls.length);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(result),
      json: async () => result,
    };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('upstashStoreFromEnv: returns null when env vars are missing (falls back to MemoryStore, no regression)', () => {
  assert.equal(upstashStoreFromEnv({}), null);
  assert.equal(upstashStoreFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x' }), null, 'URL alone is not enough');
  assert.equal(upstashStoreFromEnv({ UPSTASH_REDIS_REST_TOKEN: 'tok' }), null, 'token alone is not enough');
});

test('upstashStoreFromEnv: returns a real store when both env vars are set', () => {
  const store = upstashStoreFromEnv({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'test-token' });
  assert.ok(store instanceof UpstashRedisStore);
});

test('increment(): sends a pipeline of [INCR, PEXPIRE ... NX] to the correct endpoint with Bearer auth', async () => {
  const mock = mockFetchPipeline(() => [{ result: 1 }, { result: 1 }]);
  try {
    const store = new UpstashRedisStore({ url: 'https://example.upstash.io', token: 'test-token' });
    await store.increment('rl:1:1.2.3.4:12345', 60_000);
    assert.equal(mock.calls.length, 1, 'exactly one HTTP round trip for the whole increment');
    assert.equal(mock.calls[0].url, 'https://example.upstash.io/pipeline');
    assert.equal(mock.calls[0].opts.headers.Authorization, 'Bearer test-token');
    const commands = JSON.parse(mock.calls[0].opts.body);
    assert.deepEqual(commands[0], ['INCR', 'rl:1:1.2.3.4:12345']);
    assert.equal(commands[1][0], 'PEXPIRE');
    assert.equal(commands[1][1], 'rl:1:1.2.3.4:12345');
    assert.equal(commands[1][3], 'NX', 'PEXPIRE uses NX -- only sets a TTL on a brand-new key, never resets the window on later increments');
  } finally { mock.restore(); }
});

test('increment(): returns the INCR result as count, resetAt as the current fixed-window start', async () => {
  const mock = mockFetchPipeline(() => [{ result: 7 }, { result: 0 }]);
  try {
    const store = new UpstashRedisStore({ url: 'https://example.upstash.io', token: 'test-token' });
    const before = Date.now();
    const { count, resetAt } = await store.increment('somekey', 60_000);
    assert.equal(count, 7);
    assert.ok(resetAt <= before && resetAt > before - 60_000, 'resetAt is the start of the current 60s window');
  } finally { mock.restore(); }
});

test('increment(): a non-numeric INCR result throws (never silently treats a garbled response as count 0)', async () => {
  const mock = mockFetchPipeline(() => [{ result: 'not-a-number' }, { result: 1 }]);
  try {
    const store = new UpstashRedisStore({ url: 'https://example.upstash.io', token: 'test-token' });
    await assert.rejects(() => store.increment('k', 60_000));
  } finally { mock.restore(); }
});

test('increment(): trailing slash on the configured URL is normalized', async () => {
  const mock = mockFetchPipeline(() => [{ result: 1 }, { result: 1 }]);
  try {
    const store = new UpstashRedisStore({ url: 'https://example.upstash.io/', token: 'test-token' });
    await store.increment('k', 60_000);
    assert.equal(mock.calls[0].url, 'https://example.upstash.io/pipeline', 'no double slash');
  } finally { mock.restore(); }
});

test('rateLimit() middleware: with a store providing increment(), consecutive requests are correctly counted atomically (not via get-then-set)', async () => {
  let redisState = new Map();
  const store = {
    async get() { throw new Error('get() should never be called when increment() is available'); },
    async set() { throw new Error('set() should never be called when increment() is available'); },
    async increment(key, ttlMs) {
      const rec = redisState.get(key) || { count: 0, resetAt: Date.now() };
      rec.count += 1;
      redisState.set(key, rec);
      return rec;
    },
  };
  setRateLimitStore(store);
  try {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyFn: () => 'fixed-key' });
    const results = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => {
        const res = { statusCode: null, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { results.push({ status: this.statusCode || 200, body: b }); resolve(); } };
        const next = () => { results.push({ status: 200 }); resolve(); };
        mw({}, res, next);
      });
    }
    assert.equal(results.filter((r) => r.status === 200).length, 2, 'first 2 requests (at the limit) pass');
    assert.equal(results.filter((r) => r.status === 429).length, 2, 'requests 3 and 4 (over the limit) are rejected -- increment() path used, not the throwing get/set');
  } finally {
    resetToMemoryStore();
  }
});
