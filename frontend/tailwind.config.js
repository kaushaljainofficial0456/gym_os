/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ══════════════════════════════════════════════════════════════
           TOKEN-DRIVEN COLOURS — see src/design/tokens.js for the rules.

           `rgb(var(--x-rgb) / <alpha-value>)` is what makes BOTH of these
           work off one definition:
             bg-panel      -> rgb(var(--panel-rgb) / 1)
             bg-panel/90   -> rgb(var(--panel-rgb) / .9)
           and it themes automatically, because light mode redefines the
           variable rather than overriding the class.

           These previously carried a `light:` sibling (e.g.
           `bg: { DEFAULT: '#080C10', light: '#F7F3EE' }`) which generated
           unused `bg-bg-light` classes -- light mode was actually being
           applied by !important overrides in theme.css instead. The
           variable is now the single mechanism.
           ══════════════════════════════════════════════════════════════ */
        bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
        bg2: 'rgb(var(--bg2-rgb) / <alpha-value>)',
        panel: 'rgb(var(--panel-rgb) / <alpha-value>)',
        panel2: 'rgb(var(--panel2-rgb) / <alpha-value>)',
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',

        /* Brand. `accent` is the correct name; `ember`/`gold` are kept as
           ALIASES because ~120 existing usages depend on them, but their
           names had drifted badly from their values (`ember` was a teal,
           `gold` was a cyan). New code should use accent/accent-deep. */
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        'accent-deep': 'rgb(var(--accent-deep-rgb) / <alpha-value>)',
        ember: 'rgb(var(--accent-deep-rgb) / <alpha-value>)',  // alias, deprecated
        gold: 'rgb(var(--accent-rgb) / <alpha-value>)',        // alias, deprecated
        cyanx: 'rgb(var(--cyan-rgb) / <alpha-value>)',
        violetx: 'rgb(var(--violet-rgb) / <alpha-value>)',

        good: 'rgb(var(--good-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        bad: 'rgb(var(--bad-rgb) / <alpha-value>)',

        /* DELIBERATE EXCEPTION — do not "fix" these into channel form.
           These bake in an alpha and are used BOTH bare (`border-line`,
           which must stay a .07 hairline) and with modifiers
           (`border-line/40`). A channel token cannot serve both: Tailwind
           substitutes <alpha-value> with 1 when no modifier is present,
           which would turn every hairline into solid white. Left literal
           so Tailwind's rgba parser handles the modifier; they are themed
           by the existing overrides in theme.css. Full reasoning in
           src/design/tokens.js.

           This is dark mode's literal default (light overrides it via the
           `.light` !important block in theme.css) -- it was drifted from
           `:root`'s own --line/--mute/--faint (white 250,250,250 here vs
           ink 247,236,231 there, .50/.28 alpha here vs the already-tuned
           .68/.44 there), so the last contrast pass that darkened --mute/
           --faint never actually reached anything styled through these
           Tailwind classes. Now recoloured to blush AND realigned to the
           same alpha as theme.css's :root, so both paths agree. */
        line: 'rgba(255,223,221,.08)',
        mute: 'rgba(255,223,221,.68)',
        faint: 'rgba(255,223,221,.44)',
      },
      /* The four legacy names are KEPT as aliases rather than renamed,
         because ~40 files use `font-display` / `font-grotesk` today and a
         rename would be a 40-file diff whose only effect is churn. They
         now all resolve to Satoshi, so the type change lands everywhere at
         once. `font-serif` is the new one, and it is intentionally the only
         way to reach Sentient — see the note in theme.css about keeping the
         serif off data. */
      fontFamily: {
        brand: ['Satoshi', 'system-ui', 'sans-serif'],
        display: ['Satoshi', 'system-ui', 'sans-serif'],
        /* grotesk carries the SUPPORTING text app-wide — kickers, list
           sub-lines, table cells, form labels, timestamps — and points at
           DM Sans, whose quieter geometric numerals read calmer at small
           sizes than Satoshi's punchier default. brand/display/body (the
           actual headings and hero numbers) stay on Satoshi. Two faces,
           two distinct jobs: Satoshi says "this is the important number on
           the screen", DM Sans says "this is context for it".
           Set HERE rather than as a CSS override in theme.css: a
           `.font-grotesk` rule there would tie with Tailwind's own utility
           on specificity and win only by source order, which is a silent
           trap for whoever edits the file next. */
        grotesk: ['DM Sans', 'system-ui', 'sans-serif'],
        body: ['Satoshi', 'system-ui', 'sans-serif'],
        serif: ['Sentient', 'Georgia', 'serif'],
      },
      borderRadius: {
        card: '16px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08)',
        'card-dark': '0 24px 48px -24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04)',
        'card-hover': '0 32px 64px -28px rgba(0,0,0,.7), 0 0 0 1px rgba(196,248,42,.08)',
        'card-hover-dark': '0 32px 64px -28px rgba(0,0,0,.85), 0 0 0 1px rgba(196,248,42,.1)',
        glow: '0 0 20px rgba(196,248,42,.4)',
        ember: '0 6px 20px -8px rgba(168,217,36,.5)',
        gold: '0 6px 20px -8px rgba(196,248,42,.4)',
        inner: 'inset 0 1px 0 rgba(255,255,255,.05)',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: 0, transform: 'translateY(8px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: 0 },
          '100%': { opacity: 1 },
        },
        scaleIn: {
          '0%': { opacity: 0, transform: 'scale(.97)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
      },
      animation: {
        fadeUp: 'fadeUp .3s cubic-bezier(.22,.8,.3,1) both',
        fadeIn: 'fadeIn .25s ease both',
        scaleIn: 'scaleIn .22s cubic-bezier(.22,.8,.3,1) both',
      },
      opacity: {
        2: '.02', 3: '.03', 4: '.04', 8: '.08', 12: '.12', 15: '.15', 35: '.35', 45: '.45', 55: '.55', 65: '.65', 85: '.85',
      },
    },
  },
  plugins: [],
};
