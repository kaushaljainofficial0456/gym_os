// Quick debug: check actual DB column counts and test both INSERTs
import { config } from '../src/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', '..', config.sqlitePath);
console.log('DB path:', dbPath);

const db = new DatabaseSync(dbPath);

// Column counts
const msgCols = db.prepare('PRAGMA table_info(messages)').all();
const notifCols = db.prepare('PRAGMA table_info(notifications)').all();
console.log('messages columns:', msgCols.length, '→', msgCols.map(c=>c.name).join(', '));
console.log('notifications columns:', notifCols.length, '→', notifCols.map(c=>c.name).join(', '));

// Get valid IDs
const org = db.prepare('SELECT id FROM organizations LIMIT 1').get();
const user = db.prepare('SELECT id FROM users LIMIT 1').get();
const client = db.prepare('SELECT id FROM clients LIMIT 1').get();
if (!org || !user || !client) {
  console.log('No test data available');
  db.close();
  process.exit(1);
}

console.log('\n--- Testing messages INSERT ---');
const msgSql = `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'inapp', 0, ?)`;
const msgParams = ['msg_debug', org.id, user.id, user.id, client.id, 'message', 'test', new Date().toISOString()];
console.log('SQL ? count:', (msgSql.match(/\?/g)||[]).length);
console.log('Params count:', msgParams.length);
try {
  db.prepare(msgSql).run(...msgParams);
  console.log('✓ messages INSERT succeeded');
} catch(e) {
  console.log('✗ messages INSERT failed:', e.message);
}

console.log('\n--- Testing notifications INSERT ---');
const notifSql = `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const notifParams = ['ntf_debug', org.id, user.id, client.id, 'message', 'msg title', 'test body', new Date().toISOString()];
console.log('SQL ? count:', (notifSql.match(/\?/g)||[]).length);
console.log('Params count:', notifParams.length);
try {
  db.prepare(notifSql).run(...notifParams);
  console.log('✓ notifications INSERT succeeded');
} catch(e) {
  console.log('✗ notifications INSERT failed:', e.message);
}

// Also test the EXACT SQL from messages.js (with 'message' literal for title)
console.log('\n--- Testing notifications INSERT (with literal) ---');
const notifSql2 = `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?, 'message', ?, ?)`;
const notifParams2 = ['ntf_debug2', org.id, user.id, client.id, 'message', 'test body', new Date().toISOString()];
console.log('SQL ? count:', (notifSql2.match(/\?/g)||[]).length);
console.log('Params count:', notifParams2.length);
try {
  db.prepare(notifSql2).run(...notifParams2);
  console.log('✓ notifications INSERT (literal) succeeded');
} catch(e) {
  console.log('✗ notifications INSERT (literal) failed:', e.message);
}

// Clean up
try { db.prepare('DELETE FROM messages WHERE id = ?').run('msg_debug'); } catch {}
try { db.prepare('DELETE FROM notifications WHERE id LIKE ?').run('ntf_debug%'); } catch {}

db.close();
console.log('\nDone.');
