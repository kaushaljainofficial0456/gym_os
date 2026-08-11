// ============================================================
// EQUIPMENT — canonical equipment items, client availability checks,
// and computed exercise alternatives. Alternatives are derived from
// the library (same primary muscle, compatible equipment, similar
// difficulty) rather than stored as free text.
// ============================================================

export const EQUIPMENT_ITEMS = [
  { id: 'barbell', label: 'Barbell' },
  { id: 'dumbbells', label: 'Dumbbells' },
  { id: 'cable', label: 'Cable machine' },
  { id: 'machine', label: 'Machine' },
  { id: 'bench', label: 'Bench' },
  { id: 'pull_up_bar', label: 'Pull-up bar' },
  { id: 'bands', label: 'Resistance bands' },
  { id: 'bodyweight', label: 'Bodyweight' }
];

// exercise_library.equipment value -> required equipment item ids
const LIB_TO_ITEM = {
  BARBELL: ['barbell'], DUMBBELL: ['dumbbells'], DUMBBELLS: ['dumbbells'],
  CABLE: ['cable'], MACHINE: ['machine'], BENCH: ['bench'],
  PULLUP: ['pull_up_bar'], 'PULL-UP': ['pull_up_bar'], BANDS: ['bands'], BAND: ['bands'],
  BODYWEIGHT: ['bodyweight'], BW: ['bodyweight'], NONE: []
};

export function requiredItems(libraryEquipment) {
  const key = String(libraryEquipment || 'BODYWEIGHT').toUpperCase();
  return LIB_TO_ITEM[key] || (key === '—' ? [] : [String(libraryEquipment).toLowerCase().replace(/[^a-z_]/g, '_')]);
}

// client profile equipment: JSON array or comma list; "full_gym" = everything
export function parseAvailable(profileEquipment) {
  if (!profileEquipment) return new Set(['bodyweight']);
  let list = profileEquipment;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = String(list).split(','); }
  }
  if (!Array.isArray(list)) list = [String(list)];
  const set = new Set(list.map(x => String(x).trim().toLowerCase()).filter(Boolean));
  if (set.has('full_gym')) return new Set(EQUIPMENT_ITEMS.map(i => i.id));
  if (set.size === 0) set.add('bodyweight');
  return set;
}

// [{ exerciseId, exerciseName, equipment, missing: [item ids] }]
export function checkExercises(exercises, profileEquipment) {
  const available = parseAvailable(profileEquipment);
  return (exercises || []).map(ex => {
    const need = requiredItems(ex.equipment);
    const missing = need.filter(i => !available.has(i));
    return {
      exerciseId: ex.id,
      name: ex.name,
      equipment: ex.equipment,
      missing,
      ok: missing.length === 0
    };
  }).filter(r => !r.ok);
}

const DIFF_ORDER = { BEGINNER: 0, INTERMEDIATE: 1, ADVANCED: 2 };

// Same-primary-muscle alternatives, scored by equipment compatibility
// and difficulty closeness. Reason explains why it's a good swap.
export async function suggestAlternatives(db, exercise, profileEquipment, limit = 3) {
  if (!exercise?.id) return [];
  const available = parseAvailable(profileEquipment);
  const rows = await db.q(
    `SELECT id, name, primary_muscle, equipment, difficulty, movement, animation_key
       FROM exercise_library WHERE primary_muscle = ? AND id != ?`,
    [exercise.primary_muscle, exercise.id]);
  const scored = [];
  for (const r of rows) {
    const need = requiredItems(r.equipment);
    const eqScore = need.every(i => available.has(i)) ? 2 : need.length ? 0 : 2;
    const diffScore = 2 - Math.abs((DIFF_ORDER[r.difficulty] ?? 0) - (DIFF_ORDER[exercise.difficulty] ?? 0));
    const sameMovement = r.movement === exercise.movement ? 1 : 0;
    scored.push({
      id: r.id, name: r.name, equipment: r.equipment, difficulty: r.difficulty,
      movement: r.movement, animation_key: r.animation_key,
      score: eqScore + diffScore + sameMovement,
      reason: buildReason(r, eqScore === 2)
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function buildReason(r, equipmentOk) {
  const parts = [`Targets the same primary muscle (${r.primary_muscle})`];
  if (r.movement === 'horizontal_push' || r.movement === 'vertical_push' || r.movement === 'horizontal_pull' || r.movement === 'vertical_pull' || r.movement === 'squat' || r.movement === 'hinge') {
    // movement pattern is meaningful for these
  }
  parts.push(equipmentOk ? `Equipment you have (${r.equipment})` : `Needs: ${r.equipment}`);
  if (r.difficulty === 'BEGINNER') parts.push('Beginner-friendly');
  return parts.join(' · ');
}
