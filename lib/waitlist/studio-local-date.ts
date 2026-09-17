import { localDateString, localTimeString, tzOffsetMinutes } from "@/lib/booking/tz";

// WAIT-04A. A calendar date the operator typed, as the EARLIEST REAL INSTANT
// belonging to that local calendar date in the studio's timezone.
//
// ===========================================================================
// WHY THIS IS ITS OWN MODULE
// ===========================================================================
//
// It lived in the server-action file first, and `next build` refused it:
// "Server Actions must be async functions". A `"use server"` module may export
// nothing but async functions, and this is a PURE synchronous function — no
// I/O, no session, no database. Typecheck cannot see that rule; only the build
// does. Being pure is also why it belongs here rather than being made async to
// satisfy the compiler: a date conversion that awaits nothing should not be
// awaited, and here it is unit-testable without a server boundary.
//
// ===========================================================================
// WHY THE DATE MUST BE CONVERTED AT ALL
// ===========================================================================
//
// `import_legacy_waitlist_entry`'s `p_joined_at` is `timestamptz`. Handing
// PostgreSQL a bare 'YYYY-MM-DD' lets the DATABASE SESSION's timezone decide
// which instant it names, and that session is UTC. Measured:
//
//     America/Toronto  "2025-03-04" as UTC -> renders back as 2025-03-03
//
// One day earlier than the practitioner typed. And `joined_at` is half of the
// (joined_at, id) total order, so this was never cosmetic: it moved the
// person's position in the queue.
//
// ===========================================================================
// THIS IS A BOUNDARY PROBLEM, NOT A SAMPLING PROBLEM
// ===========================================================================
//
// A previous revision probed candidate wall-clock times (00:00, 01:00, 02:00,
// ...) and took the first that landed on the requested date. That is sampling,
// and sampling cannot state the property this function owes its caller. It
// silently returned a LATER instant whenever the local day began at an offset
// the sample grid did not contain — confirmed against real IANA data:
//
//     America/Paramaribo 1984-10-01  true start 03:30:00Z (local 00:30)
//                                    hourly probe gave 04:00:00Z   (+30 min)
//     Pacific/Rarotonga  1984-10-28  true start 10:00:00Z
//                                    hourly probe gave 10:30:00Z   (+30 min)
//     Pacific/Kiritimati 1979-10-01  true start 10:40:00Z
//                                    hourly probe gave 11:00:00Z   (+20 min)
//
// Refining the grid to five minutes would have moved the failures rather than
// removed them: Kiritimati needs a 20-minute boundary, and nothing prevents a
// zone whose offset changes by a number of seconds. The property is EXACT, so
// the method must be exact.
//
// THE PROPERTY, STATED ONCE:
//
//     result renders as `ymd` in `tz`, and NO earlier instant does.
//
// `assertFirstInstant` below checks exactly that, in one millisecond, and the
// tests assert it for every case.
//
// ===========================================================================
// HOW IT IS FOUND — THREE CASES, NO GRID
// ===========================================================================
//
// A. ORDINARY MIDNIGHT. Local 00:00 exists. Two offset passes find it: read the
//    zone offset at the naive instant, correct, re-read at the corrected
//    instant, correct again. (That second pass is the PR #184 fix — one pass
//    lands an hour off when the naive and corrected instants straddle a
//    transition.) Both candidates are kept rather than the last one.
//
// B. REPEATED MIDNIGHT. A backward transition AT midnight makes local 00:00
//    happen twice. Both candidates are then valid midnights and the EARLIER is
//    the first instant of the day — which is why the two passes are collected
//    into a set and sorted, rather than the second overwriting the first.
//
// C. SKIPPED MIDNIGHT. A forward transition at midnight means local 00:00 never
//    occurs; the day begins at the transition itself (Paramaribo's 00:30). No
//    wall-clock arithmetic can name that instant, because it is defined by the
//    transition and not by a time anybody can type. It is found by BISECTING
//    the boundary to the millisecond between an instant known to be on the
//    previous date and one known to be on this date.
//
// A date that does not exist at all — a zone that skipped a whole calendar day
// crossing the date line, as Pacific/Kiritimati did in 1994 and Pacific/Apia in
// 2011 — has no first instant and is REFUSED.
//
// Platform APIs express all of this: `Intl.DateTimeFormat` with a `timeZone`
// is the whole dependency, through lib/booking/tz.ts. No date library is added.

// ===========================================================================
// THE METHOD — CONSTANT-OFFSET SEGMENTS, NOT PROBES AND NOT A PLAIN BISECTION
// ===========================================================================
//
// Two earlier revisions were wrong, each in a way the next one's guard caught:
//
//   1. WALL-CLOCK PROBES (00:00, 01:00, ...). Sampling cannot answer a boundary
//      question; it silently returned a later instant wherever a local day
//      began off the grid.
//
//   2. OFFSET CORRECTION plus a bisection. Correcting the offset twice finds
//      *a* local midnight, but when midnight happens TWICE — a fall-back
//      exactly at midnight — both passes can converge on the SECOND one.
//      Europe/Sofia 1979-10-01 has midnights at 21:00Z and 22:00Z; the
//      correction found 22:00Z, an hour into a day that had already begun.
//
// The property check below caught (2) and turned it into a refusal rather than
// a wrong instant, which is why every return path goes through it. But a
// refusal for a date that plainly exists is also wrong, so the search itself
// has to be exact.
//
// WHAT MAKES IT EXACT. Inside a span of CONSTANT UTC offset, local time is just
// `t + offset`, so the local date is strictly increasing and the instant of any
// local wall-clock time is a subtraction. All the irregularity — skipped
// midnights, repeated midnights, fractional shifts, date-line jumps — lives
// exactly at the offset TRANSITIONS.
//
// So: find the transitions in a window around the date, which splits it into
// constant-offset segments; walk the segments in chronological order; return
// the first instant of the first segment that contains any part of the local
// date. Taking the FIRST such segment is what makes a repeated midnight resolve
// to the earlier occurrence rather than the later.

/** Bisection window. 36h comfortably spans any single day plus the largest real offset swing. */
const BISECT_WINDOW_MS = 36 * 60 * 60 * 1000;

/** Sub-windows scanned for offset changes. Two transitions in 36h is already unheard of. */
const TRANSITION_SCAN_SLICES = 12;

function localDateOf(t: number, tz: string): string {
  return localDateString(new Date(t), tz);
}

/**
 * The zone offset at `t`, sampled on a SECOND BOUNDARY.
 *
 * `tzOffsetMinutes` builds its comparison instant from formatted parts, which
 * carry seconds but not milliseconds, then subtracts the full millisecond
 * timestamp. Sampled at a non-second-aligned instant it therefore returns a
 * FRACTIONAL offset — -210.00001666 rather than -210 — and an equality test
 * between two such samples reports a transition that does not exist. A
 * bisection driven by that comparison converges on a phantom boundary; it is
 * what made America/Paramaribo 1984-10-01 refuse after the segment search was
 * introduced.
 *
 * Truncating to the second removes the artifact without rounding away real
 * sub-minute offsets, which historical LMT zones genuinely have.
 */
function offsetAt(t: number, tz: string): number {
  return tzOffsetMinutes(new Date(Math.floor(t / 1000) * 1000), tz);
}

/**
 * The instant at which the UTC offset changes between `lo` and `hi`, to the
 * second. Callers guarantee the offsets at the two ends differ.
 *
 * SECOND PRECISION IS EXACT HERE, not an approximation: IANA transitions occur
 * on whole seconds. Narrowing further would only re-enter the fractional-offset
 * artifact `offsetAt` exists to avoid.
 */
function bisectTransition(lo: number, hi: number, tz: string): number {
  const startOffset = offsetAt(lo, tz);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + Math.floor((hi - lo) / 2)) / 1000) * 1000;
    if (mid <= lo || mid >= hi) break;
    if (offsetAt(mid, tz) === startOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Every offset transition inside `[lo, hi]`, in order. */
function transitionsIn(lo: number, hi: number, tz: string): number[] {
  const out: number[] = [];
  const step = Math.ceil((hi - lo) / TRANSITION_SCAN_SLICES);
  for (let a = lo; a < hi; a += step) {
    const b = Math.min(a + step, hi);
    if (offsetAt(a, tz) !== offsetAt(b, tz)) {
      out.push(bisectTransition(a, b, tz));
    }
  }
  return out;
}

/**
 * The earliest instant of local date `ymd` inside one constant-offset segment
 * `[start, end)`, or null if the segment holds no part of that date.
 *
 * Two ways a segment can begin the date, and both are needed:
 *   * local midnight falls INSIDE the segment — the ordinary case, and an exact
 *     subtraction rather than a search;
 *   * the segment OPENS already inside the date — which is what a skipped
 *     midnight looks like, the day beginning at the transition itself.
 */
function segmentStartOfDate(
  start: number,
  end: number,
  wallUtcMs: number,
  ymd: string,
  tz: string,
): number | null {
  const offsetMin = offsetAt(start, tz);
  // Rounded because a historical LMT offset is not a whole number of minutes.
  const midnight = Math.round(wallUtcMs - offsetMin * 60_000);
  if (midnight >= start && midnight < end && localDateOf(midnight, tz) === ymd) {
    return midnight;
  }
  if (localDateOf(start, tz) === ymd) return start;
  return null;
}

/**
 * THE PROPERTY, CHECKED. `t` renders as `ymd`, and one millisecond earlier does
 * not. Every return path passes through here, so a future change to the search
 * cannot quietly start returning a later instant — which is exactly how the two
 * earlier revisions failed.
 */
function assertFirstInstant(t: number, ymd: string, tz: string): boolean {
  return localDateOf(t, tz) === ymd && localDateOf(t - 1, tz) !== ymd;
}

/**
 * The earliest real instant of local calendar date `ymd` in `timezone`, as an
 * ISO string — or `null` if there is no such instant.
 *
 * REFUSES, NEVER GUESSES: a malformed date, an absent or unrecognised timezone,
 * a date that does not exist in that zone, or any result that fails the
 * first-instant property. In particular an unresolvable timezone is never read
 * as UTC — that silent fallback is the original off-by-one defect.
 */
export function studioLocalDateInstant(ymd: string, timezone: string | null): string | null {
  // `<input type="date">` submits YYYY-MM-DD. Anything else is malformed or
  // forged, not something to interpret.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  // No timezone is a refusal, not a silent fallback to UTC.
  if (typeof timezone !== "string" || timezone.length === 0) return null;

  const wallUtc = Date.parse(`${ymd}T00:00:00.000Z`);
  if (!Number.isFinite(wallUtc)) return null;

  try {
    // The window is centred on the naive instant and is wide enough to contain
    // the whole local day whatever the offset. An unrecognised IANA zone makes
    // Intl throw on the first call, caught below.
    const lo = wallUtc - BISECT_WINDOW_MS;
    const hi = wallUtc + BISECT_WINDOW_MS;
    const bounds = [lo, ...transitionsIn(lo, hi, timezone), hi];

    for (let i = 0; i < bounds.length - 1; i += 1) {
      const found = segmentStartOfDate(bounds[i], bounds[i + 1], wallUtc, ymd, timezone);
      // The FIRST segment that holds any of the date wins, which is what makes
      // a repeated midnight resolve to the earlier occurrence.
      if (found !== null) {
        // An impossible calendar date — "2025-02-30" parses to March 2nd — and
        // a date the zone skipped entirely both fail here rather than being
        // detected by a second calendar implementation.
        return assertFirstInstant(found, ymd, timezone)
          ? new Date(found).toISOString()
          : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
