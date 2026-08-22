// Vercel serverless entry point for the UNIFIED SK OS project (frontend +
// backend deployed together, Root Directory = repo root). Every /api/* and
// /uploads/* request (see the rewrites in ../vercel.json) lands here;
// Express's own router does the real dispatch, unchanged from the
// traditional-server code path in backend/src/index.js.
//
// This is a thin re-export — it duplicates NO routes or middleware. It
// mirrors backend/api/index.js (kept as-is for anyone deploying backend/ as
// its own standalone Vercel project); the only difference is the relative
// import path, since this file lives at the repo root instead of backend/api.
//
// The app is built once and memoized across warm invocations of the same
// function instance (a fresh cold start rebuilds it, which is normal and
// cheap here -- getDb() just opens a pg Pool, it doesn't run migrations).
import { buildApp } from '../backend/src/index.js';

let appPromise;

export default async function handler(req, res) {
  if (!appPromise) appPromise = buildApp();
  const app = await appPromise;
  return app(req, res);
}
