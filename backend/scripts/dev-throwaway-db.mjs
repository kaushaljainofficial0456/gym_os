// ============================================================
// SECURITY-VERIFICATION-ONLY dev entry point. Boots the exact same
// server as `npm run dev` (src/index.js's own isMain check), but forces
// SQLITE_PATH to a throwaway file in the OS temp dir BEFORE config.js is
// ever imported (env vars must be set before that import, not after --
// config.js reads them once, at import time).
//
// Exists so interactive browser-based verification (login, session
// flows, security-header checks) never touches backend/data/physique.db,
// no matter how the dev server is launched -- cross-platform-safe (pure
// Node, no shell-specific `set`/`export` syntax) rather than relying on
// PowerShell/bash env-var syntax differing across how this might be
// invoked.
// ============================================================
import os from 'node:os';
import path from 'node:path';

process.env.SQLITE_PATH = path.join(os.tmpdir(), 'skos-security-verify.db');
delete process.env.DATABASE_URL;
console.log(`[dev-throwaway-db] SQLITE_PATH -> ${process.env.SQLITE_PATH} (never the real dev DB)`);

// index.js's own "start a listener" logic only fires when it is the
// DIRECTLY invoked entry point (process.argv[1] === this file) -- true
// for `node src/index.js`, false when it's imported from a wrapper like
// this one. Start the listener explicitly instead of relying on that.
const { buildApp } = await import('../src/index.js');
const { config } = await import('../src/config.js');
const app = await buildApp();

app.listen(config.port, () => {
  console.log(`[dev-throwaway-db] listening on http://127.0.0.1:${config.port}`);
});

// TEST-ONLY, this-file-only: a SEPARATE tiny HTTP server (own port, own
// Express app) that reads the SAME in-memory mock email outbox -- same
// process, same module instance, so it sees whatever the main app just
// sent. Deliberately not mounted on the main `app` above: that app's own
// buildApp() already registers a catch-all 404 handler as the very last
// middleware, so anything appended after buildApp() returns is dead code.
// A second server sidesteps that entirely without touching src/index.js.
// Lets an interactive/browser verification pass read the token a
// verification/reset link actually contains, without ever printing a raw
// secret to a shared log. Never wired into src/index.js, never shipped,
// and this whole script only runs when explicitly invoked by name.
const { _mockOutbox } = await import('../src/services/notifications/emailProvider.js');
const express = (await import('express')).default;
const testApp = express();
testApp.get('/outbox', (req, res) => res.json(_mockOutbox()));
testApp.listen(config.port + 1, () => {
  console.log(`[dev-throwaway-db] test-only outbox reader on http://127.0.0.1:${config.port + 1}/outbox`);
});
