// ============================================================
// WHITE-LABEL BRANDING -- a gym's own look inside Barbell.
//
// A gym that signs up chooses two colours (and, if it likes, a logo).
// Everyone who belongs to that gym -- its members, its trainers, its owner
// -- then sees the app in those colours with "<Gym> × Barbell" in the
// header, so it feels like the gym's own app. The colours are only ever
// stored here as two plain #RRGGBB values; turning them into a readable
// dark and light theme is the frontend's job (frontend/src/brand/), where
// it can be measured against the real surfaces.
//
// Who gets a brand: organizations of type 'gym' only. Independent clients
// share one pseudo-org (type 'independent', slug 'independent') and always
// see plain Barbell -- they belong to no gym.
//
// The logo is a small data URL in gym_settings.brand_logo. It is NEVER
// sent inside /auth/me (that runs on every page load); /auth/me carries a
// URL to GET /api/branding/logo/:slug instead, versioned by
// brand_updated_at so the image can be cached for a year and still change
// the moment the owner uploads a new one.
// ============================================================

export const HEX = /^#[0-9a-f]{6}$/i;

/** '#f5c518' / 'F5C518' / '#F5C518' -> '#F5C518'; anything else -> null. */
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^#?/, '#');
  return HEX.test(s) ? s.toUpperCase() : null;
}

// gym_settings.brand_name starts life as a placeholder ('SK OS' is the
// column default, 'Barbell' what the settings screen used to prefill).
// Neither is the gym's name, so the organization's own name stands in.
const PLACEHOLDER_NAMES = new Set(['', 'sk os', 'barbell']);
export function gymDisplayName(orgName, brandName) {
  const b = String(brandName || '').trim();
  return PLACEHOLDER_NAMES.has(b.toLowerCase()) ? String(orgName || '').trim() : b;
}

export const LOGO_MIME = ['image/png', 'image/jpeg', 'image/webp'];
// The app resizes a logo to 256 px before sending it, which is typically
// 10-60 kB; this is the ceiling for one sent some other way.
export const LOGO_MAX_BYTES = 300 * 1024;

/** A logo data URL -> { mime, bytes } or { error }. SVG is refused: served
 *  from our own origin it could carry script. */
export function parseLogo(dataUrl) {
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return { error: 'The logo must be a PNG, JPEG or WebP image' };
  const mime = m[1].toLowerCase();
  if (!LOGO_MIME.includes(mime)) return { error: 'The logo must be a PNG, JPEG or WebP image' };
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LOGO_MAX_BYTES) return { error: 'That logo is too large (300 kB at most)' };
  return { mime, bytes };
}

const BRAND_SELECT = `
  SELECT o.id, o.name, o.slug, o.type,
         s.brand_name, s.brand_primary, s.brand_secondary, s.brand_updated_at,
         CASE WHEN s.brand_logo IS NULL THEN 0 ELSE 1 END AS has_logo
    FROM organizations o LEFT JOIN gym_settings s ON s.org_id = o.id`;

const isGym = (row) => !!row && row.type === 'gym' && row.slug !== 'independent';

/** The shape every client of this module sees. Colours may be null (the
 *  gym has not chosen any): the name and code are still the gym's. */
export function brandingView(row) {
  if (!isGym(row)) return null;
  const version = row.brand_updated_at || null;
  return {
    gymName: gymDisplayName(row.name, row.brand_name),
    code: row.slug,
    primary: normalizeHex(row.brand_primary),
    secondary: normalizeHex(row.brand_secondary),
    logoUrl: row.has_logo
      ? `/api/branding/logo/${encodeURIComponent(row.slug)}${version ? `?v=${encodeURIComponent(version)}` : ''}`
      : null,
    version,
  };
}

/** The brand of the gym this org id is, or null (no org, independent). */
export async function brandingForOrg(db, orgId) {
  if (!orgId) return null;
  return brandingView(await db.q1(`${BRAND_SELECT} WHERE o.id = ?`, [orgId]));
}

/** The brand behind a gym code (the org's slug) -- what a sign-up screen
 *  shows before anyone has an account. */
export async function brandingForCode(db, code) {
  const slug = String(code || '').toLowerCase().trim();
  if (!slug || slug.length > 80) return null;
  return brandingView(await db.q1(`${BRAND_SELECT} WHERE o.slug = ?`, [slug]));
}

export async function logoForCode(db, code) {
  const slug = String(code || '').toLowerCase().trim();
  if (!slug || slug.length > 80) return null;
  const row = await db.q1(
    `SELECT o.slug, o.type, s.brand_logo FROM organizations o JOIN gym_settings s ON s.org_id = o.id WHERE o.slug = ?`,
    [slug]);
  if (!isGym(row) || !row.brand_logo) return null;
  const parsed = parseLogo(row.brand_logo);
  return parsed.error ? null : parsed;
}

/**
 * Save a gym's brand. `patch` fields are three-state like every other gym
 * setting: undefined leaves it alone, null clears it, a value sets it.
 * Both colours null is "back to the Barbell look".
 */
export async function saveBranding(db, orgId, { primary, secondary, logo }, nowIso) {
  const org = await db.q1('SELECT name FROM organizations WHERE id = ?', [orgId]);
  const existing = await db.q1('SELECT brand_primary, brand_secondary, brand_logo FROM gym_settings WHERE org_id = ?', [orgId]);
  const pick = (incoming, current) => (incoming === undefined ? (current ?? null) : incoming);
  const next = {
    primary: pick(primary, existing?.brand_primary),
    secondary: pick(secondary, existing?.brand_secondary),
    logo: pick(logo, existing?.brand_logo),
  };
  // A first gym_settings row is named after the gym, not the column's
  // 'SK OS' placeholder, so the settings screen opens on the right name.
  await db.run(
    `INSERT INTO gym_settings (org_id, brand_name, brand_primary, brand_secondary, brand_logo, brand_updated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET brand_primary = excluded.brand_primary,
       brand_secondary = excluded.brand_secondary, brand_logo = excluded.brand_logo,
       brand_updated_at = excluded.brand_updated_at, updated_at = excluded.updated_at`,
    [orgId, org?.name || 'Barbell', next.primary, next.secondary, next.logo, nowIso, nowIso]);
  return brandingForOrg(db, orgId);
}
