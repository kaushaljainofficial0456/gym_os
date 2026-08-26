// ============================================================
// PAYMENTS DEV BRIDGE — the ONE browser-callable route that stands in
// for a real payment gateway's client-side checkout widget, but ONLY
// while the mock provider is active (see paymentProvider.js's
// providerName() -- 'mock' unless PAYMENT_PROVIDER=razorpay AND both
// real Razorpay keys are configured). Once real keys exist, this
// route 409s unconditionally and the frontend's PaymentCheckout
// component switches to loading Razorpay's actual checkout.js SDK
// instead (see frontend/src/components/PaymentCheckout.jsx) -- this
// file is never involved in a real payment.
//
// The HMAC secret that makes a signature genuinely verifiable never
// reaches the browser here or anywhere else: this route computes the
// signature SERVER-SIDE (mockSimulateCheckout) and hands back only
// the already-signed { paymentId, signature } pair, exactly what a
// real gateway's checkout widget would hand back via its own
// callback. The existing /payment/verify and /client/payment/verify
// routes are what actually check ownership before applying it -- this
// route only proves "the mock gateway says this order was paid",
// nothing more, and is completely inert once real money is involved.
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { providerName, mockSimulateCheckout } from '../services/payments/paymentProvider.js';

export default function paymentsDevRoutes() {
  const r = Router();
  r.use(requireAuth);
  const limit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });

  r.post('/mock/complete', limit, validate(z.object({
    providerOrderId: z.string().min(1),
    outcome: z.enum(['success', 'failure']).default('success'),
  })), async (req, res) => {
    if (providerName() !== 'mock') return res.status(409).json({ error: 'not_in_mock_mode' });
    try {
      const result = mockSimulateCheckout(req.body.providerOrderId, { outcome: req.body.outcome });
      res.json(result);
    } catch (e) {
      res.status(404).json({ error: 'unknown_mock_order' });
    }
  });

  r.get('/provider', limit, async (_req, res) => {
    res.json({ provider: providerName() });
  });

  return r;
}
