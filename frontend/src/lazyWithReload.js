/**
 * A screen's code that has disappeared because a new version was deployed.
 *
 * Every deploy renames the app's code files (their names carry a content
 * hash). A tab or home-screen app still running the previous version keeps
 * the old names, so the first time it opens a screen it had not loaded yet --
 * Workout, Nutrition -- it asks for a file that no longer exists and the
 * screen fails to load. Reloading once fetches the new version and the new
 * names, which is all that was ever wrong.
 *
 * So a failed load of the app's own code reloads the page, once. The
 * timestamp guard stops a genuinely broken file (or no network at all) from
 * reloading forever: a second failure within the window is shown as the
 * error it is.
 */
import { lazy } from 'react';

const KEY = 'barbell-new-version-reload-at';
const WINDOW_MS = 30_000;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Expected a JavaScript(-or-Wasm)? module script|ChunkLoadError|MIME type/i;

export const isStaleCodeError = (e) => CHUNK_ERROR.test(String(e?.message || e || ''));

/** Reload for the new version, unless that was just tried. */
export function reloadForNewVersion(reload = () => window.location.reload()) {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < WINDOW_MS) return false;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage unavailable: still reload -- the page cannot work as it is.
  }
  reload();
  return true;
}

/** React.lazy that turns "this version's file is gone" into a reload. */
export function lazyWithReload(factory) {
  return lazy(() => factory().catch((e) => {
    // Never resolves while the page reloads, so the loading state stays up.
    if (isStaleCodeError(e) && reloadForNewVersion()) return new Promise(() => {});
    throw e;
  }));
}
