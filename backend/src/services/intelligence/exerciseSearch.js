// ============================================================
// EXERCISE SEARCH — intent-aware filtering over the backend
// exercise database.
//   "chest"              → all chest exercises
//   "chest dumbbell"     → chest + dumbbell
//   "machine back"       → back + machine
//   "triceps cable"      → triceps + cable
//   "compound leg"       → movement + muscle
// Aliases expand the vocabulary ("flat bench" → Bench Press).
// ============================================================

const MUSCLE_KEYWORDS = [
  ['chest', 'chest', 'pec', 'pecs', 'pectoral', 'pectorals'],
  ['back', 'back', 'lat', 'lats', 'latissimus', 'rhomboid', 'rhomboids', 'upper back'],
  ['shoulders', 'shoulder', 'delts', 'delt', 'deltoid', 'deltoids', 'rear delt', 'rear delts', 'front delts'],
  ['biceps', 'biceps', 'bicep', 'bi', 'bis', 'arms'],
  ['triceps', 'triceps', 'tricep', 'tri', 'tris'],
  ['forearms', 'forearm', 'forearms'],
  ['quads', 'quad', 'quads', 'quadriceps', 'thigh', 'thighs', 'leg'],
  ['hamstrings', 'hamstring', 'hamstrings', 'hammies'],
  ['glutes', 'glute', 'glutes', 'gluteal', 'hip'],
  ['calves', 'calf', 'calves'],
  ['core', 'core', 'abs', 'ab', 'abdominals', 'abdominal', 'oblique', 'obliques', 'plank'],
  ['traps', 'trap', 'traps', 'trapezius'],
  ['full body', 'full body', 'fullbody', 'total body']
];

const EQUIPMENT_KEYWORDS = [
  ['barbell', 'barbell', 'bar'],
  ['dumbbells', 'dumbbell', 'dumbbells', 'db', 'dbs'],
  ['cable', 'cable', 'cables'],
  ['machine', 'machine', 'machines'],
  ['bodyweight', 'bodyweight', 'body weight', 'bw', 'calisthenics', 'body-weight'],
  ['bands', 'band', 'bands', 'resistance band', 'resistance bands'],
  ['kettlebell', 'kettlebell', 'kettlebells', 'kb'],
  ['pull_up_bar', 'pull up', 'pullup', 'pull-up', 'chin up', 'chin-up'],
  ['bench', 'bench'],
  ['smith', 'smith'],
  ['leg_press', 'leg press'],
  ['treadmill', 'treadmill'],
  ['bike', 'bike', 'cycling', 'cycle'],
  ['rowing', 'rowing', 'rower', 'erg'],
  ['full_gym', 'gym', 'full gym']
];

const MOVEMENT_KEYWORDS = [
  ['horizontal_push', 'push', 'press', 'bench'],
  ['vertical_push', 'overhead', 'shoulder press', 'ohp', 'military'],
  ['horizontal_pull', 'row', 'rows', 'rowing'],
  ['vertical_pull', 'pull down', 'pulldown', 'pull up', 'pullup', 'chin', 'lat'],
  ['squat', 'squat', 'squats'],
  ['hinge', 'deadlift', 'deadlift', 'hip thrust', 'hip thrusts', 'rdl', 'good morning'],
  ['lunge', 'lunge', 'lunges', 'split squat', 'step up'],
  ['core', 'crunch', 'crunch', 'sit up', 'sit-up', 'leg raise', 'plank', 'hollow'],
  ['carry', 'carry', 'carries', 'farmer'],
  ['isolation', 'curl', 'curl', 'fly', 'flyes', 'extension', 'raise', 'raises', 'kickback']
];

const DIFFICULTY_KEYWORDS = [
  ['BEGINNER', 'beginner', 'easy', 'basic'],
  ['INTERMEDIATE', 'intermediate', 'medium'],
  ['ADVANCED', 'advanced', 'hard', 'expert']
];

function classify(query) {
  const q = String(query || '').toLowerCase();
  const parts = q.split(/\s+/).filter(Boolean);
  const out = { muscles: [], equipment: [], movements: [], difficulty: null, terms: parts };
  const joined = ' ' + q + ' ';

  // whole-word match (multi-word keywords like "leg press" still work because
  // they are checked as literal phrases against the padded query).
  const hasWord = (kw) => {
    if (kw.includes(' ')) return joined.includes(kw);
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(joined);
  };

  for (const [canon, ...kws] of MUSCLE_KEYWORDS) {
    if (kws.some(hasWord)) out.muscles.push(canon);
  }
  for (const [canon, ...kws] of EQUIPMENT_KEYWORDS) {
    let hit = kws.some(hasWord);
    // "bench press" is a movement, not the bench equipment — avoid over-classifying
    if (hit && kws.includes('bench') && /\bbench\s*press/i.test(q)) hit = false;
    if (hit) out.equipment.push(canon);
  }
  for (const [canon, ...kws] of MOVEMENT_KEYWORDS) {
    if (kws.some(hasWord)) out.movements.push(canon);
  }
  for (const [canon, ...kws] of DIFFICULTY_KEYWORDS) {
    if (kws.some(hasWord)) out.difficulty = canon;
  }
  return out;
}

// Build WHERE clauses from classified intent + explicit filters.
function buildWhere(intent, filters = {}) {
  const conds = [];
  const params = [];
  const muscle = filters.muscle || intent.muscles[0];
  const equipment = filters.equipment || intent.equipment[0];
  const movement = filters.movement || intent.movements[0];

  if (muscle) {
    conds.push(`(LOWER(primary_muscle) = ? OR LOWER(secondary_muscles) LIKE ? OR LOWER(primary_muscle) LIKE ?)`);
    params.push(muscle, `%${muscle}%`, `%${muscle}%`);
  }
  if (equipment) {
    const eq = equipment === 'full_gym' ? '%' : equipment;
    // tolerate singular/plural: "dumbbells" must match stored "DUMBBELL"
    const eqLike = eq === '%' ? '' : eq.replace(/s$/, '');
    conds.push(`(LOWER(equipment) = ? OR LOWER(equipment) LIKE ?)`);
    params.push(equipment, `%${eqLike}%`);
  }
  if (movement) {
    conds.push(`(LOWER(movement) = ? OR LOWER(movement) LIKE ?)`);
    params.push(movement, `%${movement}%`);
  }
  if (filters.difficulty || intent.difficulty) {
    conds.push(`LOWER(difficulty) = ?`);
    params.push(String(filters.difficulty || intent.difficulty).toLowerCase());
  }
  return { conds, params };
}

// Build a WHERE clause that ALWAYS includes the org scope — never a
// bare `AND` when no filters apply. Works with every filter combo.
export function buildWhereClause(conds, params, orgId) {
  const scope = `(is_global = 1 OR org_id = ?)`;
  const all = conds.length ? [...conds, scope] : [scope];
  return { where: `WHERE ${all.join(' AND ')}`, params: [...params, orgId] };
}

export async function searchExercises(db, orgId, q, filters = {}, { limit = 12 } = {}) {
  const intent = classify(q);
  const { conds, params } = buildWhere(intent, filters);
  const { where, params: wparams } = buildWhereClause(conds, params, orgId);
  const rows = await db.q(
    `SELECT * FROM exercise_library ${where} ORDER BY name LIMIT ?`,
    [...wparams, Math.min(limit, 30)]);
  return rows.map((e) => ({
    id: e.id, name: e.name, primary_muscle: e.primary_muscle,
    secondary_muscles: e.secondary_muscles, equipment: e.equipment,
    movement: e.movement, difficulty: e.difficulty, animation_key: e.animation_key,
    cues: e.cues, scope: e.is_global === 1 ? 'GLOBAL' : 'GYM'
  }));
}

// Fuzzy-name fallback when intent classification finds nothing.
export async function searchExercisesByName(db, orgId, q, { limit = 12 } = {}) {
  const like = `%${String(q || '').toLowerCase()}%`;
  const rows = await db.q(
    `SELECT * FROM exercise_library
      WHERE (LOWER(name) LIKE ? OR id IN (SELECT exercise_id FROM exercise_aliases WHERE LOWER(alias) LIKE ?))
        AND (is_global = 1 OR org_id = ?)
      ORDER BY name LIMIT ?`, [like, like, orgId, Math.min(limit, 30)]);
  return rows.map((e) => ({
    id: e.id, name: e.name, primary_muscle: e.primary_muscle,
    secondary_muscles: e.secondary_muscles, equipment: e.equipment,
    movement: e.movement, difficulty: e.difficulty, animation_key: e.animation_key,
    cues: e.cues, scope: e.is_global === 1 ? 'GLOBAL' : 'GYM'
  }));
}
