/**
 * WHAT 7,500 kg ACTUALLY FEELS LIKE.
 *
 * Session volume is the number members care about and the one they have no
 * intuition for. "12,480 kg" is a score, not a sensation. "about three
 * cars" is a sensation, and it is the same fact.
 *
 * THE COMPARISON IS EXACT, NOT DECORATIVE. Volume is sets x reps x weight
 * -- the total mass moved across a session -- so "3.1 x a hatchback" means
 * the mass genuinely adds up to 3.1 hatchbacks. The wording throughout says
 * MOVED rather than lifted-in-one-go, because that is what happened.
 *
 * THE ARTWORK IS LUCIDE, NOT HAND-DRAWN. A first pass drew these
 * silhouettes by hand and they looked it -- the piano read as a crate, the
 * whale as a fish. lucide-react is already a dependency of this app, is
 * ISC-licensed, tree-shakes per icon, and is drawn by people who do this
 * properly. The object list below is therefore chosen partly for what
 * Lucide draws WELL: every rung is a real, instantly recognisable machine
 * or appliance, and nothing needs a caption to be identified.
 *
 * Nothing is fetched. These compile to inline SVG in our own bundle, which
 * is the only kind of image this app can show -- the CSP is script-src
 * 'self' with no external image host -- and it means each object inherits
 * the current theme's accent with no second asset for dark mode.
 *
 * MASSES ARE REAL and deliberately typical-not-flattering. A 40-ft shipping
 * container maxes out at 30,480 kg; a 737-800 weighs about 41 t empty; a
 * grand piano is 300-550 kg. Rounding these up would inflate every
 * member's comparison, which is the one thing a motivational number must
 * not do.
 */
import {
  Dumbbell, Refrigerator, Piano, Car, Tractor, Bus, Container, Plane, TrainFront,
} from 'lucide-react';

/* Ascending, each rung roughly 2.5-4x the last so the multiplier never
   reads as either "0.4 of" or "372". `mass` is KG -- the canonical storage
   unit -- so the ratio is identical whether the member reads kilos or
   pounds. */
export const MASS_OBJECTS = [
  { key: 'dumbbell',  mass: 20,     Icon: Dumbbell,     one: 'a 20 kg dumbbell',  many: '20 kg dumbbells' },
  { key: 'fridge',    mass: 120,    Icon: Refrigerator, one: 'a fridge-freezer',  many: 'fridge-freezers' },
  { key: 'piano',     mass: 450,    Icon: Piano,        one: 'a grand piano',     many: 'grand pianos' },
  { key: 'car',       mass: 1200,   Icon: Car,          one: 'a hatchback car',   many: 'hatchback cars' },
  { key: 'tractor',   mass: 4000,   Icon: Tractor,      one: 'a farm tractor',    many: 'farm tractors' },
  { key: 'bus',       mass: 12000,  Icon: Bus,          one: 'a city bus',        many: 'city buses' },
  { key: 'container', mass: 30000,  Icon: Container,    one: 'a loaded shipping container', many: 'loaded shipping containers' },
  { key: 'plane',     mass: 41000,  Icon: Plane,        one: 'a passenger jet',   many: 'passenger jets' },
  { key: 'train',     mass: 120000, Icon: TrainFront,   one: 'a locomotive',      many: 'locomotives' },
];

/**
 * Pick the object that makes the best sentence.
 *
 * The heaviest object the volume clears at least once -- so the count is
 * always >= 1 and, given the spacing above, never absurdly large. "0.4 of
 * an elephant" and "372 dumbbells" are both true and both useless; this
 * returns neither.
 *
 * Under the lightest rung it returns null and the caller shows nothing. A
 * 12 kg session does not need to be told it moved half a dumbbell.
 */
export function massEquivalent(kg) {
  const v = Number(kg);
  if (!Number.isFinite(v) || v < MASS_OBJECTS[0].mass) return null;
  let pick = MASS_OBJECTS[0];
  for (const o of MASS_OBJECTS) if (v >= o.mass) pick = o;
  const count = v / pick.mass;
  return {
    ...pick,
    count,
    // One decimal below 10 (2.8 cars reads precisely); whole numbers above
    // that, where the decimal is noise.
    countLabel: count >= 10 ? String(Math.round(count)) : (Math.round(count * 10) / 10).toFixed(1),
    // "1.0 x a hatchback car" / "3.4 x hatchback cars" -- pluralise on what
    // is actually SHOWN, so 1.96 rounding to "2.0" does not say "a car".
    label: count >= 1.95 ? pick.many : pick.one,
  };
}

/**
 * The object itself. `strokeWidth` is dialled down from Lucide's default 2
 * because these render 2-3x larger than an icon normally does, and a 2 px
 * stroke scaled to 56 px reads as heavy and cartoonish.
 */
export default function MassObject({ shape, size = 52, strokeWidth = 1.4, className = '', style }) {
  const found = MASS_OBJECTS.find((o) => o.key === shape);
  if (!found) return null;
  const { Icon } = found;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      absoluteStrokeWidth
      aria-hidden="true"
      className={className}
      style={style}
    />
  );
}
