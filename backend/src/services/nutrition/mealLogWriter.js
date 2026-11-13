// ============================================================
// MEAL LOG WRITER — the one place food logs are written from a client
// request. Shared by POST /me/nutrition/log-batch (the plate) and
// POST /nutrition/clients/:id/meals/log (the classic sheet), so the two can
// never drift on the three guarantees this file exists to keep:
//
//   1. IDEMPOTENT. A request id (client-generated, reused on retry) is
//      written to meal_log_requests in the SAME transaction as the logs.
//      A retry of a request that already succeeded returns the stored
//      response and writes nothing; two concurrent copies race on the
//      primary key and exactly one wins.
//   2. SERVER-PRICED. A database-matched item is re-priced here from its
//      source_id and grams (services/nutrition/provenance.js); the client's
//      numbers are a cross-check, not the record.
//   3. PROVENANCE. Every row records where its numbers came from, the grams,
//      and the fibre / sugar / sodium that used to be thrown away.
//
// All-or-nothing: half a meal in the log is worse than none, because the
// person sees "logged" and stops checking.
// ============================================================
'use strict';

import { id, now } from '../../ids.js';
import { resolveLoggedNutrition } from './provenance.js';

// 'ai' is the older photo/text estimate flow; it was always stored as an
// estimate with its provider, and still is.
const ESTIMATED = new Set(['ai', 'ai_estimated', 'ai_estimated_user_adjusted', 'knn_estimated']);

export function isUniqueViolation(e) {
  return e?.code === '23505' || /UNIQUE constraint failed|duplicate key value/i.test(String(e?.message || ''));
}

async function storedResponse(db, clientId, requestId) {
  const row = await db.q1(
    'SELECT response_json FROM meal_log_requests WHERE client_id = ? AND request_id = ?',
    [clientId, requestId]);
  if (!row || !row.response_json) return null;
  try { return JSON.parse(row.response_json); } catch { return null; }
}

/**
 * @param {object} db
 * @param {{clientId:string, date:string, slot:string, items:object[],
 *          requestId?:string|null, excluded?:string[], eaten?:boolean,
 *          mealId?:string|null}} opts
 * @returns {Promise<{replayed:boolean, response:object}>}
 */
export async function writeMealLogs(db, { clientId, date, slot, items, requestId = null, excluded = [], eaten = true, mealId = null }) {
  if (requestId) {
    const prior = await storedResponse(db, clientId, requestId);
    if (prior) return { replayed: true, response: prior };
  }
  const reqId = requestId || id('mlr');
  const ids = [];
  const priced = items.map((it) => ({ it, n: resolveLoggedNutrition(it) }));
  const response = {
    ids,
    date,
    slot,
    request_id: reqId,
    // What the server stored vs what the client sent, per item, so a UI
    // that showed a stale number can correct itself rather than disagree.
    items: [],
    excluded,
  };

  try {
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO meal_log_requests (client_id, request_id, created_at, response_json, excluded_json)
         VALUES (?,?,?,?,?)`,
        [clientId, reqId, now(), null, excluded.length ? JSON.stringify(excluded) : null]);
      for (const { it, n } of priced) {
        const lId = id('mlg');
        ids.push(lId);
        const isEst = ESTIMATED.has(it.source) || it.estimate === true;
        await tx.run(
          `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat,
                                  eaten, source, estimate, ai_provider, ai_model, ai_confidence, quantity, unit,
                                  nutrition_source, source_id, grams, fiber, sugar, sodium, confidence, request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [lId, clientId, mealId, date, slot, it.name, n.calories, n.protein, n.carbs, n.fat,
           eaten ? 1 : 0, it.source || 'manual', isEst ? 1 : 0,
           isEst ? (it.ai_provider ?? null) : null,
           isEst ? (it.ai_model ?? null) : null,
           isEst ? (it.confidence ?? null) : null,
           it.quantity == null ? null : Math.round(Number(it.quantity) * 10) / 10, it.unit ?? null,
           n.nutrition_source, n.source_id, n.grams, n.fiber, n.sugar, n.sodium,
           it.confidence ?? null, reqId]);
        response.items.push({
          id: lId, name: it.name, calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat,
          nutrition_source: n.nutrition_source, repriced: n.repriced,
        });
      }
      await tx.run(
        'UPDATE meal_log_requests SET response_json = ? WHERE client_id = ? AND request_id = ?',
        [JSON.stringify(response), clientId, reqId]);
    });
  } catch (e) {
    // A concurrent copy of the same request committed first: hand back what
    // it stored, exactly as a sequential retry would get.
    if (requestId && isUniqueViolation(e)) {
      const prior = await storedResponse(db, clientId, requestId);
      if (prior) return { replayed: true, response: prior };
    }
    throw e;
  }
  return { replayed: false, response };
}
