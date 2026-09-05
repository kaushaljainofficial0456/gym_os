// Preview (READ-ONLY): the derived metadata + relation edges the migration
// would write, for BOTH existing rows and the GENUINELY_NEW candidates.
// No DB writes. node scripts/exercise-audit/preview-meta.mjs
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATES } from './candidates.mjs';
import { normalizeName, sameMovement } from './normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.resolve(__dirname, '..', '..', 'backend', 'data', 'physique.db');
const db = new DatabaseSync(DB, { readOnly: true });
const existing = db.prepare(`SELECT name, primary_muscle, secondary_muscles, equipment, movement, difficulty, animation_key FROM exercise_library`).all();
db.close();
const aliasRows = []; // not needed here

// ---- classification (mirror dedup.mjs) ----
const existNorm = new Map(existing.map(e => [normalizeName(e.name), e]));
const isNew = (c) => {
  if (existNorm.has(normalizeName(c.name))) return false;
  if (existing.some(e => sameMovement({ name: c.name, primary_muscle: c.primary, equipment: c.equipment }, { name: e.name, primary_muscle: e.primary_muscle, equipment: e.equipment }))) return false;
  if (/^(ALIAS|DUPLICATE)→/.test(c.hint || '')) return false;
  return true;
};
const NEW = CANDIDATES.filter(isNew);

// ---- deriveMeta: the same logic seed.js / migration will use ----
const STATIC_HOLD = /\b(plank|hold|wall sit|support hold|dead hang|isometric)\b/i;
const CARRY_MOVE = new Set(['carry']);
const CARDIO_EQUIP = new Set(['TREADMILL', 'BIKE', 'ROWING', 'SKIERG']);

export function deriveMeta(row) {
  const { name, equipment, movement, difficulty, primary_muscle } = row;
  const eq = String(equipment).toUpperCase();
  const bodyweightEquip = ['BODYWEIGHT', 'PULL_UP_BAR', 'TRX', 'RINGS'].includes(eq);
  const is_bodyweight = bodyweightEquip ? 1 : 0;

  let compound_or_isolation = row.ci
    || (movement === 'isolation' || movement === 'core' || movement === 'mobility' ? 'isolation' : 'compound');

  let tracking_type = row.track;
  if (!tracking_type) {
    if (CARDIO_EQUIP.has(eq)) tracking_type = 'distance_time';
    else if (STATIC_HOLD.test(name)) tracking_type = 'time';
    else if (CARRY_MOVE.has(movement)) tracking_type = 'distance_time';
    else if (bodyweightEquip && !/weighted|dip|pull.?up|chin.?up|muscle.?up/i.test(name)) tracking_type = 'bodyweight_reps';
    else if (bodyweightEquip) tracking_type = 'weighted_bodyweight';
    else tracking_type = 'weight_reps';
  }

  let default_reps = row.reps;
  if (!default_reps) {
    if (tracking_type === 'distance_time') default_reps = '20-40 m';
    else if (tracking_type === 'time') default_reps = '30-45 sec';
    else if (CARDIO_EQUIP.has(eq)) default_reps = '10-20 min';
    else if (compound_or_isolation === 'compound') default_reps = difficulty === 'ADVANCED' ? '4-8' : '6-10';
    else default_reps = '10-15';
  }

  const is_unilateral = row.uni ? 1
    : /\b(single.?arm|single.?leg|one.?arm|one.?leg|b.?stance|split|lunge|pistol|cossack|suitcase|staggered|1.?arm|1.?leg|kickstand)\b/i.test(name) ? 1 : 0;

  return { compound_or_isolation, is_unilateral, is_bodyweight, tracking_type, default_reps };
}

console.log(`\n=== DERIVED METADATA — sample of EXISTING rows (${existing.length}) ===`);
for (const e of existing.slice(0, 12)) console.log(' ', e.name.padEnd(28), JSON.stringify(deriveMeta(e)));
console.log(`  ... (all ${existing.length} existing rows get the same treatment; strings/movement/difficulty unchanged)`);

console.log(`\n=== DERIVED METADATA — GENUINELY_NEW (${NEW.length}) ===`);
for (const c of NEW) {
  const m = deriveMeta({ name: c.name, equipment: c.equipment, movement: c.movement, difficulty: c.difficulty, primary_muscle: c.primary, ci: c.ci, track: c.track, reps: c.reps, uni: c.uni });
  console.log('  ' + c.key.padEnd(26), `${m.compound_or_isolation.padEnd(9)} uni=${m.is_unilateral} bw=${m.is_bodyweight} ${m.tracking_type.padEnd(17)} reps="${m.default_reps}"`);
}

let edges = 0;
console.log(`\n=== exercise_relations EDGES from GENUINELY_NEW candidates ===`);
for (const c of NEW) {
  for (const [rel, arr] of [['alternative', c.alts], ['progression', c.prog], ['regression', c.regr]]) {
    for (const k of (arr || [])) { console.log(`  ${c.key} --${rel}--> ${k}`); edges++; }
  }
}
console.log(`  total curated edges: ${edges}  (each stored once; the reverse edge is derived at read time)`);
