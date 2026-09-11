// ============================================================
// WHOOP PROVIDER ADAPTER.
//
// STATUS: LIVE-VERIFIED 2026-09-09 against a real WHOOP developer app
// and a real connected account -- OAuth connect, token exchange
// (including the `offline` scope for refresh tokens), and incrementalSync
// across all three collections (workout/recovery/sleep) all confirmed
// working end-to-end against production WHOOP data, not just docs. The
// v1 API paths this file originally used are gone (WHOOP moved to v2) --
// already fixed below. Webhook signature verification (verifyWebhookSignature)
// is implemented per WHOOP's documented HMAC scheme but NOT live-delivery-
// tested -- that requires a publicly reachable HTTPS URL registered in
// WHOOP's Developer Dashboard, which only exists once this is deployed.
//
// Never rename WHOOP's own recovery/strain scores into an SK OS score
// (spec §8) -- normalizeRecovery/normalizeWorkout store them as
// source_score + source_metric, exactly as ingested.
// ============================================================
import crypto from 'node:crypto';
import { RequiresNativeAppError, ProviderNotConfiguredError, emptyCapabilities } from './baseProvider.js';
import { config } from '../../../config.js';

// Per WHOOP's documented OAuth 2.0 endpoints (developer.whoop.com).
// VERIFY against current docs before production use -- WHOOP has
// changed API versions before (v1 -> v2) and may again.
const AUTHORIZE_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
// v1 -> v2 (confirmed live 2026-09-09 against developer.whoop.com/api --
// the comment above already flagged this exact risk before it was ever
// tested against the real API). Caught live: incrementalSync's workout
// fetch 404'd against v1 immediately after a real, successful OAuth
// connect. v2's /activity/workout response shape (records[], score.{
// strain, average_heart_rate, max_heart_rate, kilojoule}, sport_id,
// score_state, next_token) is unchanged from what normalizeWorkout
// already assumed -- only the path version needed to move.
const API_BASE = 'https://api.prod.whoop.com/developer/v2';

// 'offline' is required for WHOOP to issue a refresh_token at all (per
// developer.whoop.com/docs/developing/oauth -- "You must request the
// offline scope to receive a refresh token"). Without it, a connection
// silently dies once the short-lived access token expires with no way
// to renew it -- caught live: the first successful WHOOP token exchange
// came back with refresh_token entirely absent because this was missing.
const SCOPES = ['offline', 'read:recovery', 'read:cycles', 'read:workout', 'read:sleep', 'read:profile', 'read:body_measurement'];

function requireCredentials() {
  const missing = [];
  if (!config.whoopClientId) missing.push('WHOOP_CLIENT_ID');
  if (!config.whoopClientSecret) missing.push('WHOOP_CLIENT_SECRET');
  if (missing.length) throw new ProviderNotConfiguredError('whoop', missing);
}

function getAuthorizeUrl(state, redirectUri) {
  requireCredentials();
  const p = new URLSearchParams({
    client_id: config.whoopClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  requireCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.whoopClientId,
      client_secret: config.whoopClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`WHOOP token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = await res.json();
  // WHOOP's own numeric user id -- required to match an incoming webhook
  // delivery (which carries WHOOP's user_id, never our users.id) back to
  // this connection. `read:profile` is already a requested scope, so this
  // costs one extra call right after the exchange rather than leaving it
  // for the first sync -- a webhook can arrive before any sync ever runs.
  // Best-effort: a failure here must never fail the whole connection (the
  // access token is already valid) -- it just means webhook auto-sync
  // can't resolve this user until the next successful sync retries it.
  let externalAccountId = null;
  try {
    const profileRes = await fetch(`${API_BASE}/user/profile/basic`, { headers: { Authorization: `Bearer ${body.access_token}` } });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      externalAccountId = profile.user_id != null ? String(profile.user_id) : null;
    }
  } catch { /* best-effort -- see comment above */ }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 0) * 1000).toISOString(),
    externalAccountId,
    scopes: (body.scope || '').split(' ').filter(Boolean),
  };
}

/** Verifies a WHOOP webhook delivery per developer.whoop.com/docs/developing/webhooks:
 *  base64(HMAC-SHA256(timestamp + rawBody, client_secret)), compared to the
 *  X-WHOOP-Signature header (X-WHOOP-Signature-Timestamp supplies `timestamp`).
 *  Mirrors paymentProvider.js's verifyWebhookSignature -- same fail-closed-on-
 *  missing-secret and timingSafeEqual discipline, different provider/encoding. */
function verifyWebhookSignature(rawBody, signature, timestamp) {
  if (!config.whoopClientSecret) return false; // fail closed -- never verify against a missing secret
  if (!signature || !timestamp) return false;
  const expected = crypto.createHmac('sha256', config.whoopClientSecret).update(`${timestamp}${rawBody}`).digest('base64');
  const a = Buffer.from(expected, 'base64');
  const b = Buffer.from(String(signature), 'base64');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); }
  catch { return false; } // malformed signature -- never a match
}

/** Exchanges a refresh token for a fresh access token.
 *
 *  TWO WHOOP-SPECIFIC DETAILS, both confirmed against
 *  developer.whoop.com/docs/developing/oauth:
 *
 *  1. `scope: 'offline'` is part of WHOOP's own documented refresh
 *     payload -- without it a refresh can come back WITHOUT a new
 *     refresh_token, which (given rotation, below) permanently kills the
 *     connection on the following refresh.
 *  2. Refresh tokens ROTATE: "the refresh token from the refresh
 *     response is now the valid refresh token, and your app must use the
 *     new refresh token on the subsequent refresh request". The caller
 *     MUST persist the returned refreshToken -- storing only the new
 *     access token and keeping the old refresh token means the next
 *     refresh fails with an invalid_grant and the user has to reconnect
 *     by hand. See health.js's ensureFreshToken, which does persist it. */
async function refreshAccessToken(refreshToken) {
  requireCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.whoopClientId,
      client_secret: config.whoopClientSecret,
      scope: 'offline',
    }),
  });
  if (!res.ok) throw new Error(`WHOOP token refresh failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = await res.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 0) * 1000).toISOString(),
  };
}

/** Pure transform: a WHOOP workout record -> CanonicalHealthRecordInput.
 *  Shape assumed (VERIFY): { id, start, end, sport_id, score_state,
 *  score: { strain, average_heart_rate, max_heart_rate, kilojoule } }.
 *  WHOOP reports energy in kilojoules -- converted to kcal here (1 kcal
 *  = 4.184 kJ), the ONE place this conversion happens for this provider. */
function normalizeWorkout(raw) {
  const kj = Number(raw?.score?.kilojoule);
  return {
    provider: 'whoop',
    provider_record_id: String(raw.id),
    data_type: 'workout',
    activity_type: whoopSportToActivityType(raw.sport_id),
    start_time: raw.start,
    end_time: raw.end,
    active_kcal: Number.isFinite(kj) ? kj / 4.184 : null,
    heart_rate_avg: numOrNull(raw?.score?.average_heart_rate),
    heart_rate_max: numOrNull(raw?.score?.max_heart_rate),
    source_score: numOrNull(raw?.score?.strain),
    source_metric: 'strain',
    auto_detected: true, // WHOOP workouts are device-detected by default
    data_quality: raw.score_state === 'SCORED' ? 'good' : 'flagged',
    data_quality_reason: raw.score_state === 'SCORED' ? null : `WHOOP score_state=${raw.score_state}`,
  };
}

/** WHOOP recovery record -> CanonicalHealthRecordInput. Shape assumed
 *  (VERIFY): { cycle_id, sleep_id, score_state, score: { recovery_score,
 *  resting_heart_rate, hrv_rmssd_milli } }. recovery_score stored as
 *  source_score, NEVER as an SK OS recovery score (spec §8/§37). */
function normalizeRecovery(raw) {
  return {
    provider: 'whoop',
    provider_record_id: `recovery_${raw.cycle_id}`,
    data_type: 'recovery',
    start_time: raw.created_at || raw.updated_at,
    resting_hr: numOrNull(raw?.score?.resting_heart_rate),
    hrv_ms: numOrNull(raw?.score?.hrv_rmssd_milli),
    source_score: numOrNull(raw?.score?.recovery_score),
    source_metric: 'recovery',
    data_quality: raw.score_state === 'SCORED' ? 'good' : 'flagged',
  };
}

/** WHOOP sleep record -> CanonicalHealthRecordInput. Shape assumed
 *  (VERIFY): { id, start, end, score: { stage_summary: { total_in_bed_time_milli, ... } } }. */
function normalizeSleep(raw) {
  const totalMs = Number(raw?.score?.stage_summary?.total_in_bed_time_milli);
  return {
    provider: 'whoop',
    provider_record_id: String(raw.id),
    data_type: 'sleep',
    start_time: raw.start,
    end_time: raw.end,
    sleep_duration_seconds: Number.isFinite(totalMs) ? totalMs / 1000 : null,
    sleep_stages_json: raw?.score?.stage_summary ? JSON.stringify(raw.score.stage_summary) : null,
    data_quality: raw.score_state === 'SCORED' ? 'good' : 'flagged',
  };
}

function whoopSportToActivityType(sportId) {
  // WHOOP's sport_id is a numeric enum documented on their developer
  // site (-1 = activity, 0 = running, 1 = cycling, 45 = strength, ...).
  // Only mapping the handful needed to exercise the matching engine's
  // activity-similarity check -- unmapped ids fall through to 'other'
  // rather than guessing.
  const MAP = { 0: 'running', 1: 'cycling', 45: 'strength_training', 52: 'swimming', 63: 'walking' };
  return MAP[sportId] || 'other';
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function fetchCollection(path, { accessToken, cursor, since }) {
  const p = new URLSearchParams();
  if (since) p.set('start', since);
  if (cursor) p.set('nextToken', cursor);
  const res = await fetch(`${API_BASE}${path}?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`WHOOP sync failed (${path}): ${res.status}`);
  const body = await res.json();
  return { records: body.records || [], nextCursor: body.next_token || null };
}

/** incrementalSync -- real fetch calls IF connect() has succeeded and a
 *  live accessToken is available; each call still requires the actual
 *  WHOOP API to be reachable and the shape above to still be accurate.
 *  `since` bounds each request to WHOOP's documented `start` query param.
 *
 *  Pulls all THREE collections the provider actually advertises
 *  (capabilities.workouts/recovery/sleep) -- caught live: this originally
 *  only ever fetched /activity/workout, so a real connected WHOOP account
 *  synced real workouts but recovery_score and sleep_duration stayed null
 *  forever (dailyIntelligence.js correctly reported "insufficient
 *  evidence", but the evidence existed on WHOOP's side and was simply
 *  never fetched). normalizeRecovery/normalizeSleep already existed and
 *  were correct -- they were just dead code with nothing calling them.
 *
 *  `cursor` is a JSON-encoded {workout, recovery, sleep} triple, not one
 *  shared token -- WHOOP's next_token is per-endpoint (3 separate
 *  collections, 3 separate pagination cursors), so a single combined
 *  cursor would silently stop paging 2 of the 3 collections correctly. */
async function incrementalSync({ accessToken, cursor, since }) {
  let cursors = {};
  if (cursor) { try { cursors = JSON.parse(cursor); } catch { cursors = {}; } }

  const [workouts, recoveries, sleeps] = await Promise.all([
    fetchCollection('/activity/workout', { accessToken, cursor: cursors.workout, since }),
    fetchCollection('/recovery', { accessToken, cursor: cursors.recovery, since }),
    fetchCollection('/activity/sleep', { accessToken, cursor: cursors.sleep, since }),
  ]);

  const records = [
    ...workouts.records.map(normalizeWorkout),
    ...recoveries.records.map(normalizeRecovery),
    ...sleeps.records.map(normalizeSleep),
  ];
  const nextCursor = (workouts.nextCursor || recoveries.nextCursor || sleeps.nextCursor)
    ? JSON.stringify({ workout: workouts.nextCursor, recovery: recoveries.nextCursor, sleep: sleeps.nextCursor })
    : null;
  return { records, nextCursor };
}

export default {
  key: 'whoop',
  implemented: true,
  nativeOnly: false,
  capabilities: {
    ...emptyCapabilities(),
    workouts: true, autoDetectedWorkouts: true, activeEnergy: true,
    heartRate: true, sleep: true, recovery: true, hrv: true, restingHeartRate: true,
  },
  getAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  incrementalSync,
  normalizeWorkout,
  normalizeRecovery,
  normalizeSleep,
  verifyWebhookSignature,
  supportsWebhook: true,
};
