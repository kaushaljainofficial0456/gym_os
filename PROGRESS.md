# OAuth `origin_mismatch` — Progress Log

**Status as of 2026-09-04: ROOT CAUSE CONFIRMED (100%, reproduced live). Fix is BLOCKED on one manual action only the account owner can take — see "Remaining action" below. No code changes needed or made.**

Do not re-investigate from scratch. Read this whole file first, then jump to "Remaining action."

---

## Task

Google Sign-In on production (`https://gym-os-nikhaar-fashions-connect.vercel.app`) fails with
`Error 400: origin_mismatch` ("Access blocked: Authorisation error"). Fix it completely.

## Conclusion

This is **not an application bug**. It is a missing entry in the Google Cloud Console OAuth
client's "Authorized JavaScript origins" list. Every app-side thing that could plausibly be wrong
has been individually verified correct and live-tested. The only remaining step requires signing
in to Google Cloud Console with the project owner's Google account, which Claude cannot and will
not do (no credentials, and this class of action — modifying security/OAuth settings on a
third-party account — is out of scope for Claude to perform even with access). This step is
otherwise ready to go: exact values are below, no guessing required.

## Evidence trail (everything already verified — do not repeat)

1. **Code audit** (session 1) — [frontend/src/googleIdentity.js](frontend/src/googleIdentity.js),
   [frontend/src/pages/IndependentLogin.jsx](frontend/src/pages/IndependentLogin.jsx),
   [frontend/src/pages/SetupOrg.jsx](frontend/src/pages/SetupOrg.jsx),
   [backend/src/routes/auth.js](backend/src/routes/auth.js) — all correct. Standard GIS popup
   flow (ID-token only, no redirect URIs involved — confirms the error is specifically the
   *JavaScript origins* list, not *redirect URIs*), same Client ID used frontend+backend,
   backend verifies token audience server-side. `vercel.json` / `vite.config.js` CSP already
   allow `accounts.google.com` (`script-src`, `connect-src`, `frame-src`) — not a CSP block.

2. **Production domain confirmed**: `https://gym-os-nikhaar-fashions-connect.vercel.app`
   (Vercel project `gym-os` under team/org `nikhaar-fashions-connect`; corroborated by
   [IMPLEMENTATION.md:1002](IMPLEMENTATION.md:1002) and `vercel project ls`). This is the
   **stable production domain**, not a per-push preview hash URL — so the "which URL" branch of
   the investigation is closed: it's production itself that's unregistered, not preview churn.

3. **`vercel env ls`**: `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID` both exist, scoped to
   Production+Preview, added 10 days ago. `CORS_ORIGINS` also present.

4. **Red herring, ruled out**: `vercel env pull --environment=production` returns an **empty
   string** for `GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_ID`, `CORS_ORIGINS`, `JWT_SECRET`,
   `DATABASE_URL`, and every other dashboard-set *encrypted* secret (but NOT for
   `VITE_RAZORPAY_KEY_ID` / `NEXT_PUBLIC_RAZORPAY_KEY_ID`, which pull fine). This looked alarming
   at first (like the vars had been wiped) but was **directly disproven** by steps 5–6 below — the
   real runtime/build values are present and correct. Treat this as a `vercel env pull` CLI
   quirk/limitation for certain encrypted vars on this account, not a real config gap. Don't waste
   time chasing it again; it's cosmetic to this task.

5. **Live frontend check** (Browser pane, no login, no popup-blocked dead end — see step 6):
   navigated to `/independent` on the real production URL. The "Continue with Google" button
   rendered normally (not the app's own "Google sign-in isn't configured yet" fallback), proving
   `VITE_GOOGLE_CLIENT_ID` **is** baked into the live build. Clicking it, `read_console_messages`
   captured the exact outgoing GIS request:
   ```
   client_id=64705102283-0ee8sj1et2qab5tv7e53p19e93jkm6gq.apps.googleusercontent.com
   origin=https%3A%2F%2Fgym-os-nikhaar-fashions-connect.vercel.app
   ```
   (Popup itself was blocked by the browser-automation sandbox, not by Google — expected in that
   environment, unrelated to this bug.)

6. **Live reproduction of the exact error, credential-free**: took the captured
   `accounts.google.com/o/oauth2/v2/auth?...` URL from step 5 and navigated directly to it (full
   page nav instead of popup — same request Google receives either way). Google immediately
   redirected to `accounts.google.com/signin/oauth/error?authError=...origin_mismatch...`,
   rendering the identical "Access blocked: Authorisation error / Error 400: origin_mismatch"
   page the user screenshotted — reproduced independently, live, on today's production
   deployment, with zero Google account interaction. **This is definitive**: Google itself is
   rejecting Client ID `64705102283-...apps.googleusercontent.com` for origin
   `https://gym-os-nikhaar-fashions-connect.vercel.app` right now.

7. **Backend runtime check**: `curl -X POST https://gym-os-nikhaar-fashions-connect.vercel.app/api/auth/google -d '{"credential":"<bogus 20+ char string>"}'` → **HTTP 401** ("Could not verify
   Google sign-in"), not the 503 that [auth.js](backend/src/routes/auth.js) would return if
   `GOOGLE_CLIENT_ID` were unset server-side (`if (!googleClient) return res.status(503)...`).
   Confirms the backend's runtime `GOOGLE_CLIENT_ID` is also correctly set — fully closes out the
   step-4 red herring for the backend side too.

**Net result: app code, build-time env var, and runtime env var are all confirmed correct and
consistent. The one and only thing wrong is Google Cloud Console's own OAuth client
configuration.**

## Remaining action (needs the account owner — Claude cannot do this step)

Sign in to Google Cloud Console with the Google account that owns this OAuth client, then:

1. Go to **APIs & Services → Credentials**:
   https://console.cloud.google.com/apis/credentials
2. Open the **OAuth 2.0 Client ID** whose Client ID is exactly:
   ```
   64705102283-0ee8sj1et2qab5tv7e53p19e93jkm6gq.apps.googleusercontent.com
   ```
   (Type: Web application — search/filter by this exact string if there are multiple clients on
   the project.)
3. Under **Authorized JavaScript origins**, click **+ Add URI** and add exactly:
   ```
   https://gym-os-nikhaar-fashions-connect.vercel.app
   ```
   (No trailing slash, no path — scheme + host only. Keep `http://localhost:5173` if it's already
   there for local dev.)
4. Click **Save**.
5. Wait a few minutes for propagation (Google: usually fast, can rarely take longer).
6. Tell Claude (or whoever picks up this task) that it's saved, so step 6's live reproduction
   above can be re-run to confirm the fix — see "How to re-verify" below. Don't rely on the phone
   browser alone; it may have cached the failed state briefly after the change.

Optional but recommended while in there: if there's a custom domain planned for this app, or a
Vercel preview alias in regular use (e.g. `gym-os-nikhaar-fashions-connect-git-<branch>-<scope>.vercel.app`), add those origins too now to avoid repeating this ticket later.

## How to re-verify once the user says it's done (no login needed, ~2 min)

Repeat steps 5–6 from the evidence trail:
1. Browser pane → navigate to `https://gym-os-nikhaar-fashions-connect.vercel.app/independent`.
2. Click "Continue with Google", capture the fresh `accounts.google.com/o/oauth2/v2/auth?...`
   request URL via `read_console_messages` (the `as=` state param is single-use/short-lived, so
   grab a **new** one each time — don't reuse the URL logged in this file).
3. Navigate directly to that captured URL.
   - **Fixed**: lands on a normal Google account chooser (`accounts.google.com/signin/oauth/...`
     account selection UI, no "Access blocked").
   - **Still broken**: redirects to `signin/oauth/error?authError=...origin_mismatch...` again —
     re-check steps 1–4 above were done exactly (exact origin string, exact client ID, saved).
4. Do **not** complete an actual sign-in (no Google account login) — reaching the account chooser
   without an error is sufficient proof the origin is now authorized; going further would mean
   signing into somebody's real Google account, which Claude does not do.
5. Once confirmed fixed, update this file's Status line to RESOLVED with the date, and that's the
   completion condition satisfied.

## Explicitly ruled out (don't re-check these)

- App code (frontend GIS wiring, backend token verification) — correct.
- CSP blocking `accounts.google.com` — allowed in both `vercel.json` and `vite.config.js`.
- Wrong/missing env vars at build or runtime — both confirmed present and correct via live
  behavior (steps 5–7), independent of the misleading `vercel env pull` output (step 4).
- Preview-deployment URL churn — the failing origin is the stable production domain itself, not a
  rotating preview hash URL.
- Redirect URI mismatch — not applicable, this flow only uses JavaScript origins (no
  `redirect_uri` in the OAuth client config is involved).
