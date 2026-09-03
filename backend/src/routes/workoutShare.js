// ============================================================
// WORKOUT SHARE — public preview for a shared workout link.
//
// PUBLIC ON PURPOSE: same reasoning as share.js — a recipient may
// not have an SK OS account, or may be at a different gym, so the
// preview must be viewable without auth. Importing the workout DOES
// require auth (see POST /me/workout-share/:id/import in me.js).
//
// Mounted at /api/workout-share, separate from /api/me and /api/share.
// ============================================================
import { Router } from 'express';
import { rateLimit } from '../rateLimit.js';

export default function workoutShareRoutes(db) {
  const r = Router();

  // Public + IP-keyed rate limit. The id itself (10 random chars) isn't
  // practically guessable, but an unauthenticated route is freely
  // triggerable (a link, not a login).
  const limit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.ip || 'anon' });

  r.get('/:id', limit, async (req, res) => {
    const row = await db.q1('SELECT * FROM shared_workouts WHERE id = ?', [req.params.id]);
    // Same expires_at convention as share.js -- NULL is legacy-only.
    if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      return res.status(404).json({ error: 'This shared workout link is invalid or has expired' });
    }
    let workout = {};
    try { workout = JSON.parse(row.payload_json) || {}; } catch { workout = {}; }
    // Explicit whitelist — never return org_id, client_id, or internal data
    res.json({
      id: row.id,
      shared_by_name: row.shared_by_name || null,
      created_at: row.created_at,
      workout: {
        name: workout.name || row.workout_name || 'Workout',
        notes: workout.notes || null,
        exercises: (workout.exercises || []).map((ex) => ({
          name: ex.name,
          sets: ex.sets,
          reps: ex.reps,
          weight: ex.weight,
          rest_sec: ex.rest_sec,
          tempo: ex.tempo || null,
          notes: ex.notes || null,
          position: ex.position,
        })),
      },
    });
  });

  return r;
}
