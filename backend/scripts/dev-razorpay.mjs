// ============================================================
// `npm run dev:razorpay`: the ordinary dev server, with Razorpay as the
// payment provider, so checkout opens the real Razorpay widget (test keys
// from backend/.env) instead of the mock.
//
// PAYMENT_PROVIDER is set here, not in the npm script: the inline
// `PAYMENT_PROVIDER=razorpay node ...` form is POSIX shell syntax, and on
// Windows npm runs scripts through cmd.exe, which does not understand it.
// It stays out of backend/.env on purpose: the test suite reads that file
// too, and must keep running against the mock provider.
// ============================================================
process.env.PAYMENT_PROVIDER = 'razorpay';

// index.js only starts listening when it is the entry point itself, so a
// wrapper like this one starts the listener explicitly (as
// dev-throwaway-db.mjs does).
const { buildApp } = await import('../src/index.js');
const { config } = await import('../src/config.js');
const app = await buildApp();
app.listen(config.port, () => {
  console.log(`[dev-razorpay] API listening on http://127.0.0.1:${config.port}, payments through Razorpay`);
});
