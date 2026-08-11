/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#070A11',
        bg2: '#0C101A',
        panel: '#10151F',
        panel2: '#161C29',
        line: 'rgba(255,255,255,.08)',
        ink: '#F5F7FC',
        mute: 'rgba(245,247,252,.62)',
        faint: 'rgba(245,247,252,.36)',
        ember: '#FF6B3E',
        gold: '#FFC24B',
        cyanx: '#35D7FF',
        violetx: '#9B7CFF',
        good: '#4ADE80',
        warn: '#FFC857',
        bad: '#FF5C5C'
      },
      fontFamily: {
        brand: ['Unbounded', 'sans-serif'],
        grotesk: ['"Space Grotesk"', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif']
      },
      borderRadius: {
        card: '20px'
      },
      opacity: {
        2: '.02', 3: '.03', 4: '.04', 8: '.08', 12: '.12', 15: '.15', 35: '.35', 45: '.45', 55: '.55', 65: '.65', 85: '.85'
      },
      boxShadow: {
        card: '0 30px 60px -32px rgba(0,0,0,.75), inset 0 1px 0 rgba(255,255,255,.05)',
        'card-hover': '0 36px 70px -34px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,.05), 0 0 40px -18px rgba(255,107,62,.18)',
        glow: '0 0 24px rgba(255,107,62,.5)',
        ember: '0 8px 28px -10px rgba(255,107,62,.6)',
        gold: '0 8px 28px -10px rgba(255,194,75,.5)',
        inner: 'inset 0 1px 0 rgba(255,255,255,.06)'
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: 0, transform: 'translateY(10px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' }
        }
      },
      animation: {
        fadeUp: 'fadeUp .32s cubic-bezier(.22,.8,.3,1) both'
      }
    }
  },
  plugins: []
};
