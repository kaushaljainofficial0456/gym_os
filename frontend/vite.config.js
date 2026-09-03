import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors vercel.json's production CSP (F-06) so `npm run preview` (the
// real production build, not the dev server -- see the `preview` block
// below for why) is a genuine local rehearsal of exactly what production
// sends. Verified live against this: login/signup, the client dashboard,
// an active workout session (set/rep input forms), the Progress tab's
// recharts SVG, and the 3D anatomy view's WebGL canvas -- zero CSP
// violations. Keep this string in sync with vercel.json's copy by hand;
// there is no single source both configs can import from (one is JSON
// consumed by Vercel's edge, the other is this JS config file).
const PRODUCTION_CSP = "default-src 'self'; script-src 'self' https://checkout.razorpay.com https://accounts.google.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.openfoodfacts.org https://*.openfoodfacts.net; font-src 'self'; connect-src 'self' https://*.razorpay.com https://accounts.google.com; frame-src https://*.razorpay.com https://accounts.google.com; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  },
  // `vite preview` serves the real production build (no dev-mode inline
  // HMR/Fast-Refresh preamble, which a strict script-src would otherwise
  // -- and did, when first tried against `vite dev` -- correctly flag as
  // a CSP violation for code that never ships) -- this is the accurate
  // way to browser-verify the exact CSP string vercel.json will send.
  preview: {
    port: Number(process.env.PORT) || 5173,
    headers: {
      'Content-Security-Policy': PRODUCTION_CSP
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  }
});
