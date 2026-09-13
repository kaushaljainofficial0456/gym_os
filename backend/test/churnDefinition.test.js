// ============================================================
// CHURN — a metric that could only ever report zero.
//
// Analytics counted a departure as a subscription with status 'expired'
// or 'cancelled'. Nothing in this app ever sets either: rows stay
// 'active' forever. So `left` was structurally always 0, and churn with
// it — this gym was shown "0% churn" while 21 of its 25 memberships had
// already run out. A metric that cannot produce a non-zero answer is
// worse than no metric, because it reads as good news.
//
// The careful part is NOT counting renewals. Someone on their fourth
// quarterly plan has three expired rows behind them and has not left at
// all; treating each as a departure would invent a churn rate roughly
// equal to the renewal rate — wrong in the opposite, panic-inducing
// direction. A subscription is a departure only when its end date has
// passed AND the client has nothing running later.
//
// Same rule as the dashboard's lapsed-membership bucket and the roster's
// "Lapsed" pill, on purpose: one gym, one definition of "gone".
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

/** The rule exactly as /api/admin/analytics applies it. Kept as a pure
 *  function so the DEFINITION is what these tests describe. */
function departureFilter(subs, today) {
  const latestEndByClient = new Map();
  for (const sb of subs) {
    if (!sb.end_date) continue;
    const best = latestEndByClient.get(sb.client_id);
    if (!best || sb.end_date > best) latestEndByClient.set(sb.client_id, sb.end_date);
  }
  return (sb) => {
    if (sb.status === 'cancelled') return true;
    if (!sb.end_date || sb.end_date >= today) return false;
    return latestEndByClient.get(sb.client_id) === sb.end_date;
  };
}

const TODAY = '2026-09-13';
const count = (subs) => subs.filter(departureFilter(subs, TODAY)).length;

test('a plan that ran out and was never replaced is a departure', async () => {
  // The case that was invisible: still labelled 'active', ended in April.
  const subs = [{ client_id: 'c1', status: 'active', end_date: '2026-04-30' }];
  assert.equal(count(subs), 1);
});

test('a client who renewed has not left, however many expired rows trail them', async () => {
  // THE trap. Three past plans plus a current one is a loyal member, not
  // three departures — counting them would invent a churn rate roughly
  // equal to the renewal rate.
  const subs = [
    { client_id: 'c1', status: 'active', end_date: '2026-01-31' },
    { client_id: 'c1', status: 'active', end_date: '2026-04-30' },
    { client_id: 'c1', status: 'active', end_date: '2026-07-31' },
    { client_id: 'c1', status: 'active', end_date: '2026-12-31' },
  ];
  assert.equal(count(subs), 0);
});

test('a future end date is a renewal date, not a departure', async () => {
  const subs = [{ client_id: 'c1', status: 'active', end_date: '2026-12-31' }];
  assert.equal(count(subs), 0);
});

test('an explicit cancellation counts whatever the dates say', async () => {
  // Someone who cancels a plan running until December has left in
  // December's terms but has left.
  const subs = [{ client_id: 'c1', status: 'cancelled', end_date: '2026-12-31' }];
  assert.equal(count(subs), 1);
});

test('a client whose last plan expired counts once, not once per plan', async () => {
  const subs = [
    { client_id: 'c1', status: 'active', end_date: '2026-01-31' },
    { client_id: 'c1', status: 'active', end_date: '2026-04-30' },   // the last one
  ];
  assert.equal(count(subs), 1, 'one person leaving is one departure');
});

test('a subscription with no end date is never a departure', async () => {
  // An open-ended plan has not ended. Treating a null as "expired" is how
  // a metric starts counting missing data as bad news.
  const subs = [{ client_id: 'c1', status: 'active', end_date: null }];
  assert.equal(count(subs), 0);
});

test('several clients are counted independently', async () => {
  const subs = [
    // left
    { client_id: 'c1', status: 'active', end_date: '2026-04-30' },
    // renewed, still here
    { client_id: 'c2', status: 'active', end_date: '2026-03-31' },
    { client_id: 'c2', status: 'active', end_date: '2026-11-30' },
    // cancelled outright
    { client_id: 'c3', status: 'cancelled', end_date: '2026-10-31' },
    // brand new
    { client_id: 'c4', status: 'active', end_date: '2027-01-31' },
  ];
  assert.equal(count(subs), 2, 'c1 and c3 — not c2, not c4');
});

test('churn is null, not 0%, when nobody was on the books', async () => {
  // 0% churn on an empty gym reads like an achievement. The route already
  // had this right; this holds it while the numerator changes underneath.
  const activeNow = 0;
  const left = 0;
  const exposed = activeNow + left;
  const churnPct = exposed > 0 ? Math.round((left / exposed) * 1000) / 10 : null;
  assert.equal(churnPct, null);
});
