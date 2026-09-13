#!/usr/bin/env node
/**
 * Bundle budget gate. Run after `vite build`:
 *
 *   npm run build && npm run check:bundle
 *
 * Measures what a browser actually downloads, gzipped, and fails if it grows
 * past the budget:
 *
 *   initial JS    the entry script plus every chunk index.html modulepreloads
 *                 -- the cost of the first paint on EVERY route, including the
 *                 login screen a signed-out visitor sees
 *   initial CSS   the stylesheets index.html links
 *   route chunk   the largest lazily loaded chunk not explicitly listed below
 *   named heavy   three.js and recharts are big on purpose and must stay lazy;
 *                 each has its own ceiling and must never be preloaded
 *
 * Budgets sit a little above the measured size so ordinary work passes and a
 * real regression -- a heavy library pulled into the entry, a page that
 * doubles -- does not. When a budget fails, find out what grew before
 * raising the number.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const KB = 1024;
// Measured on the build that introduced this gate: initial JS 84.3 kB
// (down from 140.3 kB once the signed-in shells went lazy), CSS 17.3 kB,
// largest route chunk 44.1 kB (the 3D stage), three 185.5 kB, charts 104.5 kB.
const BUDGET = {
  initialJs: 95 * KB,
  initialCss: 20 * KB,
  routeChunk: 50 * KB,
  heavy: { 'three.module': 200 * KB, charts: 115 * KB },
};

const gz = (file) => zlib.gzipSync(fs.readFileSync(path.join(DIST, file))).length;
const kb = (n) => `${(n / KB).toFixed(1)} kB`;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`check-bundle: no build at ${DIST} -- run \`npm run build\` first.`);
  process.exit(2);
}

const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const refs = (re) => [...html.matchAll(re)].map((m) => m[1].replace(/^\//, ''));
const initialJs = [...new Set([
  ...refs(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g),
  ...refs(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
])];
const initialCss = refs(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g);

const allJs = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`);
const heavyName = (file) => Object.keys(BUDGET.heavy).find((name) => path.basename(file).startsWith(`${name}-`));

const failures = [];
const rows = [];
const check = (label, size, budget) => {
  const ok = size <= budget;
  rows.push([ok ? 'ok  ' : 'FAIL', label, kb(size), kb(budget)]);
  if (!ok) failures.push(label);
};

check(`initial JS (${initialJs.length} files)`, initialJs.reduce((s, f) => s + gz(f), 0), BUDGET.initialJs);
check(`initial CSS (${initialCss.length} files)`, initialCss.reduce((s, f) => s + gz(f), 0), BUDGET.initialCss);

for (const file of initialJs) {
  const name = heavyName(file);
  if (name) {
    rows.push(['FAIL', `${name} is preloaded on first paint`, path.basename(file), 'must be lazy']);
    failures.push(`${name} preloaded`);
  }
}

const lazy = allJs.filter((f) => !initialJs.includes(f));
for (const [name, budget] of Object.entries(BUDGET.heavy)) {
  const file = lazy.find((f) => heavyName(f) === name);
  if (file) check(`${name} (lazy)`, gz(file), budget);
}
const routeChunks = lazy.filter((f) => !heavyName(f)).map((f) => [f, gz(f)]).sort((a, b) => b[1] - a[1]);
if (routeChunks.length) {
  const [file, size] = routeChunks[0];
  check(`largest route chunk (${path.basename(file)})`, size, BUDGET.routeChunk);
}

const width = Math.max(...rows.map((r) => r[1].length));
for (const [status, label, size, budget] of rows) {
  console.log(`${status}  ${label.padEnd(width)}  ${size.padStart(10)}  / ${budget}`);
}
if (failures.length) {
  console.error(`\nBundle budget exceeded: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll bundle budgets met.');
