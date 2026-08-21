# SK OS Design System

**For:** Manavi (frontend) · **Branch:** `ui-manavi`
**Live showcase:** run `npm run dev`, open **`/design`** — no login needed.

Everything here is **additive**. No existing component was rewritten, and no page
had to change to land it. `components/UI.jsx`, `components/motion.jsx` and
`utils.js`'s `cls()` all still work exactly as before.

---

## 1. What this is, in one paragraph

Three layers: **tokens** (colour/motion/elevation defined once), **motion**
(framer-motion primitives for things CSS can't do), and **3D** (a lazy,
performance-tiered R3F wrapper). Import from one place:

```js
import { cn, Reveal, Tilt, Pressable, AnimatedNumber, AmbientBackdrop } from '../design';
```

---

## 2. Tokens — the important change

### The problem it fixes

Light mode was implemented by overriding individual Tailwind classes with
`!important` — **110 of them** in `theme.css`. The same brand colour existed in
four places at once (Tailwind config hex, CSS variable, a hardcoded
`linear-gradient(...)` inside three components, and again as a light-mode
override). Two token *names* had also drifted from their values: `ember` was
`#0A8A85` (a teal, not an ember) and `gold` was `#14C4BC` (a cyan, not a gold).

### How it works now

A colour is defined **once**, as a CSS variable, in channel form:

```css
:root       { --accent-rgb: 20 196 188; }   /* dark  */
.light      { --accent-rgb: 140 106 77; }   /* light */
```

Tailwind consumes it so opacity modifiers keep working:

```js
accent: 'rgb(var(--accent-rgb) / <alpha-value>)'
```

```jsx
<div className="bg-accent" />       {/* full opacity      */}
<div className="bg-accent/30" />    {/* 30% — still works */}
```

Light mode now needs **no override for these** — it redefines the variable.

### Use these names

| Use | Not |
|---|---|
| `accent`, `accent-deep` | ~~`gold`~~, ~~`ember`~~ |

`gold`/`ember` still work — ~120 usages depend on them — but they're aliases now
and shouldn't be used in new code.

### ⚠️ One deliberate exception — don't "fix" it

`line`, `mute`, `faint` are **still literal `rgba()`**, not channel tokens.

They bake in an alpha and are used *both* bare (`border-line` must stay a `.07`
hairline) *and* with modifiers (`border-line/40`). A channel token can't serve
both: Tailwind substitutes `<alpha-value>` with `1` when there's no modifier,
which would turn **every hairline border in the app into solid white**.

Converting them "for consistency" is a visible regression. The reasoning is
also in `src/design/tokens.js`.

---

## 3. Motion

CSS keyframes in `theme.css` are fine and stay. framer-motion is for what CSS
can't do: **interruptible** and **gesture-driven** motion.

| Primitive | Use for |
|---|---|
| `<Reveal>` | Scroll-into-view entrance. **Same API** as `components/motion.jsx` — drop-in |
| `<Stagger>` | Sequenced children |
| `<PageTransition>` | Route change |
| `<Tilt>` | Pointer-tracked 3D card tilt — **CSS transform, no WebGL** |
| `<Pressable>` | Press feedback. Renders a real `<button>` |
| `<AnimatedNumber>` | Springs to a value, retargets mid-flight |

One house easing curve, `cubic-bezier(.22, .8, .3, 1)`, shared with the existing
CSS so both engines feel identical. A second "house curve" would just make the
app feel like two apps.

**Reduced motion is enforced in JS, not just CSS.** `theme.css` zeroes CSS
animation durations under `prefers-reduced-motion`, but that rule cannot reach
framer-motion, which animates via inline style. Every primitive above checks the
preference itself and renders the final state directly.

**`Tilt` is the one to reach for most.** It gives depth for the cost of a CSS
transform, so it works anywhere — unlike a real 3D `Stage`.

---

## 4. 3D

### Use it for

- Ambient backdrops behind a hero or empty state
- **One** standout moment (workout complete, streak milestone)
- Genuinely spatial content (a muscle map)

### Do not use it for

- Anything behind a number the user reads — motion hurts legibility
- More than one `Stage` on screen at once
- Decoration a CSS gradient or `<Tilt>` would achieve
- Lists, tables, anything that scrolls

### Usage

```jsx
<div className="relative overflow-hidden">
  <AmbientBackdrop />
  {/* content */}
</div>
```

That's the whole API. It handles: lazy-loading three.js, gating on visibility,
device tiering, reduced-motion, missing WebGL, and re-tinting on theme change.

### ⚠️ The rule that actually matters

**Never import `Stage` or a scene from `design/index.js`, and never import them
statically from a screen.**

This was measured, not theorised. The first version of this system exported
`Stage` from the barrel, assuming lazy-loading the *scene* was enough. It isn't
— `Stage` imports `Canvas` from `@react-three/fiber`, so anything reaching it
statically pulls in the whole renderer. The entry chunk went from **224 kB to
509 kB gzipped**, with three.js hoisted out of its lazy chunk into the bundle
every user downloads on first paint.

`AmbientBackdrop` is the lazy boundary and contains no 3D imports — that's why
it's the only 3D thing exported. New 3D surface? Put it behind its own
`React.lazy`.

### Measured bundle impact

| Chunk | gzip | When downloaded |
|---|---:|---|
| entry | **224.4 kB** | always |
| `three.module` | 189.7 kB | first 3D surface only |
| `AmbientBackdropImpl` (R3F) | 44.8 kB | first 3D surface only |
| `AuroraField` scene | 0.9 kB | first 3D surface only |
| `DesignSystem` (`/design`) | 49.2 kB | only if visited |

Baseline entry before any of this work: **224.3 kB**. The design system costs
**+0.1 kB** on first load. Everything else is deferred.

### Performance tiering

`Stage` picks DPR / antialiasing / shadows from a device tier
(`deviceMemory`, `hardwareConcurrency`, pointer type), then **downgrades** if
frames run over a 22 ms budget for 45 consecutive frames. Downgrade is one-way
on purpose — a renderer that upgrades and downgrades at the boundary produces
visible quality pumping, which is worse than running a notch lower.

Scenes read the resolved tier via `useStageTier()` and scale their own workload
(`AuroraField` draws 60/140/260 particles). Without that, tiering would only
control renderer settings while the scene kept drawing the same load.

DPR clamping matters most: an unclamped DPR of 3 renders **nine times** the
pixels of DPR 1 — the most common cause of a beautiful scene at 15 fps.

---

## 5. `cn()` vs `cls()`

`cls()` (in `utils.js`) joins strings. `cn()` also **resolves Tailwind
conflicts**:

```js
cls('p-5', 'p-2')  // "p-5 p-2" — winner depends on stylesheet order
cn('p-5', 'p-2')   // "p-2"     — caller wins, predictably
```

Use `cn()` in anything that accepts a `className` prop meant to override a
default. `cls()` is untouched and still used by existing components.

---

## 6. What is NOT done — honest list

1. **~102 `!important` light-mode overrides still exist in `theme.css`.** Only
   the ones for `.btn-primary`, `.tab.active` and `.navlink.active` were
   removed (those three are now token-driven). The rest are *redundant* now
   for tokenised colours — they set the same value the variable already
   produces — but removing them is a separate, visually-verifiable pass, and
   deleting ~100 rules while a teammate is actively editing the same file is
   how you get a merge conflict *and* a regression at once.
2. **`line`/`mute`/`faint` still theme via override**, by design — see §2.
3. **One deliberate visual change:** the light-mode primary button was a *solid*
   brown; it is now a brown→tan gradient, matching how dark mode has always
   treated it. Verified in-browser. If you prefer the flat fill, set
   `--accent-grad` in `.light` to a single-colour gradient — one line, one
   place.
4. **`lucide-react` is installed but unused.** The app currently uses emoji as
   icons (`🫙`, `⚠️`, `✕`). Swapping to a real icon set is a genuine polish win
   but touches many files, so it wasn't bundled into this change.
5. **Pre-existing vulnerabilities were left alone** — `vite`/`esbuild`
   (dev-server only) and `react-router-dom`. Neither comes from the new
   packages. `npm audit fix --force` installs Vite 8, a breaking change; that's
   a team decision, not a silent one.
6. **No existing page uses the new primitives yet.** The system is built and
   proven on `/design`; adopting it screen-by-screen is the next step.

---

## 7. Files

| Path | Purpose |
|---|---|
| `src/design/tokens.js` | Source of truth — colour, motion, perf, radius, z |
| `src/design/cn.js` | className merge helper |
| `src/design/motion/index.jsx` | Motion primitives |
| `src/design/three/AmbientBackdrop.jsx` | **Lazy boundary** — the 3D entry point |
| `src/design/three/AmbientBackdropImpl.jsx` | 3D half; never import statically |
| `src/design/three/Stage.jsx` | Canvas wrapper, tiering, gating |
| `src/design/three/webgl.js` | Capability check, deliberately three-free |
| `src/design/three/useDeviceTier.js` | Tier detection + adaptive downgrade |
| `src/design/three/scenes/AuroraField.jsx` | Default ambient scene |
| `src/pages/DesignSystem.jsx` | The `/design` showcase |

Questions on any of this — ask before building around it.
