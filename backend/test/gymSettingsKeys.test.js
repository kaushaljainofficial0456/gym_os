// ============================================================
// Every gym_settings column round-trips through PUT /admin/settings.
//
// Business.jsx saves by sending back the whole object GET gave it, and the
// endpoint refuses any key it does not know (so a typo can never report
// "Saved" while saving nothing). The two rules together mean a column
// added anywhere -- schema.sql or an init-db.js migration -- and missing
// from SETTING_KEYS breaks "Save gym settings" for every gym with a 422.
// That happened with six access/opening-hours columns; this keeps it from
// happening again.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTING_KEYS } from '../src/routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

function gymSettingsColumns() {
  const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
  const table = schema.match(/CREATE TABLE IF NOT EXISTS gym_settings \(([\s\S]*?)\n\);/)[1];
  const cols = table.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
  const initDb = fs.readFileSync(path.join(root, 'backend', 'scripts', 'init-db.js'), 'utf8');
  for (const m of initDb.matchAll(/\['gym_settings',\s*'([a-z_]+)'/g)) cols.push(m[1]);
  return [...new Set(cols)];
}

test('every gym_settings column (schema + migrations) is accepted by PUT /admin/settings', () => {
  const cols = gymSettingsColumns();
  assert.ok(cols.length > 20, `parsed ${cols.length} columns -- the parser is reading the table`);
  const refused = cols.filter((c) => !SETTING_KEYS.has(c));
  assert.deepEqual(refused, [], `GET hands these out and PUT refuses them: ${refused.join(', ')}`);
});
