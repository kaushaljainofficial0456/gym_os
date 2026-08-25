// ============================================================
// CLIENT (BROWSER) ERROR REPORTING — the frontend half of real
// observability, complementing the backend's own global error handler
// (src/index.js persists every unhandled request failure to `events` as
// `server_error`; this route lets the frontend's ErrorBoundary do the
// same for a render crash the backend never sees at all).
//
// PUBLIC ON PURPOSE: a crash can happen before a user is logged in (e.g.
// on the public SharedMeal preview), so this must never require auth --
// same reasoning as share.js. If a valid JWT IS present, its org/user are
// recorded for context; if not, the event is still recorded, just
// unscoped (org_id/user_id both null, same as any other nullable event).
//
// Rate-limited by IP (not by user -- there may not be one) since this is
// the one write path in the app that's both unauthenticated AND freely
// client-triggerable content, the combination worth guarding against
// someone scripting a flood of fake crash reports.
// ============================================================
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { rateLimit } from '../rateLimit.js';
import { validate, schemas } from '../validate.js';
import { track } from '../services/events.js';

// Best-effort JWT decode -- never throws, never requires a valid/present
// token. Purely for attaching org/user context to a report when we
// happen to have it; a missing or invalid token just means less context,
// never a rejected report.
function tryDecodeUser(req) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return { org: null, sub: null };
    const payload = jwt.verify(token, config.jwtSecret);
    return { org: payload.org || null, sub: payload.sub || null };
  } catch {
    return { org: null, sub: null };
  }
}

export default function clientErrorRoutes(db) {
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.ip || 'anon' });

  r.post('/', limit, validate(schemas.clientError), async (req, res) => {
    const { org, sub } = tryDecodeUser(req);
    await track(db, {
      type: 'client_error',
      orgId: org,
      userId: sub,
      data: {
        message: req.body.message,
        path: req.body.path || null,
        componentStack: req.body.component_stack || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      },
    }).catch(() => {});
    // 204: the frontend never needs to do anything with this response,
    // and a crashed page is exactly the wrong place to depend on parsing
    // a JSON body successfully.
    res.status(204).end();
  });

  return r;
}
