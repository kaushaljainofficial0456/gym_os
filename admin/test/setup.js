// Same setup as frontend/test/setup.js (see its own comment for the full
// "why not Vitest" reasoning) -- this app's own separate package.json
// needs its own copy of the same three-line setup.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom DOES implement window.matchMedia, but as a stub that always
// reports matches:false for every query (it never computes a real media
// query) -- so an `existing || fallback` pattern here would silently
// keep jsdom's own always-false stub instead of installing this one.
// StatCard's own count-up hook reads
// `window.matchMedia?.('(prefers-reduced-motion: reduce)')` specifically
// so it can skip its rAF-driven animation for that preference --
// reporting it as ALWAYS matching here makes every test exercise that
// (correct, simpler, deterministic) reduced-motion path by default:
// values render at their final number immediately instead of needing a
// real animation-timing wait in every test that touches one.
// global-jsdom exposes `window` as its OWN object, distinct from
// `globalThis` (confirmed: `window === globalThis` is false here) --
// setting only globalThis.matchMedia silently does nothing for code that
// reads window.matchMedia, which is exactly what StatCard does. Set on
// window explicitly; also on globalThis in case anything reads the bare
// global instead.
const mockMatchMedia = (query) => ({
  matches: query.includes('prefers-reduced-motion'),
  media: query,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
});
window.matchMedia = mockMatchMedia;
globalThis.matchMedia = mockMatchMedia;
