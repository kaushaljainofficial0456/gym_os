// ============================================================
// A URL that is safe to write to the access log.
//
// Query strings can carry credentials: the signed provider-callback URLs of
// AI Communication (?k= the WhatsApp inbound key, ?j= a job token, ?t= an
// audio token) and any ?token= / ?signature= / ?code=. Their VALUES are
// masked; parameter names and the path are kept so the line stays useful.
// ============================================================
const SECRET_QUERY = /^(k|j|t|token|sig|signature|secret|code|key|access_token)$/i;

export function redactUrl(url) {
  const u = String(url ?? '');
  const q = u.indexOf('?');
  if (q < 0) return u;
  const params = new URLSearchParams(u.slice(q + 1));
  let changed = false;
  for (const k of [...new Set(params.keys())]) {
    if (SECRET_QUERY.test(k)) { params.set(k, '***'); changed = true; }
  }
  return changed ? `${u.slice(0, q)}?${params.toString().replace(/%2A/g, '*')}` : u;
}
