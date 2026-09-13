// ============================================================
// QUICK ADD — the foods you already eat, and the SQL trap behind them.
//
// Most people eat a small set of things on rotation, and logging that
// same breakfast cost a search, a portion and a confirm every morning.
// This endpoint is what makes one tap enough.
//
// The grouping is also where this nearly shipped broken. The first
// version wrote `SELECT name ... GROUP BY LOWER(name)` and ordered by
// `rowid` -- both perfectly legal in SQLite, which is what the tests run
// on, and both wrong on PostgreSQL, which is what production runs on.
// Postgres rejects a selected column that is neither grouped nor
// aggregated, and has no rowid at all. The whole suite would have stayed
// green while the live endpoint 500'd, which is exactly how the
// community_members outage happened. Hence the guard at the bottom.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
    raw,
  });
  return mk();
}

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const meRoutes = (await import('../src/routes/me.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  for (const [u, c, mail] of [['u1', 'c1', 'a@x.in'], ['u2', 'c2', 'b@x.in']]) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                  VALUES (?,'o1',?,'x','CLIENT','C',1,?)`, [u, mail, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, 'o1', ts]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const call = (url, as = 'u1') => fetch(`http://127.0.0.1:${port}${url}`, {
    headers: { Authorization: `Bearer ${jwt.sign({ sub: as, role: 'CLIENT', org: 'o1', name: 'C', email: 'a@x.in' }, config.jwtSecret)}` },
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

let n = 0;
const logMeal = (db, clientId, date, name, over = {}) => db.run(
  `INSERT INTO meal_logs (id, client_id, date, name, calories, protein, carbs, fat, eaten, source, quantity, unit)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [`ml${n += 1}`, clientId, date, name,
    over.calories ?? 300, over.protein ?? 10, over.carbs ?? 20, over.fat ?? 5,
    over.eaten ?? 1, over.source ?? 'manual', over.quantity ?? null, over.unit ?? null]);

const recent = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

test('the most-eaten food comes first', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  for (let i = 0; i < 4; i += 1) await logMeal(db, 'c1', recent(i + 1), 'Oats');
  for (let i = 0; i < 2; i += 1) await logMeal(db, 'c1', recent(i + 1), 'Poha');

  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.deepEqual(foods.map((f) => f.name), ['Oats', 'Poha']);
  assert.equal(foods[0].times, 4);
});

test('the same food in different cases is one food', async (t) => {
  // "Chapati" and "chapati" are the same breakfast. Split, each half
  // falls under the twice-eaten bar and the food vanishes entirely.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(1), 'Chapati');
  await logMeal(db, 'c1', recent(2), 'chapati');
  await logMeal(db, 'c1', recent(3), 'CHAPATI');

  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods.length, 1, 'one food, not three');
  assert.equal(foods[0].times, 3);
});

test('something eaten once is not offered', async (t) => {
  // Quick Add is for your rotation. A one-off would push a real staple
  // off the end of the rail.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(1), 'Airport Sandwich');
  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods.length, 0);
});

test('it returns the portion last actually eaten, not an average', async (t) => {
  // An average of three portions is a number that was never on a plate.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(5), 'Oats', { calories: 200, quantity: 40, unit: 'g' });
  await logMeal(db, 'c1', recent(1), 'Oats', { calories: 500, quantity: 100, unit: 'g' });

  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods[0].calories, 500, 'the most recent portion');
  assert.equal(foods[0].quantity, 100);
  assert.equal(foods[0].unit, 'g');
});

test("a repeat inherits the original's provenance", async (t) => {
  // Re-logging an AI-estimated food does not make its numbers measured.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(2), 'Guessed Curry', { source: 'ai_estimated' });
  await logMeal(db, 'c1', recent(1), 'Guessed Curry', { source: 'ai_estimated' });

  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods[0].source, 'ai_estimated');
});

test('food that was planned but not eaten does not count', async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(1), 'Salad', { eaten: 0 });
  await logMeal(db, 'c1', recent(2), 'Salad', { eaten: 0 });
  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods.length, 0);
});

test("you never see another client's foods", async (t) => {
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c2', recent(1), 'Their Staple');
  await logMeal(db, 'c2', recent(2), 'Their Staple');
  const { foods } = await (await call('/api/me/nutrition/frequent', 'u1')).json();
  assert.equal(foods.length, 0);
});

test('anything eaten long ago has dropped off', async (t) => {
  // The rail is what you eat NOW. A staple you gave up in spring should
  // not outrank this month's breakfast forever.
  const { db, call, close } = await startApi();
  t.after(() => close());
  await logMeal(db, 'c1', recent(200), 'Old Favourite');
  await logMeal(db, 'c1', recent(199), 'Old Favourite');
  const { foods } = await (await call('/api/me/nutrition/frequent')).json();
  assert.equal(foods.length, 0);
});

// ---------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------
test('no SQLite-only SQL reaches code that runs against PostgreSQL', async () => {
  // `rowid` is a SQLite pseudo-column that does not exist in PostgreSQL.
  // A query using it passes every test here and throws in production --
  // the same shape of failure as the community_members outage, where the
  // suite was green because it rebuilds SQLite from schema.sql and can
  // therefore never observe what production cannot do.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        // Skip prose: these files carry long explanatory comments, and
        // naming the trap in one is the opposite of falling into it.
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
    `rowid is SQLite-only and will throw on PostgreSQL:\n  ${offenders.join('\n  ')}`);
});
