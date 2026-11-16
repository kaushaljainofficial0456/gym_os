// ============================================================
// USER CORRECTIONS — what a person changed about what the engine proposed.
// (Nutrition overhaul, Phase 2 / F9.)
//
// Every time the plate is logged with a different food than the engine
// proposed ("dal" -> Dal makhani), or a different amount for a food whose
// amount the engine had to ASSUME ("dal" with no amount -> 2 katoris), the
// difference is recorded in nutrition_corrections in the same transaction
// as the log: original and corrected values, who (org, client, user), when,
// from where, the engine's confidence in its proposal, and a review status.
// A quantity edit to a logged item is recorded the same way.
//
// FOUR KINDS OF CHANGE, KEPT APART
//
//   personal        a person's own corrections. Applied ONLY to that person's
//                   future descriptions, and only once repeated
//                   (MIN_PERSONAL_REPEATS), labelled on the item as
//                   "personalised". Never read for anyone else. One user's
//                   corrections can never change another user's numbers.
//   verified        measured catalogue data (IFCT / USDA / CNF / INDB rows):
//                   not changed by corrections at all.
//   admin-approved  a phrase -> food mapping a platform operator approved
//                   after seeing that at least MIN_DISTINCT_CLIENTS different
//                   people made the same swap (food_correction_approvals);
//                   or a shared AI estimate approved via food_data_reviews.
//   global          an admin-approved mapping, applied to everyone's
//                   descriptions and labelled as a reviewed mapping. Nothing
//                   becomes global without that approval.
//
// Corrections never edit a database row. A personal preference picks a
// different, existing food or amount; the numbers are still the catalogue's.
// ============================================================
'use strict';

import { id, now } from '../../ids.js';
import { parseFragment, plateItemFor } from '../foodEstimator.js';
import { normStaple } from '../food/staples.js';

/** A swap must be repeated this many times before it becomes a default. */
export const MIN_PERSONAL_REPEATS = 2;
/** Distinct people needed before a phrase -> food swap is shown for review. */
export const MIN_DISTINCT_CLIENTS = 3;
const LOOKBACK_DAYS = 180;

/** The food words of what was typed: "2 katori dal" -> "dal". */
export function phraseOf(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let name = null;
  try { name = parseFragment(raw)?.name || null; } catch { name = null; }
  const p = normStaple(name || raw).slice(0, 80);
  return p || null;
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The corrections one logged plate item implies, comparing the engine's
 * proposal (sent by the client as `proposed`) with what was logged.
 *   food_swap   a different food than proposed
 *   amount      the same food, at least 10% more or less, where the engine
 *               had ASSUMED the amount (a stated amount changed later is
 *               the person eating a different amount, not a correction)
 * @returns {Array<{kind, phrase, original, corrected, confidence}>}
 */
export function detectCorrections(it, n) {
  const p = it?.proposed;
  if (!p) return [];
  const phrase = phraseOf(p.matched_from || p.name);
  if (!phrase) return [];
  const original = {
    source_id: p.source_id ?? null, staple_key: p.staple_key ?? null, name: p.name ?? null,
    grams: num(p.grams), qty: num(p.qty), unit: p.unit ?? null, calories: num(p.calories), assumed: !!p.assumed,
  };
  const corrected = {
    source_id: it.source_id ?? null, staple_key: it.staple_key ?? null, name: it.name ?? null,
    grams: num(n?.grams ?? it.grams), qty: num(it.quantity), unit: it.unit ?? null, calories: num(n?.calories ?? it.calories),
  };
  const conf = ['high', 'medium', 'low', 'unreliable'].includes(p.confidence) ? p.confidence : null;
  if (original.source_id && corrected.source_id && original.source_id !== corrected.source_id) {
    return [{ kind: 'food_swap', phrase, original, corrected, confidence: conf }];
  }
  if (original.assumed && original.source_id && original.source_id === corrected.source_id
      && original.grams > 0 && corrected.grams > 0 && Math.abs(corrected.grams / original.grams - 1) >= 0.1) {
    return [{ kind: 'amount', phrase, original, corrected, confidence: conf }];
  }
  return [];
}

/** Insert correction rows (inside the caller's transaction). */
export async function recordCorrections(tx, { orgId, clientId, userId = null, source, mealLogId = null, corrections }) {
  if (!orgId || !clientId || !corrections?.length) return 0;
  for (const c of corrections) {
    await tx.run(
      `INSERT INTO nutrition_corrections (id, org_id, client_id, user_id, phrase, kind, original_json, corrected_json,
                                          source, confidence, scope, review_status, meal_log_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'personal', 'unreviewed', ?, ?)`,
      [id('ncor'), orgId, clientId, userId, c.phrase, c.kind, JSON.stringify(c.original), JSON.stringify(c.corrected),
       source, c.confidence ?? null, mealLogId, now()]);
  }
  return corrections.length;
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * One person's learned preferences, by phrase. Reads ONLY that client's own
 * rows -- the query is the isolation boundary, and RLS scopes the org.
 *   swap    the food they switched this phrase to, if the LATEST swap's
 *           target was chosen at least MIN_PERSONAL_REPEATS times
 *   amount  per food: the median amount they set when the engine assumed
 *           one, once they have done so MIN_PERSONAL_REPEATS times
 */
export async function personalPreferences(db, clientId, { since = null } = {}) {
  const from = since || new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const rows = await db.q(
    `SELECT phrase, kind, original_json, corrected_json, created_at
       FROM nutrition_corrections
      WHERE client_id = ? AND source = 'plate' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 500`, [clientId, from]);
  const prefs = new Map();
  for (const r of rows) {
    const corrected = parse(r.corrected_json);
    if (!corrected) continue;
    const p = prefs.get(r.phrase) || { swaps: [], amounts: new Map() };
    if (r.kind === 'food_swap' && corrected.source_id) p.swaps.push(corrected);
    if (r.kind === 'amount' && corrected.source_id && corrected.grams > 0) {
      const list = p.amounts.get(corrected.source_id) || [];
      if (list.length < 5) list.push(corrected);       // the five most recent
      p.amounts.set(corrected.source_id, list);
    }
    prefs.set(r.phrase, p);
  }
  const out = new Map();
  for (const [phrase, p] of prefs) {
    const entry = {};
    if (p.swaps.length) {
      const latest = p.swaps[0];
      const times = p.swaps.filter((s) => s.source_id === latest.source_id).length;
      if (times >= MIN_PERSONAL_REPEATS) entry.swap = { ...latest, times };
    }
    const amounts = {};
    for (const [sid, list] of p.amounts) {
      if (list.length >= MIN_PERSONAL_REPEATS) {
        amounts[sid] = { grams: Math.round(median(list.map((x) => x.grams)) * 10) / 10, times: list.length, unit: list[0].unit, qty: list[0].qty };
      }
    }
    if (Object.keys(amounts).length) entry.amounts = amounts;
    if (entry.swap || entry.amounts) out.set(phrase, entry);
  }
  return out;
}

/** Admin-approved phrase -> food mappings, applied for everyone. */
export async function approvedMappings(db) {
  const rows = await db.q(
    `SELECT phrase, source_id, staple_key, name FROM food_correction_approvals WHERE status = 'approved' ORDER BY approved_at DESC`);
  const out = new Map();
  for (const r of rows) if (!out.has(r.phrase)) out.set(r.phrase, r);
  return out;
}

const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;

/** Re-price a plate item at its current unit and quantity. */
function repriced(item) {
  const u = (item.units || []).find((x) => x.key === item.unit_key) || item.units?.[0];
  const grams = r1((u?.grams || 0) * (Number(item.qty) || 0));
  const f = grams / 100;
  const p = item.per100 || {};
  return { ...item, grams, calories: Math.round((p.calories || 0) * f), protein: r1((p.protein || 0) * f), carbs: r1((p.carbs || 0) * f), fat: r1((p.fat || 0) * f) };
}

/** `next` at the amount `item` had: same unit label if it has one, else grams. */
function keepAmount(item, next) {
  const old = (item.units || []).find((u) => u.key === item.unit_key) || item.units?.[0];
  const same = old && next.units.find((u) => u.label === old.label);
  if (same) return repriced({ ...next, unit_key: same.key, qty: item.qty });
  const g = next.units.find((u) => u.key === 'g');
  const grams = Number(item.grams) || (old ? old.grams * item.qty : 0);
  if (g && grams > 0) return repriced({ ...next, unit_key: 'g', qty: Math.round(grams) });
  return repriced(next);
}

/** `item` set to `grams`, in the unit the person used if it fits, else g. */
function atGrams(item, pref) {
  const u = pref.unit && item.units.find((x) => x.label === pref.unit && x.grams > 0);
  if (u && pref.qty > 0 && Math.abs(u.grams * pref.qty - pref.grams) <= pref.grams * 0.05) {
    return repriced({ ...item, unit_key: u.key, qty: pref.qty });
  }
  const g = item.units.find((x) => x.key === 'g');
  return g ? repriced({ ...item, unit_key: 'g', qty: Math.round(pref.grams) }) : item;
}

/**
 * Apply admin-approved mappings (everyone) and then this person's own
 * learned preferences to a describeMeal() result. Every changed item says
 * what was changed and why and keeps the engine's original as its first
 * alternative (one tap back). The client snapshots each item AS SHOWN
 * (`proposed`), so accepting a default records nothing new, while switching
 * back to the engine's food records that reversal -- and the latest swap
 * then no longer has the repeats a default needs, so the default ends.
 */
export function applyCorrections(described, { personal = new Map(), approved = new Map() } = {}) {
  if (!described?.items?.length || (!personal.size && !approved.size)) return described;
  const items = described.items.map((item) => {
    const phrase = phraseOf(item.matched_from || item.name);
    if (!phrase) return item;
    let out = item;
    const notes = [];
    const swapTo = (target, note) => {
      if (!target?.source_id || target.source_id === out.source_id) return;
      const next = plateItemFor(target.source_id, { stapleKey: target.staple_key || null });
      if (!next) return;
      const kept = keepAmount(out, next);
      out = {
        ...kept,
        matched_from: item.matched_from,
        assumed: item.assumed,
        alternatives: [{ source_id: out.source_id, staple_key: out.staple_key, name: out.name },
          ...(kept.alternatives || []).filter((a) => a.source_id !== out.source_id)].slice(0, 3),
      };
      notes.push(note);
    };
    const mapped = approved.get(phrase);
    if (mapped) swapTo(mapped, { kind: 'approved_mapping', scope: 'global', note: `“${phrase}” is usually ${mapped.name || 'this food'} (reviewed)` });
    const mine = personal.get(phrase);
    if (mine?.swap) swapTo(mine.swap, { kind: 'food_swap', scope: 'personal', note: `You usually log “${phrase}” as ${mine.swap.name} (${mine.swap.times}×)` });
    const amount = mine?.amounts?.[out.source_id];
    if (amount && out.assumed) {
      out = { ...atGrams(out, amount), assumed: false };
      notes.push({ kind: 'amount', scope: 'personal', note: `Your usual amount (${amount.times} times)` });
    }
    if (!notes.length) return item;
    return { ...out, personalized: notes };
  });
  const total = items.reduce((t, it) => ({
    calories: t.calories + (it.calories || 0), protein: r1(t.protein + (it.protein || 0)),
    carbs: r1(t.carbs + (it.carbs || 0)), fat: r1(t.fat + (it.fat || 0)),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return { ...described, items, total };
}

/**
 * Platform view (SUPER_ADMIN): phrase -> food swaps made by at least
 * MIN_DISTINCT_CLIENTS different people. Counts only -- never who, never
 * which gym -- and phrases below the threshold are not shown at all.
 */
export async function correctionCandidates(db, { limit = 50 } = {}) {
  const rows = await db.q(
    `SELECT phrase, corrected_json, client_id FROM nutrition_corrections WHERE kind = 'food_swap' ORDER BY created_at DESC LIMIT 20000`);
  const groups = new Map();
  for (const r of rows) {
    const c = parse(r.corrected_json);
    if (!c?.source_id) continue;
    const key = `${r.phrase}\u0000${c.source_id}`;
    const g = groups.get(key) || { phrase: r.phrase, source_id: c.source_id, staple_key: c.staple_key ?? null, name: c.name, clients: new Set(), corrections: 0 };
    g.clients.add(r.client_id);
    g.corrections += 1;
    groups.set(key, g);
  }
  const approved = await approvedMappings(db);
  return [...groups.values()]
    .filter((g) => g.clients.size >= MIN_DISTINCT_CLIENTS)
    .map((g) => ({
      phrase: g.phrase, source_id: g.source_id, staple_key: g.staple_key, name: g.name,
      distinct_clients: g.clients.size, corrections: g.corrections,
      approved: approved.get(g.phrase)?.source_id === g.source_id,
    }))
    .sort((a, b) => b.distinct_clients - a.distinct_clients || b.corrections - a.corrections)
    .slice(0, limit);
}

/** Approve a candidate mapping for everyone (SUPER_ADMIN). */
export async function approveMapping(db, { phrase, sourceId, reviewerId }) {
  const cand = (await correctionCandidates(db, { limit: 1000 })).find((c) => c.phrase === phrase && c.source_id === sourceId);
  if (!cand) return { ok: false, error: `No candidate with at least ${MIN_DISTINCT_CLIENTS} distinct people for that phrase and food` };
  if (!plateItemFor(sourceId, { stapleKey: cand.staple_key })) return { ok: false, error: 'That food is not in the catalogue' };
  await db.tx(async (tx) => {
    await tx.run(
      `UPDATE food_correction_approvals SET status = 'superseded', revoked_by = ?, revoked_at = ? WHERE phrase = ? AND status = 'approved'`,
      [reviewerId, now(), phrase]);
    await tx.run(
      `INSERT INTO food_correction_approvals (id, phrase, source_id, staple_key, name, distinct_clients, status, approved_by, approved_at)
       VALUES (?,?,?,?,?,?, 'approved', ?, ?)`,
      [id('fca'), phrase, sourceId, cand.staple_key, cand.name, cand.distinct_clients, reviewerId, now()]);
  });
  return { ok: true, mapping: { phrase, source_id: sourceId, name: cand.name, distinct_clients: cand.distinct_clients } };
}

/** Withdraw an approved mapping (SUPER_ADMIN). Personal corrections are untouched. */
export async function revokeMapping(db, { phrase, reviewerId }) {
  const r = await db.run(
    `UPDATE food_correction_approvals SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE phrase = ? AND status = 'approved'`,
    [reviewerId, now(), phrase]);
  return { ok: r.changes > 0 };
}
