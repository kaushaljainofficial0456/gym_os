// ============================================================
// SEED THE DEMO TENANT — "BeFitter", owned by Kirthi.
//
//   npm run seed:demo
//
// Idempotent and repeatable: re-running rebuilds the demo gym's content
// from the canonical seed (see src/services/demo/seed.js) rather than
// creating a second one. The organization ROW survives a re-run, so the
// founder's demo_sessions history is never destroyed by a reset.
//
// Safe against production: every write is scoped to an organization
// flagged is_demo = 1, and the reset step refuses outright to touch an
// org that is not. It never reads or writes another org's data.
//
// NOT run at deploy time, and deliberately not wired into `npm run
// build` or any startup path -- the spec is explicit that deploying must
// not silently re-create demo data (spec 28). A founder runs this once
// to establish the tenant, and afterwards "Reset Demo Data" in the admin
// console calls the same function.
// ============================================================
import { getDb } from '../src/db.js';
import { config } from '../src/config.js';
import { seedDemoTenant, findDemoOrg, DEMO_GYM_NAME, DEMO_OWNER_NAME } from '../src/services/demo/seed.js';
import { enforceSession } from '../src/services/demo/session.js';

const db = await getDb();
const driver = db.driver || (config.databaseUrl ? 'postgres' : 'sqlite');
console.log(`[seed-demo] db: ${driver}`);
console.log(`[seed-demo] tenant: ${DEMO_GYM_NAME} (owner ${DEMO_OWNER_NAME})`);

// Rebuilding deletes and recreates every account in the tenant, so doing
// it under a running demo pulls the ground out from under a prospect
// mid-sentence. The admin console's Reset button already refuses in that
// case; this is the same guard for the command line, because a founder
// running the seeder by hand can do just as much damage as one pressing
// the button. --force is the deliberate override.
const existing = await findDemoOrg(db);
if (existing && !process.argv.includes('--force')) {
  const live = [];
  for (const s of await db.q(`SELECT id FROM demo_sessions WHERE demo_org_id = ? AND status = 'active'`, [existing.id])) {
    // enforceSession, not a bare status read: a session whose clock ran
    // out but which nobody has made a request against since still says
    // 'active' in the table, and must not block a reseed.
    if ((await enforceSession(db, s.id)).ok) live.push(s.id);
  }
  if (live.length) {
    console.error(`[seed-demo] REFUSING: ${live.length} demo session(s) are running right now.`);
    console.error('  Revoke them in Admin Console -> Demos, wait for them to finish, or re-run with --force.');
    process.exit(1);
  }
}

const t0 = Date.now();
const { orgId, counts } = await seedDemoTenant(db, { log: (m) => console.log(m) });

console.log(`[seed-demo] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — org ${orgId}`);
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(22)} ${v}`);
console.log('');
console.log('Next: approve a demo request in the Admin Console (Demo Management) to hand out a link.');
console.log('No demo account can be signed into with a password — access is only ever a founder-approved session.');

if (driver === 'postgres' && db.raw?.end) await db.raw.end();
