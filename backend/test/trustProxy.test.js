// On Vercel every request reaches the function through the platform's proxy,
// so without trusting X-Forwarded-For every visitor had the same req.ip and
// each per-address rate limit was one bucket shared by the whole app.
// Anywhere else the header is the caller's to write, so it stays untrusted.
import test from 'node:test';
import assert from 'node:assert/strict';

async function ipSeenBy(env) {
  const before = process.env.VERCEL;
  if (env) process.env.VERCEL = env; else delete process.env.VERCEL;
  try {
    const { buildApp } = await import(`../src/index.js?vercel=${env || 'none'}`);
    const app = await buildApp();
    return app.get('trust proxy');
  } finally {
    if (before === undefined) delete process.env.VERCEL; else process.env.VERCEL = before;
  }
}

test('X-Forwarded-For is trusted on Vercel, where the edge writes it', async () => {
  assert.equal(await ipSeenBy('1'), true);
});

test('X-Forwarded-For is not trusted anywhere else', async () => {
  assert.ok(!(await ipSeenBy('')));
});
