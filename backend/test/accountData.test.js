// ============================================================
// A member's own data: GET /me/export and POST /me/delete-account.
//
// Export: everything that is theirs, nothing that is anyone else's, and
// never a secret (password hash, wearable OAuth tokens).
// Delete: the person is gone -- body data, photos, wearable connections,
// sign-in -- while the gym's own books (payments) stay, anonymised, and an
// already-open session stops working on its next request.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
const ts = '2026-01-01T00:00:00Z';

async function startApi() {
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
  });
  const db = mk();
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const meRoutes = (await import('../src/routes/me.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  const people = [['u1', 'c1', 'member@x.in', 'CLIENT'], ['u2', 'c2', 'other@x.in', 'CLIENT'], ['u3', null, 'owner@x.in', 'GYM_OWNER']];
  for (const [u, c, mail, role] of people) {
    await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, phone, avatar, active, created_at)
                  VALUES (?,'o1',?,'$2a$12$realhashrealhash','${role}','Real Name','+91 90000 00000','data:image/png;base64,AAAA',1,?)`, [u, mail, ts]);
    if (c) {
      await db.run('INSERT INTO clients (id, user_id, org_id, age, height_cm, current_weight, created_at) VALUES (?,?,?,?,?,?,?)', [c, u, 'o1', 30, 175, 80, ts]);
      await db.run('INSERT INTO client_profiles (client_id, medical_notes) VALUES (?, ?)', [c, 'knee surgery 2024']);
      await db.run('INSERT INTO weight_logs (id, client_id, date, weight, created_at) VALUES (?,?,?,?,?)', [`w_${c}`, c, '2026-10-01', 80, ts]);
      await db.run('INSERT INTO payments (id, org_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?)', [`p_${c}`, 'o1', c, 1999, 'paid', ts]);
    }
  }
  await db.run(`INSERT INTO health_provider_connections (id, user_id, org_id, provider, access_token, refresh_token, oauth_state, connected_at, created_at, updated_at)
                VALUES ('h1','u1','o1','whoop','live-access-token','live-refresh-token','csrf-state',?,?,?)`, [ts, ts, ts]);

  const app = express();
  app.set('db', db); // requireAuth's account gate reads this database
  app.use(express.json());
  app.use('/api/me', meRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tokenFor = (sub, role) => jwt.sign({ sub, role, org: 'o1', name: 'Real Name' }, config.jwtSecret);
  const call = async (method, url, { as = 'u1', role = 'CLIENT', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(as, role)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, disposition: res.headers.get('content-disposition'), cookie: res.headers.get('set-cookie') };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, call, close };
}

test('export: the member\'s own data, as a download, with every secret stripped', async (t) => {
  const { call, close } = await startApi(); t.after(close);
  const res = await call('GET', '/api/me/export');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(res.disposition || '', /attachment; filename="barbell-my-data-/);
  const out = res.json;
  assert.equal(out.format, 'barbell-export-v1');
  assert.equal(out.account.email, 'member@x.in');
  assert.equal(out.account.password_hash, undefined, 'no password hash');
  assert.equal(out.data.weight_logs.length, 1);
  assert.equal(out.data.weight_logs[0].client_id, 'c1', 'only their own rows');
  assert.equal(out.data.payments.length, 1);
  const conn = out.data.health_provider_connections[0];
  assert.equal(conn.provider, 'whoop');
  for (const k of ['access_token', 'refresh_token', 'oauth_state']) assert.equal(conn[k], undefined, `${k} never leaves the server`);
  assert.ok(!JSON.stringify(out).includes('live-access-token'));
});

test('delete: refused unless the account email is typed, and nothing changes', async (t) => {
  const { db, call, close } = await startApi(); t.after(close);
  const res = await call('POST', '/api/me/delete-account', { body: { confirm: 'someone@else.in' } });
  assert.equal(res.status, 422);
  const u = await db.q1('SELECT name, active FROM users WHERE id = ?', ['u1']);
  assert.deepEqual({ ...u }, { name: 'Real Name', active: 1 });
});

test('delete: the person is gone, the gym\'s books stay, and the open session stops working', async (t) => {
  const { db, call, close } = await startApi(); t.after(close);
  const res = await call('POST', '/api/me/delete-account', { body: { confirm: '  Member@X.in ' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(res.cookie || '', /sk_token=;|sk_token=$|Max-Age=0|Expires=Thu, 01 Jan 1970/i, 'cookie cleared');

  const u = await db.q1('SELECT name, email, phone, avatar, active, password_hash FROM users WHERE id = ?', ['u1']);
  assert.equal(u.name, 'Deleted member');
  assert.equal(u.email, 'deleted-u1@deleted.invalid');
  assert.equal(u.phone, null);
  assert.equal(u.avatar, null);
  assert.equal(u.active, 0);
  assert.notEqual(u.password_hash, '$2a$12$realhashrealhash', 'the old password no longer opens it');

  assert.equal((await db.q('SELECT id FROM weight_logs WHERE client_id = ?', ['c1'])).length, 0, 'body data gone');
  assert.equal(await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', ['c1']), null, 'medical notes gone');
  assert.equal((await db.q('SELECT id FROM health_provider_connections WHERE user_id = ?', ['u1'])).length, 0, 'wearable tokens gone');
  const c = await db.q1('SELECT age, height_cm, current_weight, status FROM clients WHERE id = ?', ['c1']);
  assert.deepEqual({ ...c }, { age: null, height_cm: null, current_weight: null, status: 'INACTIVE' });
  assert.equal((await db.q('SELECT id FROM payments WHERE client_id = ?', ['c1'])).length, 1, 'payments kept for the gym');

  // Someone else is untouched.
  assert.equal((await db.q('SELECT id FROM weight_logs WHERE client_id = ?', ['c2'])).length, 1);

  // The token issued before deletion is refused on its next use.
  const after = await call('GET', '/api/me/export');
  assert.equal(after.status, 401);
});

test('delete: owners are refused -- their account is the gym', async (t) => {
  const { db, call, close } = await startApi(); t.after(close);
  const res = await call('POST', '/api/me/delete-account', { as: 'u3', role: 'GYM_OWNER', body: { confirm: 'owner@x.in' } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /support/);
  assert.equal((await db.q1('SELECT active FROM users WHERE id = ?', ['u3'])).active, 1);
});
