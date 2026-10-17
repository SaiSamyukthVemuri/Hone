import { describe, expect, it } from "vitest";
import { getAvailableSlots } from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// ===========================================================================
// BOOK-TZ-01 — WEEKLY HOURS COME FROM THE REQUESTED LOCAL DATE
// ===========================================================================
//
// THE INVARIANT.
//
//     `dateStr` reaching getAvailableSlots is ALREADY a studio-local calendar
//     date. Its weekday is intrinsic to that date. No timezone may advance or
//     rewind the calendar date used to select weekly availability.
//
// THE DEFECT THIS FILE EXISTS TO KEEP CLOSED. The engine derived the weekday by
// turning the requested local date into NOON UTC and then asking which local
// weekday that INSTANT falls on:
//
//     localDayOfWeek(new Date(`${dateStr}T12:00:00Z`), tz)
//
// Those are two different questions. `localDayOfWeek(Date, tz)` is a correct
// helper — for an INSTANT. Applying it to a value that is already a local
// calendar date re-converts something that was never in UTC to begin with.
//
// East of UTC+12 the noon-UTC instant has already crossed midnight locally, so
// the answer is TOMORROW'S weekday. Measured, on this runtime:
//
//     dateStr 2026-01-05 (a Monday), noon UTC ->
//       UTC                 2026-01-05 12:00  Mon   same day
//       America/Toronto     2026-01-05 07:00  Mon   same day
//       Pacific/Auckland    2026-01-06 01:00  TUE   rolled over
//       Pacific/Kiritimati  2026-01-06 02:00  TUE   rolled over
//
// So a recipient asking an Auckland studio for Monday was offered MONDAY'S date
// with TUESDAY'S opening hours. It is not a DST artefact: Auckland rolls over in
// NZDT (UTC+13, January) and in NZST (UTC+12, July) alike, because noon UTC at
// +12 lands exactly on the next local midnight.
//
// THIS PRE-EXISTS WAIT ENTIRELY. `getAvailableSlots` is the shared engine behind
// ordinary public booking, public rescheduling, practitioner/client booking and
// the calendar move paths. WAIT-03 B3 only exposed it, by correctly using the
// local calendar date in its own range loader.
//
// WHAT IS NOT CHANGED. The timezone still decides how a local wall-clock time
// becomes a UTC instant — `utcInstantFromLocal` is untouched, and the assertions
// below check the produced slot instants through it. Only the WEEKDAY SELECTION
// stops asking the timezone a question the date string had already answered.

const STUDIO = "studio-1";

/** Monday. Chosen so the neighbouring weekday (Tuesday) has different hours. */
const MONDAY = "2026-01-05";
/** The same Monday in the southern winter, so the proof is not a DST artefact. */
const MONDAY_NZST = "2026-07-06";

const MON = 1;
const TUE = 2;

/** Distinct windows, so which weekday was consulted is visible in the output. */
const HOURS: Record<number, { open: string; close: string }> = {
  [MON]: { open: "09:00:00", close: "10:00:00" },
  [TUE]: { open: "14:00:00", close: "15:00:00" },
};

type Probe = { daysQueried: number[] };

/**
 * Filter-aware Supabase mock.
 *
 * It RECORDS every `day_of_week` the engine filters on and serves that day's
 * window, so the test can assert the selection authority directly rather than
 * inferring it from slot times alone. Both are checked: the weekday asked for,
 * and the wall-clock window that came back.
 */
function mock(probe: Probe) {
  function builder(table: string) {
    const f: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "lte", "gte", "lt", "gt", "order"]) b[m] = () => b;
    b.eq = (col: string, val: unknown) => {
      f[col] = val;
      if (table === "studio_availability_default" && col === "day_of_week") {
        probe.daysQueried.push(val as number);
      }
      return b;
    };
    b.is = (col: string, val: unknown) => {
      f[col] = val;
      return b;
    };
    const resolve = () => {
      if (table === "studio_blockouts") return { data: [], error: null };
      // No override anywhere: the weekly default is what must be selected.
      if (table === "studio_availability_overrides") return { data: null, error: null };
      if (table === "studio_availability_default") {
        const dow = f.day_of_week as number;
        const h = HOURS[dow];
        return {
          data: h ? { is_open: true, open_time: h.open, close_time: h.close } : null,
          error: null,
        };
      }
      if (table === "studio_calendar_reservations") return { data: [], error: null };
      return { data: null, error: null };
    };
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any;
}

const studio = (tz: string) => ({
  id: STUDIO,
  timezone: tz,
  default_appointment_duration_minutes: 60,
  buffer_minutes: 0,
  practitioner_capacity_enabled: false,
});

// ---------------------------------------------------------------------------
// THE MATRIX. Same date string, four zones, one answer.
// ---------------------------------------------------------------------------
describe("BOOK-TZ-01 — the requested local date owns its own weekday", () => {
  it.each([
    ["UTC", "UTC", MONDAY],
    ["America/Toronto — west of UTC, control", "America/Toronto", MONDAY],
    ["Pacific/Auckland — UTC+13, NZDT", "Pacific/Auckland", MONDAY],
    ["Pacific/Kiritimati — UTC+14, the extreme", "Pacific/Kiritimati", MONDAY],
    ["Pacific/Auckland — UTC+12, NZST, not a DST artefact", "Pacific/Auckland", MONDAY_NZST],
  ])("%s: a Monday queries MONDAY's weekly hours", async (_label, tz, date) => {
    const probe: Probe = { daysQueried: [] };
    const slots = await getAvailableSlots(mock(probe), studio(tz), date);

    // 1. THE SELECTION AUTHORITY, asserted directly.
    expect(
      probe.daysQueried,
      `${tz} on ${date}: the engine consulted weekday(s) ${probe.daysQueried.join(", ")} ` +
        `for a date whose intrinsic weekday is ${MON} (Monday)`,
    ).not.toHaveLength(0);
    for (const d of probe.daysQueried) expect(d).toBe(MON);

    // 2. THE CONSEQUENCE. Monday's 09:00-10:00 window, not Tuesday's 14:00-15:00.
    expect(slots.map((s) => s.start)).toEqual([
      utcInstantFromLocal(date, "09:00", tz).toISOString(),
    ]);
  });

  it("the same date string yields the same weekday in every zone", async () => {
    const seen = new Set<number>();
    for (const tz of ["UTC", "America/Toronto", "Pacific/Auckland", "Pacific/Kiritimati"]) {
      const probe: Probe = { daysQueried: [] };
      await getAvailableSlots(mock(probe), studio(tz), MONDAY);
      for (const d of probe.daysQueried) seen.add(d);
    }
    // A single value across the whole matrix. Two would mean the zone is still
    // deciding which weekday a fixed calendar date is.
    expect([...seen]).toEqual([MON]);
  });

  it("NON-VACUITY: the mock really can tell the two weekdays apart", async () => {
    // Tuesday's own date must produce Tuesday's window — otherwise every
    // assertion above would pass against a fixture that only ever serves Monday.
    const probe: Probe = { daysQueried: [] };
    const tuesday = "2026-01-06";
    const slots = await getAvailableSlots(mock(probe), studio("UTC"), tuesday);
    for (const d of probe.daysQueried) expect(d).toBe(TUE);
    expect(slots.map((s) => s.start)).toEqual([
      utcInstantFromLocal(tuesday, "14:00", "UTC").toISOString(),
    ]);
  });

  it("TIMEZONE STILL GOVERNS THE INSTANT, which this repair must not touch", async () => {
    // The weekday stops consulting the zone; converting the local wall clock to
    // a UTC instant still must. Same 09:00 local, four different instants.
    const instants = new Set<string>();
    for (const tz of ["UTC", "America/Toronto", "Pacific/Auckland", "Pacific/Kiritimati"]) {
      const slots = await getAvailableSlots(mock({ daysQueried: [] }), studio(tz), MONDAY);
      expect(slots).toHaveLength(1);
      instants.add(slots[0]!.start);
    }
    expect(instants.size, "the zone must still decide the UTC instant").toBe(4);
  });
});
