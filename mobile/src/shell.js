/*
 * GymOS Android shell script.
 *
 * MainActivity injects this into the GymOS origin -- and only that origin --
 * at document start, before any of the web app's own scripts run. It closes
 * the few gaps between Android System WebView and the mobile Chrome the web
 * app was built for, without the web app needing to know it is in an APK:
 *
 *   - navigator.share: WebView has none, so every share sheet silently fell
 *     back to copy-link. Routed to Android's native share sheet instead.
 *   - Blob downloads (invoice PDFs): WebView ignores <a download href="blob:">.
 *     The blob is handed to the native side, saved to Downloads and opened.
 *   - The Back button: steps back inside the screen first (the open dialog,
 *     or the screen's own Back control), then walks the app's own history,
 *     and leaves the app from a home screen instead of stepping back onto a
 *     sign-in screen that would immediately bounce forward again.
 *   - Light/dark theme: mirrored onto the status and navigation bars.
 *
 * Also loaded as a CommonJS module by test/shell.test.js, which exercises the
 * decision logic without a browser.
 */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (window.top === window) {
    api.install(window);
  }
})(function () {
  'use strict';

  // Back leaves the app from these instead of stepping back. The entry before
  // any of them is a sign-in, onboarding or legal step already completed, and
  // App.jsx's GuestOnly/Require guards would send the user straight forward
  // again -- so stepping back would look like the button did nothing.
  const HOME_PATHS = new Set(['/', '/login', '/app', '/app/client', '/app/trainer', '/join', '/legal']);

  const DIALOG_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"]';
  const CLOSE_BUTTON_SELECTOR = 'button[aria-label="Close"], button[aria-label^="Close "]';
  // Filter chips and tabs can read "Back" too: it is a muscle group.
  const TOGGLE_SELECTOR = '[role="tab"], [role="radio"], [aria-pressed], [aria-selected], .chip';

  function normalizePath(pathname) {
    const trimmed = String(pathname || '/').replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
  }

  function backAction({ pathname, backControl, dialogOpen, canGoBack }) {
    if (backControl) return 'press-back';
    if (dialogOpen) return 'close-dialog';
    if (HOME_PATHS.has(normalizePath(pathname))) return 'exit';
    return canGoBack ? 'history' : 'exit';
  }

  function isShown(el) {
    return !!el && el.isConnected !== false && el.getClientRects().length > 0;
  }

  // Dialogs are portalled to the end of <body>, so the last visible match in
  // document order is the one on top.
  function topmostDialog(doc) {
    const all = doc.querySelectorAll(DIALOG_SELECTOR);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (isShown(all[i])) return all[i];
    }
    return null;
  }

  // The screen's own one-step-back control. PageHeader, Modal and FoodLogSheet
  // label theirs aria-label="Back"; the sign-in steps, onboarding, the app tour
  // and a few multi-step forms use a button that just reads "Back". Those steps
  // have no history entry, so Back has to press the control to land where the
  // user expects. The last visible one is the innermost step.
  function findBackControl(scope) {
    const candidates = scope.querySelectorAll('button, a[href]');
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const el = candidates[i];
      const named = el.getAttribute('aria-label') === 'Back' || el.textContent.trim() === 'Back';
      if (named && !el.disabled && !el.matches(TOGGLE_SELECTOR) && isShown(el)) return el;
    }
    return null;
  }

  function closeDialog(win, dialog) {
    const doc = win.document;
    const origin = dialog.contains(doc.activeElement) ? doc.activeElement : dialog;
    origin.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    // Most GymOS dialogs close on Escape; a few only offer a Close button.
    // Give React a frame to unmount the dialog, then press that button if the
    // dialog is still up. A dialog with neither (a mandatory onboarding step)
    // stays open, and Back does nothing -- it never navigates away beneath it.
    win.requestAnimationFrame(() => {
      if (!isShown(dialog)) return;
      const close = dialog.querySelector(CLOSE_BUTTON_SELECTOR);
      if (close) close.click();
    });
  }

  function handleBack(win, canGoBack) {
    const dialog = topmostDialog(win.document);
    const control = findBackControl(dialog || win.document);
    const action = backAction({ pathname: win.location.pathname, backControl: !!control, dialogOpen: !!dialog, canGoBack });
    if (action === 'press-back') control.click();
    else if (action === 'close-dialog') closeDialog(win, dialog);
    else if (action === 'history') win.history.back();
    return action;
  }

  // Web Share data -> @capacitor/share options. Null when there is nothing the
  // native sheet can send (it shares text and links, not files).
  function toShareOptions(data) {
    const d = data || {};
    if (d.files && d.files.length) return null;
    if (!d.url && !d.text) return null;
    const options = {};
    if (d.title) {
      options.title = String(d.title);
      options.dialogTitle = String(d.title);
    }
    if (d.text) options.text = String(d.text);
    if (d.url) options.url = String(d.url);
    return options;
  }

  function installShare(win, plugin) {
    const nav = win.navigator;
    if (typeof nav.share === 'function') return;
    let sharing = false;
    nav.share = function share(data) {
      const options = toShareOptions(data);
      if (!options) return Promise.reject(new win.TypeError('Only text and links can be shared'));
      const Share = plugin('Share');
      if (!Share) return Promise.reject(new win.DOMException('Sharing is not available', 'NotAllowedError'));
      if (sharing) return Promise.reject(new win.DOMException('A share is already in progress', 'InvalidStateError'));
      sharing = true;
      return Share.share(options).then(
        () => { sharing = false; },
        (err) => {
          sharing = false;
          throw new win.DOMException(String((err && err.message) || err), 'AbortError');
        },
      );
    };
    nav.canShare = function canShare(data) {
      return toShareOptions(data) !== null;
    };
  }

  function readAsBase64(win, blob) {
    return new Promise((resolve, reject) => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function installDownloads(win, plugin) {
    const urls = win.URL;
    const create = urls.createObjectURL;
    const revoke = urls.revokeObjectURL;
    // Blob URLs cannot be fetched from native code, and api.js's downloadFile()
    // revokes the URL the moment after click() returns -- so the Blob itself is
    // remembered at creation and picked up synchronously in the click handler.
    // Holding it here keeps it alive no longer than the URL registry already
    // does: the entry is dropped as soon as the page revokes the URL.
    const blobs = new Map();
    urls.createObjectURL = function createObjectURL(obj) {
      const url = create.call(urls, obj);
      if (obj instanceof win.Blob) blobs.set(url, obj);
      return url;
    };
    urls.revokeObjectURL = function revokeObjectURL(url) {
      blobs.delete(url);
      return revoke.call(urls, url);
    };

    win.document.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
      const blob = anchor ? blobs.get(anchor.href) : undefined;
      if (!blob) return;
      event.preventDefault();
      const shell = plugin('GymOSShell');
      if (!shell) return;
      readAsBase64(win, blob)
        .then((data) => shell.saveDownload({
          data,
          filename: anchor.getAttribute('download') || '',
          mimeType: blob.type || 'application/octet-stream',
        }))
        // The native side already tells the user when a save fails.
        .catch(() => {});
    }, true);
  }

  function themeOf(doc) {
    return doc.documentElement.classList.contains('light') ? 'light' : 'dark';
  }

  function installThemeSync(win, plugin) {
    let reported = null;
    const report = () => {
      const theme = themeOf(win.document);
      const shell = plugin('GymOSShell');
      if (theme === reported || !shell) return;
      reported = theme;
      shell.setTheme({ theme });
    };
    const observe = () => {
      new win.MutationObserver(report).observe(win.document.documentElement, { attributes: true, attributeFilter: ['class'] });
      report();
    };
    if (win.document.documentElement) observe();
    else win.document.addEventListener('DOMContentLoaded', observe, { once: true });
  }

  function install(win) {
    if (win.__gymosShell) return;
    // Resolved on every use: this script runs before Capacitor's own bridge
    // script has defined window.Capacitor.
    const plugin = (name) => (win.Capacitor && win.Capacitor.Plugins ? win.Capacitor.Plugins[name] : undefined);
    installShare(win, plugin);
    installDownloads(win, plugin);
    installThemeSync(win, plugin);
    Object.defineProperty(win, '__gymosShell', {
      value: Object.freeze({ back: (canGoBack) => handleBack(win, canGoBack === true) }),
    });
  }

  return { install, backAction, findBackControl, normalizePath, toShareOptions, topmostDialog, HOME_PATHS };
});
