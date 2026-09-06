// ============================================================
// REMEDIATION: regression test for the STATIC security headers in the
// three vercel.json files. securityHeaders.test.js already locks in the
// backend Express app's own header middleware (index.js) against a real
// booted server; this file is the missing other half -- the frontend's
// and admin console's headers are plain JSON config, set by Vercel's
// platform at the edge, never executed by any test that boots an app.
// Without this, a future edit that loosens or drops a directive (e.g.
// widening script-src while debugging something, then forgetting to
// tighten it back) has nothing catching the regression before it ships.
//
// This intentionally does NOT re-implement a CSP parser -- it asserts on
// the exact directive substrings each policy is documented (see index.js
// and this repo's audit history) to need, the same "does the string
// contain X" style prodreadiness.test.js already uses for schema.sql.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function cspFor(vercelJson) {
  const block = vercelJson.headers?.find((h) => h.source === '/((?!api/|uploads/).*)' || h.source === '/(.*)');
  const csp = block?.headers?.find((h) => h.key === 'Content-Security-Policy');
  return { block, csp: csp?.value || '' };
}

test('root vercel.json (combined frontend+API deploy): CSP allows exactly Razorpay + Google + Open Food Facts, nothing else new', () => {
  const v = readJson('vercel.json');
  const { csp } = cspFor(v);
  assert.ok(csp, 'a Content-Security-Policy header must exist on the root vercel.json');
  for (const must of [
    "default-src 'self'",
    'checkout.razorpay.com', '*.razorpay.com',
    'accounts.google.com',
    'openfoodfacts.org',
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ]) {
    assert.ok(csp.includes(must), `root CSP must include "${must}" -- got: ${csp}`);
  }
  // Never a BARE wildcard script source ("*", matching any origin) or
  // 'unsafe-eval' -- that would defeat the point of an allow-list CSP
  // entirely. A SCOPED subdomain wildcard on a specific trusted vendor
  // (https://*.razorpay.com) is fine and expected -- only a standalone
  // "*" token is the actual hazard, so this checks tokens, not substrings
  // (a naive "does script-src contain an asterisk" check would wrongly
  // flag the legitimate *.razorpay.com scoping).
  const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) || '';
  const tokens = scriptSrc.split(/\s+/).slice(1);
  assert.ok(!tokens.includes('*'), `script-src must never contain a bare wildcard source: ${scriptSrc}`);
  assert.ok(!tokens.includes("'unsafe-eval'"), `script-src must never allow 'unsafe-eval': ${scriptSrc}`);
});

test('root vercel.json: HSTS + the standard header set are present, matching index.js\'s own posture', () => {
  const v = readJson('vercel.json');
  const { block } = cspFor(v);
  const get = (k) => block.headers.find((h) => h.key === k)?.value;
  assert.match(get('Strict-Transport-Security') || '', /max-age=\d+/);
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get('X-Frame-Options'), 'DENY');
  assert.equal(get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  // camera=(self) here (not the backend API's camera=()) -- the frontend
  // genuinely uses the camera for QR/barcode scanning; see Permissions-Policy's
  // own value below. A regression to camera=() would silently break scanning;
  // a regression to a bare wildcard would silently allow every embedded frame.
  assert.match(get('Permissions-Policy') || '', /camera=\(self\)/);
});

test('admin/vercel.json: same header discipline as the root deploy (separate app, separate Vercel project)', () => {
  const v = readJson('admin/vercel.json');
  const { csp, block } = cspFor(v);
  assert.ok(csp, 'admin console must ship its own Content-Security-Policy');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("object-src 'none'"));
  const get = (k) => block.headers.find((h) => h.key === k)?.value;
  assert.equal(get('X-Frame-Options'), 'DENY');
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.match(get('Strict-Transport-Security') || '', /max-age=\d+/);
});

// REMEDIATION FINDING (not fixed here -- flagged, see remediation notes):
// frontend/vercel.json (a standalone-deploy config for the frontend, distinct
// from the root combined one above) currently has NO `headers` block at all.
// If this file is ever what Vercel actually reads for a real deployment of
// `frontend/` on its own (rather than the root vercel.json, which already
// bundles the frontend via outputDirectory), that deployment would ship with
// none of the security headers the root config and admin config both carry.
// This test documents the gap rather than silently asserting a header set
// that doesn't exist -- deciding whether frontend/vercel.json is live,
// vestigial, or needs its own headers block is a deployment-topology
// question outside a rate-limit/header-hardening pass.
test('frontend/vercel.json: documents its current gap -- no headers block exists (see comment above)', () => {
  const v = readJson('frontend/vercel.json');
  assert.equal(v.headers, undefined, 'this assertion exists to make the gap visible and force a deliberate update to this test the day someone adds (or intentionally continues omitting) headers here');
});
