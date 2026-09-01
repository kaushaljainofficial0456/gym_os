// ============================================================
// SKOS FOOD ENGINE — barrel
//
// The canonical import surface. Prefer `import { … } from '../services/food/index.js'`
// over reaching into `foodEstimator.js` or (retired) `skos-food/`.
//
//   engine   — canonical entry points + legacy-named primitives + `foodSearch`
//   pipeline — the staged IR pipeline (Phase 1: normalize + segment real, rest scaffolded)
//   irTypes  — IR typedefs + pure constructors/guards
// ============================================================
'use strict';

export * from './engine.js';
export * as pipeline from './pipeline.js';
export * as irTypes from './types.js';
