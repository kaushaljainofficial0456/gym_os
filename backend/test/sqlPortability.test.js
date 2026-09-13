// ============================================================
// SQL THAT PASSES EVERY TEST AND FAILS IN PRODUCTION.
//
// The suite builds a SQLite database from schema.sql on every run.
// Production is PostgreSQL. So any query using a SQLite-only construct
// is green here and throws there, and nothing in between ever says so --
// which is precisely how the community_members outage happened: code went
// live against a database that could not satisfy its queries, /api/
// community/* returned 500 for three days, and the tests stayed green the
// entire time.
//
// db-check.js closes the half of that gap about missing TABLES. This
// closes the half about incompatible SQL.
//
// `rowid` is the case that prompted this: a frequent-foods query ordered
// by it, which SQLite provides as a pseudo-column on every table and
// PostgreSQL does not have at all. Caught in review rather than by a
// test, which is the argument for the test.
//
// This checks one construct, not all of them. A guard that catches the
// mistake actually made beats an exhaustive one nobody finishes.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

test('no SQLite-only SQL reaches code that runs against PostgreSQL', async () => {
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        // Strip comments. These files carry long explanatory headers, and
        // naming the trap in prose is the opposite of falling into it.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        // Case-SENSITIVE, and only the spellings SQL actually uses. A
        // case-insensitive match also flags `rowId` — an ordinary
        // camelCase identifier this codebase uses for generated ids — and
        // 15 false positives would have made this guard noise. A noisy
        // guard is a guard someone deletes.
        if (/\b(rowid|ROWID)\b/.test(code)) offenders.push(`${path.relative(root, full)}:${i + 1}`);
      });
    }
  };
  walk(path.join(root, 'backend', 'src'));

  assert.deepEqual(offenders, [],
    `rowid is a SQLite pseudo-column and does not exist in PostgreSQL:\n  ${offenders.join('\n  ')}`);
});
