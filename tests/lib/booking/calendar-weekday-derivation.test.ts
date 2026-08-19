import { describe, expect, it } from "vitest";
import { getAvailableSlots } from "@/lib/booking/slots";
import { calendarDayOfWeek, utcInstantFromLocal } from "@/lib/booking/tz";

// CALENDAR-DATE WEEKDAY DERIVATION.
//
// `getAvailableSlots` receives `dateStr` — a STUDIO-LOCAL calendar date,
// "YYYY-MM-DD" — and must look up the weekly availability row for THAT date's
// weekday. Every SQL availability function derives it from the calendar date
// itself (`extract(dow from p_local_date)`: migrations 0170:283, 0171:360,
// 0171:370; and `extract(dow from v_local_start)` at 0170:493, 0171:641).
//
// The defect this file pins: the generator round-tripped a FABRICATED instant —
// noon UTC on the requested date — back through the studio timezone and asked
// which local day that instant fell on. For any studio at UTC offset >= +12,
// noon UTC has already crossed into the next local day, so a Monday request
// resolved to TUESDAY's weekly row.
//
// The boundary is offset >= +12:00, which is wider than "UTC+13/+14": it takes
// in New Zealand, Fiji, Chatham and Kamchatka, year-round.
//
// THE INVARIANT
//   For a "YYYY-MM-DD" studio-local calendar date, the weekday used for the
//   weekly-availability lookup is the Gregorian weekday of that date, and is
//   INDEPENDENT of the studio timezone, its UTC offset, and any DST transition.
//
// These are BEHAVIOURAL tests: they drive the real `getAvailableSlots` and
// observe (a) which `day_of_week` it actually queries and (b) which window's
// slots it actually produces. They do not assert on source text, and they do
// not import the helper under repair — so they hold across any implementation
// that satisfies the invariant.

// ---------------------------------------------------------------------------
// The zone matrix. Six studios at offset >= +12 (the affected class) and eight
// controls spanning +10 through -12, so a fix that merely special-cased the
// Pacific would be caught by the controls going red.
// ---------------------------------------------------------------------------
const ZONES_AT_OR_ABOVE_PLUS_12 = [
  "Pacific/Kiritimati", // +14
  "Pacific/Apia", // +13
  "Pacific/Auckland", // +12 / +13
  "Pacific/Fiji", // +12 / +13
  "Pacific/Chatham", // +12:45 / +13:45
  "Asia/Kamchatka", // +12
] as const;

const CONTROL_ZONES = [
  "Australia/Sydney", // +10 / +11
  "Asia/Tokyo", // +9
  "Europe/London", // 0 / +1
  "UTC", // 0
  "America/Toronto", // -5 / -4
  "Pacific/Honolulu", // -10
  "Pacific/Midway", // -11
  "Etc/GMT+12", // -12  (the far negative extreme)
] as const;

const ALL_ZONES = [...ZONES_AT_OR_ABOVE_PLUS_12, ...CONTROL_ZONES];

// Dates spanning both hemispheres' DST transitions, a month boundary, a leap-
// free February, and a year boundary — so weekday derivation is exercised where
// UTC offsets move rather than only on quiet mid-month days.
const DATES = [
  "2026-01-05", // Monday
  "2026-02-28", // Saturday, month boundary
  "2026-03-08", // Sunday, US spring-forward
  "2026-04-05", // Sunday, AU/NZ fall-back
  "2026-06-21", // Sunday, solstice
  "2026-08-17", // Monday
  "2026-09-27", // Sunday, NZ spring-forward
  "2026-11-01", // Sunday, US fall-back
  "2026-12-31", // Thursday
  "2027-01-01", // Friday, year boundary
] as const;

// The expected answer, stated independently of anything under test: the
// Gregorian weekday of the calendar date, 0 = Sunday .. 6 = Saturday, the same
// domain as Postgres's `extract(dow from date)`. Built from integer components
// via Date.UTC, so it depends on no parser, no locale and no host timezone.
function gregorianWeekday(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ---------------------------------------------------------------------------
// A supabase mock that RECORDS the day_of_week it is asked for, and answers
// from a per-weekday table so the choice has a visible product consequence.
// ---------------------------------------------------------------------------
type WindowRow = { is_open: boolean; open_time: string; close_time: string };

function recordingSupabase(windowsByWeekday: Record<number, WindowRow>) {
  const queriedWeekdays: number[] = [];

  function builder(table: string) {
    let weekday: number | null = null;
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "is", "lte", "gte", "lt", "gt", "order"]) {
      b[m] = chain;
    }
    b.eq = (column: string, value: unknown) => {
      if (table === "studio_availability_default" && column === "day_of_week") {
        weekday = value as number;
        queriedWeekdays.push(value as number);
      }
      return b;
    };
    const resolve = () => {
      if (table === "studio_availability_default") {
        return {
          data: weekday === null ? null : (windowsByWeekday[weekday] ?? null),
          error: null,
        };
      }
      if (table === "studio_blockouts") return { data: [], error: null };
      if (table === "studio_calendar_reservations") return { data: [], error: null };
      // studio_availability_overrides: no date override, so the weekly default
      // is the row that decides — which is the path the defect lives on.
      return { data: null, error: null };
    };
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR);
    return b;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { from: (t: string) => builder(t) } as any,
    queriedWeekdays,
  };
}

const studio = (timezone: string, capacityEnabled = false) => ({
  id: "studio-1",
  timezone,
  default_appointment_duration_minutes: 60,
  buffer_minutes: 0,
  practitioner_capacity_enabled: capacityEnabled,
});

const OPEN_ALL_DAY: WindowRow = {
  is_open: true,
  open_time: "09:00:00",
  close_time: "17:00:00",
};
const everyWeekdayOpen: Record<number, WindowRow> = {
  0: OPEN_ALL_DAY,
  1: OPEN_ALL_DAY,
  2: OPEN_ALL_DAY,
  3: OPEN_ALL_DAY,
  4: OPEN_ALL_DAY,
  5: OPEN_ALL_DAY,
  6: OPEN_ALL_DAY,
};

// ---------------------------------------------------------------------------
// 1. THE MATRIX — which weekday row does the generator actually ask for?
// ---------------------------------------------------------------------------
describe("weekday derivation — full zone x date matrix", () => {
  it("queries the requested calendar date's Gregorian weekday in EVERY zone", async () => {
    const disagreements: string[] = [];

    for (const timezone of ALL_ZONES) {
      for (const date of DATES) {
        const { client, queriedWeekdays } = recordingSupabase(everyWeekdayOpen);
        await getAvailableSlots(client, studio(timezone), date, 60);
        const expected = gregorianWeekday(date);
        for (const actual of queriedWeekdays) {
          if (actual !== expected) {
            disagreements.push(
              `${timezone} ${date}: expected dow ${expected}, queried ${actual}`,
            );
          }
        }
      }
    }

    // Reported as a list so a failure names every affected zone and date at
    // once rather than stopping at the first.
    expect(disagreements).toEqual([]);
  });

  it("asks the SAME weekday for a given date regardless of studio timezone", async () => {
    for (const date of DATES) {
      const expected = gregorianWeekday(date);
      for (const timezone of ALL_ZONES) {
        const { client, queriedWeekdays } = recordingSupabase(everyWeekdayOpen);
        await getAvailableSlots(client, studio(timezone), date, 60);
        expect(
          queriedWeekdays,
          `${timezone} on ${date} must resolve to weekday ${expected}`,
        ).not.toHaveLength(0);
        expect(
          new Set(queriedWeekdays),
          `${timezone} on ${date}`,
        ).toEqual(new Set([expected]));
      }
    }
  });

  it("holds on the capacity-ON path, which resolves the window separately", async () => {
    const disagreements: string[] = [];
    for (const timezone of ALL_ZONES) {
      for (const date of DATES) {
        const { client, queriedWeekdays } = recordingSupabase(everyWeekdayOpen);
        await getAvailableSlots(
          client,
          studio(timezone, true),
          date,
          60,
          undefined,
          "practitioner-1",
        );
        const expected = gregorianWeekday(date);
        for (const actual of queriedWeekdays) {
          if (actual !== expected) {
            disagreements.push(`${timezone} ${date}: ${actual} != ${expected}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. THE CONSEQUENCE — reading the wrong weekday offers the wrong hours.
//
// A query-argument assertion alone could be satisfied by a change that never
// reaches a practitioner. These give each weekday a DIFFERENT window, so
// picking the wrong row changes the slots the studio actually offers.
// ---------------------------------------------------------------------------
describe("weekday derivation — product consequence", () => {
  // Monday trades 09:00-17:00; Tuesday only 13:00-15:00; every other day shut.
  const distinctWindows: Record<number, WindowRow> = {
    1: { is_open: true, open_time: "09:00:00", close_time: "17:00:00" },
    2: { is_open: true, open_time: "13:00:00", close_time: "15:00:00" },
  };

  const MONDAY = "2026-08-17";

  it.each(ZONES_AT_OR_ABOVE_PLUS_12)(
    "%s: a Monday request offers MONDAY's hours, not Tuesday's",
    async (timezone) => {
      const { client } = recordingSupabase(distinctWindows);
      const slots = await getAvailableSlots(client, studio(timezone), MONDAY, 60);

      // Monday opens at 09:00 local and runs to 17:00, so the opening anchor is
      // 09:00 and the day offers more than Tuesday's two-hour window could.
      expect(slots.length).toBeGreaterThan(2);
      expect(slots[0]?.start).toBe(
        utcInstantFromLocal(MONDAY, "09:00", timezone).toISOString(),
      );
    },
  );

  it.each(CONTROL_ZONES)(
    "%s: unchanged — a Monday request already offers Monday's hours",
    async (timezone) => {
      const { client } = recordingSupabase(distinctWindows);
      const slots = await getAvailableSlots(client, studio(timezone), MONDAY, 60);
      expect(slots.length).toBeGreaterThan(2);
      expect(slots[0]?.start).toBe(
        utcInstantFromLocal(MONDAY, "09:00", timezone).toISOString(),
      );
    },
  );

  it.each(ZONES_AT_OR_ABOVE_PLUS_12)(
    "%s: a Sunday request finds the studio CLOSED, not open on Monday's hours",
    async (timezone) => {
      // 2026-08-16 is a Sunday; no window is configured for weekday 0. Reading
      // the following local day would find Monday's 09:00-17:00 and offer slots
      // on a day the studio does not trade.
      const { client } = recordingSupabase(distinctWindows);
      const slots = await getAvailableSlots(
        client,
        studio(timezone),
        "2026-08-16",
        60,
      );
      expect(slots).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. THE HELPER'S CONTRACT.
//
// `calendarDayOfWeek` is checked against an INDEPENDENT ORACLE — Sakamoto's
// algorithm, pure integer arithmetic with no Date, no Intl, no parser and no
// clock. Agreeing with it means the helper's answer cannot be resting on any
// Date.UTC or host-environment behaviour.
// ---------------------------------------------------------------------------
function sakamotoWeekday(y: number, m: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
}

describe("calendarDayOfWeek — contract", () => {
  it("agrees with an independent integer-arithmetic oracle over 12 years of dates", () => {
    const disagreements: string[] = [];
    // Every day from 2020-01-01 through 2031-12-31: leap years, century rules,
    // month lengths and year boundaries, with no Date used to enumerate them.
    for (let y = 2020; y <= 2031; y++) {
      for (let m = 1; m <= 12; m++) {
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        for (let d = 1; d <= lastDay; d++) {
          const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const actual = calendarDayOfWeek(iso);
          const expected = sakamotoWeekday(y, m, d);
          if (actual !== expected) {
            disagreements.push(`${iso}: got ${actual}, oracle says ${expected}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("advances by exactly one weekday per calendar day, across DST transitions", () => {
    // A structural invariant that ANY offset dependence would break: the
    // weekday sequence is a plain +1 (mod 7) walk. The window deliberately
    // straddles both hemispheres' 2026 transitions.
    const start = Date.UTC(2026, 0, 1);
    let previous = calendarDayOfWeek("2026-01-01");
    for (let i = 1; i < 400; i++) {
      const iso = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const current = calendarDayOfWeek(iso);
      expect(current, `weekday must advance by one at ${iso}`).toBe((previous + 1) % 7);
      previous = current;
    }
  });

  it("returns the Postgres domain: 0 = Sunday .. 6 = Saturday", () => {
    expect(calendarDayOfWeek("2026-08-16")).toBe(0); // Sunday
    expect(calendarDayOfWeek("2026-08-17")).toBe(1); // Monday
    expect(calendarDayOfWeek("2026-08-22")).toBe(6); // Saturday
  });

  it("handles leap days and rejects the ones that do not exist", () => {
    expect(calendarDayOfWeek("2028-02-29")).toBe(2); // Tuesday, a real leap day
    expect(() => calendarDayOfWeek("2027-02-29")).toThrow(RangeError);
    expect(() => calendarDayOfWeek("2100-02-29")).toThrow(RangeError); // century rule
  });

  it("throws on a date that does not exist rather than rolling it forward", () => {
    // Date.UTC(2026, 1, 30) silently becomes 2 March. Postgres's date cast
    // refuses it, and so does this.
    expect(() => calendarDayOfWeek("2026-02-30")).toThrow(RangeError);
    expect(() => calendarDayOfWeek("2026-04-31")).toThrow(RangeError);
    expect(() => calendarDayOfWeek("2026-13-01")).toThrow(RangeError);
    expect(() => calendarDayOfWeek("2026-00-10")).toThrow(RangeError);
    expect(() => calendarDayOfWeek("2026-06-00")).toThrow(RangeError);
  });

  it("throws on malformed input, as the previous derivation did", () => {
    // The old path fed the string to `new Date(...)` and then to
    // Intl.DateTimeFormat.format, which throws RangeError on an Invalid Date.
    // Preserving the throw keeps this repair free of any behaviour change
    // outside the weekday itself.
    for (const bad of ["", "not-a-date", "2026-8-17", "26-08-17", "2026/08/17", "2026-08-17T00:00:00Z"]) {
      expect(() => calendarDayOfWeek(bad), `${JSON.stringify(bad)} must throw`).toThrow(RangeError);
    }
  });

  it("takes no timezone, so no caller can make the answer depend on one", () => {
    // A compile-time fact made observable: the function has arity 1. A second
    // argument would be the seam through which offset dependence returned.
    expect(calendarDayOfWeek).toHaveLength(1);
  });
});
