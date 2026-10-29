const test = require('node:test');
const assert = require('node:assert/strict');
const shell = require('../src/shell.js');

test('Back closes an open dialog before doing anything else', () => {
  assert.equal(shell.backAction({ pathname: '/app/client', dialogOpen: true, canGoBack: false }), 'close-dialog');
  assert.equal(shell.backAction({ pathname: '/app/client/workout', dialogOpen: true, canGoBack: true }), 'close-dialog');
});

test('Back leaves the app from a home screen even when history exists', () => {
  for (const pathname of ['/', '/login', '/login/', '/app', '/app/client', '/app/trainer/', '/join', '/legal']) {
    assert.equal(shell.backAction({ pathname, dialogOpen: false, canGoBack: true }), 'exit', pathname);
  }
});

test('Back walks history from any other screen, and exits when there is none', () => {
  assert.equal(shell.backAction({ pathname: '/app/client/workout', dialogOpen: false, canGoBack: true }), 'history');
  assert.equal(shell.backAction({ pathname: '/signup', dialogOpen: false, canGoBack: true }), 'history');
  assert.equal(shell.backAction({ pathname: '/invite/abc123', dialogOpen: false, canGoBack: false }), 'exit');
});

test("Back presses the screen's own Back control before closing, stepping back or exiting", () => {
  assert.equal(shell.backAction({ pathname: '/login', backControl: true, dialogOpen: false, canGoBack: true }), 'press-back');
  assert.equal(shell.backAction({ pathname: '/app/client/workout', backControl: true, dialogOpen: true, canGoBack: true }), 'press-back');
  assert.equal(shell.backAction({ pathname: '/app/client', backControl: false, dialogOpen: true, canGoBack: false }), 'close-dialog');
});

function fakeButton({ label = null, text = '', toggle = false, shown = true, disabled = false }) {
  return {
    disabled,
    textContent: text,
    getAttribute: (name) => (name === 'aria-label' ? label : null),
    matches: () => toggle,
    getClientRects: () => (shown ? [{}] : []),
  };
}

test('the Back control is a real one-step-back button, never a filter chip named Back', () => {
  const scope = (buttons) => ({ querySelectorAll: () => buttons });
  const pageHeader = fakeButton({ label: 'Back', text: 'Back' });
  const signInStep = fakeButton({ text: '  Back ' });
  const muscleChip = fakeButton({ text: 'Back', toggle: true });
  assert.equal(shell.findBackControl(scope([pageHeader, signInStep, muscleChip])), signInStep);
  assert.equal(shell.findBackControl(scope([pageHeader, muscleChip])), pageHeader);
  assert.equal(shell.findBackControl(scope([muscleChip])), null);
  assert.equal(shell.findBackControl(scope([fakeButton({ text: 'Back', shown: false })])), null);
  assert.equal(shell.findBackControl(scope([fakeButton({ label: 'Back', disabled: true })])), null);
  assert.equal(shell.findBackControl(scope([fakeButton({ text: 'Back to sign in' })])), null);
});

test('share data maps onto the native share sheet options', () => {
  assert.deepEqual(
    shell.toShareOptions({ title: 'Leg day on Barbell', text: 'Check out this workout', url: 'https://example.test/workout-share/1' }),
    { title: 'Leg day on Barbell', dialogTitle: 'Leg day on Barbell', text: 'Check out this workout', url: 'https://example.test/workout-share/1' },
  );
  assert.deepEqual(shell.toShareOptions({ url: 'https://example.test/share/2' }), { url: 'https://example.test/share/2' });
  assert.equal(shell.toShareOptions({ title: 'Only a title' }), null);
  assert.equal(shell.toShareOptions({ url: 'https://example.test', files: [{}] }), null);
  assert.equal(shell.toShareOptions(undefined), null);
});

test('the topmost visible dialog is the last one in document order', () => {
  const hidden = { getClientRects: () => [] };
  const lower = { getClientRects: () => [{}] };
  const upper = { getClientRects: () => [{}] };
  assert.equal(shell.topmostDialog({ querySelectorAll: () => [lower, upper, hidden] }), upper);
  assert.equal(shell.topmostDialog({ querySelectorAll: () => [hidden] }), null);
});

function fakeWindow() {
  const listeners = {};
  const classes = new Set(['dark']);
  const calls = { share: [], saveDownload: [], setTheme: [] };
  let mutationCallback = null;
  const registry = new Map();
  let nextId = 0;
  const win = {
    navigator: {},
    Blob,
    DOMException,
    TypeError,
    URL: {
      createObjectURL(obj) { const url = `blob:https://gymos.test/${nextId += 1}`; registry.set(url, obj); return url; },
      revokeObjectURL(url) { registry.delete(url); },
    },
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload();
        });
      }
    },
    MutationObserver: class {
      constructor(cb) { mutationCallback = cb; }
      observe() {}
    },
    document: {
      documentElement: { classList: { contains: (c) => classes.has(c) } },
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelectorAll: () => [],
    },
    Capacitor: {
      Plugins: {
        Share: { share: async (options) => { calls.share.push(options); } },
        GymOSShell: {
          saveDownload: async (options) => { calls.saveDownload.push(options); },
          setTheme: (options) => { calls.setTheme.push(options); },
        },
      },
    },
  };
  return {
    win,
    calls,
    classes,
    click: (event) => listeners.click(event),
    mutate: () => mutationCallback(),
  };
}

test('navigator.share opens the native share sheet', async () => {
  const { win, calls } = fakeWindow();
  shell.install(win);
  assert.equal(typeof win.navigator.share, 'function');
  assert.equal(win.navigator.canShare({ url: 'https://gymos.test/share/1' }), true);
  assert.equal(win.navigator.canShare({ files: [{}] }), false);
  await win.navigator.share({ title: 'My meal on Barbell', url: 'https://gymos.test/share/1' });
  assert.deepEqual(calls.share, [{ title: 'My meal on Barbell', dialogTitle: 'My meal on Barbell', url: 'https://gymos.test/share/1' }]);
  await assert.rejects(win.navigator.share({ title: 'nothing to send' }), TypeError);
});

test('a failed native share rejects the way the Web Share API does', async () => {
  const { win } = fakeWindow();
  win.Capacitor.Plugins.Share.share = async () => { throw new Error('Share canceled'); };
  shell.install(win);
  await assert.rejects(win.navigator.share({ url: 'https://gymos.test/share/1' }), (err) => err.name === 'AbortError');
});

test('an existing navigator.share is left alone', () => {
  const { win } = fakeWindow();
  const original = () => Promise.resolve();
  win.navigator.share = original;
  shell.install(win);
  assert.equal(win.navigator.share, original);
});

test('a blob download is saved natively even though the page revokes its URL right after click()', async () => {
  const { win, calls, click } = fakeWindow();
  shell.install(win);
  const blob = new Blob(['%PDF-1.7 invoice'], { type: 'application/pdf' });
  const href = win.URL.createObjectURL(blob);
  const anchor = { href, getAttribute: (name) => (name === 'download' ? 'INV-0001.pdf' : null) };
  anchor.closest = (selector) => (selector === 'a[download]' ? anchor : null);
  let prevented = false;
  click({ target: anchor, preventDefault: () => { prevented = true; } });
  win.URL.revokeObjectURL(href);
  assert.equal(prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.saveDownload, [{
    data: Buffer.from('%PDF-1.7 invoice').toString('base64'),
    filename: 'INV-0001.pdf',
    mimeType: 'application/pdf',
  }]);
});

test('ordinary links and non-blob downloads are not intercepted', () => {
  const { win, click } = fakeWindow();
  shell.install(win);
  let prevented = false;
  const link = { href: 'https://gymos.test/terms', getAttribute: () => null, closest: () => null };
  click({ target: link, preventDefault: () => { prevented = true; } });
  const staleDownload = { href: 'blob:https://gymos.test/unknown', getAttribute: () => 'x.pdf' };
  staleDownload.closest = () => staleDownload;
  click({ target: staleDownload, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('theme changes are mirrored to the system bars once per change', () => {
  const { win, calls, classes, mutate } = fakeWindow();
  shell.install(win);
  assert.deepEqual(calls.setTheme, [{ theme: 'dark' }]);
  mutate();
  assert.equal(calls.setTheme.length, 1);
  classes.delete('dark');
  classes.add('light');
  mutate();
  assert.deepEqual(calls.setTheme, [{ theme: 'dark' }, { theme: 'light' }]);
});

test('installing twice does not wrap anything twice', () => {
  const { win } = fakeWindow();
  shell.install(win);
  const share = win.navigator.share;
  const create = win.URL.createObjectURL;
  shell.install(win);
  assert.equal(win.navigator.share, share);
  assert.equal(win.URL.createObjectURL, create);
  assert.equal(typeof win.__gymosShell.back, 'function');
});
