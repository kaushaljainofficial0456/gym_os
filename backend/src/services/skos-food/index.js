import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ref from './foodEstimate.reference.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

const foodsPath = path.join(
  projectRoot,
  'ml',
  'data',
  'processed',
  'unified_food_db.json'
);

const aliasesPath = path.join(
  projectRoot,
  'ml',
  'data',
  'processed',
  'food_aliases.json'
);

const foods = JSON.parse(fs.readFileSync(foodsPath, 'utf8'));
const aliasesData = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));

export const foodSearch = new ref.FoodSearch(
  foods,
  aliasesData.aliases || {}
);

export const {
  FoodSearch,
  normalize,
  toGrams,
  densityFor,
  expectedState,
  moistureMismatch,
  adjustOil,
  fattyAcidSplit,
  scaleNutrition,
  listPortions,
  portionToGrams,
  canonicalPortion,
  effectiveDensity,
  OIL_LEVELS,
  OIL_FATTY_ACID_PROFILE,
  KCAL_PER_G_OIL,
  MAX_PLAUSIBLE_KCAL,
  VOLUME_PORTIONS,
  COUNT_PORTIONS,
  OBSERVED_SPREAD,
  SOURCE_RANK
} = ref;

export { foods, aliasesData };
