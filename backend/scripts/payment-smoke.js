#!/usr/bin/env node
// ============================================================
// PAYMENT PROVIDER SMOKE TEST — optional, one real call to Razorpay's
// live TEST-mode API (Orders: Create). Mirrors food-ai-smoke.js's own
// pattern and cautions exactly.
//
// NEVER run by `npm test` (lives under scripts/, not *.test.js). Run
// explicitly, with PAYMENT_PROVIDER=razorpay set JUST for this one
// process -- backend/.env deliberately never sets that var itself (see
// its own comment), so every other run of this app -- dev server, the
// whole automated test suite -- stays on the free mock provider by
// default even with real keys present:
//   PAYMENT_PROVIDER=razorpay node scripts/payment-smoke.js
//
// Creates exactly ONE Rs 1.00 order against Razorpay's TEST endpoint
// (rzp_test_ keys only -- this script refuses to run against a live
// rzp_live_ key, see the guard below). An order alone moves no money
// and requires no customer action; this proves the API credentials
// and request shape are genuinely correct, which is as far as an
// unattended script can verify -- actually completing a checkout
// needs a real browser and Razorpay's own widget (see
// PaymentCheckout.jsx), which this script cannot drive.
// ============================================================
import '../src/config.js';
import { providerName, createProviderOrder } from '../src/services/payments/paymentProvider.js';

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  if (!keyId) {
    console.log('SKIPPED — RAZORPAY_KEY_ID is not set (see backend/.env).');
    return;
  }
  if (!keyId.startsWith('rzp_test_')) {
    console.error(`REFUSED — RAZORPAY_KEY_ID does not start with "rzp_test_" (this script never runs against a live key).`);
    process.exitCode = 1;
    return;
  }
  if (providerName() !== 'razorpay') {
    console.log(`SKIPPED — providerName() is "${providerName()}", not "razorpay". Run with PAYMENT_PROVIDER=razorpay set (see this file's header comment).`);
    return;
  }

  console.log(`Provider: razorpay (test mode, key ${keyId.slice(0, 12)}…)`);
  console.log('Creating a Rs 1.00 test order via the real Razorpay Orders API…');
  try {
    const order = await createProviderOrder({ amount: 1, currency: 'INR', receipt: `smoke-${Date.now()}`, notes: { source: 'payment-smoke.js' } });
    console.log('SUCCESS —', { providerOrderId: order.providerOrderId, status: order.status });
    console.log('\nCredentials and request shape are genuinely valid against Razorpay\'s live TEST API.');
    console.log('This does NOT prove the checkout widget or webhook delivery -- those need a real browser');
    console.log('session (PaymentCheckout.jsx) and a webhook URL registered in the Razorpay dashboard.');
  } catch (e) {
    console.error('FAILED —', e.message);
    process.exitCode = 1;
  }
}

main();
