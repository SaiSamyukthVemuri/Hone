import { afterEach, describe, expect, it, vi } from "vitest";
import { getAvailableSlots, filterFutureSlots, type ReservationExclusion } from "@/lib/booking/slots";
import { loadPublicSlotsByDate } from "@/lib/booking/public-slot-range";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

// SCH-003 regression: "Next available" on a reschedule link.
//
// fetchNextAvailableDateForRescheduleAction finds the date with the bulk range
// loader (loadPublicSlotsByDate, stopAfterFirstMatch), but the page then fills
// that date with the per-day loader (getAvailableSlots via
// fetchRescheduleSlotsAction). If the two disagree, the link lands on a date
// that shows no times, or skips a date that has them. The existing tests mock
// one side or the other; this one runs BOTH real loaders over the same
// in-memory rows, across DST changes and far-east timezones, with the original
// practitioner, the own-reservation exclusion, a buffer, a blockout and a
// reservation that crosses local midnight. Synthetic ids only.

type Row = Record<string, unknown>;

// A small PostgREST-shaped fake over in-memory tables: just the operators the
// two loaders use. Every query is answered from the same rows.
function fakeAdmin(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const preds: Array<(row: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let page: [number, number] | null = null;
      const run = () => {
        let rows = (tables[table] ?? []).filter((row) => preds.every((p) => p(row)));
        for (const [key, asc] of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const x = String(a[key]);
            const y = String(b[key]);
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        if (page) rows = rows.slice(page[0], page[1] + 1);
        return rows;
      };
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), chain),
        is: (k: string, v: unknown) => (preds.push((r) => (r[k] ?? null) === v), chain),
        lt: (k: string, v: string) => (preds.push((r) => String(r[k]) < v), chain),
        lte: (k: string, v: string) => (preds.push((r) => String(r[k]) <= v), chain),
        gt: (k: string, v: string) => (preds.push((r) => String(r[k]) > v), chain),
        gte: (k: string, v: string) => (preds.push((r) => String(r[k]) >= v), chain),
        order: (k: string, o?: { ascending?: boolean }) => (orders.push([k, o?.ascending !== false]), chain),
        range: (from: number, to: number) => ((page = [from, to]), chain),
        maybeSingle: async () => {
          const rows = run();
          return rows.length > 1
            ? { data: null, error: { code: "PGRST116" } }
            : { data: rows[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(resolve, reject),
      };
      return chain;
    },
  };
}

const STUDIO = "studio-1";
const P = "prac-P";
const Q = "prac-Q";
const OWN: ReservationExclusion = { sourceKind: "appointment", sourceId: "appt-own" };

function weekly(dow: number, open: string | null, close: string | null, practitioner_id: string | null) {
  return { id: `d${dow}-${practitioner_id}`, studio_id: STUDIO, day_of_week: dow, is_open: open !== null, open_time: open, close_time: close, practitioner_id };
}
function dated(date: string, open: string | null, close: string | null, practitioner_id: string | null) {
  return { id: `o${date}-${practitioner_id}`, studio_id: STUDIO, effective_date: date, is_open: open !== null, open_time: open, close_time: close, practitioner_id, note: null };
}
function reservation(id: string, tz: string, date: string, start: string, minutes: number, resource: string, source_id = id) {
  const s = utcInstantFromLocal(date, start, tz);
  return {
    id, studio_id: STUDIO, resource_key: resource, source_kind: "appointment", source_id,
    starts_at: s.toISOString(), ends_at: new Date(s.getTime() + minutes * 60_000).toISOString(),
  };
}

function datesFrom(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

// Each case is a studio zone and a window crossing that zone's awkward dates.
const CASES = [
  // DST ends Sunday 2026-11-01 (25-hour day).
  { tz: "America/Toronto", now: "2026-10-28T13:00:00Z", first: "2026-10-28" },
  // DST starts Sunday 2027-03-14 (23-hour day).
  { tz: "America/Toronto", now: "2027-03-10T13:00:00Z", first: "2027-03-10" },
  // UTC+13 then +12: NZ DST ends Sunday 2027-04-04.
  { tz: "Pacific/Auckland", now: "2027-03-31T20:00:00Z", first: "2027-04-01" },
  // UTC+14, no DST: local date is a day ahead of UTC for most of the day.
  { tz: "Pacific/Kiritimati", now: "2026-07-01T00:00:00Z", first: "2026-07-01" },
  // Half-hour offset and half-hour DST: Lord Howe starts DST 2026-10-04.
  { tz: "Australia/Lord_Howe", now: "2026-09-30T00:00:00Z", first: "2026-09-30" },
] as const;

function world(tz: string, first: string) {
  const d = (n: number) => addDays(first, n);
  return {
    studio_availability_default: [
      ...[0, 1, 2, 3, 4, 5, 6].map((dow) => weekly(dow, "09:00:00", "17:00:00", null)),
      // P's own week: late on one weekday, closed on another.
      weekly(2, "13:00:00", "23:30:00", P),
      weekly(4, null, null, P),
      // Q's schedule must never leak into P's.
      weekly(5, null, null, Q),
    ],
    studio_availability_overrides: [
      dated(d(1), null, null, null), // studio closed on day 1
      dated(d(3), "10:00:00", "12:00:00", P), // P's own short day
      dated(d(6), "07:00:00", "23:59:00", null), // studio long day
      // P works late on day 4, which is the 25-hour day in the first Toronto
      // case: a booking after 23:00 local is past 24 hours from midnight.
      dated(d(4), "13:00:00", "23:59:00", P),
    ],
    studio_blockouts: [{ id: "b1", studio_id: STUDIO, starts_on: d(8), ends_on: d(8) }],
    studio_calendar_reservations: [
      // P is busy across local midnight from day 4 into day 5.
      reservation("r-midnight", tz, d(4), "23:15", 180, P),
      // P's own appointment on day 0 must not block its own reschedule.
      reservation("r-own", tz, d(0), "09:00", 480, P, "appt-own"),
      // Q is booked solid on day 2; P is unaffected.
      reservation("r-q", tz, d(2), "00:00", 1440, Q),
      // A late appointment the buffer must still respect.
      reservation("r-late", tz, d(6), "16:00", 60, P),
    ],
  };
}

afterEach(() => vi.useRealTimers());

describe("SCH-003 reschedule Next available matches the date page's slots", () => {
  for (const c of CASES) {
    it(`${c.tz} from ${c.first}: every date agrees, and the first match is the per-day first non-empty date`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(c.now));
      const admin = fakeAdmin(world(c.tz, c.first)) as never;
      const now = new Date();
      const dates = datesFrom(c.first, 14);
      const studio = {
        id: STUDIO, timezone: c.tz, buffer_minutes: 15, default_appointment_duration_minutes: 60,
        practitioner_capacity_enabled: true,
      } as never;
      const ctx = {
        studioId: STUDIO, timezone: c.tz, publicBookingHorizonMonths: 6, bufferMinutes: 15,
        serviceDurationMinutes: 90, practitionerCapacityEnabled: true, practitionerId: P, excludeReservation: OWN,
      };

      const range = await loadPublicSlotsByDate(admin, ctx, dates, now);
      expect(range.ok).toBe(true);
      if (!range.ok) return;
      const rangeByDate = new Map(range.byDate.map((g) => [g.date, g.slots]));

      const perDay = new Map<string, unknown[]>();
      for (const date of dates) {
        const slots = filterFutureSlots(await getAvailableSlots(admin, studio, date, 90, OWN, P), now);
        perDay.set(date, slots);
        expect(rangeByDate.get(date) ?? [], `${c.tz} ${date}`).toEqual(slots);
      }

      // The scenario must exercise both empty and non-empty dates.
      expect([...perDay.values()].some((s) => s.length === 0)).toBe(true);
      expect([...perDay.values()].some((s) => s.length > 0)).toBe(true);

      const next = await loadPublicSlotsByDate(admin, ctx, dates, now, { stopAfterFirstMatch: true });
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      const firstPerDay = dates.find((date) => (perDay.get(date) ?? []).length > 0) ?? null;
      expect(next.byDate[0]?.date ?? null).toBe(firstPerDay);
    });
  }

  it("does not let the own appointment hide the original day, and does not use Q's bookings", async () => {
    const c = CASES[0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(c.now));
    const admin = fakeAdmin(world(c.tz, c.first)) as never;
    const ctx = {
      studioId: STUDIO, timezone: c.tz, publicBookingHorizonMonths: 6, bufferMinutes: 15,
      serviceDurationMinutes: 90, practitionerCapacityEnabled: true, practitionerId: P,
    };
    const tomorrow = [addDays(c.first, 2)];
    const withOwn = await loadPublicSlotsByDate(admin, { ...ctx, excludeReservation: OWN }, [c.first, ...tomorrow], new Date());
    const withoutExclusion = await loadPublicSlotsByDate(admin, ctx, [c.first], new Date());
    if (!withOwn.ok || !withoutExclusion.ok) throw new Error("range read failed");
    // Day 0 is fully held by the own appointment: only the exclusion frees it.
    expect(withoutExclusion.byDate).toEqual([]);
    expect(withOwn.byDate.map((g) => g.date)).toContain(c.first);
    // Day 2 is Q's fully booked day; P is still offered times.
    expect(withOwn.byDate.map((g) => g.date)).toContain(addDays(c.first, 2));
  });
});
