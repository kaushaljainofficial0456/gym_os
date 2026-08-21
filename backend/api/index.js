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
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  return app(req, res);
}
