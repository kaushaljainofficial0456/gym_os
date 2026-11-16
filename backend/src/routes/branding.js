// ============================================================
// /api/branding -- a gym's own look inside Barbell. See
// services/branding.js for what is stored and who gets it.
//
//   GET  /gym/:code    PUBLIC  the brand behind a gym code, so a sign-up
//                              screen opened from the gym's link (or with
//                              its code typed in) already looks like the
//                              gym's app before an account exists.
//   GET  /logo/:code   PUBLIC  the gym's logo image. Public on purpose: it
//                              is shown on those same signed-out screens.
//   GET  /             any signed-in user: their own gym's brand.
//   PUT  /             GYM_OWNER: set the colours and logo.
//
// Only a name, a code, two colours and a logo ever leave here -- nothing
// a gym would not print on its own front door.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { now } from '../ids.js';
import { track } from '../services/events.js';
import {
  brandingForOrg, brandingForCode, logoForCode, normalizeHex, parseLogo, saveBranding,
} from '../services/branding.js';

export default function brandingRoutes(db) {
  const r = Router();
  // Per address -- there is no user yet. A person typing a gym code makes
  // a handful of lookups; this is sized to that, not to walking the codes.
  const publicLimit = rateLimit({ windowMs: 60_000, max: 40, keyFn: (req) => req.ip || 'ip' });
  const writeLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.user?.sub || 'anon' });

  r.get('/gym/:code', publicLimit, async (req, res) => {
    const branding = await brandingForCode(db, req.params.code);
    // Short: an owner who changes colours should see a fresh link pick
    // them up within a minute, and an unknown code must not be cached long.
    res.set('Cache-Control', 'public, max-age=60');
    if (!branding) return res.status(404).json({ error: 'Gym code not found' });
    res.json({ branding });
  });

  r.get('/logo/:code', async (req, res) => {
    const logo = await logoForCode(db, req.params.code);
    if (!logo) return res.status(404).end();
    res.set('Content-Type', logo.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    // A versioned URL (?v=brand_updated_at) names one exact image forever;
    // a new upload gets a new URL, so this can be cached for a year.
    res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    res.send(logo.bytes);
  });

  r.get('/', requireAuth, orgScope, async (req, res) => {
    res.json({ branding: await brandingForOrg(db, req.orgId) });
  });

  const colour = z.union([z.string().max(9), z.null()]).optional();
  r.put('/', requireAuth, orgScope, requireRole('GYM_OWNER', 'SUPER_ADMIN'), writeLimit,
    validate(z.object({
      primary: colour,
      secondary: colour,
      // ~300 kB of image is ~400 kB of base64.
      logo: z.union([z.string().max(420_000), z.null()]).optional(),
    }).strict()),
    async (req, res) => {
      if (!req.orgId) return res.status(400).json({ error: 'No gym selected' });
      if (!(await brandingForOrg(db, req.orgId))) return res.status(409).json({ error: 'Only a gym can have its own look' });

      const patch = {};
      for (const k of ['primary', 'secondary']) {
        const v = req.body[k];
        if (v === undefined) continue;
        if (v === null) { patch[k] = null; continue; }
        const hex = normalizeHex(v);
        if (!hex) return res.status(422).json({ error: `${k === 'primary' ? 'Main' : 'Second'} colour must look like #F5C518` });
        patch[k] = hex;
      }
      // Two colours or none. One colour on its own is half a theme, and
      // the app would have to guess the other.
      if ('primary' in patch && 'secondary' in patch && (patch.primary === null) !== (patch.secondary === null)) {
        return res.status(422).json({ error: 'Choose both colours, or reset both' });
      }
      if (req.body.logo !== undefined) {
        if (req.body.logo === null) patch.logo = null;
        else {
          const parsed = parseLogo(req.body.logo);
          if (parsed.error) return res.status(422).json({ error: parsed.error });
          patch.logo = req.body.logo;
        }
      }

      const branding = await saveBranding(db, req.orgId, patch, now());
      await track(db, {
        type: 'gym_branding_updated', orgId: req.orgId, userId: req.user.sub,
        data: { primary: branding.primary, secondary: branding.secondary, logo: !!branding.logoUrl },
      }).catch(() => {});
      res.json({ branding });
    });

  return r;
}
