# Security audit (2026-11-08/09)

Branch `eng/production-overhaul`, from `origin/main` `45d68a7`. Scope: the API
(`backend/src`, 34 route modules, 536 endpoints), the web client's session
handling, dependencies, and configuration. Aligned with the OWASP Top 10 and
the OWASP API Security Top 10. No testing was done against production; every
dynamic check ran against a throwaway SQLite database.

This builds on earlier passes recorded in the code (F-05 cookie auth, F-08
rate-limit store, F-10 password reset, F-12 hardening) and in
`docs/RLS-BOUNDARY.md` and `docs/BACKEND-AUDIT.md`; it does not repeat them.

## Method

| Check | How | Result |
|---|---|---|
| SQL injection | Every SQL string in `backend/src` with a `${...}` interpolation reviewed (script output kept in the commit history of this doc) | Clean. Interpolations are fixed column names, fixed clauses, or `?` placeholder lists; all values are bound parameters |
| Broken object-level authorisation | Script listing every handler with a URL parameter whose body mentions no org/owner/user scope; each hit read by hand | No IDOR found. Hits were SUPER_ADMIN console routes (platform-wide by design), and friend-community/tournament routes that authorise through `loadCommunityFor` / `loadContext` (membership- or visibility-scoped, 404 for others) |
| Authentication | Read `auth.js`, `routes/auth.js` | One finding fixed (S-1) |
| File serving | Read the `/uploads` handler; reproduced against a seeded local instance | One finding fixed (S-2) |
| Public endpoints | Read each unauthenticated route | Expiring, unguessable ids; IP rate limits; no personal data beyond the sharer's display name |
| Dependencies | `npm audit --omit=dev` in root, backend, frontend, admin | Fixed three; one accepted with mitigation (S-4) |
| Headers / CORS / cookies | `index.js`, `vercel.json`, `admin/vercel.json` | Sound: strict CSP on the API, CSP on the SPA, HSTS, nosniff, frame denial, CORS allow-list with credentials, `httpOnly` + `SameSite=Strict` + `Secure` cookie |

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | High | Password change/reset did not end other sessions | **Fixed** (`462b134`) |
| S-2 | High | `/uploads` ownership check and served file could differ (`..` segments) | **Fixed** (`4c4ed2d`) |
| S-3 | High (config) | Rate limits are per-instance unless Upstash is configured; production store unverified | **Open — production blocker to verify** |
| S-4 | High (dep) | `zod` 3.x memory exhaustion advisory; fix is zod 4 (breaking) | Accepted, mitigated; upgrade tracked |
| S-5 | Critical/High/Mod (deps) | `proxy-addr`, `body-parser`, `qs` advisories | **Fixed** (`66ece86`) |
| S-6 | Medium | RLS protects only the `db.tx()` path | Known, documented in `RLS-BOUNDARY.md`; unchanged |
| S-7 | Medium | Logout does not revoke the token server-side (only "sign out everywhere" does) | Open, by design for now |
| S-8 | Low | `callAI()` has no timeout on the paid-provider paths | Open (deferred to avoid conflicting with in-progress assistant work in `aiProvider.js`) |
| S-9 | Low | Login lockout is per email+IP; no per-account ceiling across IPs | Open |

### S-1 — Sessions survived a password change or reset (fixed)

**What was wrong.** Sessions are stateless 7-day JWTs. `/auth/change-password`
and `/auth/reset-password` changed the hash and, at most, cleared the current
browser's cookie. Any other device's token, or a token an attacker had copied,
kept working for up to 7 days. The code documented this as residual risk F-10;
an unmerged branch (`remediation/p1-security-session-revocation`, Sep 2026)
proposed a token-epoch fix against much older code and does not merge.

**What changed.** `users.sessions_valid_after` (guarded migration, NULL for
everyone). `requireAuth` rejects a token whose `iat` is earlier. The value is
read in the same query the deactivation check already made, so it adds no
round trip. `/change-password` revokes and re-signs the current session from
its current claims; `/reset-password` revokes everything; new
`POST /auth/logout-everywhere`.

**Why it is safe.** A timestamp against the standard `iat` claim means none of
the 14 places that sign tokens changed (a per-token counter would have had to
be threaded through all of them, and a missed one would lock users out). NULL
by default, so no existing session is affected by the deploy. On a database
without the column the gate falls back to the old query (deactivation still
enforced) and revocation logs loudly instead of failing the password change.
`db:check` refuses to build production until the column exists.

**Residual.** Other warm instances learn of a revocation within 30 s (same
window as account deactivation). Tokens issued in the same second as a
revocation survive it.

**Tests.** `backend/test/sessionRevocation.test.js` (9): other device signed out
after change; this device stays on the same gym; wrong password revokes
nothing; reset ends all; logout-everywhere (and requires a session); per-user
isolation; un-migrated database; gate order unchanged. Browser check against a
local instance: after a password change the browser stays signed in; after
"sign out everywhere" its next request is 401.

### S-2 — Private upload path traversal (fixed)

**What was wrong.** `/uploads/*` (progress photos, label scans) checks that the
requester owns the client id in one path segment, then serves the *resolved*
path. Express passes `..` through unchanged (verified:
`/uploads/photos/A/../B/x.jpg` arrives as `req.path = /photos/A/../B/x.jpg`), so
the id checked (`A`, the requester's own) and the file served (`B`'s) could
differ. With the local driver the file is served (outside a dot-directory);
with the S3 driver the `..` reaches the object-store key, and whether that
resolves depends on the endpoint's URL normalisation.

**What changed.** `uploadPathSegments()` (exported from `index.js`) refuses
empty, `.` and `..` segments, raw or percent-encoded, and separators or NUL
inside a segment, before the ownership lookup. Real keys are unchanged.

**Tests.** `backend/test/uploadsPath.test.js` (4). Reproduction against a
seeded local instance: the traversal request is now refused before any
database or storage access.

### S-3 — Rate limits per instance unless Upstash is configured (open)

`rateLimit.js` uses process memory unless `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are set. On Vercel each instance counts separately
and starts from zero on a cold start, so login, reset, sign-up and coupon
limits are weaker than they read. These variables were missing from
`.env.example`; they are now documented there. **Before launch: confirm the
production function logs `Rate limiting: using Upstash Redis` at start-up.**

### S-4 — zod 3 advisory (accepted with mitigation)

No 3.x release fixes it. Request bodies are capped (1 MB default, 8 MB on the
three upload mounts), which bounds the memory any one request can make zod
allocate. Upgrading to zod 4 touches every schema in `validate.js` and the
routes; do it as its own change with the full suite.

### S-7 — Logout is client-side only (open)

`POST /auth/logout` clears the cookie but the token itself stays valid until
expiry. Making every logout revoke would sign the person out on all devices
(the timestamp is per user). A per-token denylist (`jti`) would fix this
precisely; it needs a shared store (the same Upstash instance as S-3).

## What was checked and is sound

- JWT: HS256 pinned on sign and verify; production refuses to boot with a
  weak or default `JWT_SECRET`.
- Passwords: bcrypt cost 12, transparent rehash of older hashes on login.
- Webhooks: Razorpay, WHOOP and the access provider verify HMACs over raw
  bytes; the mock payment bridge is never mounted in production.
- Production boot refuses `neondb_owner` (BYPASSRLS) as the runtime role.
- Public share links: ~60-bit random ids, expiry, identical 404 for expired
  and missing, IP rate limit.
- Error handler never returns SQL, stacks or secrets in production.
