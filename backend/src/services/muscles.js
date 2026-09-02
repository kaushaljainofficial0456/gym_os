// ============================================================
// MUSCLE MODEL — normalized muscles + exercise_muscles.
// The legacy exercise_library.primary_muscle / secondary_muscles
// string columns remain for compatibility; exercise_muscles is the
// authoritative relationship for muscle targeting and volume math.
// ============================================================

import { NEW_MUSCLES, NEW_MUSCLE_ALIASES } from '../data/exerciseExpansion.js';

// Canonical muscles. target ranges are TRAINING GUIDANCE (sets/week),
// not medical facts — clearly labelled in the UI.
export const MUSCLES = [
  { id: 'chest',         name: 'CHEST',          region: 'chest',   view: 'front', min: 10, max: 16 },
  { id: 'upper_chest',   name: 'UPPER CHEST',    region: 'chest',   view: 'front', min: 6,  max: 10 },
  { id: 'shoulders',     name: 'SHOULDERS',      region: 'shoulders', view: 'front', min: 8, max: 14 },
  { id: 'side_delts',    name: 'SIDE DELTS',     region: 'shoulders', view: 'front', min: 6,  max: 12 },
  { id: 'rear_delts',    name: 'REAR DELTS',     region: 'shoulders', view: 'back',  min: 6,  max: 12 },
  { id: 'biceps',        name: 'BICEPS',         region: 'arms',    view: 'front', min: 8,  max: 14 },
  { id: 'triceps',       name: 'TRICEPS',        region: 'arms',    view: 'back',  min: 8,  max: 14 },
  { id: 'forearms',      name: 'FOREARMS',       region: 'arms',    view: 'front', min: 4,  max: 8 },
  { id: 'traps',         name: 'TRAPS',          region: 'back',    view: 'back',  min: 4,  max: 8 },
  { id: 'lats',          name: 'LATS',           region: 'back',    view: 'back',  min: 10, max: 16 },
  { id: 'upper_back',    name: 'UPPER BACK',     region: 'back',    view: 'back',  min: 6,  max: 10 },
  { id: 'lower_back',    name: 'LOWER BACK',     region: 'back',    view: 'back',  min: 4,  max: 8 },
  { id: 'glutes',        name: 'GLUTES',         region: 'legs',    view: 'back',  min: 8,  max: 14 },
  { id: 'hamstrings',    name: 'HAMSTRINGS',     region: 'legs',    view: 'back',  min: 8,  max: 14 },
  { id: 'quads',         name: 'QUADS',          region: 'legs',    view: 'front', min: 8,  max: 14 },
  { id: 'calves',        name: 'CALVES',         region: 'legs',    view: 'back',  min: 6,  max: 12 },
  { id: 'core',          name: 'CORE',           region: 'core',    view: 'front', min: 6,  max: 12 },
  { id: 'abs',           name: 'ABS',            region: 'core',    view: 'front', min: 6,  max: 12 },
  { id: 'posterior_chain', name: 'POSTERIOR CHAIN', region: 'legs', view: 'back', min: 6, max: 10 },
  // --- library expansion: adductors / abductors / obliques (region drives the
  // Workout picker's muscle chips; also maps the "OBLIQUES" string already
  // present on legacy rows like bicycle_crunch / russian_twist). ---
  ...NEW_MUSCLES,
];

const ALIASES = {
  'CHEST': 'chest', 'UPPER CHEST': 'upper_chest', 'SHOULDERS': 'shoulders',
  'SIDE DELTS': 'side_delts', 'REAR DELTS': 'rear_delts', 'DELTS': 'shoulders',
  'TRICEPS': 'triceps', 'BICEPS': 'biceps', 'FOREARMS': 'forearms',
  'TRAPS': 'traps', 'LATS': 'lats', 'UPPER BACK': 'upper_back',
  'LOWER BACK': 'lower_back', 'GLUTES': 'glutes', 'HAMSTRINGS': 'hamstrings',
  'QUADS': 'quads', 'CALVES': 'calves', 'CORE': 'core', 'ABS': 'abs',
  'ABDOMINALS': 'core', 'POSTERIOR CHAIN': 'posterior_chain', 'FRONT DELTS': 'shoulders',
  ...NEW_MUSCLE_ALIASES,
};

export function normalizeMuscle(name) {
  if (!name) return null;
  const key = String(name).toUpperCase().trim();
  if (ALIASES[key]) return ALIASES[key];
  // fuzzy match on canonical names
  const upper = key;
  for (const m of MUSCLES) {
    if (upper.includes(m.name) || m.name.includes(upper)) return m.id;
  }
  return null;
}

export async function seedMuscles(db) {
  for (const m of MUSCLES) {
    await db.run(
      `INSERT INTO muscles (id, name, region, view, target_sets_min, target_sets_max)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, region = excluded.region,
         view = excluded.view, target_sets_min = excluded.target_sets_min, target_sets_max = excluded.target_sets_max`,
      [m.id, m.name, m.region, m.view, m.min, m.max]);
  }
}

// Rebuild exercise_muscles from the legacy string columns (idempotent).
export async function syncExerciseMuscles(db) {
  const exercises = await db.q('SELECT id, primary_muscle, secondary_muscles FROM exercise_library');
  for (const ex of exercises) {
    await db.run('DELETE FROM exercise_muscles WHERE exercise_id = ?', [ex.id]);
    const roles = [[ex.primary_muscle, 'PRIMARY']];
    if (ex.secondary_muscles) {
      for (const name of String(ex.secondary_muscles).split(',')) {
        const t = name.trim();
        if (t && t !== '—') roles.push([t, 'SECONDARY']);
      }
    }
    for (const [name, role] of roles) {
      const muscleId = normalizeMuscle(name);
      if (!muscleId) continue;
      await db.run(
        `INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES (?, ?, ?)`,
        [ex.id, muscleId, role]);
    }
  }
}

export async function getExerciseMuscles(db, exerciseId) {
  if (!exerciseId) return [];
  const rows = await db.q(
    `SELECT em.role, m.id, m.name, m.region, m.view
       FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
      WHERE em.exercise_id = ? ORDER BY CASE em.role WHEN 'PRIMARY' THEN 0 ELSE 1 END, em.muscle_id`,
    [exerciseId]);
  if (rows.length) return rows;
  // fallback: derive from legacy strings (library rows without a sync)
  const ex = await db.q1('SELECT primary_muscle, secondary_muscles FROM exercise_library WHERE id = ?', [exerciseId]);
  if (!ex) return [];
  const out = [];
  const p = normalizeMuscle(ex.primary_muscle);
  if (p) out.push({ role: 'PRIMARY', id: p, name: MUSCLES.find(m => m.id === p)?.name, region: MUSCLES.find(m => m.id === p)?.region, view: MUSCLES.find(m => m.id === p)?.view });
  if (ex.secondary_muscles) {
    for (const name of String(ex.secondary_muscles).split(',')) {
      const id = normalizeMuscle(name.trim());
      if (id && id !== p) {
        const m = MUSCLES.find(x => x.id === id);
        out.push({ role: 'SECONDARY', id, name: m?.name, region: m?.region, view: m?.view });
      }
    }
  }
  return out;
}
