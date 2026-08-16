/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /* ── Dark mode (default) ── */
        bg: { DEFAULT: '#080C10', light: '#F7F3EE' },
        bg2: { DEFAULT: '#0E1418', light: '#EFE6DE' },
        panel: { DEFAULT: '#111920', light: '#FFFFFF' },
        panel2: { DEFAULT: '#162128', light: '#F5EDE4' },
        line: { DEFAULT: 'rgba(255,255,255,.07)', light: 'rgba(91,70,54,.10)' },
        ink: { DEFAULT: '#F0F4F3', light: '#3D2B1A' },
        mute: { DEFAULT: 'rgba(240,244,243,.55)', light: 'rgba(61,43,26,.55)' },
        faint: { DEFAULT: 'rgba(240,244,243,.30)', light: 'rgba(61,43,26,.32)' },
        ember: '#0A8A85',
        gold: '#14C4BC',
        cyanx: '#38D8FF',
        violetx: '#A080FF',
        good: '#34D399',
        warn: '#FBBF24',
        bad: '#F87171',
      },
      fontFamily: {
        brand: ['"DM Sans"', 'sans-serif'],
        display: ['"DM Sans"', 'sans-serif'],
        grotesk: ['"Plus Jakarta Sans"', 'sans-serif'],
        body: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '16px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08)',
        'card-dark': '0 24px 48px -24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04)',
        'card-hover': '0 32px 64px -28px rgba(0,0,0,.7), 0 0 0 1px rgba(20,196,188,.08)',
        'card-hover-dark': '0 32px 64px -28px rgba(0,0,0,.85), 0 0 0 1px rgba(20,196,188,.1)',
        glow: '0 0 20px rgba(20,196,188,.4)',
        ember: '0 6px 20px -8px rgba(10,138,133,.5)',
        gold: '0 6px 20px -8px rgba(20,196,188,.4)',
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
