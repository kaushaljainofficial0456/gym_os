// ============================================================
// TRAINING-DATA EXPORT CLI
//
//   node scripts/export-training-data.js [--out path.jsonl] [--limit n]
//
// Streams the training dataset (docs/training-data-contract.md) as
// JSONL from the configured database (DATABASE_URL in
// staging/production, SQLite in development). Read-only — this
// script never writes to the database.
//
//   --out    write records to a file (default: stdout)
//   --limit  page size for the batched read (default 100)
//
// The summary goes to stderr and contains COUNTS ONLY — records,
// payloads, body weights, and credentials are never logged.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db.js';
import { extractTrainingDataset, DEFAULT_BATCH_SIZE } from '../src/services/intelligence/trainingData.js';

const args = process.argv.slice(2);
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : NaN;
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : DEFAULT_BATCH_SIZE;

const stats = { scanned: 0, written: 0, noRealSets: 0, ambiguous: 0, failed: 0 };

let db;
try {
  db = await getDb();
} catch (e) {
  console.error(`[sk-os] training-data export FAILED to connect: ${String(e?.message || e).slice(0, 300)}`);
  process.exit(1);
}

let fd = null; // null => stdout
if (outFile) {
  const abs = path.resolve(outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fd = fs.createWriteStream(abs, { flags: 'w' });
}
const sink = fd || process.stdout;

try {
  for await (const rec of extractTrainingDataset(db, { limit, stats })) {
    sink.write(JSON.stringify(rec) + '\n');
  }
} catch (e) {
  console.error(`[sk-os] training-data export FAILED: ${String(e?.message || e).slice(0, 300)}`);
  if (fd) fd.destroy();
  process.exit(1);
} finally {
  if (fd) await new Promise((r) => fd.end(r));
}

console.error(
  `[sk-os] training-data export complete: ${stats.written} records from ${stats.scanned} completed workouts ` +
  `(excluded: ${stats.noRealSets} no-real-sets, ${stats.ambiguous} ambiguous name-only, ${stats.failed} failed).`
);
process.exit(0);
