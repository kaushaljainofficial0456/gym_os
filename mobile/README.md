# GymOS for Android

> **Status (September 2026):** builds and passes its unit tests, and the APKs
> have been inspected (package, permissions, signature, bundled config).
> **It has not yet been run on a phone or emulator.** Work through the
> [on-device acceptance checklist](#on-device-acceptance-checklist) before
> distributing it, and see [Known limitations](#known-limitations).

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
domain against `https://<GymOS host>/.well-known/assetlinks.json`. That file
is `frontend/public/.well-known/assetlinks.json`: it lists `com.gymos.app`
and the SHA-256 fingerprint of the release signing key, and ships with the
web app.

- Verification happens when the app is installed, so it only succeeds once
  the file is live on the domain.
- Until then, links open in the browser; a user can turn on *Open supported
  links* in the app's settings.
- If the app is signed with another key (for example Google Play App
  Signing), add that key's fingerprint to the list.
- Debug builds are signed with a per-machine debug key and are not verified.

## Known limitations

- **Google Sign-In** (the *Independent client* screen, and *Continue with
  Google* when setting up a gym). Google does not allow its sign-in inside
  embedded WebViews, so these buttons are expected to be refused in the app.
  This has not yet been confirmed on a device. Email and password sign-in is
  unaffected.
  - The fix is native sign-in: Android Credential Manager, posting the same
    ID token to `/auth/google`.
  - That fix also needs an Android OAuth client (package `com.gymos.app` plus
    the signing key's SHA-1) in the Google Cloud project.
- **Browser notifications.** WebView has no Notification API, so the app's
  "enable notifications" prompt stays hidden, as in any browser without one.
  The in-app notification bell works normally. System push notifications
  would need a native implementation.
- **Needs a connection to open.** Without one, the offline screen shows until
  the network returns.
- **The admin console** (`admin/`) is a separate web app and is not part of
  this APK.
- **Naming.** The launcher name is *GymOS*; inside, the product is branded
  *Barbell*, exactly as on the web.

## On-device acceptance checklist

Install the release APK (`adb install -r GymOS-1.0.0-release.apk`), sign in
with real test accounts, and confirm each item. For crashes and WebView
errors, check `adb logcat --pid=$(adb shell pidof com.gymos.app)` throughout.

1. **Install and launch.** The launcher shows *GymOS* with the Barbell mark.
   A dark splash leads straight into the Barbell welcome screen, with no white
   flash, and the status bar icons stay legible.
2. **Sign in** as a client, a trainer and a gym owner; each lands on its home.
   Force-stop the app and reopen it: still signed in.
3. **Back.**
   - The sign-in steps (role, then form) step back one at a time.
   - An open sheet (for example, log food) closes.
   - A page with a header Back button steps back.
   - From a home screen, Back sends the app to the background, and reopening
     it restores the same screen.
4. **Navigation.** Bottom tabs, the profile menu, Settings, Help, and the
   trainer and owner sidebars all load.
5. **Forms and validation.** Invalid input shows the same field errors as on
   the web.
6. **Data persists.** Log food, record a workout set and edit the profile.
   Pull the data again after reopening the app: the changes are saved.
7. **Camera.** The food barcode scanner and the gym QR join both ask for
   camera permission once, then scan. The profile photo's *Take a photo*
   opens the camera.
8. **Uploads.** Choosing a profile or progress photo from the gallery
   uploads it and shows the image.
9. **Share.** Sharing a meal, a workout or a community invite opens Android's
   share sheet with the link.
10. **Downloads.** As an owner, *Enterprise → Billing → invoice* saves the
    PDF to Downloads and opens it.
11. **Payments.** Razorpay checkout opens in a sheet over the app. A test
    payment completes and returns to GymOS.
12. **Health devices.** *Connect WHOOP* (or Oura) opens the provider sign-in
    in the app and returns to Connected devices.
13. **Theme.** Switching light/dark recolours the status and navigation bars.
14. **Keyboard and rotation.** Focused fields stay above the keyboard, and
    rotating keeps the current screen and form input.
15. **Offline.** In airplane mode, opening the app shows the offline screen.
    Turning the network back on reconnects without a tap.
16. **External links.** The Contact page's email link opens a mail app; links
    to other sites open the browser.
17. **Deep links.**
    `adb shell am start -a android.intent.action.VIEW -d https://<host>/invite/<code>`
    opens the invite page inside the app.
18. **Sign out.** It returns to sign-in, and Back does not re-enter the app.
19. **Google Sign-In.** Record what happens (see Known limitations).
