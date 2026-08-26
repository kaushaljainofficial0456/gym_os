// ============================================================
// SK OS package/pricing engine -- verified against the spec's own two
// worked examples (80 clients -> Rs.12,775; 105 clients -> Rs.15,775),
// which take precedence over its ambiguous prose (see pricing.js's own
// header comment for the reconciliation).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculatePackagePrice, getCurrentPackages, getCurrentPricingRules, effectiveCostPerClient } from '../src/services/enterprise/pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8');

async function memDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  return {
    driver: 'sqlite',
    async q(sql, params = []) { const stmt = db.prepare(sql); return params.length ? stmt.all(...params) : stmt.all(); },
    async q1(sql, params = []) { const rows = await this.q(sql, params); return rows[0] || null; },
    async run(sql, params = []) { const stmt = db.prepare(sql); const res = params.length ? stmt.run(...params) : stmt.run(); return { changes: Number(res.changes) }; },
    raw: db,
  };
}

// Seeds the EXACT spec example values -- independent of whatever
// init-db.js's own seed currently has, so this test never silently
// breaks if that seed is tuned later.
async function seedPricing(db, { rate = 155 } = {}) {
  const nowIso = '2026-01-01T00:00:00Z';
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at) VALUES
    ('p75', '75 Clients', 75, 12000, 'INR', 365, 1, 'active', ?, ?),
    ('p100', '100 Clients', 100, 15000, 'INR', 365, 1, 'active', ?, ?),
    ('p200', '200 Clients', 200, 24000, 'INR', 365, 1, 'active', ?, ?)`,
    [nowIso, nowIso, nowIso, nowIso, nowIso, nowIso]);
  await db.run(`INSERT INTO sk_pricing_rules (id, base_package_id, additional_client_rate, max_capacity, version, status, effective_from, created_at) VALUES
    ('r75', 'p75', ?, 100, 1, 'active', ?, ?),
    ('r100', 'p100', ?, 200, 1, 'active', ?, ?)`,
    [rate, nowIso, nowIso, rate, nowIso, nowIso]);
}

test('calculatePackagePrice — exact tier matches pay the tier price, no arithmetic', async () => {
  const db = await memDb();
  await seedPricing(db);
  for (const [n, price] of [[75, 12000], [100, 15000], [200, 24000]]) {
    const r = await calculatePackagePrice(db, n);
    assert.equal(r.ok, true);
    assert.equal(r.price, price);
    assert.equal(r.breakdown.additional, 0);
  }
});

test('calculatePackagePrice — 80 clients matches the spec\'s own worked example exactly (Rs.12,775)', async () => {
  const db = await memDb();
  await seedPricing(db);
  const r = await calculatePackagePrice(db, 80);
  assert.equal(r.ok, true);
  assert.equal(r.price, 12775);
  assert.equal(r.breakdown.base, 12000);
  assert.equal(r.breakdown.additionalClients, 5);
  assert.equal(r.breakdown.rate, 155);
  assert.equal(r.breakdown.additional, 775);
  assert.equal(r.basePackage.id, 'p75');
});

test('calculatePackagePrice — 105 clients matches the spec\'s own worked example exactly (Rs.15,775)', async () => {
  const db = await memDb();
  await seedPricing(db);
  const r = await calculatePackagePrice(db, 105);
  assert.equal(r.ok, true);
  assert.equal(r.price, 15775);
  assert.equal(r.breakdown.base, 15000);
  assert.equal(r.breakdown.additionalClients, 5);
  assert.equal(r.basePackage.id, 'p100');
});

test('calculatePackagePrice — a capacity at or below the smallest tier pays that tier\'s price as a floor', async () => {
  const db = await memDb();
  await seedPricing(db);
  const r = await calculatePackagePrice(db, 40);
  assert.equal(r.ok, true);
  assert.equal(r.price, 12000, '40 clients still pays the 75-tier floor price, no discount for wanting fewer');
});

test('calculatePackagePrice — a capacity beyond the largest configured rule is refused, never extrapolated', async () => {
  const db = await memDb();
  await seedPricing(db);
  const r = await calculatePackagePrice(db, 350);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'capacity_exceeds_configured_range');
});

test('calculatePackagePrice — rejects invalid capacity input (zero, negative, non-integer, non-numeric)', async () => {
  const db = await memDb();
  await seedPricing(db);
  for (const bad of [0, -5, 12.5, 'abc', null, undefined]) {
    const r = await calculatePackagePrice(db, bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_capacity');
  }
});

test('calculatePackagePrice — changing the configured additional-client rate changes future calculations (proves nothing is hardcoded)', async () => {
  const db = await memDb();
  await seedPricing(db, { rate: 999 });
  const r = await calculatePackagePrice(db, 80);
  assert.equal(r.price, 12000 + 5 * 999, 'must use the CONFIGURED rate, not a hardcoded 155');
});

test('calculatePackagePrice — no packages configured at all is a graceful, explicit failure', async () => {
  const db = await memDb();
  const r = await calculatePackagePrice(db, 80);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_packages_configured');
});

test('pricing versioning — an archived/superseded package version is excluded from getCurrentPackages', async () => {
  const db = await memDb();
  await seedPricing(db);
  // Simulate an admin price change: v1 superseded, v2 becomes current.
  await db.run(`UPDATE sk_packages SET effective_until = '2026-06-01T00:00:00Z' WHERE id = 'p75'`);
  await db.run(`INSERT INTO sk_packages (id, name, client_capacity, price, currency, duration_days, version, status, effective_from, created_at)
    VALUES ('p75v2', '75 Clients', 75, 13000, 'INR', 365, 2, 'active', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`);
  const current = await getCurrentPackages(db);
  const seventyFive = current.find((p) => p.client_capacity === 75);
  assert.equal(seventyFive.id, 'p75v2', 'the superseded v1 row must not be picked as current');
  assert.equal(seventyFive.price, 13000);

  const r = await calculatePackagePrice(db, 75);
  assert.equal(r.price, 13000, 'new purchases use the new price');
});

test('effectiveCostPerClient computes a simple per-client figure for the package UI', () => {
  assert.equal(effectiveCostPerClient(12775, 80), 159.69);
  assert.equal(effectiveCostPerClient(0, 0), 0, 'never divides by zero');
});
