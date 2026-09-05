# SK OS — Complete UI/UX Design Refinement

**Status:** local working tree only. Nothing committed, pushed, or deployed.
`HEAD` is still `9d4fec5`; 82 files changed.

**How to review:** `cd frontend && npm run dev`, then walk the matrix in §11.

---

## 1. Typography

**One typeface now carries the product: DM Sans, 400–1000.**

The single most consequential finding of this pass: the three self-hosted
`dmsans-400/500/700.woff2` files were **byte-identical** — same md5, one
weight served under three names. Every `font-bold` DM Sans label in the app
was therefore browser-*synthesised* faux bold: smeared strokes, wrong
sidebearings, no real weight contrast. Replaced with the genuine variable
file (`dmsans-var-latin.woff2`, 62 KB) plus the `latin-ext` subset, which is
what carries **₹ (U+20B9)** — the currency symbol used on every payment
screen in the product.

Three other typefaces were being referenced and none of them worked:

| Reference | Where | What actually rendered |
|---|---|---|
| `Satoshi` | 11 inline `fontFamily` styles | Real Satoshi — a *second* typeface on screen |
| `Bricolage Grotesque` | Trainer Dashboard hero, 50 px | Browser default sans (never loaded) |
| `Plus Jakarta Sans` | Every chart tooltip | Browser default sans (never loaded) |

All removed. Satoshi's `@font-face` block was deleted too, so a leftover
inline reference can now only fall through to the system stack — never to a
second real face.

**Type scale** (`theme.css`, `@layer components`): `.t-display` `.t-title`
`.t-section` `.t-card` `.t-body` `.t-sub` `.t-micro` `.t-metric`. The
uppercase micro-label had been retyped in four different sizes across four
files, each maintaining a private `Label` component; those are gone and
`.t-micro` is the one definition.

---

## 2. Design tokens

Added to `:root` alongside the existing colour tokens:

- **Radii** `--r-xs`…`--r-2xl`, `--r-pill`
- **Spacing** `--s-1`…`--s-12` on the 4/8/12/16/20/24/32/40/48 rhythm
- **Elevation** `--e-1`…`--e-4`, defined *separately per theme* — dark's
  near-black shadows read as dirty smudges on a near-white ground, so light
  mode gets a warm-tinted ladder of its own
- **Motion** `--dur-fast|base|slow` (140/220/320 ms), `--ease-out`,
  `--ease-in-out`
- **Focus** `--focus-ring`

Two colour corrections:

- **`--gold`** `#FBBF24` → `#D9A441` (dark) / `#9A6D16` (light). The old
  value was a saturated primary yellow in a terracotta-and-blush palette.
  *Scope note:* Tailwind's `gold` utility is aliased to `--accent-rgb`, so
  the ~120 `text-gold` class usages were already terracotta — this token
  only drives the handful of inline `var(--gold)` readers. The light value
  is darkened to clear 4.5:1, because gold is used as *label text*.
- **`tint`** added to the Tailwind palette. `bg-white/[.02]` appeared at 49
  sites as the standard "nested tile inside a card" fill. It works on a
  near-black ground and is **completely invisible on the light theme**,
  whose panels are already white — so every one of those tiles lost its
  boundary in light mode. `--tint-rgb` is blush on dark, warm brown on
  light; all 49 converted.

---

## 3. Spacing & 4. Cards

Card system unchanged in structure (`.card`, `.card-hover`,
`.card-elevated`) but re-grounded on the token ladder, with the light-mode
`--card-shadow` rebuilt as two layers — a tight contact shadow to keep the
edge crisp against the near-white ground, plus a wide soft one for lift.

Light mode was also repainted: `--bg` `#FFDFDD` → `#FAF5F3`. The old value
was a saturated peach that fought every accent placed on it.

---

## 5. Buttons

Rebuilt as `.btn-base` (geometry + states) plus colour-only variants:
`.btn` `.btn-primary` `.btn-secondary` `.btn-ghost` `.btn-danger`
`.btn-danger-quiet`; sizes `.btn-sm` `.btn-lg` `.btn-block` `.btn-icon`.
Every variant inherits `:disabled`, `:active` press, and a
`[data-loading="true"]` spinner — so "Signing in…" / "Starting…" /
"Processing…" string swaps are replaced by one mechanism.

Two rendering bugs fixed:

- The size modifiers were **defined before** the colour variants, so on
  equal specificity `.btn`'s `padding: 10px 18px` beat `.btn-icon`'s
  `padding: 0` by source order. An icon button rendered 40 px wide with 18 px
  of padding each side, squeezing its 15 px icon to a 4 px sliver — visible
  on the Workout share button.
- `.btn-primary::after` (the hover sheen) parked at `translateX(-120%)` of
  its *own* 34% width — roughly −41% of the button — and `skewX(-18deg)`
  pushed its bottom-left corner back across x=0. Every primary button in the
  product had a permanent pale sliver on its left edge at rest.

---

## 6. Inputs & forms

`.input` (44 px min-height, `aria-invalid` styling), `.field`,
`.field-label`, `.field-hint`, `.field-error` — the error carries a `::before`
"!" glyph so the state is not conveyed by colour alone. `.field-suffix`,
`.segmented`, `.badge`, `.empty-state*`, `.row`, `.skeleton-*`, `.meter`,
`.toast` added.

**Login now has a password reveal.** A password field with no reveal is the
single most common cause of a failed mobile sign-in.

---

## 7. Navigation

- **Bottom tab bar** and **top header** moved to `.app-tabbar` / `.app-header`
  with `env(safe-area-inset-*)`. Without it, the last row of tab labels sits
  under the iOS home indicator and the targets lose ~20 px of their bottom
  edge.
- **Profile menu regrouped** into who-I-am / what-I-use / how-it-behaves.
  It had eight flat rows, three of which — Profile, Measurements, Goals —
  pointed at the *same* URL, so two of them silently lied about where they
  would take you. Profile drives its panels off internal state, so those
  rows now carry `?section=…` and Profile opens the named panel directly.
- **Hover moved from JS to CSS** (`.chrome-btn`, `.menu-row`). The layouts
  were assigning `element.style` in `onMouseEnter`/`onMouseLeave`, which
  gives keyboard focus no feedback at all, never produces an `:active`
  state, and outranks every media query. One of those handlers assigned
  `var(--surfaceHover)` — **a token that does not exist**, so the avatar
  menu had never had hover feedback on any row.

---

## 8. Page headers · 9. Modals · 10–11. Loading & error states

`PageHeader` gained optional `eyebrow` / `onBack`. `Modal` is a bottom sheet
on mobile and centred from `sm` up, with `.sheet-handle`, `.sheet-header`,
and optional `sub`/`footer`/`onBack`. Added `.sheet-centered` for dialogs
that are not docked to an edge — the top-only radius only reads correctly
when the panel touches something.

**Skeletons replaced every full-page spinner.** Home, Workout, Progress,
Membership and Billing write their own; the other fifteen pages use the
shared `PageSkeleton` (§23). Each is shaped like the screen it becomes, so
nothing jumps when data lands; a centred spinner on a four-band page
guarantees a layout shift on every load.

`ErrorState` now surfaces only short prose and hides technical detail behind
a `<details>`.

---

## 12–17. Page-level work

**Home** — token-driven Community card (was the last `#FBBF24` on the
screen); real skeleton; and a **first-run Fuel state**: without a nutrition
plan the ring divided by a fake max of 1 and the bars read `0 / 0 g`, three
rows of zeroes that look like a broken screen rather than an un-started one.

**Workout** — three peer action tiles wore three different colours (gold /
ember / good) for no semantic difference, which also implied "My PR" was a
success state; now one accent treatment, icon carries the distinction.
Labels had hard `<br/>` breaks mid-phrase. `START SESSION` was the only
shouted button label in the product. Rest day became a real `.empty-state`.

**Progress** — the delta *is* the page; it had been 12 px grey under a
generic "Progress" heading. Added a first-run state (the whole page is
data-gated, so a new client previously saw a title, an input, and three
empty boxes). Toast now auto-dismisses — it previously sat over the bottom
of the screen for the rest of the session.

**Login** — `animation-delay={...}` was passed as a **JSX prop**, which
React forwards to the DOM as a literal attribute; the intended stagger had
never run. Demo-account icons were `◧`, `₹`, `⌁` — three Unicode glyphs
from three blocks, one of them a currency symbol used as a picture.

**Gym owner** — the Dashboard hero was a fixed 50 px set against a desktop
window; on a 375 px phone the sentence ran to four lines and pushed every
KPI below the fold, so the screen's own question hid its answers. Now
`clamp(1.875rem, 6.2vw, 3.125rem)`. Attention rows converted to `.row`
(they had three white-alpha washes, all invisible in light mode).

**Admin Console** — deliberately **left alone**. It already runs DM Sans +
DM Mono with real weights and its own off-white/wine-red palette, which is
exactly the "distinct but same family" brief, and it is live in production.
Changing its font source for cosmetic consistency would risk a working
deploy for no user-visible gain.

---

## 18. Receipt printer animation

`frontend/src/components/ReceiptPrinterAnimation.jsx` — zero dependencies,
inline SVG printer (body, vents, breathing status lamp, paper slot, two
spinning rollers, sweeping print head), paper with zig-zag torn edges,
staggered line-by-line printing, terminal PAID stamp. ~1.4 s at typical
line counts. States: `printing` | `complete` | `error`.

Every keyframe uses `both` fill mode, so under `prefers-reduced-motion` the
collapsed result is the **finished** receipt, not an invisible one.

**It renders only the data it is handed.** No placeholder amount, no sample
transaction id. A missing field is *omitted*, never filled with something
plausible. The one place sample figures exist is the `/design` showcase,
labelled as samples on screen.

---

## 19. Payment & receipt UX

`PaymentResult.jsx` keeps **payment state and receipt state as separate
props** — `payment: processing | verifying | success | failed | cancelled |
refund_pending | refunded`, `receipt: generating | ready | error`. A single
merged enum is exactly how "receipt failed → shows Payment Failed" gets
written, so the type makes that impossible to express.

Verified live on `/design`: **payment `success` + receipt `error` keeps the
"Payment successful ✓" headline** and shows a separate "Receipt not ready —
your payment went through, only the receipt failed to generate" panel whose
Retry retries the receipt alone.

Wired into `Membership.jsx` and `EnterpriseBilling.jsx`. Both handle the
dangerous case explicitly: **if the gateway confirmed the charge but our own
verify call failed, the payment shows `verifying`, not `failed`** — telling
a user "payment failed" there sends them to pay twice.

Receipt data comes only from values the page can vouch for. Membership omits
the invoice *number* (the verify route issues an invoice but doesn't return
it). Enterprise legitimately reports `receipt: 'generating'` then promotes
to `ready` once the real invoice number arrives — or to `error` if it
doesn't, rather than spinning forever.

`PaymentCheckout` also had `theme: { color: '#14C4BC' }` — a teal from a
palette two repaints ago, meaning the one screen a paying customer sees
rendered the Razorpay widget in a colour the product no longer uses. Now
read from the live accent token.

---

## 20. Iconography

Roughly 55 glyph-and-emoji icons replaced with SVG. The `XIcon` /
`CheckIcon` / `ChevronRightIcon` / `ArrowRightIcon` primitives are sized
`1em` with `stroke="currentColor"`, so every existing `text-[Npx]` class and
`color` style at the call sites keeps working untouched.

Emoji removed from the surfaces that matter most: the onboarding wizard's
goal and sex pickers (the *first* screen a new client sees), the first-run
feature popups — which showed a different icon than the tab they were
introducing — Settings sections, and the Nutrition action tiles.

---

## 21. Bugs found and fixed along the way

Not cosmetic; found by looking closely at code that was being restyled.

1. **`TrendChart` gradient never resolved.** The id was built as
   `` `tg${color.replace('#','')}` `` — fine for hex literals, but every
   caller now passes `color="var(--accent)"`, producing the id
   `tgvar(--accent)` and the reference `url(#tgvar(--accent))`. Parentheses
   terminate a fragment identifier, so the fill failed silently and Recharts
   fell back to its default slate. **Every adherence and trend chart in the
   product rendered as a grey block** under an accent stroke.
2. **Home's goal ring only worked for cutting.** `(start − current) /
   (start − target)` guarded by `span > 0`. A client bulking 68 → 76 kg has a
   negative span, fell to the else branch, and saw a permanent **0%** no
   matter how much they gained.
3. **Progress photos pluralised on the wrong variable** —
   `photo{v.length > 1 ? 's' : ''}` where `v` is the *view name*
   (`'front'`/`'side'`/`'back'`), all longer than one character. One photo
   always read "1 photos".
4. **Trainer Dashboard printed a bare "% adherence"** for any client with no
   adherence data — visible on that screen for several seeded clients.
5. **Focus ring reshaped elements.** The global `:focus-visible` rule forced
   `border-radius: 10px`, so a pill button squared off and a circular avatar
   became a rounded square the moment you tabbed to it. Outlines already
   follow the element's own radius.
6. Plus the button-padding, sheen-sliver, dead-hover-token and
   `animation-delay`-as-prop defects described above.

---

## 22. Verification performed

Local dev server, in-app browser, seeded Ironforge data.

| Surface | Light | Dark | 375 px | Desktop |
|---|---|---|---|---|
| Client Home | ✓ | ✓ | ✓ | ✓ |
| Workout | ✓ | — | ✓ | — |
| Nutrition | ✓ | — | ✓ | — |
| Progress | ✓ | ✓ | ✓ | — |
| Login (3 views) | ✓ | — | ✓ | ✓ |
| Trainer Dashboard | ✓ | — | ✓ | — |
| Trainer Clients | ✓ | — | ✓ | — |
| `/design` payment + receipt | ✓ | — | ✓ | ✓ |

States exercised: loading skeletons, empty, error, disabled, selected,
active/hover, and the payment matrix (all 7 payment × 4 receipt states via
the `/design` toggles).

`npm run build` clean in both `frontend/` and `admin/`.
**Console: zero errors** on a fresh tab across Home, Workout, Progress,
Trainer Dashboard. (Errors that appeared in a long-lived tab were stale HMR
history from an edit-in-flight — confirmed by reproducing in a clean tab.)

---

## 23. Second pass — what the first pass deferred

**Receipt history (Part 27)** — the Enterprise invoice list is now a real
receipt-history surface: `View` opens the *same* receipt the payment screen
shows, rendered from the stored invoice row, so a receipt looks identical
thirty seconds or thirty days after paying. The payment result's "View
receipt" scrolls to it. Verified end-to-end against seeded invoices
(`SKOS-2026-XV1ZSE`, ₹12,000, PAID stamp, Download PDF / Share).

The client side has **no** payment-history route on the backend, so there is
nothing to list there. That gap is named rather than papered over with a
fabricated list — it needs a `GET` route before it can be built honestly.

**`PageSkeleton` primitive** — fifteen pages gated their whole render on
`<Spinner label="…" />`. Every one guaranteed a layout jump on every load,
and told the user nothing about what was coming. One primitive with five
shape families (`dashboard` / `list` / `detail` / `form` / `split`), fifteen
one-line swaps. The `label` now goes to `aria-label`, which is where
"Loading clients…" was actually useful. Inline spinners inside an
already-laid-out card were left alone — those are correct.

**`PasswordInput` primitive** — all four password fields in the product
(Login, SignUp, SetupOrg, TrainerSignUp) had no reveal toggle, the single
most common cause of a failed sign-in on a phone. One component, sized and
`aria-pressed`-labelled, replacing what would otherwise have been four
inline copies.

**Auth-flow form sweep** — 12 hand-typed uppercase field labels → `.field-label`,
9 hand-rolled error boxes (three different paddings) → `.field-error` with
`role="alert"`, 6 `!py-3` submit buttons → `.btn-lg .btn-block`.

**65 `!important` button overrides collapsed.** Every one was a call site
fighting `.btn`'s own padding because no small size existed to reach for.
They also guaranteed that three "small" buttons on one screen were three
different sizes. Now `.btn-sm` / `.btn-lg` / `.btn-block`, with layout
classes (`flex-1`, `shrink-0`) preserved and `!text-bad` / `!text-mute`
kept, since those are colour rather than size.

**Tabs escaping their own control.** `.segmented` used `flex-1` on items,
which shrinks to zero — ClientProfile's seven tabs wrapped, and "AI Coach"
rendered *outside* the control's border at 375px. Now `flex: 1 0 auto` with
`overflow-x: auto` and hidden scrollbars: items share the width when they
fit and scroll when they don't. Verified all seven reachable, all on one
line.

**The dead teal palette is now fully gone.** 11 more literal `rgba(20,196,188)`
/ `(18,184,176)` / `(10,138,133)` values, in inline styles no token change
could reach: the sign-in welcome animation every client sees, the coach
brief drawer, the tunnel backdrop, Help, Reports, and a teal glow behind the
terracotta progress bar on ClientProfile. Mapped to the accent channel at
identical alpha, so each effect's weight is unchanged and only the hue moved.
`grep` for those values now returns only the comments explaining them.

**Bricolage Grotesque's `@font-face` block removed** — dead once the
Dashboard override went, and a dead face declaration is an invitation to
reintroduce a third typeface by accident. `theme.css`'s header comment,
which still described Satoshi as the primary face, was corrected.
`public/fonts/bricolage-*`, `satoshi-*` and `dmsans-400|500|700.woff2` are
now unreferenced and can be deleted from the repo — left in place because
deleting binary assets is the user's call.

**More missing-data defects, same family as §21:**

- ClientProfile's identity line was an unconditional template: with no
  target weight and no goal date it printed the literal
  `· Goal  kg by ` — orphaned words and a stray "kg".
- Its Weight Trend card rendered a heading over blank space, because
  `WeightChart` returns `null` on an empty series.
- Its weight-progression bar drew an empty track under "Start  kg / 0% of
  journey / Target  kg" — a progress bar for a goal that does not exist.
- Business's revenue chart passed `color={status.good}`, the literal
  `#7AA880`, which matches `--good-rgb` in dark mode only — so the chart's
  green did not follow the theme. It also spent the semantic "good" colour
  on the page's primary metric, leaving a real warning nowhere to go.
- `▲` / `▼` in the weight-delta line, and 16 more non-bracket
  `bg-white/N` washes invisible on light.

---

## 24. Third pass — fonts deleted, contrast, and the mirror that lied

**11 unused font files deleted** — 367 kB of woff2 that shipped in the repo
and could never be requested: `bricolage-400|500|700|800`,
`satoshi-400|500|700|900`, `dmsans-400|500|700`. Verified unreferenced
across every `.jsx`, `.js`, `.css`, `.html` and config file first. The four
Bricolage files were byte-identical to each other — the same
one-weight-under-four-names duplication as DM Sans. `public/fonts/` now
holds four files: the two DM Sans variable subsets and two Sentient cuts.

### Contrast pass (Part 33) — measured, not eyeballed

Every colour pair was computed against WCAG AA. Four real failures:

| Token | Was | Now | Worst-case ratio |
|---|---|---|---|
| `--faint` (both themes) | .44 alpha | **.60** | 2.80:1 → **4.51:1** |
| light `--accent` | `#C15C4C` | **`#B0503F`** | 4.28:1 → **5.17:1** |
| light `--good` | `#5F8D64` | **`#56805B`** | 3.83:1 → **4.53:1** |
| light `--warn` | `#B98A4E` | **`#946E3E`** | 3.08:1 → **4.61:1** |

`--faint` is the big one: it carries dates, units, field hints and every
tertiary line in the product, and it failed in *both* themes. The light
accent was marginal in **both directions at once** — 4.28:1 as
accent-coloured link text *and* 4.28:1 for the white label sitting on a
primary button, so `.btn-sm` at 12px (no "large text" exemption) failed too.
Nine percent darker fixes both with one token and zero call-site churn.

**A `!important` rule would have silently defeated the fix.** `.light
.text-faint` restated the alpha at `.44` and outranked the variable — so
raising `--faint` would have changed nothing for `text-faint` in light mode.
That is exactly the two-places-to-edit trap the file's own header warns
about; both are now in sync.

**Sixteen dead `.light .bg-white/*` overrides deleted** — they existed to
flip white washes to black under `.light`, which was treating the symptom.
Those call sites now use `bg-tint/*` and theme themselves. One of the
deleted rules had drifted to `rgba(90,140,0,.25)` — a **lime**, from the
palette before terracotta — and another restated the same selector twice
with two different values.

### Reduced motion was half-implemented

The media query collapsed `animation-duration` but **not `animation-delay`**.
Every stagger in the app sets an inline `animationDelay` on a keyframe with
`both` fill mode, so before the delay elapsed the element held its `from`
frame — `opacity: 0`. A reduced-motion user therefore stared at blank space
for the full delay and then a snap-in: the login cards ~200 ms, the workout
list ~400 ms, and the printed receipt roughly **800 ms of empty paper**.
Delay is now zeroed, and `scroll-behavior: auto` is forced so
`scrollIntoView({behavior:'smooth'})` jumps instead. Verified in the CSSOM.

### `design/tokens.js` — the mirror that lied

This is not documentation: `exerciseSVG.jsx` draws its figures from it and
`charts.jsx` colours the adherence breakdown from it, because SVG and
Recharts internals cannot read CSS variables. It had drifted on nearly
every value — `dark.bg` still said the warm near-black `#1C1210` (theme.css
moved to true `#000000`), `dark.panel` `#2A1D19` (now `#161616`), `dark.ink`
`#F7ECE7` (now blush `#FFDFDD`). **Every exercise animation in the product
was being drawn from a palette the app abandoned two repaints ago, on a page
painted in the current one.** Now synced, with a comment stating the
obligation, plus a `statusLight` export for the darkened light-mode statuses.

**The `/design` page was misdescribing the design system** — its typography
section read "DM Sans for display, Plus Jakarta Sans for UI and body", and
labelled live samples "Plus Jakarta Semibold". It now renders the real
`.t-*` scale, so a token regression shows up on the page instead of being
asserted away. Its colour swatches were also painting the live CSS variable
while *labelling* it with the stale hex from `tokens.js`; both now agree.

### Responsive verification (Part 32)

Scripted at **320 px** — the narrowest realistic width — across **18
routes** (7 client, 11 trainer). Result: `scrollWidth - clientWidth === 0`
on every one. No page scrolls sideways. The only element wider than the
viewport is the measurements table, which is correct: it scrolls inside its
own `overflow-x: auto` container.

### Other

- **Community fired two requests it knew would 403.** The leaderboard and
  feed fetches ran unconditionally on mount, in parallel with the membership
  check — so every visit by a client who hasn't joined made two round trips
  the server correctly denied, on a page that then rendered the join prompt
  and used neither result. Now gated on membership; console is clean.
- Business's revenue chart, the last `⇔` glyph, and the remaining
  micro-labels on NutritionTracker / Reports / EnterpriseQR.

---

## 24. Not done / knowingly deferred

- **Client-side payment history** — needs a backend route first (above).
- **Community leaderboard medals (🥇🥈🥉) left as emoji.** A medal on a
  leaderboard is semantically loaded in a way a stroke icon is not; worth a
  deliberate decision rather than a sweep.
- **Dark-mode sweep of every trainer sub-page** was spot-checked, not
  exhaustive. The systemic dark/light defects (invisible washes, the token
  mirror, contrast) were fixed at the source, so remaining risk is per-page
  rather than structural.
- **Admin Console left untouched** — see §17. It already runs DM Sans +
  DM Mono with its own identity and is live in production.
- **No backend, business-rule, calculation, auth or payment-logic changes.**
  The only non-presentational addition is `exerciseLabel()` in `utils.js`,
  which title-cases `leg_press` → `Leg Press` **for display only**; the
  stored value is untouched because it is the key the logging routes and PR
  tracker match on.
