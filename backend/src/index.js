import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { config } from './config.js';
import { requireAuth } from './auth.js';

let server = null;
let dbInstance = null;
let shuttingDown = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import clientRoutes from './routes/clients.js';
import workoutRoutes from './routes/workouts.js';
import nutritionRoutes from './routes/nutrition.js';
import trackingRoutes from './routes/tracking.js';
import { track } from './services/events.js';
import insightRoutes from './routes/insights.js';
import alertRoutes from './routes/alerts.js';
import reportRoutes from './routes/reports.js';
import messageRoutes from './routes/messages.js';
import adminRoutes from './routes/admin.js';
import meRoutes from './routes/me.js';
import shareRoutes from './routes/share.js';
import clientErrorRoutes from './routes/clientError.js';
import enterpriseRoutes from './routes/enterprise.js';
import enrollmentRoutes from './routes/enrollment.js';
import paymentsDevRoutes from './routes/paymentsDev.js';
import intelligenceRoutes from './routes/intelligence.js';
import trainerRoutes from './routes/trainer.js';
import communityRoutes from './routes/community.js';
import workoutShareRoutes from './routes/workoutShare.js';
import consoleRoutes from './routes/console.js';

// Builds the Express app without starting a listener, so it can be reused
// both by the traditional long-running server below (for local dev or a
// persistent host like Railway/Render) and by a serverless entry point
// (api/index.js, for Vercel) that just needs the (req, res) => {} handler.
// Sets dbInstance as a side effect so the graceful-shutdown handler below
// can close it -- serverless invocations never trigger that path, so it's
// a harmless no-op there.
export async function buildApp() {
  dbInstance = await getDb();
  const db = dbInstance;
  const app = express();

  // ---- Minimal cookie parser (no dependency needed) ----
  app.use((_req, _res, next) => {
    if (!_req.cookies) {
      _req.cookies = {};
      const raw = _req.headers.cookie || '';
      for (const part of raw.split(';')) {
        const [k, ...rest] = part.split('=');
        if (k) _req.cookies[k.trim()] = decodeURIComponent(rest.join('='));
      }
    }
    next();
  });

  // ---- Security headers (lightweight, no external dependency) ----
  app.use((_req, res, next) => {
    // Prevent MIME sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Clickjacking protection
    res.setHeader('X-Frame-Options', 'DENY');
    // XSS filter (legacy browsers)
    res.setHeader('X-XSS-Protection', '0'); // modern best practice: disable in favor of CSP
    // Referrer policy — strip origin from cross-origin navigations
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Permissions policy — disable unused browser features
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  app.use(cors({ origin: config.corsOrigins, credentials: true }));

  // Request ID + access log (method, path, status, duration — never bodies,
  // tokens, or headers). Gives every logged error a traceable id.
  app.use((req, res, next) => {
    req.id = randomUUID();
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`[req] ${req.id} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    next();
  });

  // Upload-carrying routes (base64 data-URL images in JSON) get a larger body
  // limit; everything else stays small so ordinary API calls can't send huge
  // payloads. The more specific mounts are registered BEFORE the global parser.
  // /api/me added for POST /me/avatar: base64 inflates a raw file by ~33%,
  // so even that route's own 1 MB (raw) cap needs headroom above the global
  // 1mb default to ever be the thing that actually rejects an oversized
  // image -- otherwise this body-parser limit trips first, on a slightly
  // SMALLER effective ceiling than the route intends, and the client sees
  // a generic "body too large" instead of the route's specific message.
  app.use(['/api/intel', '/api/clients', '/api/me'], express.json({ limit: '8mb' }));
  // Razorpay webhook signature verification needs the EXACT raw request
  // bytes (re-serializing parsed JSON can silently change byte layout
  // and break a genuinely authentic signature) -- this one path gets its
  // body as a raw Buffer instead of parsed JSON, registered before the
  // blanket express.json() below so it wins for this specific route.
  // See enterprise.js's webhook handler, which converts it back to a
  // string itself.
  app.use('/api/enterprise/payment/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

app.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true, db: db.driver, ts: new Date().toISOString() }));

// Readiness: verifies the database actually answers. Kept lightweight.
app.get(['/ready', '/api/ready'], async (_req, res) => {
  try {
    await db.q1('SELECT 1 AS ok');
    const body = { ok: true, db: db.driver, ts: new Date().toISOString() };
    // Opt-in only (EXPOSE_POOL_STATS=1) -- default production behavior is
    // byte-identical to before. For the connection-pool-starvation
    // investigation: pool.waitingCount > 0 means requests are queued behind
    // a full pool RIGHT NOW, observed directly rather than inferred from
    // slow responses. Load-test harness polls this during a run.
    if (process.env.EXPOSE_POOL_STATS === '1' && typeof db.poolStats === 'function') {
      body.pool = db.poolStats();
    }
    res.json(body);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unreachable' });
  }
});

// NOTE: org timezone is resolved per-request inside requireAuth (after the token is
// verified) so req.tz always reflects the authenticated org — never a pre-auth default.

app.use('/api/auth', authRoutes(db));
app.use('/api/dashboard', dashboardRoutes(db));
app.use('/api/clients', clientRoutes(db));
app.use('/api/workouts', workoutRoutes(db)); // /exercises, /templates, /clients/:id/workouts, /:id/complete
app.use('/api/nutrition', nutritionRoutes(db)); // /plans, /clients/:id/meals, ...
app.use('/api/tracking', trackingRoutes(db));   // /clients/:id/water, /clients/:id/sleep, /me/home
app.use('/api/insights', insightRoutes(db));    // /clients/:id, /clients/:id/analyze, /:id/action
app.use('/api/alerts', alertRoutes(db));
app.use('/api/reports', reportRoutes(db));      // /clients/:id/weekly-report
app.use('/api/messages', messageRoutes(db));
app.use('/api/business', adminRoutes(db));
app.use('/api/admin', adminRoutes(db)); // alias — Business page calls /admin/*
app.use('/api/trainer', trainerRoutes(db)); // trainer-specific: client detail dashboard
app.use('/api/me', meRoutes(db));      // client personalization: prefs, metrics, foods, meals, workouts, crowd
app.use('/api/share', shareRoutes(db)); // PUBLIC: preview a shared meals/foods link (no auth) -- saving it requires auth, see POST /api/me/share/:id/save
app.use('/api/workout-share', workoutShareRoutes(db)); // PUBLIC: preview a shared workout link (no auth) -- importing requires auth, see POST /api/me/workout-share/:id/import
app.use('/api/client-error', clientErrorRoutes(db)); // PUBLIC: frontend ErrorBoundary crash reports -- see clientError.js
app.use('/api/community', communityRoutes(db)); // gym community: leaderboards, workout sharing, membership
app.use('/api/enterprise', enterpriseRoutes(db)); // gym-owner SaaS billing: onboarding, packages, payment, invoices -- see enterprise.js
app.use('/api/enrollment', enrollmentRoutes(db)); // QR-based client/trainer onboarding -- see enrollment.js
app.use('/api/payments', paymentsDevRoutes()); // browser-callable mock-checkout bridge (inert once a real gateway is configured) -- see paymentsDev.js
app.use('/api/intel', intelligenceRoutes(db)); // SK Intelligence Engine: NL parsing, search, generation, label scan
app.use('/api/console', consoleRoutes(db)); // Admin Console (Phase 3): platform-operator API, SUPER_ADMIN only -- see console.js. Deliberately NOT /api/admin (already owned by adminRoutes)
// Private uploads: served only to the authenticated client who owns them,
// never via a public static mount. Label scans are stored under
// data/uploads/tmp/<client_id>/ and cleaned up on save.
app.use('/uploads', requireAuth, async (req, res) => {
  const rel = req.path.replace(/^\//, '');
  const abs = path.resolve(__dirname, '..', 'data', 'uploads', rel);
  const uploadsRoot = path.resolve(__dirname, '..', 'data', 'uploads') + path.sep;
  if (!abs.startsWith(uploadsRoot)) return res.status(403).json({ error: 'Forbidden' });
  // the requesting user must be authorized for this image
  // paths: tmp/<client_id>/... (label scans) | photos/<client_id>/... (progress photos)
  const seg = rel.split('/');
  const owner = seg[0] === 'tmp' || seg[0] === 'photos' ? seg[1] : seg[0];
  const client = await db.q1('SELECT id, org_id, user_id, trainer_id FROM clients WHERE id = ?', [owner]);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const canView =
    client.user_id === req.user.sub ||                                     // the client themselves
    ((req.user.role === 'GYM_OWNER' || req.user.role === 'SUPER_ADMIN') && (client.org_id === req.user.org || req.user.role === 'SUPER_ADMIN')) ||
    (req.user.role === 'TRAINER' && client.org_id === req.user.org && client.trainer_id === req.user.sub);
  if (!canView) return res.status(403).json({ error: 'Forbidden' });
  res.sendFile(abs, (err) => { if (err) res.status(404).json({ error: 'Not found' }); });
});

  // 404 + error handler
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const code = err.type === 'entity.too.large' ? 413 : (err.status || 500);
    if (code === 413) return res.status(413).json({ error: 'Request body too large' });
    // log diagnostics server-side only — never expose SQL/stack/secrets to clients
    console.error(`[error] req=${req.id || '-'}`, err?.message || err);
    // Also persist to the events table (best-effort, never blocks the
    // response) -- console.error alone is invisible on Vercel unless
    // someone is actively watching function logs at the exact moment it
    // happens. This makes a real 500 queryable after the fact instead of
    // only discoverable by a user reporting "it's broken" and someone
    // manually re-deriving what happened, the way today's whole
    // diagnostic session had to.
    track(db, {
      type: 'server_error',
      orgId: req.user?.org || null,
      userId: req.user?.sub || null,
      data: { path: req.originalUrl, method: req.method, status: code, message: String(err?.message || err).slice(0, 500), reqId: req.id || null },
    }).catch(() => {});
    res.status(500).json({ error: 'Internal server error', message: config.nodeEnv === 'production' ? undefined : err.message });
  });

  return app;
}

// Only start a traditional listener when this file is run directly (local
// dev, or a persistent host like Railway/Render) -- not when it's imported
// by the serverless entry point (api/index.js), which just wants buildApp().
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  buildApp()
    .then((app) => {
      server = app.listen(config.port, () => {
        console.log(`[sk-os] API listening on http://127.0.0.1:${config.port} (db: ${dbInstance.driver})`);
      });
    })
    .catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });
}

// ---- Process-level error handling ----
// Unhandled promise rejections crash the process (Node >=15 default).
// Log the error for diagnostics before exiting — the process manager
// (systemd, k8s, PM2, etc.) will restart the server.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

// ---- Graceful shutdown ----
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sk-os] ${signal} received — shutting down gracefully…`);

  // Stop accepting new connections
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    console.log('[sk-os] HTTP server closed.');
  }

  // Close database connection
  if (dbInstance) {
    try {
      if (dbInstance.driver === 'postgres' && dbInstance.raw) {
        await dbInstance.raw.end();
      }
      // SQLite via node:sqlite DatabaseSync has no async close — the handle
      // is released when the process exits. No action needed here.
    } catch (e) {
      console.error('[sk-os] Error closing database:', e.message);
    }
  }

  console.log('[sk-os] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
