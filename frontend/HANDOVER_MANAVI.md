# Handover — frontend, `ui-manavi`

**From:** Sambhav (ML) · **Branch:** `ui-manavi` · **Companion doc:** `frontend/DESIGN_SYSTEM.md`

This branch changed the palette, the typefaces, the icon approach, and wired
both ML models into the app. Read §1–§3 before writing code; §4 onward is
reference you can come back to.

---

## 1. Get it running

```bash
git pull origin ui-manavi

# Frontend deps CHANGED — this is not optional, the app will not build without it
cd frontend && npm install

# Backend deps (only if you have not installed them before)
cd ../backend && npm install
```

Node 24 / npm 10 is what this was built on. Older Node may fail on
`node:sqlite`, which the dev database uses.

### Two terminals, both needed

```bash
# terminal 1 — API on :4000
cd backend && npm run dev
```

```bash
# terminal 2 — app on :5173
cd frontend && npm run dev
```

**Use `npm run dev`, not `npm start`, for the backend.** `dev` runs
`node --watch`; `start` does not. A watchless backend left running for days
cost hours of debugging — every change looked like it did nothing because
the server was still executing week-old code.

### First run: create and seed the database

Only needed if `/api/health` works but every screen says *"Client profile
not found"*, or the app is empty.

```bash
cd backend && npm run init && npm run seed
```

Log in as **`client1@ironforge.in` / `demo1234`** (Rahul, a client with a
full plan). Trainer view: `trainer1@ironforge.in`, same password.

> **After ANY re-seed you must log out and back in.** The token lives in
> `localStorage` under `pos_token`, and re-seeding changes user ids, so an
> old session points at a user that no longer exists. Every screen then
> fails with "Client profile not found" — it looks exactly like a code bug
> and is not one. Clear it with:
> `localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user')`

---

## 2. The one thing that will bite you

**A green build does NOT mean the page renders.**

Vite does not check for undefined identifiers in JSX, hook-order
violations, or temporal-dead-zone errors. Three separate blank-page bugs
shipped past a clean `npm run build` this week:

| What | Symptom |
|---|---|
| Used `<Pressable>` without importing it | Whole page blank |
| Put a `useEffect` after `if (loading) return …` | *"Rendered more hooks than during the previous render"*, page blank |
| Called a `const` arrow function declared further down the component | *"Cannot access X before initialization"*, page blank |

**So: after changing a page, open it.** A React render error takes down the
entire route, not just the broken component — you get a white screen and
the real message only in the browser console.

Two rules that prevent the last two outright:

- **All hooks go above every early return.** Even if the hook is only used
  by code further down. React counts hooks per render, and a `return`
  before one changes that count.
- **Prefer a module-scope `function` for helpers that use no state.**
  Hoisted, so it cannot be called too early.

---

## 3. Design system rules

### Colour — never write a hex in a component

Everything is token-driven. Light mode is peach, dark is a teal-charcoal
chosen as its complement.

```jsx
style={{ color: 'var(--ink)', background: 'var(--panel)' }}   // yes
style={{ color: '#3B2A22' }}                                  // no
```

| Token | Use |
|---|---|
| `--bg` / `--bg2` | page ground, wells |
| `--panel` / `--panel2` | cards, raised surfaces |
| `--ink` / `--mute` / `--faint` | primary / secondary / tertiary text |
| `--line` | hairlines, borders |
| `--accent` / `--accent-deep` | brand; `--accent-grad` for the gradient |
| `--accent-contrast` | **text ON the accent** — flips white/dark by theme |
| `--good` / `--warn` / `--bad` | status; these do **not** change by theme |

For opacity, use the `-rgb` channel tokens:
`rgb(var(--accent-rgb) / .18)`, `rgb(var(--good-rgb) / .10)`.

**Why this matters:** the light theme used to be ~102 `!important`
overrides restating every colour in brown. Repainting meant editing two
places for every value. 79 are now deleted; the palette is one file
(`src/theme.css`). Adding a hex to a component reintroduces the problem.

> **Gotcha, cost me an hour:** in an inline style use the **longhand**
> `backgroundColor`, not the `background` shorthand, when the value
> contains `var()`. A shorthand with `var()` becomes a "pending
> substitution" and loses to `.card`'s own `background-color` rule — the
> style is right there in the DOM and simply does not apply.

### Type

- **Satoshi** — everything: UI, labels, numbers. Self-hosted in
  `public/fonts/`, weights 400/500/700/900.
- **Sentient** (serif) — the greeting line **only**. It is the one human
  sentence on a numeric screen. `font-serif`. Keep it off data; a serif on
  a metric reads as decoration.
- Numbers get `tabular-nums` (already global on `body`) so columns and
  counters do not jitter as digits change.

### Icons — no emoji

Emoji render as different artwork per platform, ignore the palette, and
have inconsistent baselines (which is why the old code needed four text
sizes to line rows up). ~30 were replaced.

```jsx
import Icon from '../../components/Icon.jsx';
<Icon name="home" size={18} />     // inherits currentColor
```

Add new glyphs as a path in `src/components/Icon.jsx`. Typographic marks
(`✓ ✕ ⚠`) are fine — they are characters, they take the text colour.

### Motion

```jsx
import { Reveal, Stagger, Tilt, Pressable, AnimatedNumber, motion } from '../../design/index.js';
```

- `Reveal` / `Stagger` — scroll-in entrances. **`delay` is in MILLISECONDS.**
- `Tilt` — pointer-tracked card tilt; auto-disabled on touch.
- `Pressable` — press feedback; `as={Link}` works for router links.
- `AnimatedNumber` — springs to a value. Renders the correct number on
  first paint (it does **not** count up from zero on mount).

All of them honour `prefers-reduced-motion` themselves.

### 3D

`AmbientBackdrop` is the only 3D surface currently used (client Home hero).
It is lazy — three.js (190 kB gz) downloads only when a 3D surface scrolls
into view — and it renders **nothing while the tab is hidden**. If 3D
"isn't working", check the tab is actually visible before debugging.

Do **not** import from `design/three/Stage.jsx` in a normal page: it pulls
three.js into the entry bundle. That regression measured 224 kB → 509 kB.

---

## 4. API shapes you will build against

Full contract: `ml/docs/CONTRACT_skos-food-v1.md`. The endpoints below are
live on this branch.

> The intelligence router is mounted at **`/api/intel`**, not
> `/api/intelligence`. Calling the wrong one 404s silently.

### Food search (type-ahead)

`GET /me/foods/search?q=paneer`

```jsonc
{ "foods": [{
  "source_id": "ifct:L003",      // null on rows already in the foods table
  "id": "food_abc",              // present only for stored rows
  "name": "Paneer",
  "calories": 305.4,             // per 100 g
  "protein": 18.9, "carbs": null, "fat": 24.8,
  "confidence": "high",          // high | medium | low
  "trustworthy": true,           // false => do NOT show the number
  "portions": [ { "key": "katori", "label": "Katori", "group": "bowl", "grams": 150 } ],
  "oil_applicable": true
}] }
```

**`null` means NOT MEASURED. Never render it as `0`.** Show `—`.

**Honour `confidence`.** It is calibrated against held-out lab data; two
earlier server-side schemes were measurably *inverted* before this one. Do
not re-derive it client-side.

**`portions` is per food and must not be cached across foods.** A bowl of
dal is 250 g; a bowl of spinach is 62 g. Same bowl, different density.

### Resolve a quantity (portion / grams / oil → macros)

`POST /me/foods/resolve`

```jsonc
// request
{ "source_id": "indb:123", "portion_key": "katori", "count": 1, "oil_level": "high" }
// or: { "name": "dal makhani", "grams": 250 }

// response
{ "grams": 150, "quantity_label": "1 x katori",
  "totals": { "energy_kcal": 190, "protein_g": 5, "carb_g": 11.9, "fat_g": 9.4 },
  "oil": { "applied": true, "level": "high", "delta_kcal": 79 } }
```

Always call this rather than doing the arithmetic in the UI — portion→grams
depends on the food's own density and measured serving weight, and oil is a
**delta from the dish's own recipe oil** (so "none" *reduces* calories).
`oil.applied: false` with a `reason` means the model declined; say so
rather than showing an unadjusted number as if it were adjusted.

### Add a catalogue food to the log

`POST /me/foods/from-model` `{ source_id, name }` → `{ food: { id, … } }`

Catalogue results have no `id` — they are not rows yet. Materialise first,
then use that `id` with the existing meal-item endpoint. Repeat calls reuse
the same row.

### Barcode

`GET /intel/foods/barcode/:code?servings=1` → the product at **its own**
serving size, or **404** on a miss.

A 404 is normal (Open Food Facts is crowd-sourced) — fall back to name
search, never to a substituted food. Watch `quantity.serving_grams_known`:
**54% of products have no serving size** and default to 100 g. Show that,
do not log it silently.

### Workout burn

`POST /intel/workout-burn` → `{ kcal, lower_kcal, upper_kcal, notes[] }`

**Show the range, not the bare number.** The interval is roughly ±70% of
the estimate and the model flags its own assumptions in `notes`. A lone
"597 kcal" claims precision the model explicitly disclaims.

---

## 5. Where things are

| Thing | Path |
|---|---|
| Tokens / palette / `@font-face` | `src/theme.css` |
| Token values for JS (charts, 3D) | `src/design/tokens.js` |
| Motion primitives | `src/design/motion/index.jsx` |
| 3D layer | `src/design/three/` |
| Icons | `src/components/Icon.jsx` |
| Food logging sheet (portions + oil + scan) | `src/components/FoodLogSheet.jsx` |
| Barcode scanner | `src/components/BarcodeScanner.jsx` |
| Rebuilt pages | `pages/client/Home.jsx`, `pages/client/Workout.jsx` |
| Design system reference | `frontend/DESIGN_SYSTEM.md` |

---

## 6. Known gaps — yours if you want them

1. **Trainer pages (8) got colour and icon fixes but no layout work.** They
   are consistent, not redesigned. Client `Home` and `Workout` show the
   intended treatment: one clear hero, then quieter supporting blocks.
2. **Mid-workout ticks do not survive a refresh.** Sets are client-side
   until "End session"; the server only stores `started_at`. Making them
   persist needs a backend decision, not just UI.
3. **Oil baselines are approximate.** The real per-recipe baselines (from
   541 recipes) live in the Python `OilAdjuster` and were never ported to
   JS; the JS path approximates from each dish's fat and **refuses** the
   adjustment where fat is intrinsic (paneer, nuts, meat).
4. **Nutrition page layout is still the original.** The new logging sheet
   is wired in behind "Log food", but the surrounding page has not had the
   hierarchy pass Home and Workout got.

Anything in §4 you are unsure about, ask before building around it —
changing a shape later costs all three of us more than a message does now.
