import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { getDb } from './db.js';
import { config } from './config.js';
import { requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import clientRoutes from './routes/clients.js';
import workoutRoutes from './routes/workouts.js';
import nutritionRoutes from './routes/nutrition.js';
import trackingRoutes from './routes/tracking.js';
import insightRoutes from './routes/insights.js';
import alertRoutes from './routes/alerts.js';
import reportRoutes from './routes/reports.js';
import messageRoutes from './routes/messages.js';
import adminRoutes from './routes/admin.js';
import meRoutes from './routes/me.js';
import intelligenceRoutes from './routes/intelligence.js';

async function main() {
  const db = await getDb();
  const app = express();

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
  app.use(['/api/intel', '/api/clients'], express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '1mb' }));

app.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true, db: db.driver, ts: new Date().toISOString() }));

// Readiness: verifies the database actually answers. Kept lightweight.
app.get(['/ready', '/api/ready'], async (_req, res) => {
  try {
    await db.q1('SELECT 1 AS ok');
    res.json({ ok: true, db: db.driver, ts: new Date().toISOString() });
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
app.use('/api/me', meRoutes(db));      // client personalization: prefs, metrics, foods, meals, workouts, crowd
app.use('/api/intel', intelligenceRoutes(db)); // SK Intelligence Engine: NL parsing, search, generation, label scan
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
    res.status(500).json({ error: 'Internal server error', message: config.nodeEnv === 'production' ? undefined : err.message });
  });

  app.listen(config.port, () => {
    console.log(`[sk-os] API listening on http://127.0.0.1:${config.port} (db: ${db.driver})`);
  });
}

main().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });
