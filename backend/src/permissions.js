// ============================================================
// CENTRALIZED PERMISSIONS (Phase 2 production hardening) -- a single
// source of truth for "can this role do X", replacing scattered
// `role === 'GYM_OWNER'` conditions with requirePermission('x.y') so a
// permission's actual grant list lives in exactly one place.
//
// Deliberately additive, not a rewrite: requireRole(...) in auth.js is
// untouched and every existing route keeps using it exactly as before.
// New routes (and any existing route opportunistically migrated later)
// use requirePermission() instead -- see its own comment below for why
// that's a strictly STRONGER check, never a weaker one, when layered
// alongside an existing requireRole gate.
//
// A permission string is 'resource.action' (e.g. 'billing.refund'),
// matching the shape the hardening spec itself asks for.
// ============================================================

// SUPER_ADMIN's '*' is the one deliberate wildcard -- everything else
// is an explicit allow-list. A role/permission pair not listed here is
// denied by default (hasPermission returns false), never silently
// allowed -- see requirePermission's own 403 path.
export const PERMISSIONS = Object.freeze({
  SUPER_ADMIN: ['*'],
  GYM_OWNER: [
    'billing.view', 'billing.refund', 'billing.reconcile',
    'members.view', 'members.manage',
    'trainers.view', 'trainers.manage',
    'branches.view', 'branches.manage',
    'reports.view', 'settings.manage',
  ],
  MANAGER: [
    'billing.view',
    'members.view', 'members.manage',
    'trainers.view', 'trainers.manage',
    'branches.view',
    'reports.view',
  ],
  STAFF: [
    'members.view',
    'attendance.manage',
  ],
  TRAINER: [
    'clients.manage_assigned',
    'workouts.manage', 'nutrition.manage',
  ],
  CLIENT: [
    'self.manage',
  ],
});

export function hasPermission(role, permission) {
  const granted = PERMISSIONS[role];
  if (!granted) return false;
  return granted.includes('*') || granted.includes(permission);
}

/** Call AFTER requireAuth (needs req.user.role). Meant to be layered
 *  ALONGSIDE an existing requireRole(...) gate on a route being
 *  migrated, not as a silent replacement for it -- requireRole answers
 *  "is this role even allowed near this route at all" (coarse, and
 *  every existing test already asserts it), requirePermission answers
 *  the finer "can THIS SPECIFIC role do THIS SPECIFIC action" using
 *  the one shared matrix above instead of a route-local check. Denying
 *  is always the safe failure mode: an unrecognized role or an
 *  unlisted permission both fall through to hasPermission's own
 *  default-false, never an implicit allow. */
export const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user?.role, permission)) {
    return res.status(403).json({ error: 'Insufficient permissions', required: permission });
  }
  next();
};
