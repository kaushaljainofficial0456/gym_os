// Generates backend/src/data/exerciseExpansion.js from the signed-off
// candidate list. Run once (and again if the candidate list changes).
//   node scripts/exercise-audit/gen-runtime-module.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CANDIDATES, NEW_MUSCLES, NEW_EQUIPMENT } from './candidates.mjs';
import { normalizeName, sameMovement } from './normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUT = path.join(repoRoot, 'backend', 'src', 'data', 'exerciseExpansion.js');

const db = new DatabaseSync(path.join(repoRoot, 'backend', 'data', 'physique.db'), { readOnly: true });
const existing = db.prepare(`SELECT name, primary_muscle, equipment FROM exercise_library`).all();
db.close();
const existNorm = new Set(existing.map(e => normalizeName(e.name)));

function classify(c) {
  if (existNorm.has(normalizeName(c.name))) return { cls: 'DUPLICATE', to: c.hint.split('→')[1] || '' };
  const hit = existing.find(e => sameMovement(
    { name: c.name, primary_muscle: c.primary, equipment: c.equipment },
    { name: e.name, primary_muscle: e.primary_muscle, equipment: e.equipment }));
  if (hit) return { cls: 'ALIAS', to: c.hint.startsWith('ALIAS') ? c.hint.split('→')[1] : '' };
  if (/^ALIAS→/.test(c.hint || '')) return { cls: 'ALIAS', to: c.hint.split('→')[1] };
  if (/^DUPLICATE→/.test(c.hint || '')) return { cls: 'DUPLICATE', to: c.hint.split('→')[1] };
  return { cls: 'NEW', to: '' };
}

const NEW = [], ALIAS = [], DUP = [];
for (const c of CANDIDATES) {
  const { cls, to } = classify(c);
  if (cls === 'NEW') NEW.push(c);
  else if (cls === 'ALIAS') ALIAS.push({ ...c, to });
  else DUP.push({ ...c, to });
}

// alias-string generator: clean, natural surface variants a user might type.
// (No sorted-token normalized form — alias search is a LIKE substring match,
// so token-scrambled strings never help.)
const variants = (name) => {
  const base = name.toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\s*\([^)]*\)/g, '')      // drop "(Machine)" / "(Seated)" etc.
    .replace(/\s+/g, ' ').trim();
  const spaced = base.replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim();
  const s = new Set([base, spaced]);
  s.add(spaced.replace(/\b(single arm|single-arm)\b/g, 'one arm'));
  s.add(spaced.replace(/\bdumbbell\b/g, 'db'));
  s.add(spaced.replace(/\bbarbell\b/g, 'bb'));
  s.add(spaced.replace(/\bmachine\b/g, '').replace(/\s+/g, ' ').trim());
  return [...s].filter((v) => v && v.length > 2);
};

const j = (v) => JSON.stringify(v);
const rowLit = (c) => {
  const o = { key: c.key, name: c.name, primary: c.primary, secondary: c.secondary,
    equipment: c.equipment, movement: c.movement, difficulty: c.difficulty };
  if (c.ci) o.ci = c.ci;
  if (c.uni) o.uni = true;
  if (c.track) o.track = c.track;
  if (c.reps) o.reps = c.reps;
  const extraAliases = [...new Set([...(c.aliases || []), ...variants(c.name)])]
    .filter(a => a && a !== c.name.toLowerCase());
  if (extraAliases.length) o.aliases = extraAliases;
  return '  ' + j(o).replace(/","/g, '", "').replace(/:/g, ': ').replace(/,"/g, ', "');
};

const relEdges = [];
for (const c of NEW) {
  for (const [rel, arr] of [['alternative', c.alts], ['progression', c.prog], ['regression', c.regr]]) {
    for (const to of (arr || [])) relEdges.push({ from: c.key, to, relation: rel });
  }
}

// Curated search phrases a user might type to find the canonical exercise.
const CURATED_ALIAS_PHRASES = {
  abductor_machine: ['seated hip abduction', 'abductor machine', 'abduction machine', 'seated abductor'],
  converging_chest_press: ['converging chest press', 'converging press'],
  seated_leg_press_horizontal: ['seated leg press', 'horizontal leg press'],
  smith_calf_raise: ['smith machine calf raise', 'smith calf raise'],
  single_arm_db_row: ['single arm dumbbell row', 'one arm dumbbell row', 'single arm db row', 'one arm db row', 'one arm row'],
  single_arm_triceps_pushdown: ['single arm triceps pushdown', 'single arm tricep pushdown', 'one arm pushdown', 'single arm cable pushdown'],
  single_arm_lat_pulldown_machine: ['single arm lat pulldown', 'one arm lat pulldown', 'single arm pulldown machine'],
  pinwheel_curl: ['pinwheel curl', 'cross body curl', 'cross body hammer curl'],
  suitcase_hold: ['suitcase hold', 'suitcase carry hold'],
  sled_row: ['sled row', 'sled drag row'],
  farmers_walk: ['farmers walk', 'farmer walk', 'farmers walking', 'loaded carry walk'],
};

const aliasToExisting = ALIAS.map(a => ({
  canonical: a.to,
  aliases: [...new Set([
    ...variants(a.name),
    ...(a.aliases || []),
    ...(CURATED_ALIAS_PHRASES[a.key] || []),
  ])].filter(Boolean),
}));

const existingAliasAdditions = {
  bicep_curl: ['db curl', 'dumbbell curl', 'dumbbell bicep curl', 'dumbbell biceps curl', 'db bicep curl', 'db biceps curl'],
  lat_pulldown: ['lat pull', 'lat pulls'],
};

const out = `// ============================================================
// EXERCISE LIBRARY EXPANSION — canonical runtime data.
// Consumed by backend/scripts/seed.js (fresh installs) and
// backend/scripts/expand-exercise-library.js (existing DBs).
// GENERATED by scripts/exercise-audit/gen-runtime-module.mjs from the
// signed-off candidate list — edit the candidate list + regenerate,
// don't hand-edit rows here.
//
// Non-destructive by construction: new rows get fresh ids, existing
// rows are only READ (metadata back-fill matches on animation_key).
// ============================================================

// New muscle rows for services/muscles.js MUSCLES (region drives the picker chips).
export const NEW_MUSCLES = ${j(NEW_MUSCLES)};

// normalizeMuscle() alias additions so these strings + the already-floating
// "OBLIQUES" on legacy rows resolve to a muscle id.
export const NEW_MUSCLE_ALIASES = {
  ADDUCTORS: 'adductors', ADDUCTOR: 'adductors', 'INNER THIGH': 'adductors',
  ABDUCTORS: 'abductors', ABDUCTOR: 'abductors', 'OUTER THIGH': 'abductors',
  OBLIQUES: 'obliques', OBLIQUE: 'obliques',
};

// New exercise_library.equipment string values (no picker chip — searchable by name/alias).
export const NEW_EQUIPMENT = ${j(NEW_EQUIPMENT.filter(e => NEW.some(c => c.equipment === e)))};

// ---- deterministic metadata derivation (same logic for existing + new rows) ----
const STATIC_HOLD = /\\b(plank|hold|wall sit|support hold|dead hang|isometric)\\b/i;
const CARDIO_EQUIP = new Set(['TREADMILL', 'BIKE', 'ROWING', 'SKIERG']);
const BODYWEIGHT_EQUIP = new Set(['BODYWEIGHT', 'PULL_UP_BAR', 'TRX', 'RINGS']);
const UNI_RE = /\\b(single.?arm|single.?leg|one.?arm|one.?leg|b.?stance|split squat|pistol|cossack|suitcase|staggered|1.?arm|1.?leg|kickstand|archer|copenhagen|hip airplane)\\b/i;

export function deriveExerciseMeta(row) {
  const { name, equipment, movement, difficulty } = row;
  const eq = String(equipment || '').toUpperCase();
  const bw = BODYWEIGHT_EQUIP.has(eq);
  const is_bodyweight = bw ? 1 : 0;

  const compound_or_isolation = row.ci
    || (['isolation', 'core', 'mobility'].includes(movement) ? 'isolation' : 'compound');

  let tracking_type = row.track;
  if (!tracking_type) {
    if (CARDIO_EQUIP.has(eq)) tracking_type = 'distance_time';
    else if (STATIC_HOLD.test(name)) tracking_type = 'time';
    else if (movement === 'carry') tracking_type = 'distance_time';
    else if (bw && !/weighted|\\bdip\\b|pull.?up|chin.?up|muscle.?up/i.test(name)) tracking_type = 'bodyweight_reps';
    else if (bw) tracking_type = 'weighted_bodyweight';
    else tracking_type = 'weight_reps';
  }

  let default_reps = row.reps;
  if (!default_reps) {
    if (tracking_type === 'distance_time') default_reps = CARDIO_EQUIP.has(eq) ? '10-20 min' : '20-40 m';
    else if (tracking_type === 'time') default_reps = '30-45 sec';
    else if (compound_or_isolation === 'compound') default_reps = difficulty === 'ADVANCED' ? '4-8' : '6-10';
    else default_reps = '10-15';
  }

  const is_unilateral = row.uni ? 1 : (UNI_RE.test(name) ? 1 : 0);
  return { compound_or_isolation, is_unilateral, is_bodyweight, tracking_type, default_reps };
}

// ---- 80 GENUINELY-NEW exercises ----
export const NEW_EXERCISES = [
${NEW.map(rowLit).join(',\n')},
];

// ---- ${ALIAS.length} names that are ALIASES of an existing exercise (NO new row) ----
export const ALIAS_TO_EXISTING = [
${aliasToExisting.map(a => '  ' + j(a)).join(',\n')},
];

// ---- extra aliases for EXISTING exercises (search quality) ----
export const EXISTING_ALIAS_ADDITIONS = ${JSON.stringify(existingAliasAdditions, null, 2).replace(/\n/g, '\n')};

// ---- ${relEdges.length} curated exercise_relations edges (stored once; reverse derived at read) ----
export const EXERCISE_RELATIONS = [
${relEdges.map(e => '  ' + j(e)).join(',\n')},
];
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
console.log(`wrote ${OUT}`);
console.log(`  NEW_EXERCISES     ${NEW.length}`);
console.log(`  ALIAS_TO_EXISTING ${aliasToExisting.length}`);
console.log(`  DUPLICATE(discard) ${DUP.length}  [${DUP.map(d => d.name).join(', ')}]`);
console.log(`  EXERCISE_RELATIONS ${relEdges.length}`);
console.log(`  NEW_MUSCLES ${NEW_MUSCLES.length}   NEW_EQUIPMENT ${NEW_EQUIPMENT.filter(e => NEW.some(c => c.equipment === e)).length}`);
