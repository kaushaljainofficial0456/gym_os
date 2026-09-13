// ============================================================
// PUBLIC invitation preview -- /api/community-invite/:code (no auth).
//
// An invite link is usually opened on a phone that is not signed in. This
// lets that screen say WHAT it is an invitation to before asking anyone to
// log in, which is the difference between a link people trust and one
// they ignore.
//
// It returns only what previewCode() allows without a viewer: the
// community's name, colour, mark and member count. No member names, no
// inviter, no community id. Joining is a separate, authenticated request
// (POST /api/communities/join).
// ============================================================
import { Router } from 'express';
import { rateLimit } from '../rateLimit.js';
import { previewCode } from '../services/friendCommunities/invites.js';

export default function communityInviteRoutes(db) {
  const r = Router();
  // Per IP -- there is no user yet. A real person opens one link a handful
  // of times; this is sized to that, not to someone walking the code space.
  const previewLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.ip || 'ip' });

  r.get('/:code', previewLimit, async (req, res) => {
    const out = await previewCode(db, String(req.params.code || '').slice(0, 40));
    // A preview must never be served from a cache after its code is revoked.
    res.set('Cache-Control', 'no-store');
    res.json(out);
  });

  return r;
}
