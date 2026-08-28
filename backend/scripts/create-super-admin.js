// ============================================================
// CREATE SUPER ADMIN — the ONLY way a SUPER_ADMIN account can ever
// exist in this codebase. No self-serve signup route creates one (see
// routes/auth.js -- every registration route hard-codes GYM_OWNER,
// TRAINER, or CLIENT); this is a deliberate, operator-run, one-time-
// per-admin CLI step, not a web-reachable endpoint.
//
// Usage:
//   node scripts/create-super-admin.js --email you@sk-os.com --password 'something-strong' --name "Platform Admin"
//
// Idempotent on email: re-running with the SAME email updates the
// existing account's password/name rather than failing or creating a
// duplicate (useful for rotating a lost/compromised admin password).
// org_id is intentionally NULL -- a SUPER_ADMIN is platform-wide, not
// scoped to any single gym (see auth.js's orgScope: SUPER_ADMIN gets
// req.orgId from the request, never from a fixed home org).
// ============================================================
import { getDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { id, now } from '../src/ids.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = value;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || '').toLowerCase().trim();
  const password = String(args.password || '');
  const name = String(args.name || 'Platform Admin');
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/create-super-admin.js --email you@example.com --password "..." [--name "Platform Admin"]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('--password must be at least 8 characters for a platform-wide admin account.');
    process.exit(1);
  }

  const db = await getDb();
  const passwordHash = await hashPassword(password);
  const existing = await db.q1('SELECT id, role FROM users WHERE email = ?', [email]);
  if (existing) {
    if (existing.role !== 'SUPER_ADMIN') {
      // Refuse to silently escalate an existing staff/client account --
      // that's a real privilege change and must go through a deliberate
      // separate step (an operator editing the role by hand, with the
      // consequences plainly understood), never a side effect of a
      // password-rotation script sharing an email by coincidence.
      console.error(`A user with this email already exists with role ${existing.role}, not SUPER_ADMIN. Refusing to change it here.`);
      process.exit(1);
    }
    await db.run('UPDATE users SET password_hash = ?, name = ? WHERE id = ?', [passwordHash, name, existing.id]);
    console.log(`Updated existing SUPER_ADMIN account: ${email}`);
  } else {
    const userId = id('usr');
    await db.run(
      `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at) VALUES (?, NULL, ?, ?, 'SUPER_ADMIN', ?, 1, ?)`,
      [userId, email, passwordHash, name, now()]);
    console.log(`Created SUPER_ADMIN account: ${email} (id ${userId})`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
