# SKOS_15 — Dev Server Run Doc

## How to Reproduce

1. Dependencies are already installed in the main checkout.
2. Start the backend:
   - From the project root: `cd backend && node src/index.js`
   - Or with explicit port: `set PORT=4000 && cd backend && node src/index.js`
3. Start the frontend:
   - From the project root: `cd frontend && npx vite --port 5173`
4. Open `http://localhost:5173/`

## Login Credentials

- Client: `kaushal@test.com` / `demo1234`
- Trainer: `trainer1@test.com` / `demo1234`
- Owner: `owner@test.com` / `demo1234`

## Ports

- Backend: 4000
- Frontend: 5173

## Notes

- Zero-cost AI safety: paid providers are disabled by default. No API keys needed.
- SQLite database at `backend/data/physique.db`
- Food estimation uses local SKOS data (21,353+ foods, zero network calls)
- Security: httpOnly cookie auth, security headers, setup-org gated in production
