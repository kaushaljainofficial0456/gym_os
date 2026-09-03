import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Splits the React runtime into its own long-lived chunk,
        // separate from the app's own code (which changes on every
        // deploy). Rollup's default chunking already isolates the
        // genuinely large, already-lazy-loaded dependencies correctly
        // (three.js/@react-three/* -> three.module, ~734 kB; recharts ->
        // charts, ~387 kB -- neither loads until a page that actually
        // needs 3D visuals or a chart is visited, confirmed by reading
        // this app's own lazy-route setup in App.jsx, not assumed). The
        // one chunk that DOES load on every single page view is the
        // main `index` bundle (~394 kB / ~125 kB gzip), and it's
        // React + React DOM + React Router + this app's own shared
        // shell code -- there's no unused/avoidable weight to trim out
        // of it (every dependency in package.json here is genuinely
        // used app-wide, not a redesign candidate). Pulling react/
        // react-dom/react-router-dom into their own vendor chunk doesn't
        // shrink what a FIRST visit downloads, but it does mean that
        // chunk's content (and its browser cache entry) stays identical
        // across deploys that only touch app code -- a real, if modest,
        // repeat-visit win, and the standard, low-risk way to split a
        // Vite/Rollup bundle without touching how any route loads.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  }
});
