// Lazily loads Google Identity Services' script exactly once, however
// many times ANY component mounts -- a second <script> tag would
// re-run GIS's own init and can throw. Shared by IndependentLogin.jsx
// (client sign-in) and SetupOrg.jsx (gym-owner "Continue with Google")
// rather than each keeping its own copy.
const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiPromise = null;

export function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_SRC;
      s.async = true;
      s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Google Sign-In. Check your connection and try again.'));
      document.head.appendChild(s);
    });
  }
  return gsiPromise;
}
