// ============================================================
// coupon_redemptions: the Barbell plan takes coupons.
//
// schema.sql now declares, on coupon_redemptions:
//   * quote_id nullable -- a plan purchase has no billing quote; its hold
//     key is the new plan_order_id instead,
//   * plan_order_id, user_id, user_slot -- the plan's hold key, and the
//     per-PERSON limit slot (every Independent client shares one org),
//   * 'BARBELL_PLAN' as a subject_type.
// CREATE TABLE IF NOT EXISTS is a no-op on a database that already has the
// table, so an existing one is upgraded here, from scripts/init-db.js.
//
// Additive and idempotent: no row is dropped or rewritten, and the only
// constraints that change are RELAXED (a NOT NULL, and a CHECK that now
// allows one more value), so every row that was valid stays valid. Safe to
// run on every db:init: each step is guarded and does nothing the second
// time.
//
// Its own module (no top-level side effects, unlike init-db.js) so a test
// can run it against a table in the old shape.
// ============================================================

const SUBJECT_CHECK = `CHECK (subject_type IS NULL OR subject_type IN ('ORG_PACKAGE','ORG_CAPACITY_ADDON','BARBELL_PLAN'))`;

/** The column list of schema.sql's CREATE TABLE coupon_redemptions -- the
 *  single source of the table's shape, so the SQLite rebuild below can
 *  never drift from what a fresh database gets. */
export function couponRedemptionsBody(schemaSql) {
  const m = schemaSql.match(/CREATE TABLE IF NOT EXISTS coupon_redemptions \(([\s\S]*?)\r?\n\);/);
  if (!m) throw new Error('schema.sql has no CREATE TABLE coupon_redemptions');
  return m[1];
}

/**
 * SQLite cannot drop a NOT NULL or change a CHECK in place, so an old-shape
 * table is rebuilt the way SQLite's own documentation prescribes: create
 * the new shape, copy every row across, drop the old table, rename the new
 * one into place -- all in one transaction, with foreign keys checked
 * before it commits. Returns true if it rebuilt anything.
 */
export function upgradeCouponRedemptionsSqlite(db, schemaSql) {
  const cols = db.prepare('PRAGMA table_info(coupon_redemptions)').all();
  const quoteCol = cols.find((c) => c.name === 'quote_id');
  // No table (schema.sql was not applied yet), or already the new shape.
  if (!quoteCol || !Number(quoteCol.notnull)) return false;

  const tmp = 'coupon_redemptions_upgrade';
  // Has to be outside the transaction: SQLite ignores this PRAGMA inside one.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      db.exec(`CREATE TABLE ${tmp} (${couponRedemptionsBody(schemaSql)}\n)`);
      const fresh = new Set(db.prepare(`PRAGMA table_info(${tmp})`).all().map((c) => c.name));
      const keep = cols.map((c) => c.name).filter((n) => fresh.has(n)).join(', ');
      db.exec(`INSERT INTO ${tmp} (${keep}) SELECT ${keep} FROM coupon_redemptions`);
      db.exec('DROP TABLE coupon_redemptions');
      db.exec(`ALTER TABLE ${tmp} RENAME TO coupon_redemptions`);
      const broken = db.prepare('PRAGMA foreign_key_check(coupon_redemptions)').all();
      if (broken.length) throw new Error(`coupon_redemptions upgrade: ${broken.length} row(s) fail a foreign key`);
      // DROP TABLE took the old table's indexes with it.
      for (const stmt of schemaSql.match(/CREATE INDEX IF NOT EXISTS \w+ ON coupon_redemptions\([^)]*\);/g) || []) db.exec(stmt);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return true;
}

/** PostgreSQL relaxes the same constraints in place. `query(sql)` runs one
 *  statement string; a multi-statement string runs as one implicit
 *  transaction, so each block below lands whole or not at all. */
export async function upgradeCouponRedemptionsPg(query) {
  await query(`
    ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS plan_order_id TEXT REFERENCES barbell_plan_orders(id) ON DELETE SET NULL;
    ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS user_slot INTEGER;
    ALTER TABLE coupon_redemptions ALTER COLUMN quote_id DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_plan_order_once ON coupon_redemptions(coupon_id, plan_order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_user_slot_once ON coupon_redemptions(coupon_id, user_id, user_slot);
  `);
  // PostgreSQL names schema.sql's column CHECK <table>_<column>_check.
  const res = await query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'coupon_redemptions'::regclass AND conname = 'coupon_redemptions_subject_type_check'`);
  const def = res?.rows?.[0]?.def || '';
  if (!def.includes('BARBELL_PLAN')) {
    await query(`
      ALTER TABLE coupon_redemptions DROP CONSTRAINT IF EXISTS coupon_redemptions_subject_type_check;
      ALTER TABLE coupon_redemptions ADD CONSTRAINT coupon_redemptions_subject_type_check ${SUBJECT_CHECK};
    `);
  }
}

/** Runs on both engines once the table is in its new shape. Not in
 *  schema.sql: it names a column an old table does not have yet when
 *  schema.sql is applied (the same reason as idx_notif_user). */
export const COUPON_REDEMPTION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_plan_order ON coupon_redemptions(plan_order_id)',
];
