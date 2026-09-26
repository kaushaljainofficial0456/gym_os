// ============================================================
// ONE ANSWER TO "HOW MANY PEOPLE ARE IN THE BUILDING".
//
// There are two engines in this codebase, for good reasons:
//
//   services/occupancy.js       replays attendance_events for the day.
//                               Serves gyms on manual check-in, which is
//                               most of them until they connect hardware.
//   services/access/presence.js counts open presence sessions. Serves
//                               gyms with a connected access provider,
//                               and is O(1) however large the log grows.
//
// Having two is fine. Having two ANSWERS is not, and that is exactly what
// happened: with a door panel connected, the owner dashboard read presence
// sessions and reported 3 people inside while the member crowd card read
// attendance_events and reported 0. Same building, same second, two
// numbers. A member deciding whether to drive to the gym was being shown
// the wrong one.
//
// So every surface -- member card, member detail, owner dashboard,
// trainer view -- goes through here. The rule is simple and deliberately
// not a merge:
//
//   If this gym has a real (non-demo) provider that has actually
//   delivered events, the door is the truth.
//   Otherwise, replay the manual check-in log.
//
// NOT SUMMED, because the two sources describe the same people: a gym
// mid-migration, with staff still tapping members in manually while the
// new turnstile also records them, would double every one of them.
// Choosing a source is honest; adding them is not.
// ============================================================
import { computeOccupancy } from '../occupancy.js';
import { getCrowdStatus, getFreshness } from '../crowdStatus.js';
import { liveOccupancy } from './presence.js';
import { isOpenNow } from './localTime.js';

/**
 * Does this gym have a real door feed?
 *
 * "HAS DELIVERED A REAL EVENT", not "has been tested". The first version
 * of this required status = 'ACTIVE', which sounds stricter and was
 * simply wrong: a gym whose panel was happily posting signed events all
 * morning still read CONFIGURED because nobody had pressed Test, so this
 * fell back to the manual log and reported an empty gym while three
 * people were inside. Whether a human clicked a button is not evidence
 * about the building; events are.
 *
 * DEMO PROVIDERS ARE EXCLUDED, and that exclusion is load-bearing. An
 * owner trying the sandbox must not flip their whole gym onto a
 * simulated feed -- their members would then be shown invented occupancy
 * on the way to the gym. Demo presence is also excluded from the count
 * itself (see liveOccupancy); this is the second of the two guards.
 *
 * Once a gym HAS a door feed it keeps it, even if the panel later dies.
 * Falling back to the manual log at that point would silently swap one
 * number for another with no explanation; staying on the door feed lets
 * freshness say "data delayed", which is the truth.
 */
export async function hasLiveAccessFeed(db, orgId) {
  const row = await db.q1(
    `SELECT p.id FROM access_providers p
      WHERE p.org_id = ? AND p.status != 'DISABLED' AND p.provider_key != 'demo'
        AND (p.status = 'ACTIVE' OR p.last_event_at IS NOT NULL)
      LIMIT 1`, [orgId]);
  return !!row;
}

/**
 * The occupancy figure, whichever engine owns it, in one shape.
 *
 * @param {object}  opts
 * @param {boolean} opts.showExactCount  member privacy setting; the owner
 *                                       path passes true.
 * @param {string?} opts.branchId        branch scope (access feed only --
 *                                       attendance_events has no branch).
 */
export async function liveCrowd(db, orgId, tz, settings, { showExactCount = true, branchId = null } = {}) {
  const enabled = settings ? settings.crowd_enabled !== 0 : true;
  if (!enabled) {
    return { enabled: false, source: 'disabled', current: null, crowd: null, freshness: null };
  }

  const capacity = Number(settings?.crowd_capacity) || null;
  /* true / false / null. null means opening hours are not configured and
     the gym is treated as open -- see isOpenNow for why "unknown" must not
     become "closed". */
  const open = isOpenNow(settings, tz);
  const thresholds = {
    quiet: settings?.crowd_threshold_quiet,
    moderate: settings?.crowd_threshold_moderate,
    busy: settings?.crowd_threshold_busy,
  };

  if (await hasLiveAccessFeed(db, orgId)) {
    const current = await liveOccupancy(db, orgId, { branchId });
    /* Freshness is measured against the last event the DOOR reported as
       well as the calculation time -- see getFreshness. Measuring only the
       calculation reported "Live" for a gym whose panel had been silent
       for six hours, because the calculation is always a moment old.
       Demo traffic is excluded here too: a sandbox event must not make a
       dead panel look alive. */
    const last = branchId
      ? await db.q1(`SELECT MAX(occurred_at) AS t FROM access_events
                      WHERE org_id = ? AND branch_id = ? AND source != 'demo'`, [orgId, branchId])
      : await db.q1(`SELECT MAX(occurred_at) AS t FROM access_events
                      WHERE org_id = ? AND source != 'demo'`, [orgId]);
    const calculatedAt = new Date().toISOString();
    return {
      enabled: true,
      source: 'access_control',
      current: showExactCount ? current : null,
      capacity,
      crowd: getCrowdStatus({ occupancyCount: current, capacity, thresholds, showExactCount, open: open !== false }),
      freshness: getFreshness({ calculatedAt, lastEventAt: last?.t || null }),
      lastEventAt: last?.t || null,
      calculatedAt,
      open,
      hours: open === null ? null : { open: settings.crowd_open_time, close: settings.crowd_close_time },
      branchId,
    };
  }

  // No door feed: the manual check-in log is the only thing that knows.
  const snapshot = await computeOccupancy(db, orgId, tz, settings, { showExactCount });
  if (open === false && snapshot.enabled) {
    // Closed wins over whatever the manual log last said.
    snapshot.crowd = getCrowdStatus({
      occupancyCount: snapshot.current ?? 0, capacity, thresholds, showExactCount, open: false,
    });
  }
  return {
    ...snapshot,
    source: 'manual_checkin',
    open,
    hours: open === null ? null : { open: settings.crowd_open_time, close: settings.crowd_close_time },
  };
}

export default { liveCrowd, hasLiveAccessFeed };
