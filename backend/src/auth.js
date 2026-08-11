import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, org: user.org_id, name: user.name, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

// Attach req.user from the Bearer token (claims carry identity), then resolve the
// authenticated organization's timezone into req.tz. Resolving tz AFTER auth is
// intentional: the org is only known once the token is verified. The old app-level
// middleware ran before this and always fell back to the default timezone.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const { getDb } = await import('./db.js');
    const db = await getDb();
    const { getOrgTz } = await import('./utils/time.js');
    req.tz = await getOrgTz(db, req.user.org || null);
  } catch {
    const { DEFAULT_TZ } = await import('./utils/time.js').catch(() => ({ DEFAULT_TZ: 'Asia/Kolkata' }));
    req.tz = DEFAULT_TZ;
  }
  // Scope the authenticated org for the rest of this request (db.tx uses it to
  // engage PostgreSQL RLS). Must wrap next() so the ALS context covers downstream.
  const { runWithOrg } = await import('./db.js');
  runWithOrg(req.user.org || null, () => next());
}

// Role gate. Call AFTER requireAuth.
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Tenant isolation: the token carries the org the user belongs to.
// SUPER_ADMIN spans all orgs (platform admin); everyone else is scoped to their org.
export const orgScope = (req, res, next) => {
  if (req.user.role === 'SUPER_ADMIN') {
    req.orgId = req.params.orgId || null; // platform admin may pass ?org= or :orgId
    return next();
  }
  req.orgId = req.user.org;
  next();
};

// Resolve the client record + enforce that the requesting user may see it:
//   * same-org trainer who owns the client (or owner/admin of the org)
//   * the client themselves
export async function resolveClient(db, req, res, clientId) {
  const client = await db.q1(
    `SELECT c.*, u.name, u.email, u.avatar, u.phone
       FROM clients c JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`, [clientId]);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
  const { role, org, sub } = req.user;
  const sameOrg = client.org_id === org || role === 'SUPER_ADMIN';
  const isTrainerOfClient = client.trainer_id === sub;
  const isOwnerOrAdmin = role === 'GYM_OWNER' || role === 'SUPER_ADMIN';
  const isClientSelf = role === 'CLIENT' && client.user_id === sub;
  if (!sameOrg || !(isClientSelf || isTrainerOfClient || isOwnerOrAdmin)) {
    res.status(403).json({ error: 'You do not have access to this client' });
    return null;
  }
  return client;
}
