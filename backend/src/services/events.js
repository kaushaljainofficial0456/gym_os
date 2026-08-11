// Product analytics: append-only event log. Events feed future dashboards
// (retention, feature usage, trainer time saved). Call with a plain object.
// Accept both styles: track(db, 'type', orgId, userId, data) and track(db, { type, orgId, userId, data }).
export async function track(db, typeOrOpts, orgId = null, userId = null, data = {}) {
  let type = typeOrOpts;
  if (typeof typeOrOpts === 'object' && typeOrOpts !== null) {
    ({ type, orgId = null, userId = null, data = {} } = typeOrOpts);
  }
  try {
    await db.run(
      `INSERT INTO events (id, org_id, user_id, type, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['evt_' + Math.random().toString(36).slice(2, 12), orgId, userId, type || 'unknown',
       JSON.stringify(data), new Date().toISOString()]);
  } catch {
    /* analytics must never break the request */
  }
}
