import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SK OS Admin Console -- a genuinely SEPARATE frontend app from
// frontend/ (the gym-owner/trainer/client application), per the
// hardening spec's explicit "DO NOT add the Admin Console as a normal
// route inside the client/trainer/owner frontend" instruction. Own
// package, own build, own (future) deploy target -- see admin/vercel.json.
//
// Dev proxy mirrors frontend/vite.config.js's own pattern exactly: /api
// -> the local backend on port 4000 (overridable via VITE_API_TARGET),
// so `npm run dev` here talks to the SAME backend the main app already
// uses (no separate backend for the console -- it reuses
// /api/console/* + the shared /api/auth/* login route).
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
});
