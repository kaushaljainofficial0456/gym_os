import { afterEach } from 'vitest';

// Testing Library only unmounts between tests on its own when test globals
// are enabled, and they are not here. Without this, every render() from an
// earlier test stays mounted in the shared document and later queries match
// stale nodes. Guarded because the pure-function suites run in plain Node,
// where there is no document to clean.
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  document.body.style.overflow = '';
});
