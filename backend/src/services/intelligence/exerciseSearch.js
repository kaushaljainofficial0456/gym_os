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

// Body-region -> primary_muscle strings. Mirrors muscles.MUSCLES.region so a
// single "Legs" / "Back" chip in the picker resolves to the whole muscle group
// (the coarse `muscle` LIKE match below can't: "legs" matches no stored value).
const REGION_MUSCLES = {
  chest: ['chest', 'upper chest', 'lower chest'],
  back: ['lats', 'upper back', 'lower back', 'traps', 'posterior chain'],
  shoulders: ['shoulders', 'front delts', 'side delts', 'rear delts'],
  arms: ['biceps', 'triceps', 'forearms'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors', 'posterior chain'],
  core: ['core', 'abs', 'obliques'],
};

// Build WHERE clauses from classified intent + explicit filters.
function buildWhere(intent, filters = {}) {
  const conds = [];
  const params = [];
  const muscle = filters.muscle || intent.muscles[0];
  const equipment = filters.equipment || intent.equipment[0];
  const movement = filters.movement || intent.movements[0];
  const region = filters.region && REGION_MUSCLES[String(filters.region).toLowerCase()]
    ? String(filters.region).toLowerCase() : null;

  if (region) {
    // authoritative: exercise_muscles.role='PRIMARY' joined to muscles.region;
    // OR-ed with the static primary_muscle list so it still works if
    // exercise_muscles is unsynced for a row.
    const names = REGION_MUSCLES[region];
    const ph = names.map(() => '?').join(', ');
    conds.push(
      `(id IN (SELECT em.exercise_id FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
               WHERE LOWER(m.region) = ? AND em.role = 'PRIMARY')
        OR LOWER(primary_muscle) IN (${ph}))`);
    params.push(region, ...names);
  }
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
  // A query with real words but NO recognised muscle/equipment/movement term
  // (e.g. "trx", "copenhagen", "toes to bar") must NOT fall through to "return
  // the whole catalogue" — that silently mis-resolves in parse-workout and
  // floods the picker. Let the caller's name/alias search handle it instead.
  if (conds.length === 0 && String(q || '').trim().length >= 2) return [];
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
// `filters` may carry region/equipment/difficulty to narrow a text search.
export async function searchExercisesByName(db, orgId, q, { limit = 12, filters = {} } = {}) {
  const like = `%${String(q || '').toLowerCase()}%`;
  const conds = [`(LOWER(name) LIKE ? OR id IN (SELECT exercise_id FROM exercise_aliases WHERE LOWER(alias) LIKE ?))`];
  const params = [like, like];
  const region = filters.region && REGION_MUSCLES[String(filters.region).toLowerCase()]
    ? String(filters.region).toLowerCase() : null;
  if (region) {
    const names = REGION_MUSCLES[region];
    conds.push(
      `(id IN (SELECT em.exercise_id FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
               WHERE LOWER(m.region) = ? AND em.role = 'PRIMARY')
        OR LOWER(primary_muscle) IN (${names.map(() => '?').join(', ')}))`);
    params.push(region, ...names);
  }
  if (filters.equipment && filters.equipment !== 'full_gym') {
    const eqLike = String(filters.equipment).toLowerCase().replace(/s$/, '');
    conds.push(`(LOWER(equipment) = ? OR LOWER(equipment) LIKE ?)`);
    params.push(String(filters.equipment).toLowerCase(), `%${eqLike}%`);
  }
  if (filters.difficulty) { conds.push(`LOWER(difficulty) = ?`); params.push(String(filters.difficulty).toLowerCase()); }
  conds.push(`(is_global = 1 OR org_id = ?)`);
  params.push(orgId);
  const rows = await db.q(
    `SELECT * FROM exercise_library WHERE ${conds.join(' AND ')} ORDER BY name LIMIT ?`,
    [...params, Math.min(limit, 30)]);
  return rows.map((e) => ({
    id: e.id, name: e.name, primary_muscle: e.primary_muscle,
    secondary_muscles: e.secondary_muscles, equipment: e.equipment,
    movement: e.movement, difficulty: e.difficulty, animation_key: e.animation_key,
    cues: e.cues, scope: e.is_global === 1 ? 'GLOBAL' : 'GYM'
  }));
}
