// ============================================================
// Frontend test setup, loaded via `--import` before any test file (see
// package.json's "test" script). Deliberately NOT Vitest: adding it would
// have required bumping the app's actual build tool (vite) to a new
// major version to clear a critical advisory in Vitest's own UI-server
// dependency chain (GHSA-5xrq-8626-4rwp) -- exactly the kind of
// disproportionate, untested forced upgrade docs/DEPENDENCY-AUDIT.md
// already declined to make for an unrelated reason. Node 22's own
// built-in test runner (already this repo's backend convention -- see
// backend/package.json's "test": "node --test") plus a plain JSX
// transform (tsx, which depends on nothing but esbuild used as a
// library, never as a server -- so it never touches the one esbuild
// advisory this repo HAS accepted, which is specific to esbuild's dev
// SERVER) avoids that coupling entirely.
//
// global-jsdom/register (a separate --import, see package.json) installs
// `document`/`window`/etc. as real globals before this file runs.
// ============================================================

// Tells @testing-library/react we're in an act()-aware environment.
// React Testing Library normally detects this via Jest/Vitest globals;
// neither exists here, so it must be set explicitly or every render()
// involving an effect (e.g. Modal's own useEffect) logs an "update not
// wrapped in act()" warning even though render() already awaits one.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
