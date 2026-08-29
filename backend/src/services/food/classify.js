// ============================================================
// SKOS FOOD ENGINE — CLASSIFY STAGE, COMPOSITE DETECTION  (Phase 3)
//
// Scope: the ONE piece of `classify` that Phase 3 needs to unblock composite
// routing (architecture §10, §27 Phase-3 row) — deciding whether a name
// phrase names a COMPOSITE dish (papdi chaat, chole bhature, roti dal, ...)
// that should be priced as summed components rather than "find the one row
// that best matches these tokens". Prep-state inference, the full feature-
// based `rank`, and LLM tie-breaks are LATER phases (§9, §27 Phase 6/8) and
// are not touched here.
//
// A fragment is `composite` when:
//   (a) it exact/substring-matches a curated `composite_map.json` alias, OR
//   (b) it matches a combo pattern (`X chawal/rice/bhature/pav`, `X with Y`)
//       AND no single DB row is a good enough direct match (the caller's
//       job — this module only classifies the TEXT, it never looks at
//       candidates).
// Simple foods are never marked composite by accident: (b) alone, without a
// composite_map hit, is reported as `kind:'composite', dish_key:null` so the
// caller can fall back to C4/semantic/direct rather than force a guess (see
// decompose.js, which only ever decomposes with a real dish_key).
//
// Overlay-driven, same graceful-degradation contract as plausibility.js: if
// composite_map.json can't be read, classifyComposite always returns
// `{ kind: 'unknown' }` — Phase 3 becomes a no-op, never a crash.
// ============================================================
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize as refNormalize } from '../foodEstimator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.resolve(HERE, '..', '..', '..', '..', 'ml', 'data', 'overlays', 'composite_map.json');

let _cfg;
let _loadTried = false;
let _aliasIndex = null;    // normalized alias -> dish_key
let _sortedAliases = null; // [{norm, dish_key}], longest-first, for substring matching

/** Returns the parsed overlay, or null if it can't be loaded. Cached. */
export function loadCompositeMap() {
  if (_loadTried) return _cfg ?? null;
  _loadTried = true;
  try {
    _cfg = JSON.parse(fs.readFileSync(OVERLAY, 'utf8'));
  } catch {
    _cfg = null; // degrade to no-op, same contract as plausibility.js
  }
  return _cfg ?? null;
}

/** Test-only: force a re-read of the overlay (e.g. after mocking fs). */
export function _resetCompositeMapCache() {
  _loadTried = false; _cfg = undefined; _aliasIndex = null; _sortedAliases = null;
}

function buildIndex(cfg) {
  const idx = new Map();
  const list = [];
  for (const [dishKey, dish] of Object.entries(cfg.dishes || {})) {
    for (const alias of dish.aliases || []) {
      const norm = refNormalize(alias);
      if (!norm) continue;
      idx.set(norm, dishKey);
      list.push({ norm, dish_key: dishKey });
    }
  }
  // Longest alias first so "chole bhature" is preferred over a shorter
  // alias that happens to be a substring of it.
  list.sort((a, b) => b.norm.length - a.norm.length);
  return { idx, list };
}

function ensureIndex() {
  const cfg = loadCompositeMap();
  if (!cfg) return null;
  if (!_aliasIndex) {
    const built = buildIndex(cfg);
    _aliasIndex = built.idx;
    _sortedAliases = built.list;
  }
  return { cfg, idx: _aliasIndex, list: _sortedAliases };
}

/** @param {string} phrase @returns {string[]} whitespace tokens of a normalized phrase */
function tokensOf(phrase) {
  const n = refNormalize(String(phrase || ''));
  return n ? n.split(' ').filter(Boolean) : [];
}

// A phrase "contains" an alias only on WORD boundaries (token subsequence
// containment), not raw substring — "dal" must never match inside "dalchini".
function containsAsWords(haystackTokens, needleTokens) {
  if (!needleTokens.length || needleTokens.length > haystackTokens.length) return false;
  for (let i = 0; i <= haystackTokens.length - needleTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < needleTokens.length; j++) {
      if (haystackTokens[i + j] !== needleTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Combo patterns from architecture §10: "X chawal/rice/bhature/pav", "X with Y".
// Deliberately does NOT fire on a bare dish word alone ("biryani" is not a
// combo pattern by itself — plenty of biryanis have a perfectly good single
// DB row, C1); it fires on the COMBINATION shape.
const COMBO_RE = /\b\w+\s+(chawal|chaval|rice|bhature|bhatura|pav)\b|\bwith\b/i;

/**
 * Classify a name phrase for composite routing. Pure text-in, no DB lookups.
 *
 * @param {string} namePhrase  the fragment's `name_phrase` (qty/unit already stripped)
 * @returns {{ kind: 'composite'|'unknown', dish_key: string|null, match: 'alias'|'combo_pattern'|null }}
 */
export function classifyComposite(namePhrase) {
  const phrase = String(namePhrase || '').trim();
  if (!phrase) return { kind: 'unknown', dish_key: null, match: null };

  const found = ensureIndex();
  if (found) {
    const norm = refNormalize(phrase);
    // 1. exact alias match
    if (found.idx.has(norm)) {
      return { kind: 'composite', dish_key: found.idx.get(norm), match: 'alias' };
    }
    // 2. word-boundary containment, longest alias wins
    const phraseTokens = tokensOf(phrase);
    for (const { norm: aliasNorm, dish_key } of found.list) {
      if (containsAsWords(phraseTokens, aliasNorm.split(' '))) {
        return { kind: 'composite', dish_key, match: 'alias' };
      }
    }
  }

  // 3. combo pattern, no curated template — caller decides the fallback
  // (semantic / C4 / direct); decompose.js will refuse to run without a
  // dish_key, so this can never force a bad decomposition.
  if (COMBO_RE.test(phrase)) {
    return { kind: 'composite', dish_key: null, match: 'combo_pattern' };
  }

  return { kind: 'unknown', dish_key: null, match: null };
}

/** @param {string} dishKey @returns {object|null} the composite_map entry, or null */
export function getCompositeDish(dishKey) {
  const cfg = loadCompositeMap();
  if (!cfg || !dishKey) return null;
  return cfg.dishes?.[dishKey] || null;
}
