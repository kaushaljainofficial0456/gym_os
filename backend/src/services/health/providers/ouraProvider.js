// ============================================================
// OURA PROVIDER ADAPTER.
//
// STATUS: implemented: true, UNVERIFIED against a live Oura developer
// sandbox -- same caveat as whoopProvider.js. Endpoint URLs and payload
// shapes below are written against Oura's PUBLICLY DOCUMENTED v2 API
// (cloud.ouraring.com / api.ouraring.com/v2/usercollection) as of this
// codebase's general knowledge, NOT a captured real response. VERIFY
// against https://cloud.ouraring.com/v2/docs before production use.
//
// Oura explicitly supports BOTH auto-detected and user-entered workouts
// (spec §9) -- normalizeWorkout reads that straight off the record
// rather than assuming one or the other.
// ============================================================
import { ProviderNotConfiguredError, emptyCapabilities } from './baseProvider.js';
import { config } from '../../../config.js';

const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const API_BASE = 'https://api.ouraring.com/v2/usercollection';

const SCOPES = ['daily', 'heartrate', 'workout', 'session'];

function requireCredentials() {
  const missing = [];
  if (!config.ouraClientId) missing.push('OURA_CLIENT_ID');
  if (!config.ouraClientSecret) missing.push('OURA_CLIENT_SECRET');
  if (missing.length) throw new ProviderNotConfiguredError('oura', missing);
}

function getAuthorizeUrl(state, redirectUri) {
  requireCredentials();
  const p = new URLSearchParams({
    client_id: config.ouraClientId,
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
      client_id: config.ouraClientId,
      client_secret: config.ouraClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Oura token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = await res.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 0) * 1000).toISOString(),
    externalAccountId: null,
    scopes: (body.scope || '').split(' ').filter(Boolean),
  };
}

async function refreshAccessToken(refreshToken) {
  requireCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.ouraClientId,
      client_secret: config.ouraClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Oura token refresh failed: ${res.status}`);
  const body = await res.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (Number(body.expires_in) || 0) * 1000).toISOString(),
  };
}

/** Oura workout record -> CanonicalHealthRecordInput. Shape assumed
 *  (VERIFY): { id, activity, calories, distance, intensity,
 *  start_datetime, end_datetime, source }. `source` is documented as
 *  'manual' | 'autodetected' | 'confirmed' -- mapped straight to
 *  auto_detected/user_entered, never guessed. */
function normalizeWorkout(raw) {
  const isAuto = raw.source === 'autodetected';
  return {
    provider: 'oura',
    provider_record_id: String(raw.id),
    data_type: 'workout',
    activity_type: ouraActivityToActivityType(raw.activity),
    start_time: raw.start_datetime,
    end_time: raw.end_datetime,
    active_kcal: numOrNull(raw.calories),
    distance_m: numOrNull(raw.distance),
    auto_detected: isAuto,
    user_entered: raw.source === 'manual',
    data_quality: 'good',
  };
}

/** Oura daily_activity record -> CanonicalHealthRecordInput[] (one
 *  energy_sample covering the whole reported day). Shape assumed
 *  (VERIFY): { day, active_calories, total_calories, steps,
 *  equivalent_walking_distance }. Oura reports BOTH active and total --
 *  never conflate them (spec §24). */
function normalizeDailyActivity(raw) {
  return [{
    provider: 'oura',
    provider_record_id: `daily_${raw.day}`,
    data_type: 'energy_sample',
    start_time: `${raw.day}T00:00:00Z`,
    end_time: `${raw.day}T23:59:59Z`,
    active_kcal: numOrNull(raw.active_calories),
    total_kcal: numOrNull(raw.total_calories),
    steps: Number.isInteger(raw.steps) ? raw.steps : null,
    distance_m: numOrNull(raw.equivalent_walking_distance),
    data_quality: 'good',
  }];
}

/** Oura daily_readiness -> CanonicalHealthRecordInput. Oura's own
 *  readiness `score` is stored as source_score/source_metric='readiness'
 *  -- NEVER surfaced as SK OS's own Readiness score (spec §9/§39). */
function normalizeReadiness(raw) {
  return {
    provider: 'oura',
    provider_record_id: `readiness_${raw.day}`,
    data_type: 'recovery',
    start_time: `${raw.day}T00:00:00Z`,
    resting_hr: numOrNull(raw?.contributors?.resting_heart_rate),
    hrv_ms: numOrNull(raw?.contributors?.hrv_balance),
    source_score: numOrNull(raw.score),
    source_metric: 'readiness',
    data_quality: 'good',
  };
}

/** Oura sleep record -> CanonicalHealthRecordInput. Shape assumed
 *  (VERIFY): { id, bedtime_start, bedtime_end, total_sleep_duration,
 *  efficiency }. Duration reported in seconds by Oura already. */
function normalizeSleep(raw) {
  return {
    provider: 'oura',
    provider_record_id: String(raw.id),
    data_type: 'sleep',
    start_time: raw.bedtime_start,
    end_time: raw.bedtime_end,
    sleep_duration_seconds: numOrNull(raw.total_sleep_duration),
    data_quality: 'good',
  };
}

function ouraActivityToActivityType(activity) {
  const MAP = {
    running: 'running', cycling: 'cycling', walking: 'walking',
    strength_training: 'strength_training', swimming: 'swimming',
    rowing: 'rowing', yoga: 'yoga', hiking: 'hiking',
  };
  return MAP[activity] || 'other';
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function incrementalSync({ accessToken, since }) {
  const p = new URLSearchParams();
  if (since) { p.set('start_date', since.slice(0, 10)); }
  const res = await fetch(`${API_BASE}/workout?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Oura sync failed: ${res.status}`);
  const body = await res.json();
  const records = (body.data || []).map(normalizeWorkout);
  return { records, nextCursor: body.next_token || null };
}

export default {
  key: 'oura',
  implemented: true,
  nativeOnly: false,
  capabilities: {
    ...emptyCapabilities(),
    workouts: true, autoDetectedWorkouts: true, activeEnergy: true, totalEnergy: true,
    heartRate: true, steps: true, distance: true, sleep: true, recovery: true, hrv: true,
    restingHeartRate: true,
  },
  getAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  incrementalSync,
  normalizeWorkout,
  normalizeDailyActivity,
  normalizeReadiness,
  normalizeSleep,
};
