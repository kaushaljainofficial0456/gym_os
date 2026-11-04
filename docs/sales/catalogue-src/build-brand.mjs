// Writes the BARBELL wordmark and badge as standalone SVGs, from the app's own
// geometry (frontend/src/components/brand/wordmarkPaths.js and BrandMark.jsx).
import { writeFileSync } from 'node:fs';
import { CAP_HEIGHT, INK_LEFT, INK_WIDTH, LETTERS } from '../../../frontend/src/components/brand/wordmarkPaths.js';
const PAD = 40;
const wordmark = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${INK_LEFT - 10} ${-PAD} ${INK_WIDTH + 20} ${CAP_HEIGHT + 2 * PAD}">${LETTERS.map((l) => `<path transform="translate(${l.x} 0)" d="${l.d}" fill="${fill}"/>`).join('')}</svg>`;
const STROKE = 7.2, BADGE = 240, RING_R = (BADGE - STROKE) / 2, BAR = 144, c = BADGE / 2;
const PLATES = [{ x: 36, w: 10, h: 96 }, { x: 51, w: 9, h: 64 }];
const badge = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BADGE} ${BADGE}"><circle cx="${c}" cy="${c}" r="${RING_R}" fill="none" stroke="${fill}" stroke-width="${STROKE}"/><rect x="${c - BAR / 2}" y="${c - STROKE / 2}" width="${BAR}" height="${STROKE}" fill="${fill}"/>${PLATES.flatMap((p) => [-1, 1].map((s) => `<rect x="${c + s * p.x - p.w / 2}" y="${c - p.h / 2}" width="${p.w}" height="${p.h}" rx="2" fill="${fill}"/>`)).join('')}</svg>`;
for (const [name, fill] of [['blush', '#FFDFDD'], ['ink', '#1E1714'], ['platinum', '#B4C2CE']]) {
  writeFileSync(new URL(`./assets/wordmark-${name}.svg`, import.meta.url), wordmark(fill));
  writeFileSync(new URL(`./assets/badge-${name}.svg`, import.meta.url), badge(fill));
}
console.log('brand assets written');
