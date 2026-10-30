// ============================================================
// Owner spreadsheet exports: GET /admin/export/members.csv and
// /admin/export/payments.csv.
//
// The file has to open cleanly in Excel (UTF-8 BOM, quoted cells), carry
// only this gym's rows, and never let a member's own text run as a formula
// on the owner's machine (CSV injection: a name like =HYPERLINK(...)).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-10-01T00:00:00Z';

async function startApi() {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(schema);
  // The columns later migrations added (init-db.js MIGRATIONS), which
  // schema.sql predates -- applied from the real list, not copied by hand.
  const initDb = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'init-db.js'), 'utf8');
  for (const m of initDb.matchAll(/\['(subscriptions|payments|clients|users)',\s*'[a-z_]+',\s*`([^`]+)`\]/g)) {
    try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]}`); } catch { /* already in schema.sql */ }
  }
  const mk = () => ({
    driver: 'sqlite',
    async q(sql, p = []) { const st = raw.prepare(sql); return p.length ? st.all(...p) : st.all(); },
    async q1(sql, p = []) { const rows = await mk().q(sql, p); return rows[0] || null; },
    async run(sql, p = []) { const st = raw.prepare(sql); const r = p.length ? st.run(...p) : st.run(); return { changes: Number(r.changes) }; },
    async tx(fn) { return fn(mk()); },
  });
  const db = mk();
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  for (const o of ['o1', 'o2']) await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', [o, o, o, ts]);
  const addMember = async (u, c, org, name, email) => {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, phone, active, created_at) VALUES (?,?,?,'x','CLIENT',?,'+91 98 765',1,?)`, [u, org, email, name, ts]);
    await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)', [c, u, org, ts]);
  };
  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES ('own','o1','own@x.in','x','GYM_OWNER','Owner',1,?)`, [ts]);
  await addMember('u1', 'c1', 'o1', 'Aarav, "Ace" Shah', 'aarav@x.in');
  await addMember('u2', 'c2', 'o1', '=HYPERLINK("http://evil","x")', 'evil@x.in');
  await addMember('u9', 'c9', 'o2', 'Other Gym Person', 'other@x.in');
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, method, status, paid_at) VALUES (?,?,?,?,?,?,?)', ['p1', 'o1', 'c1', 1999, 'upi', 'paid', '2026-10-05T10:00:00Z']);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, method, status, paid_at) VALUES (?,?,?,?,?,?,?)', ['p2', 'o1', 'c1', 4999, 'cash', 'paid', '2026-08-01T10:00:00Z']);
  await db.run('INSERT INTO payments (id, org_id, client_id, amount, method, status, paid_at) VALUES (?,?,?,?,?,?,?)', ['p9', 'o2', 'c9', 777, 'upi', 'paid', '2026-10-05T10:00:00Z']);

  const app = express();
  app.set('db', db);
  app.use(express.json());
  app.use('/api/admin', adminRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const get = async (url, { sub = 'own', role = 'GYM_OWNER' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      headers: { Authorization: `Bearer ${jwt.sign({ sub, role, org: 'o1' }, config.jwtSecret)}` },
    });
    // Raw bytes: res.text() strips a BOM, which is exactly what is checked.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), bom, text: new TextDecoder().decode(bytes) };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { get, close };
}

test('members.csv: this gym only, Excel-ready, quoted where it must be', async (t) => {
  const { get, close } = await startApi(); t.after(close);
  const res = await get('/api/admin/export/members.csv');
  assert.equal(res.status, 200, res.text);
  assert.match(res.type, /text\/csv/);
  assert.match(res.disposition, /attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.bom, true, 'BOM so Excel reads UTF-8');
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines[0], 'Name,Email,Phone,Goal,Coaching status,Trainer,Joined,Plan,Plan start,Plan end,Payment,Membership');
  assert.equal(lines.length, 3, 'header + the two members of this gym');
  assert.ok(lines.some((l) => l.startsWith('"Aarav, ""Ace"" Shah",aarav@x.in')), 'comma and quotes escaped');
  assert.ok(!res.text.includes('Other Gym Person'));
});

test('members.csv: a member\'s text can never run as a formula', async (t) => {
  const { get, close } = await startApi(); t.after(close);
  const { text } = await get('/api/admin/export/members.csv');
  const evil = text.split('\r\n').find((l) => l.includes('evil@x.in'));
  assert.ok(evil.startsWith(`"'=HYPERLINK(`), evil);
  assert.ok(!/(^|,)=/.test(evil), 'no cell begins with =');
});

test('payments.csv: this gym only, filtered by date when asked', async (t) => {
  const { get, close } = await startApi(); t.after(close);
  const all = await get('/api/admin/export/payments.csv');
  assert.equal(all.status, 200);
  const rows = all.text.trim().split('\r\n');
  assert.equal(rows[0], 'Date,Member,Email,Amount,Currency,Method,Status,Reference');
  assert.equal(rows.length, 3, 'two payments of this gym, newest first');
  assert.ok(rows[1].startsWith('2026-10-05,'));
  assert.ok(!all.text.includes('777'));

  const october = await get('/api/admin/export/payments.csv?from=2026-10-01&to=2026-10-31');
  assert.equal(october.text.trim().split('\r\n').length, 2);
  assert.match(october.disposition, /payments-2026-10-01-to-2026-10-31\.csv/);
});

test('exports are owner-only', async (t) => {
  const { get, close } = await startApi(); t.after(close);
  assert.equal((await get('/api/admin/export/members.csv', { sub: 'u1', role: 'CLIENT' })).status, 403);
  assert.equal((await get('/api/admin/export/payments.csv', { sub: 'u1', role: 'TRAINER' })).status, 403);
});
