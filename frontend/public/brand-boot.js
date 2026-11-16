/*
 * A gym's own colours, before the app has loaded.
 *
 * Loaded synchronously from <head>, ahead of the app bundle, so a member of
 * a gym with its own look never sees one frame of the default Barbell
 * colours first. It only replays what the app itself last applied
 * (src/brand/BrandProvider.jsx writes 'sk-os-brand'); the app re-derives
 * and corrects it the moment it starts. A plain file rather than an inline
 * script because the Content-Security-Policy allows scripts from our own
 * origin only.
 */
(function () {
  try {
    var raw = window.localStorage.getItem('sk-os-brand');
    if (!raw) return;
    var b = JSON.parse(raw);
    if (!b || typeof b.css !== 'string' || b.css.indexOf('<') !== -1) return;
    var style = document.createElement('style');
    style.id = 'gym-brand-style';
    style.textContent = b.css;
    document.head.appendChild(style);
    document.documentElement.classList.add('gym-brand');
    var light = window.localStorage.getItem('sk-os-theme') === 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && b.themeColor) meta.setAttribute('content', light ? b.themeColor.light : b.themeColor.dark);
  } catch (e) { /* storage blocked: the app applies the theme itself */ }
})();
