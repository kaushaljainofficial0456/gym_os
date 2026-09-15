# GymOS for Android

The GymOS Android app is a [Capacitor 8](https://capacitorjs.com) shell around
the **live GymOS web app**. The APK does not contain a copy of the UI: its
WebView opens the production origin, and a small native layer adds the things
a browser tab gets for free but an embedded WebView does not.

Web and Android therefore ship the same screens, forms, validation, API calls
and business logic from one codebase. A web deploy updates both. A new APK is
only needed when something in `mobile/` changes.

## Why a shell around the live site

Before choosing this, the web app was checked for what a bundled copy (the
usual Capacitor setup) would break:

| The web app relies on | Bundled in the APK (`https://localhost`) | Live origin in the WebView |
| --- | --- | --- |
| httpOnly `sk_token` session cookie, `SameSite=strict` | Cross-site to the API, so never sent. It would need `SameSite=None` or bearer tokens in JS, weakening the web app too. | First-party, unchanged |
| Relative `/api` and `/uploads` paths | Every call and image rewritten to an absolute API URL, plus CORS | Unchanged |
| `window.location.origin` in share and invite links | Links point at `https://localhost` | Correct links |
| Vercel CSP and security headers | Not applied | Applied |
| Google Sign-In and Razorpay allowed origins | New origin to register | Same origin |

A native rewrite (Kotlin, React Native, Flutter) would duplicate the entire
product and drift from it. The shell reuses all of it.

The trade-off is that the app needs a network connection to open. The web app
already needs one for everything it does, starting with the session check on
launch. When the origin cannot be reached, the app shows a GymOS-styled
offline screen that reconnects by itself.

## What the native layer adds

| Area | Plain WebView | GymOS shell |
| --- | --- | --- |
| Back button | Closes the app | Steps back inside the screen first: the open dialog, or the screen's own Back control (such as the sign-in steps). Then it steps back through the app's history. From a home screen (`/app/client`, `/app/trainer`, `/login`, ...) it sends GymOS to the background instead of bouncing onto the sign-in screen. |
| Share sheets (meal, workout, invite) | No `navigator.share`, so they silently fell back to copy-link | Android share sheet (`@capacitor/share`) |
| Invoice PDF downloads | `<a download href="blob:">` does nothing | Saved to Downloads, then opened |
| `window.open` / `target="_blank"` | Replaces the app page, and Razorpay checkout loses its opener | Sheet over the app, with close and Back. Other sites open in the browser. |
| WHOOP / Oura connect | OAuth page opens in the browser, so the callback never returns to the app | Stays in the app, like the web flow |
| `intent:` / `upi:` links from a payment page | Ignored | Open the named app |
| Barcode / QR scanner, photo capture | No camera permission | Camera permission asked on first use |
| Status and navigation bars | Generic | Follow the app's light/dark theme |
| Launch | Blank white WebView | Splash with the Barbell mark until GymOS paints |
| Shared links (`/share/`, `/workout-share/`, `/invite/`, `/reset-password`) | Browser only | Open in the app (see Deep links) |
| Session | Cookies written lazily; app data included in backups | Cookies flushed when backgrounded; nothing backed up or transferred to another phone |

The web app needs no changes for any of this. The bridge lives in
`src/shell.js`, which `MainActivity` injects into the GymOS origin at document
start.

## Layout

```
mobile/
  capacitor.config.js      app id, GymOS origin (server.url), in-app hosts
  src/shell.js             injected script: share, downloads, Back, theme
  src/offline.html         offline screen (dark theme tokens, DM Sans)
  scripts/build-www.mjs    builds www/ (offline page + shell script, never the web app)
  scripts/gradle.mjs       runs the Gradle wrapper on any OS
  scripts/local-stack.mjs  disposable local API + web build for emulator testing
  test/shell.test.js       unit tests for src/shell.js
  android/app/src/main/java/com/gymos/app/
    MainActivity.java      splash, Back, deep links, theme, cookie flush
    GymOSShellPlugin.java  native side of shell.js; in-app hosts; intent: links
    PopupWindows.java      window.open / target=_blank
    Downloads.java         save and open downloaded files
    ...
```

## Build

Requirements: Node 22+, JDK 21, and the Android SDK with platform 36 and
build-tools 35. Set `JAVA_HOME` and `ANDROID_HOME` accordingly.

```bash
cd mobile
npm ci
npm test               # shell.js unit tests
npm run test:android   # JVM unit tests for the native layer
npm run apk:debug      # android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run sync` regenerates `www/` and copies it and the config into the
Android project. Every `apk:*` script runs it first.

### Release signing

Signing material never lives in the repo. Create `mobile/keystore.properties`
(gitignored), or point `GYMOS_KEYSTORE_PROPERTIES` at a file elsewhere:

```properties
storeFile=/absolute/path/to/gymos-release.jks
storePassword=...
keyAlias=gymos
keyPassword=...
```

Then `npm run apk:release` produces
`android/app/build/outputs/apk/release/app-release.apk`. Without the file, the
release APK is unsigned and will not install.

Back up the keystore and its password. An installed app can only be updated
by an APK signed with the same key.

### Another deployment

`GYMOS_SERVER_URL` points a build at a different GymOS origin, such as a
Vercel preview. Only `https` origins are accepted, plus the emulator's
`http://10.0.2.2` alias, which only debug builds allow.

```bash
GYMOS_SERVER_URL=https://<preview>.vercel.app npm run apk:debug
```

Rebuild without it before sharing an APK. The built APK's
`assets/capacitor.config.json` shows which origin it opens.

## Testing against a local stack

`scripts/local-stack.mjs` starts the API on a throwaway SQLite database,
reseeded with the repo's demo fixtures, and serves the production web build
with `vite preview`. The emulator reaches it as `10.0.2.2`.

```bash
(cd frontend && npm run build)
node mobile/scripts/local-stack.mjs
cd mobile && GYMOS_SERVER_URL=http://10.0.2.2:4311 npm run apk:debug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Deep links

The app declares `https://<GymOS host>` links for `/share/`,
`/workout-share/`, `/invite/` and `/reset-password`, with `autoVerify`.

Android 12+ opens such links in the app by default only after verifying the
domain. That needs `https://<GymOS host>/.well-known/assetlinks.json` listing
`com.gymos.app` and the SHA-256 fingerprint of the signing key. Until that
file is deployed, links still open in the browser; a user can turn on
*Open supported links* in the app's settings.
