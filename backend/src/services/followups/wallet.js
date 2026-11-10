// ============================================================
// AI COMMUNICATION -- PRICE BOOK, BALANCES AND THE USAGE LEDGER
//
// PRODUCTS AND TIERS. Each product the gym buys has its own balance (never
// one mixed "credit"), and calls come in QUALITY TIERS, each run by a
// different provider and priced from its own cost:
//
//   voice:premium    AI voice calls, most natural voice      (e.g. ElevenLabs)
//   voice:standard   AI voice calls, natural Indian voices   (e.g. Sarvam)
//   voice:basic      AI voice calls, low cost, routine calls (e.g. your own model)
//   agent:advanced   two-way AI conversations, most human    (e.g. ElevenLabs Agents)
//   agent:standard   two-way AI conversations, simple ones   (e.g. your own agent)
//   sms              SMS, by billable segment
//   whatsapp         WhatsApp business messages
// plus caller-line subscriptions (followup_line_terms).
//
// Tiers live in the founder's price book (name, tagline, provider, its own
// cost), so tiers can be added, renamed or moved to another provider from
// the admin console. A campaign picks a tier; the tier decides which engine
// speaks and which balance pays.
//
// PRICES RECOVER EVERY BILL. The price book holds what one unit really costs
// the platform, an infrastructure share, a margin and the tax treatment.
// Every pack shows cost, price and markup, and one sold below cost + margin
// is flagged. Orders keep the version they were sold at. The defaults are
// ESTIMATES from public 2026 price lists -- replace them with real invoices.
//
// THE LEDGER is append-only. A balance only changes together with a ledger
// row, inside one transaction, through a conditional UPDATE -- so a unit can
// never be spent twice or a balance driven below zero by concurrent work.
//   purchase  units in, with the pre-tax value paid for them
//   hold      a call in progress reserves capacity (pending)
//   release   the hold given back when the call ends
//   usage     settled consumption: charge_inr is the revenue it earned (at the
//             average value of the units left), cost_estimate what it cost us
//   refund    a provider-confirmed failure given back
// ============================================================
import { id, now } from '../../ids.js';

export const PLANS = ['voice', 'agent', 'sms', 'whatsapp', 'lines'];

export const DEFAULT_PRICE_BOOK = Object.freeze({
  currency: 'INR',
  margin_pct: 25,
  tax: { rate_pct: 18, inclusive: true, label: 'GST' },
  costs: {
    telephony_per_min: 1.2,       // Exotel outbound, per connected minute (pulse)
    message_chars_per_min: 600,   // characters spoken in a minute of a voice message
    sms_per_segment: 0.25,        // DLT SMS, per segment, all-in
    whatsapp_per_msg: 0.87,       // Meta, per marketing message (India) -- the dearer category
    whatsapp_platform_fee: 0.25,  // the provider's WhatsApp fee, per message
    line_per_month: 750,          // renting one caller number, per month
    infra_pct: 5,                 // SK OS servers, storage, support -- on top of provider cost
  },
  tiers: {
    voice: [
      { id: 'premium', name: 'Premium', tagline: 'Most natural, expressive voice. For renewals and important calls.', provider: 'elevenlabs', tts_per_1k_chars: 8.5 },
      { id: 'standard', name: 'Standard', tagline: 'Natural Indian voices. Great for everyday reminders.', provider: 'sarvam', tts_per_1k_chars: 2.0 },
      { id: 'basic', name: 'Basic', tagline: 'Clear and low-cost. Good for routine, less important calls.', provider: 'http', tts_per_1k_chars: 0.5 },
    ],
    agent: [
      { id: 'advanced', name: 'Advanced', tagline: 'Most human-like. Handles questions and objections.', provider: 'elevenlabs', agent_per_min: 9.5 },
      { id: 'standard', name: 'Standard', tagline: 'Capable conversations for simple check-ins.', provider: 'http', agent_per_min: 5 },
    ],
  },
  packs: [
    { id: 'voice_premium_300', plan: 'voice', tier: 'premium', name: '300 minutes', units: { 'voice:premium': 300 }, price: 2999 },
    { id: 'voice_premium_1200', plan: 'voice', tier: 'premium', name: '1,200 minutes', units: { 'voice:premium': 1200 }, price: 11999 },
    { id: 'voice_standard_300', plan: 'voice', tier: 'standard', name: '300 minutes', units: { 'voice:standard': 300 }, price: 1199 },
    { id: 'voice_standard_1200', plan: 'voice', tier: 'standard', name: '1,200 minutes', units: { 'voice:standard': 1200 }, price: 4499 },
    { id: 'voice_basic_500', plan: 'voice', tier: 'basic', name: '500 minutes', units: { 'voice:basic': 500 }, price: 1199 },
    { id: 'voice_basic_2000', plan: 'voice', tier: 'basic', name: '2,000 minutes', units: { 'voice:basic': 2000 }, price: 4699 },
    { id: 'agent_advanced_100', plan: 'agent', tier: 'advanced', name: '100 minutes', units: { 'agent:advanced': 100 }, price: 1699 },
    { id: 'agent_advanced_500', plan: 'agent', tier: 'advanced', name: '500 minutes', units: { 'agent:advanced': 500 }, price: 8499 },
    { id: 'agent_standard_100', plan: 'agent', tier: 'standard', name: '100 minutes', units: { 'agent:standard': 100 }, price: 999 },
    { id: 'sms_1000', plan: 'sms', name: '1,000 SMS', units: { sms: 1000 }, price: 449 },
    { id: 'sms_5000', plan: 'sms', name: '5,000 SMS', units: { sms: 5000 }, price: 1999 },
    { id: 'wa_500', plan: 'whatsapp', name: '500 messages', units: { whatsapp: 500 }, price: 899 },
    { id: 'wa_2000', plan: 'whatsapp', name: '2,000 messages', units: { whatsapp: 2000 }, price: 3499 },
    { id: 'line_30', plan: 'lines', name: '1 month', lines: 1, days: 30, price: 1199, max_quantity: 5 },
    { id: 'line_90', plan: 'lines', name: '3 months', lines: 1, days: 90, price: 3499, max_quantity: 5 },
  ],
  // A first taste, granted once per gym, so test calls work before buying.
  trial: { 'voice:standard': 3, 'agent:advanced': 2, sms: 3, whatsapp: 3 },
});

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
const r2 = (v) => Math.round(v * 100) / 100;
const err = (msg, status = 422) => Object.assign(new Error(msg), { status });
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);

/* ---------------- units ---------------- */

/** Every balance unit the price book defines, with how to show it. */
export function unitsOf(book = DEFAULT_PRICE_BOOK) {
  const out = [];
  for (const t of book.tiers?.voice || []) out.push({ key: `voice:${t.id}`, product: 'voice', tier: t.id, name: `${t.name} voice calls`, tier_name: t.name, tagline: t.tagline, provider: t.provider, short: 'minutes' });
  for (const t of book.tiers?.agent || []) out.push({ key: `agent:${t.id}`, product: 'agent', tier: t.id, name: `${t.name} AI conversations`, tier_name: t.name, tagline: t.tagline, provider: t.provider, short: 'minutes' });
  out.push({ key: 'sms', product: 'sms', tier: null, name: 'SMS', short: 'SMS' });
  out.push({ key: 'whatsapp', product: 'whatsapp', tier: null, name: 'WhatsApp messages', short: 'messages' });
  return out;
}
export const unitKeys = (book) => unitsOf(book).map((u) => u.key);
export const tierOf = (book, product, tierId) => (book.tiers?.[product] || []).find((t) => t.id === tierId) || null;

/* ---------------- the price book ---------------- */

/** What one unit costs the platform, per unit key. */
export function unitCosts(book = DEFAULT_PRICE_BOOK) {
  const c = { ...DEFAULT_PRICE_BOOK.costs, ...(book.costs || {}) };
  const infra = 1 + num(c.infra_pct) / 100;
  const out = {
    sms: r2(num(c.sms_per_segment) * infra),
    whatsapp: r2((num(c.whatsapp_per_msg) + num(c.whatsapp_platform_fee)) * infra),
    line_month: r2(num(c.line_per_month) * infra),
  };
  for (const t of book.tiers?.voice || []) out[`voice:${t.id}`] = r2((num(c.telephony_per_min) + num(t.tts_per_1k_chars) * num(c.message_chars_per_min) / 1000) * infra);
  for (const t of book.tiers?.agent || []) out[`agent:${t.id}`] = r2((num(t.agent_per_min) + num(c.telephony_per_min)) * infra);
  return out;
}

export function taxed(price, book = DEFAULT_PRICE_BOOK) {
  const rate = num(book.tax?.rate_pct, 18) / 100;
  const p = num(price);
  if (book.tax?.inclusive !== false) {
    const net = r2(p / (1 + rate));
    return { net, tax: r2(p - net), total: r2(p) };
  }
  return { net: r2(p), tax: r2(p * rate), total: r2(p * (1 + rate)) };
}

/** A pack's cost to the platform, its pre-tax price, and the markup over cost. */
export function evaluatePack(pack, book = DEFAULT_PRICE_BOOK, quantity = 1) {
  const u = unitCosts(book);
  const q = Math.max(1, Math.round(num(quantity, 1)));
  let cost = 0;
  for (const [unit, n] of Object.entries(pack.units || {})) cost += num(n) * num(u[unit]);
  if (pack.plan === 'lines') cost += num(pack.lines, 1) * u.line_month * (num(pack.days, 30) / 30);
  cost = r2(cost * q);
  const t = taxed(num(pack.price) * q, book);
  const floor = r2(cost * (1 + num(book.margin_pct, 25) / 100));
  return {
    cost, net: t.net, tax: t.tax, total: t.total, floor,
    markup_pct: cost > 0 ? Math.round(((t.net - cost) / cost) * 1000) / 10 : 0,
    profit: r2(t.net - cost),
    healthy: t.net >= floor,
  };
}

function cleanTiers(raw, product, costKey) {
  const list = (Array.isArray(raw) ? raw : DEFAULT_PRICE_BOOK.tiers[product]).slice(0, 6).map((t) => {
    const tid = slug(t.id);
    if (!tid) throw err(`Every ${product} tier needs an id`);
    const cost = num(t[costKey]);
    if (cost < 0 || cost > 10000) throw err(`Tier ${tid}: cost is out of range`);
    return { id: tid, name: String(t.name || tid).slice(0, 24), tagline: String(t.tagline || '').slice(0, 120), provider: slug(t.provider) || 'elevenlabs', [costKey]: cost, active: t.active !== false };
  });
  if (!list.length) throw err(`Keep at least one ${product} tier`);
  if (new Set(list.map((t) => t.id)).size !== list.length) throw err(`${product} tier ids must be unique`);
  return list;
}

/** Validate and clean a price book from the console. Throws on nonsense. */
export function cleanPriceBook(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const costs = {};
  for (const [k, v] of Object.entries(DEFAULT_PRICE_BOOK.costs)) {
    const n = num(b.costs?.[k], v);
    if (n < 0 || n > 100000) throw err(`Cost "${k}" is out of range`);
    costs[k] = n;
  }
  const margin = num(b.margin_pct, DEFAULT_PRICE_BOOK.margin_pct);
  if (margin < 0 || margin > 500) throw err('Margin is out of range');
  const rate = num(b.tax?.rate_pct, 18);
  if (rate < 0 || rate > 50) throw err('Tax rate is out of range');
  const tax = { rate_pct: rate, inclusive: b.tax?.inclusive !== false, label: String(b.tax?.label || 'GST').slice(0, 12) };
  const tiers = { voice: cleanTiers(b.tiers?.voice, 'voice', 'tts_per_1k_chars'), agent: cleanTiers(b.tiers?.agent, 'agent', 'agent_per_min') };
  const known = new Set(unitKeys({ tiers }));
  const packs = (Array.isArray(b.packs) ? b.packs : DEFAULT_PRICE_BOOK.packs).slice(0, 60).map((p) => {
    const plan = PLANS.includes(p.plan) ? p.plan : null;
    const pid = slug(p.id);
    if (!plan || !pid) throw err('Every pack needs an id and a product');
    const price = num(p.price);
    if (!(price >= 1 && price <= 1_000_000)) throw err(`Pack ${pid}: price is out of range`);
    const out = { id: pid, plan, name: String(p.name || pid).slice(0, 60), price, active: p.active !== false };
    if (plan === 'lines') {
      out.lines = Math.min(20, Math.max(1, Math.round(num(p.lines, 1))));
      out.days = Math.min(366, Math.max(1, Math.round(num(p.days, 30))));
      out.max_quantity = Math.min(20, Math.max(1, Math.round(num(p.max_quantity, 5))));
    } else {
      out.units = {};
      for (const [unit, v] of Object.entries(p.units || {})) {
        if (!known.has(unit)) throw err(`Pack ${pid}: "${unit}" is not a product`);
        const n = Math.round(num(v));
        if (n < 0 || n > 1_000_000) throw err(`Pack ${pid}: ${unit} is out of range`);
        if (n) out.units[unit] = n;
      }
      if (!Object.keys(out.units).length) throw err(`Pack ${pid} includes nothing`);
      const first = Object.keys(out.units)[0];
      if (first.includes(':')) out.tier = first.split(':')[1];
    }
    return out;
  });
  if (new Set(packs.map((p) => p.id)).size !== packs.length) throw err('Pack ids must be unique');
  const trial = {};
  for (const [unit, v] of Object.entries(b.trial || DEFAULT_PRICE_BOOK.trial)) {
    if (known.has(unit)) trial[unit] = Math.min(50, Math.max(0, Math.round(num(v))));
  }
  return { currency: 'INR', margin_pct: margin, tax, costs, tiers, packs, trial };
}

export async function getPriceBook(db) {
  const row = await db.q1('SELECT version, config_json FROM followup_price_versions ORDER BY version DESC LIMIT 1');
  const fallback = () => ({ version: 0, ...JSON.parse(JSON.stringify(DEFAULT_PRICE_BOOK)) });
  if (!row) return fallback();
  try { return { version: Number(row.version), ...cleanPriceBook(JSON.parse(row.config_json)) }; } catch { return fallback(); }
}

/** Save a new version. Earlier versions stay, so every order's price is explainable. */
export async function savePriceBook(db, raw, userId) {
  const book = cleanPriceBook(raw);
  for (let i = 0; i < 3; i++) {
    const top = await db.q1('SELECT MAX(version) AS v FROM followup_price_versions');
    const version = Number(top?.v || 0) + 1;
    try {
      await db.run('INSERT INTO followup_price_versions (id, version, config_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id('fpv'), version, JSON.stringify(book), userId || null, now()]);
      return { version, ...book };
    } catch (e) { if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e; }
  }
  throw err('Could not save the price book, try again', 409);
}

/**
 * Packs an owner can buy. Never exposes cost or margin. `available(product, tier)`
 * says if a tier is live (asked for tiered packs only); `selling` false closes all sales.
 */
export function catalogue(book, available = () => true, { selling = true } = {}) {
  return book.packs.filter((p) => p.active !== false).map((p) => {
    const t = taxed(p.price, book);
    const tier = p.tier ? tierOf(book, p.plan, p.tier) : null;
    return {
      id: p.id, plan: p.plan, name: p.name, price: p.price, currency: book.currency,
      net: t.net, tax: t.tax, total: t.total, tax_label: book.tax?.label || 'GST', tax_inclusive: book.tax?.inclusive !== false,
      units: p.units || null, lines: p.lines || null, days: p.days || null, max_quantity: p.max_quantity || 1,
      tier: p.tier || null, tier_name: tier?.name || null, tagline: tier?.tagline || null,
      // Sales closed (`off` mode) -> nothing is available; otherwise a tiered
      // pack also needs its tier active and its engine live.
      available: selling && (!tier || (tier.active !== false && available(p.plan, tier))),
    };
  });
}

/* ---------------- balances ---------------- */

/** Balances for every unit the price book knows (0 when never bought). */
export async function getWallet(db, orgId, book = null) {
  const rows = await db.q('SELECT unit, balance FROM followup_balances WHERE org_id = ?', [orgId]);
  const out = Object.fromEntries(unitKeys(book || DEFAULT_PRICE_BOOK).map((k) => [k, 0]));
  for (const r of rows) out[r.unit] = num(r.balance);
  return out;
}

/** Units on hold for calls still in progress. */
export async function pendingHolds(db, orgId) {
  // units_held is zeroed on settlement, so any job still holding units counts --
  // including a completed call still waiting for the provider to report its length.
  const rows = await db.q(`SELECT unit, SUM(units_held) AS held FROM followup_jobs WHERE org_id = ? AND units_held > 0 GROUP BY unit`, [orgId]);
  return Object.fromEntries(rows.map((r) => [r.unit, num(r.held)]));
}

async function ensureRow(t, orgId, unit) {
  const row = await t.q1('SELECT balance FROM followup_balances WHERE org_id = ? AND unit = ?', [orgId, unit]);
  if (row) return;
  try { await t.run('INSERT INTO followup_balances (org_id, unit, balance, value, updated_at) VALUES (?, ?, 0, 0, ?)', [orgId, unit, now()]); } catch (e) { if (!/UNIQUE|duplicate|PRIMARY/i.test(String(e.message))) throw e; }
}

const ledgerRow = (t, row) => t.run(
  `INSERT INTO followup_ledger (id, org_id, unit, delta, reason, job_id, order_id, rule_id, provider, provider_ref, charge_inr, cost_estimate, pricing_version, note, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id('fl'), row.orgId, row.unit, row.delta, row.reason, row.jobId || null, row.orderId || null, row.ruleId || null, row.provider || null,
    row.providerRef || null, r2(num(row.charge)), row.cost ?? null, row.pricingVersion ?? null, row.note || null, now()]);

const inTx = (db, orgId, tx, fn) => (tx ? fn(tx) : db.tx(fn, { orgId }));

/*
 * ONE JOB, ONE OF EACH MOVEMENT. Provider callbacks arrive twice, late and
 * concurrently (a retried webhook racing the sweep). Every function below
 * that moves money for a job first takes a row lock on that job (Postgres;
 * SQLite has a single writer already), so its "has this been done?" check
 * and its write cannot interleave with another. Underneath that, the
 * ux_followup_ledger_job_reason index makes a second hold / release / usage /
 * refund row for the same job impossible; if one is ever attempted, the
 * transaction rolls back whole and the caller sees "already done".
 */
async function lockJob(t, jobId) {
  if (jobId && t.driver === 'postgres') await t.q1('SELECT id FROM followup_jobs WHERE id = ? FOR UPDATE', [jobId]);
}
export const isDuplicateLedgerRow = (e) => e?.code === '23505' || /UNIQUE constraint failed: followup_ledger|ux_followup_ledger_job_reason|duplicate key/i.test(String(e?.message || ''));

/** Run a job's money movement; a duplicate-row collision means another delivery already did it. */
async function once(work, onDuplicate) {
  try { return await work(); } catch (e) { if (isDuplicateLedgerRow(e)) return onDuplicate(); throw e; }
}

async function add(t, orgId, unit, n, value) {
  await ensureRow(t, orgId, unit);
  await t.run('UPDATE followup_balances SET balance = balance + ?, value = value + ?, updated_at = ? WHERE org_id = ? AND unit = ?', [n, r2(value), now(), orgId, unit]);
}

/** Take n units at their average value. Returns the value taken, or null if short. */
async function take(t, orgId, unit, n) {
  const w = await t.q1('SELECT balance, value FROM followup_balances WHERE org_id = ? AND unit = ?', [orgId, unit]);
  const bal = num(w?.balance);
  if (!w || bal < n) return null;
  const value = bal > 0 ? r2(num(w.value) * (n / bal)) : 0;
  // GREATEST in Postgres, scalar MAX in SQLite -- picked by driver, never by
  // catching an error (a failed statement aborts a Postgres transaction).
  const greatest = t.driver === 'postgres' ? 'GREATEST' : 'MAX';
  const r = await t.run(`UPDATE followup_balances SET balance = balance - ?, value = ${greatest}(0, value - ?), updated_at = ? WHERE org_id = ? AND unit = ? AND balance >= ?`, [n, value, now(), orgId, unit, n]);
  return r.changes === 1 ? value : null;
}

/** Add units with the pre-tax value paid for them (0 for trials/adjustments). */
export async function creditUnits(db, orgId, units, { values = {}, reason, orderId = null, pricingVersion = null, note = null, tx = null } = {}) {
  return inTx(db, orgId, tx, async (t) => {
    for (const [unit, raw] of Object.entries(units || {})) {
      const n = num(raw);
      if (!n) continue;
      const v = r2(num(values[unit]));
      await add(t, orgId, unit, n, v);
      await ledgerRow(t, { orgId, unit, delta: n, reason, orderId, pricingVersion, charge: v, note });
    }
  });
}

/** Reserve capacity for a call about to be placed. False when short. */
export async function holdUnits(db, orgId, unit, n, { jobId, ruleId = null, tx = null } = {}) {
  return once(() => inTx(db, orgId, tx, async (t) => {
    await lockJob(t, jobId);
    if (await t.q1(`SELECT id FROM followup_ledger WHERE job_id = ? AND reason = 'hold' LIMIT 1`, [jobId])) return true;   // already held
    const value = await take(t, orgId, unit, n);
    if (value === null) return false;
    await ledgerRow(t, { orgId, unit, delta: -n, reason: 'hold', jobId, ruleId, charge: value, note: 'Reserved while the call is in progress' });
    await t.run('UPDATE followup_jobs SET units_held = ?, unit = ?, updated_at = ? WHERE id = ?', [n, unit, now(), jobId]);
    return true;
  }), () => true);
}

/**
 * Settle a call: give back its hold, then charge what it really used (up to
 * what is left). Idempotent per job: a second settle changes nothing.
 */
export async function settleJob(db, job, { used, cost = null, provider = null, providerRef = null, pricingVersion = null }) {
  return once(() => db.tx(async (t) => {
    await lockJob(t, job.id);
    const fresh = await t.q1('SELECT units_held, units, unit FROM followup_jobs WHERE id = ?', [job.id]);
    if (!fresh) return 0;
    const already = await t.q1(`SELECT id FROM followup_ledger WHERE job_id = ? AND reason IN ('usage','release') LIMIT 1`, [job.id]);
    if (already) return num(fresh.units);
    const unit = fresh.unit || job.unit;
    const held = num(fresh.units_held);
    if (held > 0) {
      const holdRow = await t.q1(`SELECT SUM(charge_inr) AS v FROM followup_ledger WHERE job_id = ? AND reason = 'hold'`, [job.id]);
      const heldValue = num(holdRow?.v);
      await add(t, job.org_id, unit, held, heldValue);
      await ledgerRow(t, { orgId: job.org_id, unit, delta: held, reason: 'release', jobId: job.id, ruleId: job.rule_id, charge: heldValue, note: 'Hold released' });
    }
    let charged = 0;
    let value = 0;
    const want = num(used);
    if (want > 0) {
      // Another job can spend from the same balance between the read and the
      // conditional take; when the take finds less than it read, read again.
      // The usage row always records exactly what was taken, so the ledger and
      // the balance can never disagree.
      for (let attempt = 0; attempt < 3; attempt++) {
        const w = await t.q1('SELECT balance FROM followup_balances WHERE org_id = ? AND unit = ?', [job.org_id, unit]);
        const can = Math.min(want, Math.max(0, num(w?.balance)));
        if (can <= 0) break;
        const v = await take(t, job.org_id, unit, can);
        if (v !== null) { charged = can; value = v; break; }
      }
      await ledgerRow(t, {
        orgId: job.org_id, unit, delta: -charged, reason: 'usage', jobId: job.id, ruleId: job.rule_id, provider, providerRef,
        charge: value, cost, pricingVersion, note: charged < want ? `Used ${want}; balance covered ${charged}` : null,
      });
    }
    await t.run('UPDATE followup_jobs SET units_held = 0, units = ?, updated_at = ? WHERE id = ?', [charged, now(), job.id]);
    return charged;
  }, { orgId: job.org_id }), async () => num((await db.q1('SELECT units FROM followup_jobs WHERE id = ?', [job.id]))?.units));
}

/** Charge a message on provider acceptance. False when short. */
export async function chargeMessage(db, job, unit, n, { cost = null, provider = null, pricingVersion = null } = {}) {
  return once(() => db.tx(async (t) => {
    await lockJob(t, job.id);
    if (await t.q1(`SELECT id FROM followup_ledger WHERE job_id = ? AND reason = 'usage' LIMIT 1`, [job.id])) return true;   // already charged
    const value = await take(t, job.org_id, unit, n);
    if (value === null) return false;
    await ledgerRow(t, { orgId: job.org_id, unit, delta: -n, reason: 'usage', jobId: job.id, ruleId: job.rule_id, provider, charge: value, cost, pricingVersion });
    await t.run('UPDATE followup_jobs SET units = ?, unit = ?, updated_at = ? WHERE id = ?', [n, unit, now(), job.id]);
    return true;
  }, { orgId: job.org_id }), () => true);
}

/**
 * A message is charged BEFORE it is handed to the provider (so nothing is sent
 * without capacity), which means its usage row is written before the provider
 * has given it a reference. Fill that one column in once the send returns, so
 * every usage row can be traced to the provider's record. Amounts are never
 * touched, and a reference already set is never overwritten.
 */
export async function attachProviderRef(db, jobId, providerRef) {
  if (!jobId || !providerRef) return;
  await db.run(`UPDATE followup_ledger SET provider_ref = ? WHERE job_id = ? AND reason = 'usage' AND provider_ref IS NULL`, [String(providerRef).slice(0, 200), jobId]);
}

/** A provider-confirmed failure: give a message's units and value back. Once. */
export async function refundJob(db, job, note) {
  return once(() => db.tx(async (t) => {
    await lockJob(t, job.id);
    const used = await t.q1(`SELECT unit, SUM(-delta) AS n, SUM(charge_inr) AS v, MAX(provider) AS provider, MAX(provider_ref) AS provider_ref, MAX(pricing_version) AS pricing_version
                               FROM followup_ledger WHERE job_id = ? AND reason = 'usage' GROUP BY unit`, [job.id]);
    const done = await t.q1(`SELECT id FROM followup_ledger WHERE job_id = ? AND reason = 'refund' LIMIT 1`, [job.id]);
    if (!used || done || num(used.n) <= 0) return false;
    await add(t, job.org_id, used.unit, num(used.n), num(used.v));
    await ledgerRow(t, {
      orgId: job.org_id, unit: used.unit, delta: num(used.n), reason: 'refund', jobId: job.id, ruleId: job.rule_id, charge: num(used.v), note,
      provider: used.provider, providerRef: used.provider_ref, pricingVersion: used.pricing_version === null || used.pricing_version === undefined ? null : num(used.pricing_version),
    });
    await t.run('UPDATE followup_jobs SET units = 0, updated_at = ? WHERE id = ?', [now(), job.id]);
    return true;
  }, { orgId: job.org_id }), () => false);
}

/** The once-per-gym trial units (no value: free). Idempotent. */
export async function grantTrialOnce(db, orgId) {
  const had = await db.q1(`SELECT id FROM followup_ledger WHERE org_id = ? AND reason = 'trial' LIMIT 1`, [orgId]);
  if (had) return false;
  const book = await getPriceBook(db);
  const units = Object.fromEntries(Object.entries(book.trial || {}).filter(([, v]) => num(v) > 0));
  // A marker row with a FIXED id makes the grant exactly-once even when two
  // first visits race (two tabs, a double fetch): the second insert hits the
  // primary key and its whole transaction, credits included, rolls back.
  const marker = `fltrial_${orgId}`.slice(0, 120);
  const configured = Object.keys(units).length > 0;
  return once(() => db.tx(async (t) => {
    await t.run(`INSERT INTO followup_ledger (id, org_id, unit, delta, reason, note, created_at) VALUES (?, ?, 'sms', 0, 'trial', ?, ?)`,
      [marker, orgId, configured ? 'Free test capacity granted' : 'No trial configured', now()]);
    if (configured) await creditUnits(db, orgId, units, { reason: 'trial', note: 'Free test capacity', tx: t });
    return configured;
  }, { orgId }), () => false);
}

/* ---------------- line capacity ---------------- */

export async function lineCapacity(db, orgId, at = new Date()) {
  const iso = at.toISOString();
  const rows = await db.q('SELECT lines, ends_at FROM followup_line_terms WHERE org_id = ? AND starts_at <= ? AND ends_at > ?', [orgId, iso, iso]);
  return { lines: rows.reduce((s, r) => s + num(r.lines), 0), until: rows.reduce((m, r) => (r.ends_at > m ? r.ends_at : m), '') || null };
}

export async function grantLines(tx, orgId, { lines, days, orderId }) {
  const start = new Date();
  await tx.run('INSERT INTO followup_line_terms (id, org_id, lines, starts_at, ends_at, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id('flt'), orgId, lines, start.toISOString(), new Date(start.getTime() + days * 86_400_000).toISOString(), orderId, now()]);
}

/* ---------------- reporting ---------------- */

/** Usage, spend and cost since `sinceIso`, per unit. */
export async function usageSince(db, orgId, sinceIso, book = null) {
  const rows = await db.q(
    `SELECT unit, reason, SUM(delta) AS d, SUM(charge_inr) AS v, SUM(COALESCE(cost_estimate, 0)) AS c
       FROM followup_ledger WHERE org_id = ? AND created_at >= ? AND reason IN ('usage','refund') GROUP BY unit, reason`, [orgId, sinceIso]);
  const out = Object.fromEntries(unitKeys(book || DEFAULT_PRICE_BOOK).map((u) => [u, { used: 0, spent: 0, cost: 0 }]));
  for (const r of rows) {
    if (!out[r.unit]) out[r.unit] = { used: 0, spent: 0, cost: 0 };
    const sign = r.reason === 'refund' ? -1 : 1;
    out[r.unit].used += sign * Math.abs(num(r.d));
    out[r.unit].spent = r2(out[r.unit].spent + sign * num(r.v));
    out[r.unit].cost = r2(out[r.unit].cost + sign * num(r.c));
  }
  return out;
}

export async function spentSince(db, orgId, sinceIso) {
  const u = await usageSince(db, orgId, sinceIso);
  return r2(Object.values(u).reduce((s, x) => s + x.spent, 0));
}

/** The unearned (deferred) value a gym holds. */
export async function unearnedValue(db, orgId) {
  const r = await db.q1('SELECT SUM(value) AS v FROM followup_balances WHERE org_id = ?', [orgId]);
  return r2(num(r?.v));
}
