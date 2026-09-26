// ============================================================
// A CROWD FIGURE IS EASY TO OVERSTATE, SO THE RULES ARE PINNED HERE.
//
// The client-facing crowd screen shipped with a hard-coded 24-hour curve,
// a hard-coded "Peak hours 5:00 PM - 7:00 PM", and a footer reading "Live
// data from the gym access system". Every gym saw the same invented day.
// These tests exist so the replacement cannot drift back toward that: the
// two ways this feature lies are inventing a denominator it was never
// given, and calling old data live.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCrowdStatus, getFreshness, DEFAULT_THRESHOLDS } from '../src/services/crowdStatus.js';

test('a percentage is never invented without a configured capacity', () => {
  // The most tempting lie in the feature: a ring looks better full.
  const s = getCrowdStatus({ occupancyCount: 42, capacity: null });
  assert.equal(s.status, 'no_capacity');
  assert.equal(s.occupancyPercentage, null);
  assert.equal(s.capacity, null);
  assert.match(s.label, /42 people inside/);
  assert.match(s.description, /has not been configured/i);

  for (const cap of [0, -1, undefined, NaN, 'lots']) {
    assert.equal(getCrowdStatus({ occupancyCount: 42, capacity: cap }).occupancyPercentage, null,
      `capacity ${JSON.stringify(cap)} must not produce a percentage`);
  }
});

test('the default bands land where the spec says they do', () => {
  const at = (n) => getCrowdStatus({ occupancyCount: n, capacity: 100 }).status;
  assert.equal(at(0), 'quiet');
  assert.equal(at(30), 'quiet');
  assert.equal(at(31), 'moderate');
  assert.equal(at(60), 'moderate');
  assert.equal(at(61), 'busy');
  assert.equal(at(80), 'busy');
  assert.equal(at(81), 'very_busy');
  assert.equal(at(100), 'very_busy');
});

test('over capacity is its own state, not a clamped 100%', () => {
  // Clamping would tell an owner their packed gym is merely "very busy",
  // which is the one moment the number needs to be alarming.
  const s = getCrowdStatus({ occupancyCount: 160, capacity: 150 });
  assert.equal(s.status, 'over_capacity');
  assert.equal(s.occupancyPercentage, 107);
  assert.equal(s.severity, 'critical');
});

test('owner thresholds override the defaults', () => {
  const thresholds = { quiet: 10, moderate: 20, busy: 30 };
  const at = (n) => getCrowdStatus({ occupancyCount: n, capacity: 100, thresholds }).status;
  assert.equal(at(10), 'quiet');
  assert.equal(at(15), 'moderate');
  assert.equal(at(25), 'busy');
  assert.equal(at(40), 'very_busy');
});

test('out-of-order thresholds are repaired instead of creating a dead band', () => {
  // A settings form that saved moderate BELOW quiet would otherwise make
  // "moderately busy" unreachable, with nothing visibly broken anywhere.
  // The invariant worth asserting is not what one arbitrary occupancy maps
  // to, but that EVERY band stays reachable after the repair.
  const thresholds = { quiet: 30, moderate: 20, busy: 10 };
  const { thresholds: fixed } = getCrowdStatus({ occupancyCount: 1, capacity: 100, thresholds });
  assert.ok(fixed.moderate > fixed.quiet, 'moderate sits above quiet');
  assert.ok(fixed.busy > fixed.moderate, 'busy sits above moderate');
  assert.ok(fixed.busy < 100, 'very_busy is still reachable');

  const at = (n) => getCrowdStatus({ occupancyCount: n, capacity: 100, thresholds }).status;
  const reached = new Set([at(fixed.quiet), at(fixed.moderate), at(fixed.busy), at(100)]);
  assert.deepEqual([...reached].sort(), ['busy', 'moderate', 'quiet', 'very_busy']);
});

test('garbage thresholds fall back to the defaults rather than throwing', () => {
  for (const bad of [null, undefined, {}, { quiet: 'a lot' }, { quiet: NaN }]) {
    const s = getCrowdStatus({ occupancyCount: 20, capacity: 100, thresholds: bad });
    assert.equal(s.status, 'quiet');
  }
  assert.equal(getCrowdStatus({ occupancyCount: 20, capacity: 100 }).thresholds.quiet, DEFAULT_THRESHOLDS.quiet);
});

test('unavailable and closed are distinct states, and neither reports a crowd', () => {
  const un = getCrowdStatus({ occupancyCount: 42, capacity: 100, available: false });
  assert.equal(un.status, 'unavailable');
  assert.equal(un.occupancyCount, null);
  assert.equal(un.occupancyPercentage, null);

  const closed = getCrowdStatus({ occupancyCount: 0, capacity: 100, open: false });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.occupancyPercentage, null);
});

test('hiding the exact count removes the NUMBER, not just its label', () => {
  // The owner privacy setting has to be enforced where the value is
  // produced. A component that merely declines to render it still ships
  // the head-count to anyone who opens the network tab.
  const s = getCrowdStatus({ occupancyCount: 42, capacity: 100, showExactCount: false });
  assert.equal(s.occupancyCount, null);
  assert.equal(s.occupancyPercentage, 42, 'how busy it is is still reported');
  assert.equal(s.status, 'moderate');
  assert.ok(!/\b42\b/.test(s.description), `description leaked the count: ${s.description}`);

  const noCap = getCrowdStatus({ occupancyCount: 42, capacity: null, showExactCount: false });
  assert.ok(!/\b42\b/.test(noCap.label), `label leaked the count: ${noCap.label}`);
});

test('every state carries a colour-independent description', () => {
  // Status must never be communicated by colour alone.
  const cases = [
    { occupancyCount: 5, capacity: 100 },
    { occupancyCount: 50, capacity: 100 },
    { occupancyCount: 75, capacity: 100 },
    { occupancyCount: 95, capacity: 100 },
    { occupancyCount: 120, capacity: 100 },
    { occupancyCount: 42, capacity: null },
    { occupancyCount: 42, capacity: 100, open: false },
    { occupancyCount: 42, capacity: 100, available: false },
  ];
  for (const c of cases) {
    const s = getCrowdStatus(c);
    assert.ok(s.label && s.label.length > 2, `no label for ${JSON.stringify(c)}`);
    assert.ok(s.description && s.description.length > 10, `no description for ${JSON.stringify(c)}`);
    assert.ok(s.color.startsWith('var(--'), 'colour is a token, not a hex');
  }
});

// ---------------------------------------------------------------
test('"Live" is only ever said about data under a minute old', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const at = (secAgo) => getFreshness({
    calculatedAt: new Date(now.getTime() - secAgo * 1000).toISOString(), now,
  });

  assert.equal(at(0).state, 'live');
  assert.equal(at(59).state, 'live');
  assert.equal(at(61).state, 'recent');
  assert.equal(at(61).isLive, false, 'a minute-old figure is not live');
  assert.equal(at(600).state, 'delayed');
  assert.equal(at(4000).state, 'stale');
  assert.equal(at(4000).isLive, false);
});

test('freshness reports its own age, so a screen never has to guess', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const f = getFreshness({ calculatedAt: '2026-09-15T11:52:00Z', lastEventAt: '2026-09-15T11:30:00Z', now });
  assert.equal(f.ageSec, 480);
  assert.equal(f.lastEventAt, '2026-09-15T11:30:00Z');
  assert.match(f.label, /delayed/i);
});

test('a fresh calculation over a silent door feed is NOT live', () => {
  /* The bug this pins shut: freshness was measured only from
     `calculatedAt`, which the response builder sets to now() -- so it
     reported "Live" unconditionally, including for a gym whose panel had
     been silent for six hours. A green badge that can never turn amber
     actively vouches for a number nobody has checked. */
  const now = new Date('2026-09-17T12:00:00Z');
  const justCalculated = now.toISOString();

  const quiet = getFreshness({ calculatedAt: justCalculated, lastEventAt: '2026-09-17T11:50:00Z', now });
  assert.equal(quiet.isLive, true, 'ten quiet minutes at a real gym is not a fault');

  const silent = getFreshness({ calculatedAt: justCalculated, lastEventAt: '2026-09-17T06:00:00Z', now });
  assert.equal(silent.isLive, false, 'six hours of silence is not live, however recently we did the maths');
  assert.equal(silent.state, 'stale');
  assert.equal(silent.feedAgeSec, 6 * 3600);

  const hourAgo = getFreshness({ calculatedAt: justCalculated, lastEventAt: '2026-09-17T11:00:00Z', now });
  assert.equal(hourAgo.state, 'delayed');
  assert.equal(hourAgo.isLive, false);

  // With no feed to vouch for (the manual check-in path), only the
  // calculation age applies and a fresh calculation IS live.
  const manual = getFreshness({ calculatedAt: justCalculated, now });
  assert.equal(manual.isLive, true);
  assert.equal(manual.feedAgeSec, null);
});

test('an unparseable timestamp is unavailable, never live', () => {
  for (const bad of [null, undefined, '', 'yesterday', 0]) {
    const f = getFreshness({ calculatedAt: bad });
    assert.equal(f.state, 'unavailable');
    assert.equal(f.isLive, false);
  }
});
