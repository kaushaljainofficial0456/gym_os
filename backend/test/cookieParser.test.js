// ============================================================
// Regression coverage for buildApp()'s cookie parser
// (backend/src/index.js's parseCookieHeader).
//
// Before this fix, `decodeURIComponent(value)` ran unguarded. A malformed
// percent-escape in a cookie value (e.g. a lone trailing '%') makes
// decodeURIComponent throw URIError. Because this middleware is mounted
// FIRST -- before the request-id/access-log middleware, and long before
// any route -- the throw escaped straight to the global error handler as
// an unhandled 500 on EVERY request carrying that cookie, for as long as
// the browser kept sending it back (cookies persist across requests, so
// this bricked the app for that browser until the cookie was manually
// cleared). Reproduced live against a running instance before the fix;
// see security-review notes for the exact `Cookie: sk_token=%` PoC this
// test encodes.
//
// Tested directly against parseCookieHeader() rather than through a full
// Express app / buildApp(): buildApp() always opens a real getDb()
// connection (see its own comment), which is why no other test in this
// suite spins up the real app -- see admin-tenant-isolation.test.js's own
// note on this. parseCookieHeader() is exported specifically so the exact
// production code path is unit-testable without that dependency.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieHeader } from '../src/index.js';

test('a malformed percent-escape in a cookie value does not throw', () => {
  // The exact PoC: a bare trailing '%' is not a valid percent-escape.
  assert.doesNotThrow(() => parseCookieHeader('sk_token=%'));
  const cookies = parseCookieHeader('sk_token=%');
  // Falls back to the raw (still-encoded) value rather than dropping the
  // key entirely -- it simply won't verify as a valid JWT downstream,
  // which is the correct "unauthenticated", not a crashed request.
  assert.equal(cookies.sk_token, '%');
});

test('other malformed percent-escapes are also tolerated, not thrown', () => {
  for (const bad of ['%zz', '%e0%', 'a=%', '%%%']) {
    assert.doesNotThrow(() => parseCookieHeader(`sk_token=${bad}`), `should not throw for value "${bad}"`);
  }
});

test('a missing/empty Cookie header parses to an empty object', () => {
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader(undefined), {});
  assert.deepEqual(parseCookieHeader(null), {});
});

test('a well-formed cookie header still decodes correctly (no regression)', () => {
  const cookies = parseCookieHeader('sk_token=abc.def.ghi; other=hello%20world');
  assert.equal(cookies.sk_token, 'abc.def.ghi');
  assert.equal(cookies.other, 'hello world', 'a validly percent-encoded value still decodes');
});

test('multiple cookies, one malformed, one valid -- the valid one still decodes correctly', () => {
  const cookies = parseCookieHeader('bad=%; sk_token=abc.def.ghi');
  assert.equal(cookies.bad, '%', 'malformed value falls back to raw rather than crashing the whole parse');
  assert.equal(cookies.sk_token, 'abc.def.ghi', 'a later, well-formed cookie is unaffected');
});

test('an entry with no "=" is stored with an empty value, not skipped or thrown (unchanged pre-existing behavior)', () => {
  assert.deepEqual(parseCookieHeader('noequalssign'), { noequalssign: '' });
});

test('a real Cookie header with stray "; " segments still finds the real cookie', () => {
  const cookies = parseCookieHeader(' ; sk_token=abc; ');
  assert.equal(cookies.sk_token, 'abc');
});
