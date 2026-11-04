// Vercel serverless entry point. Every request (see backend/vercel.json's
// catch-all rewrite) lands here; Express's own router does the real
// dispatch, unchanged from the traditional-server code path in src/index.js.
//
// The app is built once and memoized across warm invocations of the same
// function instance (a fresh cold start rebuilds it, which is normal and
// cheap here -- getDb() just opens a pg Pool, it doesn't run migrations).
import { buildApp } from '../src/index.js';

let appPromise;

export default async function handler(req, res) {
  // A start-up that failed (a database blip on a cold start) must not be
  // remembered: kept, every later request on this warm instance would
  // fail the same way until the host happened to recycle it.
  if (!appPromise) appPromise = buildApp().catch((e) => { appPromise = null; throw e; });
  const app = await appPromise;
  return app(req, res);
}
