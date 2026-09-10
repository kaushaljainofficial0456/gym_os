// ============================================================
// SK OS HEALTH INTELLIGENCE — API routes (spec §68).
//
// Client-scoped (this app's wearable/energy data is inherently a
// client-facing concept, same as every other /me/* route) --
// requireAuth + a getClient() guard, same pattern me.js already uses.
//
// PERFORMANCE: none of these routes are on the existing hot paths
// (/tracking/me/home, /me/foods, etc.) -- they are new, separately
// mounted endpoints a client only hits when actually viewing the
// Connected Devices / burn-detail screens, so nothing here can slow
// down the app for someone who never opens them.
// ============================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { id, now } from '../ids.js';
import { dayKey, DEFAULT_TZ } from '../utils/time.js';
import { config } from '../config.js';
import { rateLimit } from '../rateLimit.js';
import { getProvider, listProviders } from '../services/health/providers/registry.js';
import { ProviderNotConfiguredError, RequiresNativeAppError } from '../services/health/providers/baseProvider.js';
import { upsertHealthRecord } from '../services/health/dedup.js';
import { reconcileUserDay, getDailyIntelligence, getBurnBreakdown } from '../services/health/dailyIntelligence.js';

// Refresh a token this many ms BEFORE it actually expires, so a sync
// that takes a few seconds can't have the token die mid-flight.
const TOKEN_REFRESH_SKEW_MS = 120_000;

/** Thrown when the refresh GRANT itself is dead (revoked at the provider,
 *  or a rotated refresh token was lost). Distinct from a transient sync
 *  failure: no amount of retrying fixes it -- only the user reconnecting. */
class ReconnectRequiredError extends Error {
  constructor(provider) {
    super('This connection expired. Reconnect to resume syncing.');
    this.code = 'reconnect_required';
    this.provider = provider;
  }
}

/** Returns a connection whose access token is valid RIGHT NOW, refreshing
 *  it first if it has expired (or is about to).
 *
 *  Caught live: provider.refreshAccessToken existed in every OAuth
 *  provider adapter but nothing ever called it -- syncOneConnection used
 *  conn.access_token raw. WHOOP access tokens last ~1 hour, so every
 *  connection worked for an hour and then failed every subsequent sync
 *  with "sync failed" forever, with no way to recover short of
 *  disconnecting and reconnecting by hand. This is the third instance of
 *  the same class of bug in this feature (see whoopProvider.js's
 *  incrementalSync and normalizeRecovery/normalizeSleep): written,
 *  correct, and never wired up.
 *
 *  `force` skips the expiry check -- used when a sync gets a 401 despite
 *  a token_expires_at that claims it is still valid (clock skew, a
 *  provider-side revocation, or a connection created before this existed
 *  and therefore carrying no expiry at all).
 *
 *  Persists the ROTATED refresh token, not just the new access token --
 *  WHOOP invalidates the old refresh token on every refresh, so dropping
 *  the new one bricks the connection on the NEXT refresh instead of this
 *  one (see whoopProvider.js's refreshAccessToken). */
async function ensureFreshToken(db, provider, conn, { force = false } = {}) {
  if (!provider.refreshAccessToken) return conn;
  if (!conn.refresh_token) {
    // No refresh token was ever stored (a connection made before the
    // 'offline' scope was requested, or a provider that issues none). The
    // access token cannot be renewed, so once it is rejected the only
    // real fix is reconnecting -- say that, rather than surfacing a bare
    // 401 the user cannot act on. Only escalates on `force`, i.e. after a
    // request has actually been rejected: an unexpired token still works.
    if (!force) return conn;
    await db.run(
      'UPDATE health_provider_connections SET status = ?, sync_status = ?, sync_error = ?, updated_at = ? WHERE id = ?',
      ['revoked', 'error', 'Connection expired — reconnect to resume syncing', now(), conn.id]);
    throw new ReconnectRequiredError(conn.provider);
  }
  if (!force) {
    const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : NaN;
    // No/unparseable expiry -> fall through and refresh, rather than
    // optimistically using a token whose validity we cannot reason about.
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) return conn;
  }
  let tokens;
  try {
    tokens = await provider.refreshAccessToken(conn.refresh_token);
  } catch (e) {
    // The grant is gone -- surface it as "reconnect", never as a generic
    // sync failure the user can only stare at.
    console.error(`[health] ${conn.provider} token refresh failed:`, e.message || e);
    await db.run(
      'UPDATE health_provider_connections SET status = ?, sync_status = ?, sync_error = ?, updated_at = ? WHERE id = ?',
      ['revoked', 'error', 'Connection expired — reconnect to resume syncing', now(), conn.id]);
    throw new ReconnectRequiredError(conn.provider);
  }
  const accessToken = tokens.accessToken ?? null;
  const refreshToken = tokens.refreshToken ?? conn.refresh_token;
  const tokenExpiresAt = tokens.expiresAt ?? null;
  await db.run(
    'UPDATE health_provider_connections SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?',
    [accessToken, refreshToken, tokenExpiresAt, now(), conn.id]);
  return { ...conn, access_token: accessToken, refresh_token: refreshToken, token_expires_at: tokenExpiresAt };
}

/** Our provider adapters format transport failures as
 *  `<Provider> sync failed (<path>): <status>` -- match the status as a
 *  whole token so a 401 appearing inside a longer number cannot
 *  masquerade as an auth failure. */
function isAuthFailure(err) {
  const re = new RegExp('(?:^|[^0-9])(401|403)(?:[^0-9]|$)');
  return re.test(String((err && err.message) || ''));
}

/** Syncs ONE provider connection: refresh the access token if needed,
 *  fetch incremental records, upsert them (idempotent -- see dedup.js, so
 *  a redundant call from a duplicate webhook delivery is harmless), and
 *  update the connection's own sync state. Shared by POST /sync (loops
 *  over every connection for the calling user) and the webhook handler
 *  below (exactly one connection, pushed by the provider itself) -- same
 *  sync logic either way, only who triggers it differs. Never throws -- a
 *  webhook delivery needs to ack fast regardless of whether the
 *  provider-side fetch itself failed. */
async function syncOneConnection(db, provider, conn) {
  await db.run('UPDATE health_provider_connections SET sync_status = ?, updated_at = ? WHERE id = ?', ['syncing', now(), conn.id]);
  try {
    conn = await ensureFreshToken(db, provider, conn);
    let result;
    try {
      result = await provider.incrementalSync({ accessToken: conn.access_token, cursor: conn.sync_cursor, since: conn.last_synced_at });
    } catch (e) {
      // A 401 despite a token we believed was valid: force one refresh and
      // retry exactly once. Anything else (or a second failure) propagates.
      if (!isAuthFailure(e)) throw e;
      conn = await ensureFreshToken(db, provider, conn, { force: true });
      result = await provider.incrementalSync({ accessToken: conn.access_token, cursor: conn.sync_cursor, since: conn.last_synced_at });
    }
    const { records, nextCursor } = result;
    let inserted = 0;
    for (const rec of records) {
      const { inserted: wasInserted } = await upsertHealthRecord(db, { userId: conn.user_id, orgId: conn.org_id, connectionId: conn.id }, rec);
      if (wasInserted) inserted++;
    }
    await db.run('UPDATE health_provider_connections SET sync_status = ?, sync_cursor = ?, last_synced_at = ?, sync_error = NULL, updated_at = ? WHERE id = ?',
      ['idle', nextCursor, now(), now(), conn.id]);
    return { provider: conn.provider, ok: true, recordsSynced: records.length, recordsInserted: inserted };
  } catch (e) {
    // ensureFreshToken already wrote status='revoked' + its own message for
    // this case -- don't overwrite it with a generic sync error.
    if (e instanceof ReconnectRequiredError) {
      return { provider: conn.provider, ok: false, error: e.message, code: e.code, reconnectRequired: true };
    }
    await db.run('UPDATE health_provider_connections SET sync_status = ?, sync_error = ?, updated_at = ? WHERE id = ?', ['error', e.message, now(), conn.id]);
    return { provider: conn.provider, ok: false, error: e.message };
  }
}

export default function healthRoutes(db) {
  const r = Router();

  const redirectUri = (provider) => `${config.healthApiBaseUrl}/api/health/providers/${provider}/callback`;

  // ---- GET /health/providers/:provider/callback -- OAuth redirect target ----
  // PUBLIC by necessity (the provider redirects the user's own browser
  // here with no way to attach an SK OS auth header) -- ownership is
  // instead proven by the oauth_state round-trip: the state value was
  // generated and stored against a specific user_id in /connect below,
  // and this handler only ever updates the row that state belongs to.
  //
  // Registered BEFORE `r.use(requireAuth)` below -- this route was
  // originally defined AFTER that line, so requireAuth silently rejected
  // every real provider redirect with 401 "Authentication required"
  // before this handler ever ran (caught live testing the WHOOP flow:
  // the redirect back from a real WHOOP sign-in hit this 401 instead of
  // completing the token exchange). Every route below still requires
  // auth via r.use(requireAuth) further down -- only this one is public.
  r.get('/providers/:provider/callback', async (req, res) => {
    let provider;
    try { provider = getProvider(req.params.provider); }
    catch { return res.status(404).send('Unknown provider'); }
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${config.frontendUrl}/app/client/health?connect=error&provider=${provider.key}`);
    const conn = await db.q1('SELECT * FROM health_provider_connections WHERE provider = ? AND oauth_state = ? AND status = ?', [provider.key, state, 'pending']);
    if (!conn) return res.redirect(`${config.frontendUrl}/app/client/health?connect=error&provider=${provider.key}`);
    try {
      const tokens = await provider.exchangeCode(code, redirectUri(provider.key));
      // SQLite (node:sqlite / better-sqlite3) refuses to bind `undefined`
      // -- only `null` is a valid "no value" parameter. Caught live: WHOOP's
      // real token response has no refresh_token field for this grant, so
      // tokens.refreshToken came back undefined and the UPDATE below threw
      // "cannot be bound to SQLite parameter 2" AFTER a real, successful
      // exchange -- the connection was silently lost despite WHOOP having
      // already issued a valid access token. `?? null` is applied to every
      // provider-supplied field here (not just refreshToken) since any
      // provider's response shape can omit an optional field the same way.
      const accessToken = tokens.accessToken ?? null;
      const refreshToken = tokens.refreshToken ?? null;
      const tokenExpiresAt = tokens.expiresAt ?? null;
      const externalAccountId = tokens.externalAccountId ?? null;
      await db.run(
        `UPDATE health_provider_connections SET status = 'connected', access_token = ?, refresh_token = ?, token_expires_at = ?,
           external_account_id = ?, scopes_json = ?, oauth_state = NULL, connected_at = ?, updated_at = ? WHERE id = ?`,
        [accessToken, refreshToken, tokenExpiresAt, externalAccountId, JSON.stringify(tokens.scopes || []), now(), now(), conn.id]);
      res.redirect(`${config.frontendUrl}/app/client/health?connect=success&provider=${provider.key}`);
    } catch (e) {
      // Logged server-side (never to the client redirect -- that stays a
      // generic message) so a real exchange failure is diagnosable instead
      // of silently swallowed. Caught live: the original bare `catch {}`
      // here gave zero visibility into why WHOOP's token exchange failed.
      console.error(`[health] ${provider.key} token exchange failed:`, e.message || e);
      await db.run('UPDATE health_provider_connections SET status = ?, sync_error = ?, updated_at = ? WHERE id = ?', ['error', 'Token exchange failed', now(), conn.id]);
      res.redirect(`${config.frontendUrl}/app/client/health?connect=error&provider=${provider.key}`);
    }
  });

  // ---- POST /health/providers/:provider/webhook -- automatic sync, PUSHED by the provider ----
  // This is what actually removes the "tap Sync now every time" problem:
  // instead of the user (or a poll) asking WHOOP "anything new?", WHOOP
  // calls THIS the moment a workout/recovery/sleep is scored, and the
  // handler triggers a real incremental sync for exactly that connection
  // right away. PUBLIC for the same reason the callback above is (the
  // provider calls it directly -- no SK OS session exists to attach an
  // auth header to) but authenticated by a per-provider signature instead
  // of the oauth_state round-trip a callback can use (a webhook delivery
  // has no prior request of its own to check state against).
  //
  // index.js registers express.raw() for this exact path BEFORE the
  // app-wide express.json() -- req.body arrives here as a Buffer, never
  // pre-parsed, because the signature is HMAC'd over WHOOP's exact raw
  // bytes (same reasoning as the Razorpay webhook in enterprise.js).
  //
  // NOT live-delivery-tested: that needs a public HTTPS URL registered in
  // WHOOP's Developer Dashboard (dashboard-only, no API for it), which
  // only exists once this is deployed and the user has added
  // `${HEALTH_API_BASE_URL}/api/health/providers/whoop/webhook` there.
  // The signature check and dispatch logic below are built and unit-
  // tested against WHOOP's documented HMAC scheme, not a captured
  // delivery -- same honesty rule this whole file already follows for
  // "written against docs" vs "confirmed live".
  const webhookLimit = rateLimit({ windowMs: 60_000, max: 240, keyFn: (req) => req.ip || 'anon' });
  r.post('/providers/:provider/webhook', webhookLimit, async (req, res) => {
    let provider;
    try { provider = getProvider(req.params.provider); }
    catch { return res.status(404).json({ error: 'Unknown provider' }); }
    if (!provider.supportsWebhook) return res.status(501).json({ error: `${provider.key} does not support webhooks` });

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const signature = req.headers['x-whoop-signature'];
    const timestamp = req.headers['x-whoop-signature-timestamp'];
    if (!provider.verifyWebhookSignature(rawBody, signature, timestamp)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: 'invalid webhook payload' }); } // malformed body must never trigger a retry

    // Deletion events (workout.deleted etc.) aren't handled yet -- acked
    // as a no-op rather than silently claimed as supported.
    if (!String(payload.type || '').endsWith('.updated')) return res.json({ ok: true });

    const conn = await db.q1(
      'SELECT * FROM health_provider_connections WHERE provider = ? AND external_account_id = ? AND status = ?',
      [provider.key, String(payload.user_id), 'connected']);
    // No connection found (disconnected, or externalAccountId wasn't
    // captured for a connection made before this existed) -- still a
    // 200: this is a legitimate "nothing to do" outcome, not an error
    // WHOOP should retry.
    if (!conn) return res.json({ ok: true, synced: false });

    const result = await syncOneConnection(db, provider, conn);
    res.json({ ok: true, synced: true, result });
  });

  r.use(requireAuth);

  const getClient = async (req, res) => {
    const c = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!c) { res.status(404).json({ error: 'No client profile linked to this account' }); return null; }
    return c;
  };

  // ---- GET /health/devices -- every provider, real status for each ----
  r.get('/devices', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const connections = await db.q('SELECT * FROM health_provider_connections WHERE user_id = ?', [req.user.sub]);
    const byProvider = new Map(connections.map((row) => [row.provider, row]));
    const devices = listProviders().map((p) => {
      const conn = byProvider.get(p.key);
      return {
        provider: p.key,
        implemented: p.implemented,
        nativeOnly: p.nativeOnly,
        platform: p.platform || null,
        capabilities: p.capabilities,
        status: conn?.status || 'disconnected',
        connectedAt: conn?.connected_at || null,
        lastSyncedAt: conn?.last_synced_at || null,
        syncStatus: conn?.sync_status || 'idle',
        syncError: conn?.sync_error || null,
        // Never a raw boolean "works" flag -- the frontend renders one of
        // these three states explicitly (spec §86/§108's honesty rule).
        availability: p.nativeOnly ? 'requires_native_app' : p.implemented ? 'available' : 'architected_only',
      };
    });
    res.json({ devices });
  });

  // ---- POST /health/providers/:provider/connect ----
  r.post('/providers/:provider/connect', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    let provider;
    try { provider = getProvider(req.params.provider); }
    catch { return res.status(404).json({ error: 'Unknown provider' }); }

    try {
      const state = crypto.randomBytes(24).toString('hex');
      const url = provider.getAuthorizeUrl(state, redirectUri(provider.key));
      const nowIso = now();
      const existing = await db.q1('SELECT id FROM health_provider_connections WHERE user_id = ? AND provider = ?', [req.user.sub, provider.key]);
      if (existing) {
        await db.run('UPDATE health_provider_connections SET status = ?, oauth_state = ?, updated_at = ? WHERE id = ?', ['pending', state, nowIso, existing.id]);
      } else {
        await db.run(
          `INSERT INTO health_provider_connections (id, user_id, org_id, provider, status, capabilities_json, oauth_state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [id('hconn'), req.user.sub, req.user.org, provider.key, 'pending', JSON.stringify(provider.capabilities), state, nowIso, nowIso]);
      }
      res.json({ authorizeUrl: url });
    } catch (e) {
      if (e instanceof RequiresNativeAppError) return res.status(409).json({ error: e.message, code: e.code, platform: e.platform });
      if (e instanceof ProviderNotConfiguredError) return res.status(503).json({ error: e.message, code: e.code });
      res.status(500).json({ error: 'Could not start the connection' });
    }
  });

  // ---- POST /health/providers/:provider/disconnect ----
  r.post('/providers/:provider/disconnect', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    await db.run(
      `UPDATE health_provider_connections SET status = 'disconnected', access_token = NULL, refresh_token = NULL,
         disconnected_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?`,
      [now(), now(), req.user.sub, req.params.provider]);
    // Imported data is kept by default (spec §85) -- deleting it is a
    // separate, explicit action a user would take from privacy settings,
    // not implied by disconnecting.
    res.json({ ok: true });
  });

  // ---- GET /health/sync/status ----
  r.get('/sync/status', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const rows = await db.q('SELECT provider, status, sync_status, sync_error, last_synced_at FROM health_provider_connections WHERE user_id = ?', [req.user.sub]);
    res.json({ connections: rows });
  });

  // ---- POST /health/sync -- incremental sync for every CONNECTED provider ----
  // Manual fallback / "sync right now" button -- automatic sync for
  // webhook-capable providers (WHOOP) happens on its own via the
  // /providers/:provider/webhook route above the moment new data is
  // ready, so this is no longer the ONLY way data ever arrives. Kept for
  // providers with no webhook support, and as an explicit user-triggered
  // refresh. Shares syncOneConnection with the webhook handler.
  r.post('/sync', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const connections = await db.q('SELECT * FROM health_provider_connections WHERE user_id = ? AND status = ?', [req.user.sub, 'connected']);
    const results = [];
    for (const conn of connections) {
      results.push(await syncOneConnection(db, getProvider(conn.provider), conn));
    }
    res.json({ results });
  });

  // ---- GET /health/daily-intelligence?date=YYYY-MM-DD&refresh=1 ----
  r.get('/daily-intelligence', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const date = req.query.date || dayKey(new Date(), DEFAULT_TZ);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!forceRefresh) {
      const cached = await getDailyIntelligence(db, { userId: req.user.sub, date });
      if (cached) return res.json({ intelligence: cached, cached: true });
    }
    // Without tz, reconciliation buckets the day in the SERVER's default
    // timezone, which is a different day's worth of records for a user in
    // another one -- same class of bug as the UTC-bounds query below.
    const summary = await reconcileUserDay(db, { userId: req.user.sub, orgId: req.user.org, clientId: c.id, date, tz: req.tz || DEFAULT_TZ });
    res.json({ intelligence: summary, cached: false });
  });

  // ---- GET /health/workouts?date=YYYY-MM-DD -- canonical workouts for a day ----
  r.get('/workouts', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const date = req.query.date || dayKey(new Date(), DEFAULT_TZ);
    // Wide UTC window + exact local-day filter -- the naive
    // `date+T00:00Z .. date+T23:59Z` form this used to have silently drops
    // evening sessions for any user east of UTC (see getBurnBreakdown's
    // own comment, where the same defect was caught live).
    const tz = req.tz || DEFAULT_TZ;
    const wideStart = new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000).toISOString();
    const wideEnd = new Date(Date.parse(`${date}T00:00:00Z`) + 48 * 3600 * 1000).toISOString();
    const rows = await db.q(
      `SELECT * FROM health_canonical_workouts WHERE user_id = ? AND start_time >= ? AND start_time <= ? ORDER BY start_time`,
      [req.user.sub, wideStart, wideEnd]);
    res.json({ workouts: rows.filter((w) => dayKey(new Date(w.start_time), tz) === date) });
  });

  // ---- GET /health/burn-breakdown?date=YYYY-MM-DD -- the itemized day ----
  // Powers the burn-detail screen: total burn split into resting (BMR),
  // each workout with its real timestamps and winning source, and
  // everyday movement from steps. Reads only already-reconciled rows;
  // reconciliation itself happens on /daily-intelligence, so opening this
  // screen never triggers a recompute.
  r.get('/burn-breakdown', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const date = req.query.date || dayKey(new Date(), DEFAULT_TZ);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const tz = req.tz || DEFAULT_TZ;
    let breakdown = await getBurnBreakdown(db, { userId: req.user.sub, date });
    if (!breakdown) {
      // Never reconciled yet (the user opened the breakdown before Home
      // ever loaded this day) -- compute it once, then read it back.
      await reconcileUserDay(db, { userId: req.user.sub, orgId: req.user.org, clientId: c.id, date, tz });
      breakdown = await getBurnBreakdown(db, { userId: req.user.sub, date });
    }
    res.json({ breakdown });
  });

  // ---- GET /health/trends?days=7 -- Progress screen (spec §82) ----
  // A single indexed read over the ALREADY-cached health_daily_summaries
  // table -- deliberately does NOT trigger reconciliation for any missing
  // day (that only ever happens via GET /daily-intelligence, when Home/
  // Nutrition/the workout summary screen actually visit that day). A day
  // with no cached row is simply absent from the response, not backfilled
  // synchronously -- this keeps Progress fast even for a user who has
  // never opened those other screens, at the cost of possibly-sparse
  // history until they have (an honest tradeoff, not a bug).
  r.get('/trends', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = dayKey(new Date(Date.now() - days * 86400000), DEFAULT_TZ);
    const rows = await db.q(
      `SELECT date, active_energy, training_load, workout_minutes, steps, data_quality
         FROM health_daily_summaries WHERE user_id = ? AND date >= ? ORDER BY date`,
      [req.user.sub, since]);
    res.json({ days: rows });
  });

  return r;
}
