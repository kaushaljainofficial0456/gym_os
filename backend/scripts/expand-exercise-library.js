// ============================================================
// EXERCISE LIBRARY EXPANSION — safe, idempotent migration.
//
//   npm run db:expand-exercises          (from repo root or backend/)
//
// Runs AFTER `npm run db:init` (which adds the columns + relations
// table). Safe to run repeatedly and against a live database:
//   • existing exercise_library rows: only NULL metadata columns are
//     back-filled — id / name / muscle strings / everything else is
//     never touched;
//   • new exercises: matched by animation_key, inserted with a fresh
//     id('exl') only if absent — an existing id is never rewritten;
//   • aliases + relations: inserted only when not already present;
//   • no workout / log / PR / client_workout row is read or written.
//
// The same exported expandExerciseLibrary() is called by
// scripts/seed.js so fresh installs get the expanded library too.
// ============================================================
import { getDb } from '../src/db.js';
import { id } from '../src/ids.js';
import { seedMuscles, syncExerciseMuscles } from '../src/services/muscles.js';
import {
  NEW_EXERCISES, ALIAS_TO_EXISTING, EXISTING_ALIAS_ADDITIONS,
  EXERCISE_RELATIONS, deriveExerciseMeta,
} from '../src/data/exerciseExpansion.js';

// exercise_library.equipment -> ex_type (mirrors scripts/seed.js typeFor)
const typeFor = (equip) => {
  const e = String(equip).toUpperCase();
  if (['TREADMILL', 'BIKE', 'ROWING'].includes(e)) return 'cardio';
  if (['MACHINE', 'SMITH', 'LEG_PRESS'].includes(e)) return 'machine';
  if (e === 'CABLE') return 'cable';
  if (['BODYWEIGHT', 'BANDS', 'PULL_UP_BAR', 'TRX', 'RINGS', 'PLYO_BOX'].includes(e)) return 'bodyweight';
  return 'free_weight';
};

const META_COLS = ['compound_or_isolation', 'is_unilateral', 'is_bodyweight', 'tracking_type', 'default_reps'];

async function ensureSchema(db) {
  // Defensive only — `npm run db:init` normally does this. Tolerant of "already exists".
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS exercise_relations (
      id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL REFERENCES exercise_library(id) ON DELETE CASCADE,
      related_id  TEXT NOT NULL REFERENCES exercise_library(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL CHECK (relation IN ('alternative','progression','regression')),
      UNIQUE (exercise_id, related_id, relation))`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_exrel_ex ON exercise_relations(exercise_id, relation)`);
  } catch { /* present */ }
  for (const col of META_COLS) {
    const type = col === 'is_unilateral' || col === 'is_bodyweight' ? 'INTEGER' : 'TEXT';
    try { await db.run(`ALTER TABLE exercise_library ADD COLUMN ${col} ${type}`); } catch { /* present */ }
  }
}

/**
 * @param {*} db  a getDb() handle (sqlite or pg)
 * @returns {Promise<{newInserted:number,newAlreadyPresent:number,metaBackfilled:number,aliasesAdded:number,relationsAdded:number,skipped:string[]}>}
 */
export async function expandExerciseLibrary(db, { log = () => {} } = {}) {
  await ensureSchema(db);
  const stats = { newInserted: 0, newAlreadyPresent: 0, metaBackfilled: 0, aliasesAdded: 0, relationsAdded: 0, skipped: [] };

  const setMetaWhereNull = async (exId, m) => db.run(
    `UPDATE exercise_library SET
       compound_or_isolation = COALESCE(compound_or_isolation, ?),
       is_unilateral         = COALESCE(is_unilateral, ?),
       is_bodyweight         = COALESCE(is_bodyweight, ?),
       tracking_type         = COALESCE(tracking_type, ?),
       default_reps          = COALESCE(default_reps, ?)
     WHERE id = ?`,
    [m.compound_or_isolation, m.is_unilateral, m.is_bodyweight, m.tracking_type, m.default_reps, exId]);

  // 1. Back-fill metadata for EXISTING rows (only where NULL). No other column touched.
  const existing = await db.q(
    `SELECT id, name, equipment, movement, difficulty, primary_muscle,
            compound_or_isolation, is_unilateral, is_bodyweight, tracking_type, default_reps
       FROM exercise_library`);
  for (const r of existing) {
    if (META_COLS.every((c) => r[c] !== null && r[c] !== undefined)) continue;
    await setMetaWhereNull(r.id, deriveExerciseMeta({
      name: r.name, equipment: r.equipment, movement: r.movement,
      difficulty: r.difficulty, primary_muscle: r.primary_muscle,
    }));
    stats.metaBackfilled++;
  }

  // 2. Insert NEW exercises — match on animation_key, fresh id only if absent.
  const keyToId = new Map();
  for (const r of await db.q(`SELECT id, animation_key FROM exercise_library WHERE animation_key IS NOT NULL`)) {
    keyToId.set(r.animation_key, r.id);
  }
  for (const ex of NEW_EXERCISES) {
    const meta = deriveExerciseMeta(ex);
    let exId = keyToId.get(ex.key);
    if (exId) {
      await setMetaWhereNull(exId, meta);
      stats.newAlreadyPresent++;
      continue;
    }
    exId = id('exl');
    await db.run(
      `INSERT INTO exercise_library
         (id, org_id, name, primary_muscle, secondary_muscles, equipment, movement, ex_type, difficulty, animation_key, is_global,
          compound_or_isolation, is_unilateral, is_bodyweight, tracking_type, default_reps)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [exId, ex.name, ex.primary, ex.secondary || '—', ex.equipment, ex.movement, typeFor(ex.equipment), ex.difficulty, ex.key,
       meta.compound_or_isolation, meta.is_unilateral, meta.is_bodyweight, meta.tracking_type, meta.default_reps]);
    keyToId.set(ex.key, exId);
    stats.newInserted++;
  }

  // 3. Aliases. A GLOBAL alias string must map to exactly one exercise, so we
  //    skip any alias already used by a global row (UNIQUE(org_id, alias) does
  //    NOT enforce this because SQL treats NULL org_id as distinct).
  const addAlias = async (exId, raw) => {
    const alias = String(raw || '').trim().toLowerCase();
    if (!alias || !exId) return;
    const used = await db.q1(`SELECT 1 AS x FROM exercise_aliases WHERE org_id IS NULL AND lower(alias) = ?`, [alias]);
    if (used) return;
    await db.run(`INSERT INTO exercise_aliases (id, org_id, exercise_id, alias) VALUES (?, NULL, ?, ?)`, [id('exa'), exId, alias]);
    stats.aliasesAdded++;
  };
  for (const ex of NEW_EXERCISES) {
    for (const al of (ex.aliases || [])) await addAlias(keyToId.get(ex.key), al);
  }
  for (const { canonical, aliases } of ALIAS_TO_EXISTING) {
    const exId = keyToId.get(canonical);
    if (!exId) { stats.skipped.push(`alias-canonical:${canonical}`); log(`  ! ALIAS_TO_EXISTING canonical not found: ${canonical}`); continue; }
    for (const al of aliases) await addAlias(exId, al);
  }
  for (const [canonical, aliases] of Object.entries(EXISTING_ALIAS_ADDITIONS)) {
    const exId = keyToId.get(canonical);
    if (!exId) { stats.skipped.push(`alias-existing:${canonical}`); log(`  ! EXISTING_ALIAS_ADDITIONS key not found: ${canonical}`); continue; }
    for (const al of aliases) await addAlias(exId, al);
  }

  // 4. Curated relations (stored once; reverse derived at read time).
  for (const e of EXERCISE_RELATIONS) {
    const from = keyToId.get(e.from);
    const to = keyToId.get(e.to);
    if (!from || !to) { stats.skipped.push(`relation:${e.from}->${e.to}`); log(`  ! relation unresolved: ${e.from} -> ${e.to}`); continue; }
    const dup = await db.q1(
      `SELECT 1 AS x FROM exercise_relations WHERE exercise_id = ? AND related_id = ? AND relation = ?`,
      [from, to, e.relation]);
    if (dup) continue;
    await db.run(
      `INSERT INTO exercise_relations (id, exercise_id, related_id, relation) VALUES (?, ?, ?, ?)`,
      [id('exr'), from, to, e.relation]);
    stats.relationsAdded++;
  }

  return stats;
}

// ---- CLI ----
const invokedDirectly = process.argv[1] && /expand-exercise-library\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  const db = await getDb();
  const before = await db.q1(`SELECT COUNT(*) AS c FROM exercise_library`);
  const relBefore = await db.q1(`SELECT COUNT(*) AS c FROM exercise_relations`).catch(() => ({ c: 0 }));
  await seedMuscles(db);                 // upsert the 3 new muscle rows
  const stats = await expandExerciseLibrary(db, { log: console.log });
  await syncExerciseMuscles(db);         // extend exercise_muscles for the new rows
  const after = await db.q1(`SELECT COUNT(*) AS c FROM exercise_library`);
  const relAfter = await db.q1(`SELECT COUNT(*) AS c FROM exercise_relations`);
  const aliasAfter = await db.q1(`SELECT COUNT(*) AS c FROM exercise_aliases`);
  console.log('\n--- exercise library expansion ---');
  console.log(`  new exercises inserted : ${stats.newInserted}`);
  console.log(`  new already present    : ${stats.newAlreadyPresent}`);
  console.log(`  metadata back-filled   : ${stats.metaBackfilled} existing rows`);
  console.log(`  aliases added          : ${stats.aliasesAdded}`);
  console.log(`  relations added        : ${stats.relationsAdded}`);
  if (stats.skipped.length) console.log(`  skipped (unresolved)   : ${stats.skipped.join(', ')}`);
  console.log(`  exercise_library : ${before.c} -> ${after.c}`);
  console.log(`  exercise_relations: ${relBefore.c} -> ${relAfter.c}`);
  console.log(`  exercise_aliases : ${aliasAfter.c}`);
  await db.close?.();
}
