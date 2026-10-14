import { describe, expect, it } from "vitest";
import {
  getAvailableSlots,
  reservationWindowStartUtc,
} from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// WAIT-v4 PR0 — the midnight buffer spill, fixed at the loader's window.
//
// THE DEFECT. `studio_calendar_reservations` stores an appointment's ACTUAL end
// (0152) and `protectedIntervals` re-applies the studio buffer to reach its
// PROTECTED end. Both loaders filtered reservations on `ends_at > windowStart`,
// the ACTUAL end — so a 23:50 appointment under a 30-minute buffer, protected to
// 00:20, was never loaded for the following day. The generator offered 00:00 and
// the database's `enforce_appointment_buffer` (0152) then refused the write with
// HB001. An offer the authority would not accept.
//
// WHY THE PURE CORE WAS NEVER WRONG. Given that reservation, the core already
// excluded 00:00 — slot-pure-core.test.ts characterised the defect by passing
// `reservations: []`, "exactly as the loader's query leaves it". The repair
// therefore belongs to the query boundary, which is what this file proves.
//
// THE FAKE HONOURS `gt`, DELIBERATELY. Every other slots fake in this repo
// returns its reservation rows whatever the filters say, so the window could be
// widened or narrowed and those tests would not move. A fake that cannot fail on
// the thing under test proves nothing about it.

const TZ = "America/Toronto";
const DATE = "2026-06-12"; // the day being searched
const at = (hhmm: string) => utcInstantFromLocal(DATE, hhmm, TZ).toISOString();
// 23:50 the PREVIOUS day, protected to 00:20 under a 30-minute buffer.
const prevEnd = utcInstantFromLocal("2026-06-11", "23:50", TZ);
const prevStart = utcInstantFromLocal("2026-06-11", "23:00", TZ);

type Res = {
  starts_at: string;
  ends_at: string;
  source_kind: string;
  source_id: string;
};

const PREV_DAY_APPT: Res = {
  starts_at: prevStart.toISOString(),
  ends_at: prevEnd.toISOString(),
  source_kind: "appointment",
  source_id: "appt-prev",
};

const studio = (bufferMinutes: number) => ({
  id: "studio-1",
  timezone: TZ,
  buffer_minutes: bufferMinutes,
  default_appointment_duration_minutes: 60,
  public_booking_horizon_months: 6,
});

/**
 * A Supabase double that applies the reservation filters it is given, so the
 * loader's window decides what it sees — exactly as Postgres would.
 */
function filteringSupabase(reservations: Res[]) {
  const seen: { endsAtGt?: string; startsAtLt?: string } = {};
  const windows: Record<string, { data: unknown }> = {
    studio_blockouts: { data: [] },
    studio_availability_overrides: { data: null },
    studio_availability_default: {
      data: { is_open: true, open_time: "00:00:00", close_time: "08:00:00" },
    },
  };

  function builder(table: string) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "lte", "gte", "order"]) {
      b[m] = () => b;
    }
    b.lt = (col: string, v: string) => {
      if (table === "studio_calendar_reservations" && col === "starts_at") {
        seen.startsAtLt = v;
      }
      return b;
    };
    b.gt = (col: string, v: string) => {
      if (table === "studio_calendar_reservations" && col === "ends_at") {
        seen.endsAtGt = v;
      }
      return b;
    };
    const result = () => {
      if (table !== "studio_calendar_reservations") {
        return windows[table] ?? { data: null };
      }
      // THE REAL PREDICATE: starts_at < lt AND ends_at > gt.
      const rows = reservations.filter(
        (r) =>
          (seen.startsAtLt === undefined || r.starts_at < seen.startsAtLt) &&
          (seen.endsAtGt === undefined || r.ends_at > seen.endsAtGt),
      );
      return { data: rows };
    };
    b.maybeSingle = () => Promise.resolve(result());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onF, onR);
    return b;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: (t: string) => builder(t) } as any, seen };
}

const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

describe("WAIT-v4 PR0 · a buffer crossing local midnight is loaded", () => {
  it("does NOT offer 00:00 when the previous day's protected end reaches into it", async () => {
    // The studio opens at 00:00 with a 30-minute buffer, which is the only shape
    // that reaches this: an open time within `buffer` minutes of local midnight.
    const { client } = filteringSupabase([PREV_DAY_APPT]);
    const slots = await getAvailableSlots(client, studio(30), DATE, 60);
    expect(
      starts(slots),
      "00:00 is protected until 00:20 — offering it is an offer the DB refuses with HB001",
    ).not.toContain(at("00:00"));
    // AND IT WITHHOLDS NOTHING MORE. The earliest offered start is 00:20 — the
    // reservation's protected end, which IS the earliest start the DB buffer
    // validator accepts. The repair removes the illegal offer and replaces it
    // with the legal one immediately after, rather than blanking the morning.
    expect(starts(slots)[0]).toBe(at("00:20"));
  });

  it("loads the previous day's appointment by widening the window, not by luck", async () => {
    const { client, seen } = filteringSupabase([PREV_DAY_APPT]);
    await getAvailableSlots(client, studio(30), DATE, 60);
    const windowStart = utcInstantFromLocal(DATE, "00:00", TZ);
    expect(
      seen.endsAtGt,
      "the reservation window must open one buffer before the day",
    ).toBe(new Date(windowStart.getTime() - 30 * 60_000).toISOString());
    // And the row really was inside that bound.
    expect(PREV_DAY_APPT.ends_at > seen.endsAtGt!).toBe(true);
  });

  it("with NO buffer the window is unchanged, so nothing new is loaded", async () => {
    // The previous day's appointment ends at 23:50 and protects nothing past it,
    // so 00:00 is genuinely free. This is the control: the repair must not
    // withhold a start that the authority would accept.
    const { client, seen } = filteringSupabase([PREV_DAY_APPT]);
    const slots = await getAvailableSlots(client, studio(0), DATE, 60);
    expect(seen.endsAtGt).toBe(
      utcInstantFromLocal(DATE, "00:00", TZ).toISOString(),
    );
    expect(starts(slots)).toContain(at("00:00"));
  });
});

describe("WAIT-v4 PR0 · reservationWindowStartUtc", () => {
  const base = new Date("2026-06-12T04:00:00.000Z");

  it("opens the window one buffer early", () => {
    expect(reservationWindowStartUtc(base, 30).toISOString()).toBe(
      "2026-06-12T03:30:00.000Z",
    );
  });

  it("is identity at zero, and floors a negative buffer rather than narrowing", () => {
    expect(reservationWindowStartUtc(base, 0).getTime()).toBe(base.getTime());
    expect(reservationWindowStartUtc(base, -15).getTime()).toBe(base.getTime());
  });
});
