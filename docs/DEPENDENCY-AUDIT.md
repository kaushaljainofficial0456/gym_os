# Dependency audit — 2026-09-03

`npm audit` across all three workspaces, run fresh at the end of the F-09
hardening pass. Two accepted findings remain, both dev-tooling-only with
no production exposure; everything else fixable via `npm audit fix`
(non-`--force`) has been applied.

## Fixed this pass

* **backend**: `qs` — fixed via plain `npm audit fix` (no breaking change).
* **frontend / admin**: `react-router-dom` bumped `^6.26.2` → `^7.18.3`
  (`npm install react-router-dom@^7`). Both `npm run build` verified clean
  after the bump (see Tests section of the final report).

## Accepted, not fixed — with reasoning

### `esbuild` / `vite` (frontend + admin, moderate + high)

```
esbuild  <=0.24.2 — "enables any website to send any requests to the
development server and read the response" (GHSA-67mh-4wv8-2f99)
  via vite <=6.4.2
fix available via `npm audit fix --force` → installs vite@8.2.2 (breaking)
```

**Why not fixed:** the advisory is specific to `vite`'s own **local dev
server** (`vite dev` / `vite preview`) accepting cross-origin requests
from any page a developer happens to have open in the same browser while
the dev server runs on their machine. It has **zero production
exposure** — this app's production deployment serves `vite build`'s
static output through Vercel; the dev server never runs there, and
nothing in `vite build`'s output is affected by this advisory.

`npm audit fix --force` would install Vite 8, a breaking major-version
jump with plugin-compatibility and config-shape implications across both
the frontend and admin workspaces, purely to close a dev-machine-only
advisory with no production impact — exactly the disproportionate,
untested "force it and hope" upgrade the security hardening spec for
this pass explicitly says not to do blindly. Deferred to a normal,
separately-tested dependency-upgrade pass, not bundled into a security
hardening change.

**Mitigation already in place:** developers running `npm run dev`
locally should avoid browsing untrusted sites in the same browser
session while the dev server is up — standard local-dev hygiene, not a
code change.

### `uuid` / `hyperid` / `autocannon` (backend, moderate)

```
uuid  <11.1.1 — missing buffer bounds check in v3/v5/v6 when a caller-
supplied buffer is provided (GHSA-w5hq-g745-h8pq)
  via hyperid → autocannon (devDependency only)
fix available via `npm audit fix --force` → breaking autocannon upgrade
```

**Why not fixed:** `autocannon` is a `devDependency` (confirmed via
`package.json` — not in `dependencies`), used only by
`scripts/loadtest.mjs` for local load-testing. It never ships to
production and never runs in the deployed serverless function. The
vulnerable code path itself (a caller passing its own buffer into
`uuid`'s v3/v5/v6 generation) is not a pattern this codebase's own code
or `autocannon`'s typical usage triggers. `npm audit fix --force` would
force a breaking `autocannon` major-version change for a transitive,
dev-only, not-practically-reachable advisory — again deferred rather
than forced.

## Verification

Full `npm audit` output for all three workspaces as of this pass, and
the full backend/frontend/admin test and build results this depended on,
are in the final security report's Dependency Status and Tests sections.
