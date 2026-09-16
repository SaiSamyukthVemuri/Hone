import { localDateString, utcInstantFromLocal } from "@/lib/booking/tz";

// WAIT-04A. A calendar date the operator typed, as an exact instant.
//
// ===========================================================================
// WHY THIS IS ITS OWN MODULE
// ===========================================================================
//
// It lived in the server-action file first, and `next build` refused it:
// "Server Actions must be async functions". A `"use server"` module may export
// nothing but async functions, and this is a PURE synchronous function — no
// I/O, no session, no database. Typecheck cannot see that rule; only the build
// does.
//
// Being pure is also why it belongs here rather than being made async to
// satisfy the compiler: a date conversion that awaits nothing should not be
// awaited, and here it can be unit-tested directly without a server boundary.
//
/**
 * A calendar date the operator typed, as the exact instant that date BEGAN in
 * the studio's own timezone.
 *
 * ===========================================================================
 * WHY A BARE 'YYYY-MM-DD' IS WRONG, MEASURED
 * ===========================================================================
 *
 * `p_joined_at` is `timestamptz`. Handing PostgreSQL a bare date lets the
 * DATABASE SESSION's timezone decide which instant it names, and the session is
 * UTC. For a studio west of Greenwich that instant falls on the PREVIOUS local
 * day, so the row renders back a day earlier than the practitioner typed:
 *
 *     America/Toronto, "2025-03-04" as UTC -> renders 2025-03-03   WRONG
 *     America/Toronto, local midnight      -> renders 2025-03-04   right
 *
 * East of Greenwich the calendar date survives by luck, but the instant is
 * still hours late — and `joined_at` is half of the (joined_at, id) total order
 * that decides queue position, so "by luck" is not a property to rely on.
 *
 * ===========================================================================
 * NO SECOND DATE IMPLEMENTATION
 * ===========================================================================
 *
 * `utcInstantFromLocal` in lib/booking/tz.ts already does this and is already
 * hardened for the case a naive implementation gets wrong: it re-samples the
 * zone offset at the CORRECTED instant, because a single pass lands an hour off
 * when the naive and corrected instants straddle a DST transition (PR #184).
 * `new Date("YYYY-MM-DD")` is never the authority here — it parses as UTC,
 * which is the defect itself.
 *
 * ===========================================================================
 * THE ROUND TRIP IS THE PROOF, AND THE PROBE IS WHY IT IS NOT ENOUGH ALONE
 * ===========================================================================
 *
 * The instant is accepted only if rendering it back in the studio's timezone
 * reproduces the typed date exactly. That single check also rejects impossible
 * calendar dates — "2025-02-30" parses to March 2nd and fails to round-trip —
 * without a second calendar implementation.
 *
 * BUT SOME ZONES HAVE NO MIDNIGHT ON SOME DAYS. Where the DST shift happens AT
 * midnight the local day starts at 01:00, and asking for 00:00 yields an
 * instant on the day BEFORE:
 *
 *     America/Santiago 2025-09-07 00:00 -> renders 2025-09-06
 *     America/Havana   2025-03-09 00:00 -> renders 2025-03-08
 *
 * Refusing those would reject a date the operator is entitled to enter, so the
 * first existing local hour of that date is probed for instead. Noon is the
 * last resort and always exists: no one-hour shift can skip it.
 */
const DAY_START_PROBES = ["00:00", "01:00", "02:00", "03:00", "12:00"] as const;

export function studioLocalDateInstant(ymd: string, timezone: string | null): string | null {
  // FORM SHAPE FIRST. `<input type="date">` submits YYYY-MM-DD, and anything
  // else is a forged or malformed post rather than something to interpret.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  // NO TIMEZONE IS A REFUSAL, NOT A SILENT FALLBACK TO UTC. Defaulting here
  // would reintroduce exactly the off-by-one day this function exists to
  // remove, and would do it invisibly.
  if (typeof timezone !== "string" || timezone.length === 0) return null;

  for (const time of DAY_START_PROBES) {
    let instant: Date;
    try {
      instant = utcInstantFromLocal(ymd, time, timezone);
    } catch {
      // An unrecognised IANA zone makes Intl throw. Refuse — never reinterpret
      // the date as UTC, which is the defect.
      return null;
    }
    if (!Number.isFinite(instant.getTime())) return null;
    try {
      if (localDateString(instant, timezone) === ymd) return instant.toISOString();
    } catch {
      return null;
    }
  }
  return null;
}
