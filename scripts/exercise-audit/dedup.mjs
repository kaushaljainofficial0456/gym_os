// ============================================================
// PHASE 3 / 16 — Deduplication pass (READ-ONLY).
// Compares every candidate in candidates.mjs against the existing
// exercise_library (names + aliases) and classifies it:
//   KEEP_EXISTING | ALIAS_TO_EXISTING | DUPLICATE_DO_NOT_IMPORT | GENUINELY_NEW
// Writes:
//   docs/exercise-library-audit/candidates.csv
//   docs/exercise-library-audit/duplicate-merge-report.csv
// Makes ZERO writes to the DB.
//   node scripts/exercise-audit/dedup.mjs [path-to-db]
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName, signature, sameMovement, equipClass } from './normalize.mjs';
import { CANDIDATES, NEW_EQUIPMENT, NEW_MUSCLES } from './candidates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DB_PATH = process.argv[2] || path.join(repoRoot, 'backend', 'data', 'physique.db');
const OUT_DIR = path.join(repoRoot, 'docs', 'exercise-library-audit');
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const existing = db.prepare(
  `SELECT id, name, primary_muscle, secondary_muscles, equipment, movement, difficulty, animation_key
     FROM exercise_library`).all();
const aliasRows = db.prepare(`SELECT exercise_id, alias FROM exercise_aliases`).all();
db.close();

const byKey = new Map(existing.filter(e => e.animation_key).map(e => [e.animation_key, e]));
const aliasNorm = new Map(); // normalized alias -> exercise animation_key
for (const a of aliasRows) {
  const ex = existing.find(e => e.id === a.exercise_id);
  if (ex) aliasNorm.set(normalizeName(a.alias), ex.animation_key || ex.id);
}
const existNormName = new Map(existing.map(e => [normalizeName(e.name), e]));

const EXISTING_MUSCLES = new Set(existing.map(e => e.primary_muscle));
const ALLOWED_MUSCLES = new Set([...EXISTING_MUSCLES, ...NEW_MUSCLES.map(m => m.name)]);
const EXISTING_EQUIP = new Set(existing.map(e => e.equipment));
const ALLOWED_EQUIP = new Set([...EXISTING_EQUIP, ...NEW_EQUIPMENT]);

const candKeys = new Set(CANDIDATES.map(c => c.key));
const resolvesTo = (k) => byKey.has(k) || candKeys.has(k);

function classify(c) {
  const cand = { name: c.name, primary_muscle: c.primary, equipment: c.equipment };
  const norm = normalizeName(c.name);

  // 1. exact normalized-name collision with an existing row => DUPLICATE
  if (existNormName.has(norm)) {
    const e = existNormName.get(norm);
    return { cls: 'DUPLICATE_DO_NOT_IMPORT', match: e.animation_key || e.id, matchName: e.name,
      reason: `exact normalized name "${norm}" already exists` };
  }
  // 2. normalized name equals an existing ALIAS => ALIAS (already searchable)
  if (aliasNorm.has(norm)) {
    const k = aliasNorm.get(norm);
    return { cls: 'ALIAS_TO_EXISTING', match: k, matchName: byKey.get(k)?.name || k,
      reason: `normalized name matches existing alias of "${k}"` };
  }
  // 3. same-movement (signature or token-subset + same primary+equip) => ALIAS
  const hit = existing.find(e => sameMovement(cand, {
    name: e.name, primary_muscle: e.primary_muscle, equipment: e.equipment }));
  if (hit) {
    return { cls: 'ALIAS_TO_EXISTING', match: hit.animation_key || hit.id, matchName: hit.name,
      reason: `same canonical movement as "${hit.name}" (sig/subset match)` };
  }
  // 4. author hint said ALIAS/DUPLICATE but auto-check found nothing -> trust the hint,
  //    flag for human confirmation
  if (/^ALIAS→/.test(c.hint || '')) {
    const k = c.hint.split('→')[1];
    return { cls: 'ALIAS_TO_EXISTING', match: k, matchName: byKey.get(k)?.name || k,
      reason: `author-flagged alias of "${k}" (auto-check did not independently match — confirm)` };
  }
  if (/^DUPLICATE→/.test(c.hint || '')) {
    const k = c.hint.split('→')[1];
    return { cls: 'DUPLICATE_DO_NOT_IMPORT', match: k, matchName: byKey.get(k)?.name || k,
      reason: `author-flagged duplicate of "${k}" (auto-check did not independently match — confirm)` };
  }
  return { cls: 'GENUINELY_NEW', match: '', matchName: '', reason: 'no name/alias/movement collision' };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const results = CANDIDATES.map(c => {
  const r = classify(c);
  // integrity checks
  const problems = [];
  if (!ALLOWED_MUSCLES.has(c.primary)) problems.push(`unknown primary_muscle "${c.primary}"`);
  if (!ALLOWED_EQUIP.has(c.equipment)) problems.push(`unknown equipment "${c.equipment}"`);
  for (const rel of ['alts', 'prog', 'regr']) {
    for (const k of (c[rel] || [])) if (!resolvesTo(k)) problems.push(`${rel} ref "${k}" unresolved`);
  }
  if (byKey.has(c.key)) problems.push(`key "${c.key}" collides with an existing animation_key`);
  return { c, ...r, norm: normalizeName(c.name), problems };
});

// ---- write candidates.csv (everything) ----
const head1 = ['key', 'name', 'normalized', 'primary_muscle', 'equipment', 'movement', 'difficulty',
  'classification', 'matched_existing', 'matched_name', 'reason', 'author_hint', 'integrity_problems'];
const l1 = [head1.join(',')];
for (const r of results) l1.push([
  r.c.key, r.c.name, r.norm, r.c.primary, r.c.equipment, r.c.movement, r.c.difficulty,
  r.cls, r.match, r.matchName, r.reason, r.c.hint || '', r.problems.join('; '),
].map(csvCell).join(','));
fs.writeFileSync(path.join(OUT_DIR, 'candidates.csv'), l1.join('\n') + '\n');

// ---- write duplicate-merge-report.csv (ALIAS + DUPLICATE only) ----
const head2 = ['candidate_name', 'normalized', 'classification', 'canonical_kept', 'canonical_name', 'action', 'reason'];
const l2 = [head2.join(',')];
for (const r of results.filter(x => x.cls !== 'GENUINELY_NEW')) {
  const action = r.cls === 'ALIAS_TO_EXISTING'
    ? `add alias "${normalizeName(r.c.name)}" (+ variants) to ${r.match}; DO NOT create a row`
    : `discard — ${r.match} already represents this movement`;
  l2.push([r.c.name, r.norm, r.cls, r.match, r.matchName, action, r.reason].map(csvCell).join(','));
}
fs.writeFileSync(path.join(OUT_DIR, 'duplicate-merge-report.csv'), l2.join('\n') + '\n');

// ---- stdout summary ----
const groups = { GENUINELY_NEW: [], ALIAS_TO_EXISTING: [], DUPLICATE_DO_NOT_IMPORT: [] };
for (const r of results) groups[r.cls].push(r);
const problems = results.filter(r => r.problems.length);

console.log(`\n=== DEDUP RESULT (against ${existing.length} existing exercises, ${aliasRows.length} aliases) ===`);
console.log(`candidates evaluated : ${results.length}`);
console.log(`GENUINELY_NEW        : ${groups.GENUINELY_NEW.length}`);
console.log(`ALIAS_TO_EXISTING    : ${groups.ALIAS_TO_EXISTING.length}`);
console.log(`DUPLICATE_DO_NOT_IMPORT: ${groups.DUPLICATE_DO_NOT_IMPORT.length}`);
console.log(`expected final library: ${existing.length} + ${groups.GENUINELY_NEW.length} = ${existing.length + groups.GENUINELY_NEW.length}`);

console.log(`\n--- GENUINELY_NEW (${groups.GENUINELY_NEW.length}) ---`);
for (const r of groups.GENUINELY_NEW) console.log(`  ${r.c.key.padEnd(30)} ${r.c.name}  [${r.c.primary} / ${r.c.equipment} / ${r.c.movement}]`);

console.log(`\n--- ALIAS_TO_EXISTING (${groups.ALIAS_TO_EXISTING.length}) ---`);
for (const r of groups.ALIAS_TO_EXISTING) console.log(`  "${r.c.name}"  ->  ${r.match} (${r.matchName})   ${r.reason}`);

console.log(`\n--- DUPLICATE_DO_NOT_IMPORT (${groups.DUPLICATE_DO_NOT_IMPORT.length}) ---`);
for (const r of groups.DUPLICATE_DO_NOT_IMPORT) console.log(`  "${r.c.name}"  ->  ${r.match} (${r.matchName})   ${r.reason}`);

if (problems.length) {
  console.log(`\n!!! INTEGRITY PROBLEMS (${problems.length}) — fix before Checkpoint 2 sign-off:`);
  for (const r of problems) console.log(`  ${r.c.key}: ${r.problems.join('; ')}`);
} else {
  console.log(`\nintegrity: OK (all muscles/equipment/relation refs resolve, no key collisions)`);
}
console.log(`\nwrote docs/exercise-library-audit/candidates.csv  (${results.length})`);
console.log(`wrote docs/exercise-library-audit/duplicate-merge-report.csv  (${groups.ALIAS_TO_EXISTING.length + groups.DUPLICATE_DO_NOT_IMPORT.length})`);
