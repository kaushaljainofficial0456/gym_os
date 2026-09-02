// ============================================================
// Deterministic exercise-name normalizer + identity signature.
// Shared by dedup.mjs (Checkpoint-2 report) and, later, the
// migration script. Pure, no I/O, no deps.
//
// Goal (Phase 3 / 16): decide whether two exercise names denote
// the SAME canonical movement, so we never create a second
// "Dumbbell Curl" / "Bench Press" row.
// ============================================================

// abbreviation / synonym expansion — applied token-wise
const SYNONYMS = {
  db: 'dumbbell', dbs: 'dumbbell', 'db.': 'dumbbell',
  bb: 'barbell', ohp: 'overhead press', rdl: 'romanian deadlift',
  bw: 'bodyweight', kb: 'kettlebell', ez: 'ez bar', 'ez-bar': 'ez bar',
  sldl: 'stiff leg deadlift', gm: 'good morning', bss: 'bulgarian split squat',
  'pull-up': 'pull up', pullup: 'pull up', 'chin-up': 'chin up', chinup: 'chin up',
  'push-up': 'push up', pushup: 'push up', 'sit-up': 'sit up', situp: 'sit up',
  'tri': 'triceps', tricep: 'triceps', bicep: 'biceps', 'bi': 'biceps',
  quad: 'quads', ham: 'hamstrings', hammy: 'hamstrings', hammies: 'hamstrings',
  glute: 'glutes', calf: 'calves', delt: 'deltoid', delts: 'deltoid',
  lat: 'lats', pec: 'chest', pecs: 'chest', abs: 'core', ab: 'core',
  'single-arm': 'single arm', 'one-arm': 'single arm', 'one arm': 'single arm',
  '1-arm': 'single arm', 'single-leg': 'single leg', 'one-leg': 'single leg',
  'one leg': 'single leg', '1-leg': 'single leg', unilateral: 'single arm',
  seated: 'seated', standing: 'standing', lying: 'lying', incline: 'incline',
  decline: 'decline', flat: 'flat', machine: 'machine', cable: 'cable',
  smith: 'smith machine', 't-bar': 't bar', 'tbar': 't bar',
  press: 'press', pressing: 'press', raises: 'raise', curls: 'curl',
  extensions: 'extension', rows: 'row', flyes: 'fly', flies: 'fly', flye: 'fly',
  pulldowns: 'pulldown', 'pull down': 'pulldown', 'pull-down': 'pulldown',
  pushdowns: 'pushdown', 'push down': 'pushdown', 'push-down': 'pushdown',
  kickbacks: 'kickback', crunches: 'crunch', squats: 'squat', lunges: 'lunge',
  deadlifts: 'deadlift', bridges: 'bridge', thrusts: 'thrust', swings: 'swing',
  rollouts: 'rollout', 'hip-thrust': 'hip thrust',
};

// filler tokens dropped entirely (don't change movement identity)
const FILLER = new Set(['the', 'a', 'an', 'with', 'and', 'of', 'for', 'to', 'on', 'in', 'your']);

export function normalizeName(raw) {
  let s = String(raw || '').toLowerCase().trim();
  // unify separators
  s = s.replace(/[’']/g, '').replace(/[-/]/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // phrase-level synonym pass first (multi-word keys)
  for (const [k, v] of Object.entries(SYNONYMS)) {
    if (k.includes(' ')) s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }
  let toks = s.split(' ').filter(Boolean);
  toks = toks.map((t) => SYNONYMS[t] || t);
  // re-split (a synonym may expand to two words) then singularize + drop filler
  toks = toks.join(' ').split(' ')
    .filter((t) => t && !FILLER.has(t))
    .map(singular);
  // sorted token set — word order & duplicates don't matter for identity
  return [...new Set(toks)].sort().join(' ');
}

function singular(t) {
  if (t.length <= 3) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

// equipment string (exercise_library.equipment) -> coarse class for the signature
export function equipClass(equip) {
  const e = String(equip || '').toUpperCase();
  if (['BARBELL', 'EZ_BAR', 'TRAP_BAR'].includes(e)) return 'barbell';
  if (['DUMBBELL', 'DUMBBELLS'].includes(e)) return 'dumbbell';
  if (e === 'KETTLEBELL') return 'kettlebell';
  if (e === 'CABLE') return 'cable';
  if (['MACHINE', 'SMITH', 'LEG_PRESS'].includes(e)) return 'machine';
  if (['BODYWEIGHT', 'PULL_UP_BAR', 'BANDS', 'TRX', 'RINGS'].includes(e)) return 'bodyweight';
  if (['TREADMILL', 'BIKE', 'ROWING'].includes(e)) return 'cardio';
  return e.toLowerCase();
}

// identity signature: same movement + same primary target + same equipment class
export function signature({ name, primary_muscle, equipment }) {
  return `${normalizeName(name)}|${String(primary_muscle || '').toLowerCase()}|${equipClass(equipment)}`;
}

// Tokens that, as the ONLY difference between two names, do NOT denote a
// different exercise — they just restate the target muscle or are generic
// filler. Anything else (single, trx, ring, trap, deficit, archer, pause,
// banded, assisted, incline, seated, landmine, smith, ...) IS distinguishing.
const IGNORABLE_QUALIFIERS = new Set([
  'biceps', 'triceps', 'chest', 'quads', 'hamstrings', 'glutes', 'calves',
  'deltoid', 'lats', 'forearms', 'core', 'abdominal', 'pec', 'trap', 'back',
  'exercise', 'movement', 'variation', 'standard', 'regular', 'basic', 'classic',
  'strength', 'gym', 'weighted',
]);

// Are two rows the same canonical movement?
//  - identical normalized name  -> same
//  - identical signature        -> same
//  - token-subset AND same primary+equip AND every extra token is ignorable
export function sameMovement(a, b) {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (na === nb) return true;
  if (signature(a) === signature(b)) return true;
  const sa = new Set(na.split(' ').filter(Boolean));
  const sb = new Set(nb.split(' ').filter(Boolean));
  const diff = [...new Set([...sa, ...sb])].filter((t) => !sa.has(t) || !sb.has(t));
  const subset = [...sa].every((t) => sb.has(t)) || [...sb].every((t) => sa.has(t));
  if (subset
    && diff.length > 0
    && diff.every((t) => IGNORABLE_QUALIFIERS.has(t))
    && String(a.primary_muscle).toLowerCase() === String(b.primary_muscle).toLowerCase()
    && equipClass(a.equipment) === equipClass(b.equipment)) return true;
  return false;
}
