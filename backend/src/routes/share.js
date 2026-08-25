// ============================================================
// SHARE MEALS — public preview for a shared foods/meals link.
//
// PUBLIC ON PURPOSE: sharing is explicitly cross-account (a recipient may
// not even have an SK OS account yet, or may be at a different gym), so
// the preview must be viewable without auth -- spec: "the recipient MUST
// preview before saving", never gated behind a login wall just to look.
// Saving the previewed items into the recipient's own diet DOES require
// auth (see POST /me/share/:id/save in me.js) -- viewing and saving are
// deliberately two different trust levels, this file only ever does the
// former.
//
// Mounted at /api/share, separately from /api/me (which gates its whole
// router behind requireAuth) -- keeping this route out of that file
// entirely is simpler and safer than threading an auth exception into a
// router whose defining property is "everything here requires login".
// ============================================================
import { Router } from 'express';

export default function shareRoutes(db) {
  const r = Router();

  r.get('/:id', async (req, res) => {
    const row = await db.q1('SELECT * FROM shared_meals WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'This shared link is invalid or has expired' });
    let items = [];
    try { items = JSON.parse(row.items_json) || []; } catch { items = []; }
    res.json({
      id: row.id,
      shared_by_name: row.shared_by_name || null,
      created_at: row.created_at,
      items,
    });
  });

  return r;
}
