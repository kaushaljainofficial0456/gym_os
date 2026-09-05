// ============================================================
// PHASE 2 — Existing exercise inventory (READ-ONLY).
// Opens the dev DB read-only and dumps every exercise_library
// row with its aliases and whether users have history/PRs on it.
// Writes docs/exercise-library-audit/inventory.csv and prints a
// summary. Makes ZERO writes.
//   node scripts/exercise-audit/inventory.mjs [path-to-db]
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DB_PATH = process.argv[2] || path.join(repoRoot, 'backend', 'data', 'physique.db');
const OUT_DIR = path.join(repoRoot, 'docs', 'exercise-library-audit');
const OUT_CSV = path.join(OUT_DIR, 'inventory.csv');

if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);

const rows = q(`SELECT id, org_id, name, primary_muscle, secondary_muscles, equipment,
                       movement, ex_type, difficulty, animation_key, is_global,
                       instructions, cues, mistakes, alternatives
                  FROM exercise_library ORDER BY primary_muscle, name`);

const aliasRows = q(`SELECT exercise_id, alias FROM exercise_aliases`);
const aliasBy = new Map();
for (const a of aliasRows) {
  if (!aliasBy.has(a.exercise_id)) aliasBy.set(a.exercise_id, []);
  aliasBy.get(a.exercise_id).push(a.alias);
}

const countMap = (sql) => {
  const m = new Map();
  for (const r of q(sql)) m.set(r.k, Number(r.n));
  return m;
};
const wlog   = countMap(`SELECT exercise_id k, COUNT(*) n FROM workout_logs           WHERE exercise_id IS NOT NULL GROUP BY exercise_id`);
const setlog = countMap(`SELECT exercise_id k, COUNT(*) n FROM exercise_set_logs       WHERE exercise_id IS NOT NULL GROUP BY exercise_id`);
const pr     = countMap(`SELECT exercise_id k, COUNT(*) n FROM personal_records        GROUP BY exercise_id`);
const wex    = countMap(`SELECT exercise_id k, COUNT(*) n FROM workout_exercises       WHERE exercise_id IS NOT NULL GROUP BY exercise_id`);
const cwex   = countMap(`SELECT exercise_id k, COUNT(*) n FROM client_workout_exercises WHERE exercise_id IS NOT NULL GROUP BY exercise_id`);
const emk    = countMap(`SELECT exercise_id k, COUNT(*) n FROM exercise_muscles        GROUP BY exercise_id`);

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = ['id', 'scope', 'name', 'primary_muscle', 'secondary_muscles', 'equipment',
  'movement', 'ex_type', 'difficulty', 'animation_key', 'aliases',
  'muscle_rows', 'workout_exercise_refs', 'client_workout_refs',
  'workout_log_rows', 'set_log_rows', 'pr_rows',
  'has_instructions', 'has_cues', 'has_mistakes', 'has_alternatives'];

const lines = [header.join(',')];
let withHistory = 0, withPr = 0, withProse = 0;
for (const r of rows) {
  const logs = wlog.get(r.id) || 0;
  const prs = pr.get(r.id) || 0;
  const prose = !!(r.instructions || r.cues || r.mistakes);
  if (logs) withHistory++;
  if (prs) withPr++;
  if (prose) withProse++;
  lines.push([
    r.id, r.is_global ? 'GLOBAL' : `ORG:${r.org_id}`, r.name, r.primary_muscle,
    r.secondary_muscles, r.equipment, r.movement, r.ex_type, r.difficulty, r.animation_key,
    (aliasBy.get(r.id) || []).join(' | '),
    emk.get(r.id) || 0, wex.get(r.id) || 0, cwex.get(r.id) || 0,
    logs, setlog.get(r.id) || 0, prs,
    r.instructions ? 1 : 0, r.cues ? 1 : 0, r.mistakes ? 1 : 0, r.alternatives ? 1 : 0,
  ].map(csvCell).join(','));
}
fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

// --- summary to stdout ---
const by = (key) => {
  const m = {};
  for (const r of rows) m[r[key] || '(null)'] = (m[r[key] || '(null)'] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
console.log(`\nDB: ${DB_PATH}`);
console.log(`exercise_library rows: ${rows.length}  (GLOBAL ${rows.filter(r => r.is_global).length}, ORG ${rows.filter(r => !r.is_global).length})`);
console.log(`exercise_aliases rows: ${aliasRows.length}  (covering ${aliasBy.size} exercises)`);
console.log(`rows with workout-log history: ${withHistory}`);
console.log(`rows with personal_records:    ${withPr}`);
console.log(`rows with any prose (instructions/cues/mistakes): ${withProse}`);
console.log(`\nby primary_muscle:`); for (const [k, n] of by('primary_muscle')) console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`\nby equipment:`);      for (const [k, n] of by('equipment'))      console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`\nby movement:`);       for (const [k, n] of by('movement'))       console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`\nby difficulty:`);     for (const [k, n] of by('difficulty'))     console.log(`  ${String(n).padStart(3)}  ${k}`);
console.log(`\nwrote ${OUT_CSV}  (${rows.length} rows)`);
db.close();
