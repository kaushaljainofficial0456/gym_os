// ============================================================
// PHASE 17 — master exercise dataset (READ-ONLY).
// Reads the (migrated) DB + the expansion module and emits
//   docs/exercise-library-audit/exercise-master.csv
// with the full Phase-17 column set, every row tagged EXISTING / NEW.
//   node scripts/exercise-audit/build-master.mjs [db-path]
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXERCISE_RELATIONS, NEW_EXERCISES } from '../../backend/src/data/exerciseExpansion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DB = process.argv[2] || path.join(repoRoot, 'backend', 'data', 'physique.db');
const OUT = path.join(repoRoot, 'docs', 'exercise-library-audit', 'exercise-master.csv');

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare(`SELECT * FROM exercise_library ORDER BY primary_muscle, name`).all();
const aliasBy = new Map();
for (const a of db.prepare(`SELECT exercise_id, alias FROM exercise_aliases`).all()) {
  if (!aliasBy.has(a.exercise_id)) aliasBy.set(a.exercise_id, []);
  aliasBy.get(a.exercise_id).push(a.alias);
}
const relRows = db.prepare(
  `SELECT r.relation, r.exercise_id, e1.animation_key AS from_key, e2.animation_key AS to_key
     FROM exercise_relations r
     JOIN exercise_library e1 ON e1.id = r.exercise_id
     JOIN exercise_library e2 ON e2.id = r.related_id`).all();
db.close();

const newKeys = new Set(NEW_EXERCISES.map((x) => x.key));
// relations, both directions (reverse derived), keyed by animation_key
const relByKey = new Map();
const addRel = (k, rel, target) => {
  if (!relByKey.has(k)) relByKey.set(k, { alternative: [], progression: [], regression: [] });
  relByKey.get(k)[rel].push(target);
};
for (const r of relRows) {
  addRel(r.from_key, r.relation, r.to_key);
  // reverse: progression<->regression, alternative stays
  const rev = r.relation === 'progression' ? 'regression' : r.relation === 'regression' ? 'progression' : 'alternative';
  addRel(r.to_key, rev, r.from_key);
};

const REGION = {
  CHEST: 'chest', 'UPPER CHEST': 'chest', 'LOWER CHEST': 'chest',
  LATS: 'back', 'UPPER BACK': 'back', 'LOWER BACK': 'back', TRAPS: 'back', 'POSTERIOR CHAIN': 'back',
  SHOULDERS: 'shoulders', 'FRONT DELTS': 'shoulders', 'SIDE DELTS': 'shoulders', 'REAR DELTS': 'shoulders',
  BICEPS: 'arms', TRICEPS: 'arms', FOREARMS: 'arms',
  QUADS: 'legs', HAMSTRINGS: 'legs', GLUTES: 'legs', CALVES: 'legs', ADDUCTORS: 'legs', ABDUCTORS: 'legs',
  CORE: 'core', ABS: 'core', OBLIQUES: 'core',
  CARDIO: 'full body', 'FULL BODY': 'full body', MOBILITY: 'mobility',
};
const EQUIP_CAT = (e) => {
  e = String(e).toUpperCase();
  if (['BARBELL', 'EZ_BAR', 'TRAP_BAR'].includes(e)) return 'free weights';
  if (['DUMBBELL', 'KETTLEBELL'].includes(e)) return 'free weights';
  if (e === 'CABLE') return 'cable';
  if (['MACHINE', 'SMITH', 'LEG_PRESS'].includes(e)) return 'machine';
  if (['BODYWEIGHT', 'PULL_UP_BAR'].includes(e)) return 'bodyweight';
  if (['TRX', 'RINGS', 'SLED', 'SANDBAG', 'MEDICINE_BALL', 'PLYO_BOX', 'BANDS'].includes(e)) return 'functional';
  if (['TREADMILL', 'BIKE', 'ROWING'].includes(e)) return 'cardio';
  return 'other';
};
const MOVEMENT_PATTERN = (m) => ({
  horizontal_push: 'horizontal push', vertical_push: 'vertical push',
  horizontal_pull: 'horizontal pull', vertical_pull: 'vertical pull',
  squat: 'squat', hinge: 'hinge', lunge: 'lunge', core: 'core/anti-movement',
  carry: 'loaded carry', isolation: 'isolation', mobility: 'mobility',
}[m] || m);

const HEADER = [
  'exercise_id', 'canonical_name', 'aliases', 'muscle_group', 'sub_muscle_group',
  'primary_muscles', 'secondary_muscles', 'equipment', 'equipment_category',
  'movement_pattern', 'exercise_type', 'compound_or_isolation', 'unilateral_or_bilateral',
  'bodyweight', 'difficulty', 'beginner_friendly', 'tracking_type', 'min_reps', 'max_reps',
  'instructions', 'form_cues', 'common_mistakes',
  'progression_exercises', 'regression_exercises', 'alternative_exercises', 'status', 'source',
];
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const parseReps = (s) => {
  const m = String(s || '').match(/(\d+)\s*-\s*(\d+)/);
  if (m) return [m[1], m[2]];
  const one = String(s || '').match(/(\d+)/);
  return one ? [one[1], one[1]] : ['', ''];
};

const lines = [HEADER.join(',')];
for (const e of rows) {
  const region = REGION[e.primary_muscle] || '';
  const sub = ['UPPER CHEST', 'LOWER CHEST', 'FRONT DELTS', 'SIDE DELTS', 'REAR DELTS'].includes(e.primary_muscle) ? e.primary_muscle : '';
  const rel = relByKey.get(e.animation_key) || { alternative: [], progression: [], regression: [] };
  const [minR, maxR] = parseReps(e.default_reps);
  lines.push([
    e.id, e.name, (aliasBy.get(e.id) || []).join(' | '),
    region, sub,
    e.primary_muscle, e.secondary_muscles === '—' ? '' : (e.secondary_muscles || ''),
    e.equipment, EQUIP_CAT(e.equipment),
    MOVEMENT_PATTERN(e.movement), e.ex_type,
    e.compound_or_isolation || '', e.is_unilateral ? 'unilateral' : 'bilateral',
    e.is_bodyweight ? 'yes' : 'no', e.difficulty, e.difficulty === 'BEGINNER' ? 'yes' : 'no',
    e.tracking_type || '', minR, maxR,
    e.instructions || '', e.cues || '', e.mistakes || '',
    [...new Set(rel.progression)].join(' | '),
    [...new Set(rel.regression)].join(' | '),
    [...new Set(rel.alternative)].join(' | '),
    'active',
    newKeys.has(e.animation_key) ? 'NEW' : 'EXISTING',
  ].map(cell).join(','));
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}  (${rows.length} rows: ${rows.filter((r) => newKeys.has(r.animation_key)).length} NEW / ${rows.filter((r) => !newKeys.has(r.animation_key)).length} EXISTING)`);
