import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The Barbell plan checkout (Independent clients). The page never prices
// anything itself: the coupon is priced by /plan/quote and the payment by
// /plan/order, so the API is what is mocked -- plus the gateway widget.
const apiMock = vi.fn();
vi.mock('../src/api.js', () => ({ api: (...args) => apiMock(...args), downloadFile: vi.fn() }));
vi.mock('../src/components/PaymentCheckout.jsx', () => ({
  default: ({ order, onCancel, onComplete }) => (
    <div data-testid="gateway">
      Paying {order.amount}
      <button type="button" onClick={onCancel}>Close checkout</button>
      <button type="button" onClick={() => onComplete('pay_1', 'sig_1')}>Approve payment</button>
    </div>
  ),
}));
const { default: Plan } = await import('../src/pages/client/Plan.jsx');

const STATUS = {
  applies: true, access: 'trial', trialDaysLeft: 9, trialEndsAt: '2026-11-14T00:00:00.000Z', paidUntil: null,
  plans: [
    { id: 'monthly', name: 'Monthly', amount: 59, currency: 'INR', days: 30, line: 'Billed every month' },
    { id: 'yearly', name: 'Yearly', amount: 590, currency: 'INR', days: 365, line: 'Pay for 10 months, get 2 free' },
  ],
  receipts: [],
};
const PRICING = {
  plan: 'yearly', originalAmount: 590, credit: 0, subtotal: 590, discount: 147.5, total: 442.5, currency: 'INR', savings: 147.5,
  message: 'Congratulations! SOLO25 applied successfully. You saved ₹147.50.',
  coupons: [{
    code: 'SOLO25', description: null, discountType: 'PERCENTAGE', discountValue: 25, maxDiscountAmount: null,
    discountAmount: 147.5, expiresAt: '2026-11-30T18:29:59.999Z', timezone: 'Asia/Kolkata', appliesTo: 'Barbell plan (Independent clients)',
  }],
};

const renderPlan = () => render(<MemoryRouter><Plan /></MemoryRouter>);
const total = () => screen.getByText('Total payable').nextElementSibling.textContent;
const route = (path) => apiMock.mock.calls.filter(([p]) => p === path);

async function openYearlyWithCoupon() {
  renderPlan();
  fireEvent.click(await screen.findByRole('button', { name: 'Choose yearly' }));
  expect(total()).toBe('₹590');
  fireEvent.click(screen.getByRole('button', { name: 'Have a coupon code?' }));
  fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'solo25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await screen.findByText(PRICING.message);
}

describe('Barbell plan checkout with a coupon', () => {
  // A block body, not `() => apiMock.mockReset()`: vitest runs a function
  // returned from beforeEach as a teardown, and mockReset() returns the mock.
  beforeEach(() => { apiMock.mockReset(); });

  it('prices the code on the server and pays with it, never sending an amount', async () => {
    apiMock.mockImplementation(async (path, opts) => {
      if (path === '/plan/status') return STATUS;
      if (path === '/plan/quote') return { pricing: PRICING };
      if (path === '/plan/order') return { order: { id: 'bpo_1', plan: 'yearly', amount: 442.5, currency: 'INR', provider_order_id: 'po_1' }, pricing: PRICING };
      throw new Error(`unexpected ${path} ${opts?.body}`);
    });
    await openYearlyWithCoupon();

    expect(JSON.parse(route('/plan/quote')[0][1].body)).toEqual({ plan: 'yearly', couponCodes: ['SOLO25'] });
    expect(total()).toBe('₹442.50');
    expect(screen.getByText('You saved ₹147.50!')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹442.50' }));
    await screen.findByTestId('gateway');
    const body = JSON.parse(route('/plan/order')[0][1].body);
    expect(body).toEqual({ plan: 'yearly', couponCodes: ['SOLO25'] });
    expect(screen.getByTestId('gateway').textContent).toContain('Paying 442.5');
  });

  it("shows the server's reason when a code is refused, and keeps the full price", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/plan/status') return STATUS;
      if (path === '/plan/quote') {
        throw Object.assign(new Error('This coupon is only available for Enterprise gyms.'), {
          data: { error: 'coupon_invalid', reason: 'enterprise_only', message: 'This coupon is only available for Enterprise gyms.' },
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderPlan();
    fireEvent.click(await screen.findByRole('button', { name: 'Choose monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Have a coupon code?' }));
    fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'GYMSONLY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This coupon is only available for Enterprise gyms.');
    expect(total()).toBe('₹59');
    expect(screen.getByRole('button', { name: 'Pay ₹59' })).toBeTruthy();
  });

  it('a coupon that ran out between Apply and Pay falls back to the full price, with the reason', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/plan/status') return STATUS;
      if (path === '/plan/quote') return { pricing: PRICING };
      if (path === '/plan/order') {
        throw Object.assign(new Error('This coupon has reached its maximum number of uses.'), {
          data: { error: 'coupon_unavailable', reason: 'exhausted', message: 'This coupon has reached its maximum number of uses.' },
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    await openYearlyWithCoupon();
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹442.50' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This coupon has reached its maximum number of uses.');
    expect(total()).toBe('₹590');
    expect(screen.queryByTestId('gateway')).toBeNull();
  });

  it('closing the checkout before paying hands the coupon hold back', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/plan/status') return STATUS;
      if (path === '/plan/quote') return { pricing: PRICING };
      if (path === '/plan/order') return { order: { id: 'bpo_9', plan: 'yearly', amount: 442.5, currency: 'INR', provider_order_id: 'po_9' }, pricing: PRICING };
      if (path === '/plan/order/bpo_9/cancel') return { released: 1 };
      throw new Error(`unexpected ${path}`);
    });
    await openYearlyWithCoupon();
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹442.50' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close checkout' }));
    await waitFor(() => expect(route('/plan/order/bpo_9/cancel')).toHaveLength(1));
    expect(screen.queryByTestId('gateway')).toBeNull();
  });

  it('a payment held for review says so in the server\'s words, never "pay again"', async () => {
    const HELD = "Your payment went through, but the coupon was used up before the payment was confirmed, so your purchase is on hold. We'll refund it or honour it shortly. Please don't pay again.";
    apiMock.mockImplementation(async (path) => {
      if (path === '/plan/status') return STATUS;
      if (path === '/plan/quote') return { pricing: PRICING };
      if (path === '/plan/order') return { order: { id: 'bpo_7', plan: 'yearly', amount: 442.5, currency: 'INR', provider_order_id: 'po_7' }, pricing: PRICING };
      if (path === '/plan/verify') {
        throw Object.assign(new Error(HELD), { data: { error: 'payment_held_for_review', message: HELD } });
      }
      throw new Error(`unexpected ${path}`);
    });
    await openYearlyWithCoupon();
    fireEvent.click(screen.getByRole('button', { name: 'Pay ₹442.50' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve payment' }));
    expect((await screen.findByRole('alert')).textContent).toBe(HELD);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('receipts show the price, each coupon and what was paid', async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === '/plan/status') {
        return {
          ...STATUS, access: 'active', paidUntil: '2027-11-05T00:00:00.000Z',
          receipts: [{
            id: 'bpo_1', plan: 'yearly', amount: 442.5, currency: 'INR', originalAmount: 590, discount: 147.5,
            coupons: [{ code: 'SOLO25', discountType: 'PERCENTAGE', discountValue: 25, discountAmount: 147.5 }],
            periodStart: '2026-11-05T00:00:00.000Z', periodEnd: '2027-11-05T00:00:00.000Z', number: 'BBL-2026-ABC123',
          }],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderPlan();
    const number = await screen.findByText(/BBL-2026-ABC123/);
    const row = number.closest('div.rounded-xl');
    expect(within(row).getByText('₹442.50 · Yearly')).toBeTruthy();
    expect(within(row).getByText('₹590 − SOLO25 ₹147.50')).toBeTruthy();
  });
});
