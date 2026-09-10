// ============================================================
// BACKFILL PERSONAL RECORDS from existing workout history.
//
//   node scripts/backfill-prs.js [--client <clientId>] [--dry]
//
// WHY THIS EXISTS: personal_records is only ever written when a workout
// is completed through the app (routes/workouts.js -> evaluatePRs), so
// every set logged BEFORE PR tracking shipped is invisible to the PR
// experience -- a user with a year of training history sees "no PRs yet".
// This replays their real logged sets, in chronological order, through
// the EXISTING engine (services/personalRecords.js) so the records are
// derived by exactly the same rules as live ones. It creates no data of
// its own: every value traces to a stored workout_logs/exercise_set_logs
// row.
//
// Idempotent: evaluatePRs only records a value that beats the stored
// best, so a second run is a no-op.
// ============================================================
import { config } from '../src/config.js';
import { getDb } from '../src/db.js';
import { evaluatePRs } from '../src/services/personalRecords.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const clientArg = args.includes('--client') ? args[args.indexOf('--client') + 1] : null;

const db = await getDb();

const clients = clientArg
  ? await db.q('SELECT id FROM clients WHERE id = ?', [clientArg])
  : await db.q('SELECT DISTINCT client_id AS id FROM workout_logs');

console.log(`[backfill-prs] ${clients.length} client(s), db: ${db.driver || (config.databaseUrl ? 'postgres' : 'sqlite')}${dry ? ' (DRY RUN)' : ''}`);

let totalPrs = 0;
for (const c of clients) {
  // Chronological: a PR is only a PR relative to what came BEFORE it, so
  // replaying out of order would record the wrong records entirely.
  const logs = await db.q(
    `SELECT id, exercise_id, date, weight, reps, sets_done
       FROM workout_logs
      WHERE client_id = ? AND exercise_id IS NOT NULL AND weight IS NOT NULL AND weight > 0
      ORDER BY date ASC, created_at ASC`, [c.id]);

  let clientPrs = 0;
  for (const log of logs) {
    // Prefer the real per-set rows; fall back to the session aggregate
    // (weight x reps x sets_done) when only that was recorded. Both are
    // real logged data -- neither is invented.
    const setRows = await db.q(
      `SELECT actual_weight, actual_reps, completed FROM exercise_set_logs
        WHERE client_id = ? AND exercise_id = ? AND workout_log_id = ?`,
      [c.id, log.exercise_id, log.id]);

    const sets = setRows.length
      ? setRows.map((s) => ({ actual_weight: s.actual_weight, actual_reps: s.actual_reps, completed: s.completed }))
      : Array.from({ length: Math.max(1, Number(log.sets_done) || 1) }, () => ({
        actual_weight: log.weight, actual_reps: log.reps, completed: 1,
      }));

    if (dry) continue;
    const prs = await evaluatePRs(db, c.id, log.exercise_id, sets, log.date);
    if (prs.length) {
      clientPrs += prs.length;
      // Mark the session that actually set the record -- this is what the
      // PR timeline reads (personal_records itself keeps only the current
      // best per exercise/type, so it cannot answer "when?").
      await db.run('UPDATE workout_logs SET is_pr = 1 WHERE id = ?', [log.id]);
    }
  }
  totalPrs += clientPrs;
  if (clientPrs) console.log(`  ${c.id}: ${clientPrs} records from ${logs.length} logged sessions`);
}

console.log(`[backfill-prs] done — ${totalPrs} personal record(s) recorded`);
process.exit(0);
