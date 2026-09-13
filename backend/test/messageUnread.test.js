// ============================================================
// UNREAD MESSAGES — a column that existed and meant nothing.
//
// `messages.read` has been written as 0 on every insert since the table
// was created, and read by nothing, updated by nothing. So the one field
// that answers "has anyone written to me?" could only ever say no: the
// workspace had no unread count, no badge, and no way to tell a new
// message from one answered last week. You opened threads one at a time
// to find out.
//
// Two properties carry this feature, and getting either wrong is worse
// than having no badge at all:
//
//   UNREAD IS FROM THE RECIPIENT'S SIDE. Your own outgoing messages are
//   never unread to you — which sounds obvious and is exactly what a
//   naive `WHERE read = 0` returns.
//
//   READING NEVER CLEARS THE OTHER SIDE. If opening a thread marked the
//   whole thread read, a trainer glancing at a conversation would wipe
//   the client's badge and the client would never know a reply arrived.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');
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
    raw,
  });
  return mk();
}

async function startApi() {
  const express = (await import('express')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../src/config.js');
  const messageRoutes = (await import('../src/routes/messages.js')).default;
  const { resetRateLimits } = await import('../src/rateLimit.js');
  resetRateLimits();

  const db = await memDb();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o1', 'Gym', 'gym', ts]);
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)', ['o2', 'Other', 'other', ts]);
  const mkUser = (id, org, role) => db.run(
    `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
     VALUES (?,?,?,'x',?,?,1,?)`, [id, org, `${id}@x.in`, role, id, ts]);
  await mkUser('coach', 'o1', 'TRAINER');
  await mkUser('coach2', 'o1', 'TRAINER');
  await mkUser('member', 'o1', 'CLIENT');
  await mkUser('outsider', 'o2', 'CLIENT');
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?,?,?,?,?)',
    ['cMine', 'member', 'o1', 'coach', ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, created_at) VALUES (?,?,?,?)',
    ['cOther', 'outsider', 'o2', ts]);

  const app = express();
  app.use(express.json());
  app.use('/api/messages', messageRoutes(db));
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const tok = (sub, role, org) => jwt.sign({ sub, role, org, name: sub, email: `${sub}@x.in` }, config.jwtSecret);
  const call = (method, url, token, body) => fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { db, tok, call, close };
}

const COACH = (tok) => tok('coach', 'TRAINER', 'o1');
const MEMBER = (tok) => tok('member', 'CLIENT', 'o1');

test('a message you received is unread; one you sent is not', async (t) => {
  // The naive `WHERE read = 0` counts your own outgoing messages, so a
  // chatty coach would show a growing unread badge from their own words.
  const { tok, call, close } = await startApi();
  t.after(() => close());

  await call('POST', '/api/messages', MEMBER(tok), { client_id: 'cMine', type: 'message', body: 'Can we move Friday?' });
  await call('POST', '/api/messages', COACH(tok), { client_id: 'cMine', type: 'message', body: 'Yes, 7am.' });

  const coachSees = await (await call('GET', '/api/messages/unread', COACH(tok))).json();
  assert.equal(coachSees.total, 1, "the member's message only");
  assert.equal(coachSees.byClient.cMine, 1);

  const memberSees = await (await call('GET', '/api/messages/unread', MEMBER(tok))).json();
  assert.equal(memberSees.total, 1, "the coach's reply only");
});

test('opening a thread clears only YOUR side of it', async (t) => {
  // If reading marked the whole thread, a coach glancing at a
  // conversation would wipe the client's badge and the client would
  // never learn a reply had arrived.
  const { tok, call, close } = await startApi();
  t.after(() => close());

  await call('POST', '/api/messages', MEMBER(tok), { client_id: 'cMine', type: 'message', body: 'Question' });
  await call('POST', '/api/messages', COACH(tok), { client_id: 'cMine', type: 'message', body: 'Answer' });

  const marked = await (await call('POST', '/api/messages/read', COACH(tok), { client_id: 'cMine' })).json();
  assert.equal(marked.marked, 1);

  assert.equal((await (await call('GET', '/api/messages/unread', COACH(tok))).json()).total, 0);
  assert.equal((await (await call('GET', '/api/messages/unread', MEMBER(tok))).json()).total, 1,
    "the member's badge survives the coach reading");
});

test('marking read twice is harmless', async (t) => {
  const { tok, call, close } = await startApi();
  t.after(() => close());
  await call('POST', '/api/messages', MEMBER(tok), { client_id: 'cMine', type: 'message', body: 'Hello' });

  assert.equal((await (await call('POST', '/api/messages/read', COACH(tok), { client_id: 'cMine' })).json()).marked, 1);
  assert.equal((await (await call('POST', '/api/messages/read', COACH(tok), { client_id: 'cMine' })).json()).marked, 0,
    'nothing left to mark, and no error');
});

test('you cannot mark a thread read that is not yours', async (t) => {
  // Otherwise this becomes an oracle for which client ids exist
  // elsewhere, and a way to silently clear someone else's badge.
  const { tok, call, close } = await startApi();
  t.after(() => close());

  const otherGym = await call('POST', '/api/messages/read', COACH(tok), { client_id: 'cOther' });
  assert.equal(otherGym.status, 403, "another gym's client");

  const notMine = await call('POST', '/api/messages/read', tok('coach2', 'TRAINER', 'o1'), { client_id: 'cMine' });
  assert.equal(notMine.status, 403, "same gym, another trainer's client");
});

test('unread counts are per client, and only your own', async (t) => {
  const { db, tok, call, close } = await startApi();
  t.after(() => close());

  await db.run(`INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
                VALUES ('member2','o1','m2@x.in','x','CLIENT','m2',1,?)`, [ts]);
  await db.run('INSERT INTO clients (id, user_id, org_id, trainer_id, created_at) VALUES (?,?,?,?,?)',
    ['cSecond', 'member2', 'o1', 'coach', ts]);

  await call('POST', '/api/messages', MEMBER(tok), { client_id: 'cMine', type: 'message', body: 'a' });
  await call('POST', '/api/messages', MEMBER(tok), { client_id: 'cMine', type: 'message', body: 'b' });
  await call('POST', '/api/messages', tok('member2', 'CLIENT', 'o1'), { client_id: 'cSecond', type: 'message', body: 'c' });

  const seen = await (await call('GET', '/api/messages/unread', COACH(tok))).json();
  assert.equal(seen.total, 3);
  assert.deepEqual(seen.byClient, { cMine: 2, cSecond: 1 });

  // The other coach has nobody writing to them.
  const other = await (await call('GET', '/api/messages/unread', tok('coach2', 'TRAINER', 'o1'))).json();
  assert.equal(other.total, 0);
});
