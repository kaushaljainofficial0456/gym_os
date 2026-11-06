import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The component must never price anything itself: every number it shows
// comes from the server's quote. So the API is the only thing mocked.
const apiMock = vi.fn();
vi.mock('../src/api.js', () => ({ api: (...args) => apiMock(...args) }));
const { CouponField, PriceSummary } = await import('../src/components/billing/CouponCheckout.jsx');

const PRICING = {
  originalAmount: 13999, credit: 0, subtotal: 13999, discount: 3499.75, total: 10499.25, currency: 'INR', savings: 3499.75,
  message: 'Congratulations! BARBELL25 applied successfully. You saved ₹3,499.75.',
  coupons: [{
    code: 'BARBELL25', description: '25% off your first year', discountType: 'PERCENTAGE', discountValue: 25, maxDiscountAmount: null,
    discountAmount: 3499.75, expiresAt: '2026-11-30T18:29:59.999Z', timezone: 'Asia/Kolkata', appliesTo: 'All purchases',
  }],
};

function Harness() {
  const [applied, setApplied] = useState(null);
  return (
    <>
      <PriceSummary planLabel="100 clients" original={13999} pricing={applied?.pricing} />
      <CouponField request={{ kind: 'ORG_PACKAGE', capacity: 100 }} applied={applied} onApplied={setApplied} />
    </>
  );
}

const total = () => screen.getByText('Total payable').nextElementSibling.textContent;

describe('coupon at checkout', () => {
  beforeEach(() => apiMock.mockReset());

  it('applies a code through the server and shows original, discount, total and the saving', async () => {
    apiMock.mockResolvedValueOnce({ quote: { id: 'bq_1', total: 10499.25 }, pricing: PRICING });
    render(<Harness />);
    expect(total()).toBe('₹13,999');
    fireEvent.click(screen.getByRole('button', { name: 'Have a coupon code?' }));
    fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'barbell25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await screen.findByRole('status');
    expect(apiMock).toHaveBeenCalledWith('/enterprise/billing/quote', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(apiMock.mock.calls[0][1].body);
    expect(body).toEqual({ kind: 'ORG_PACKAGE', capacity: 100, couponCodes: ['BARBELL25'] });
    expect(screen.getByRole('status').textContent).toBe('Congratulations! BARBELL25 applied successfully. You saved ₹3,499.75.');
    expect(total()).toBe('₹10,499.25');
    expect(screen.getByText('You saved ₹3,499.75!')).toBeTruthy();
  });

  it('shows the server\'s reason when a code is refused, and keeps the original price', async () => {
    const err = Object.assign(new Error('This coupon has expired.'), { data: { error: 'coupon_invalid', reason: 'expired', message: 'This coupon has expired.' } });
    apiMock.mockRejectedValueOnce(err);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Have a coupon code?' }));
    fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'OLDCODE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This coupon has expired.');
    expect(screen.getByLabelText('Coupon code').getAttribute('aria-invalid')).toBe('true');
    expect(total()).toBe('₹13,999');
  });

  it('removing the coupon returns to the original price without another request', async () => {
    apiMock.mockResolvedValueOnce({ quote: { id: 'bq_1', total: 10499.25 }, pricing: PRICING });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Have a coupon code?' }));
    fireEvent.change(screen.getByLabelText('Coupon code'), { target: { value: 'BARBELL25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Remove coupon BARBELL25' }));
    await waitFor(() => expect(total()).toBe('₹13,999'));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
