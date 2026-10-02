import { describe, expect, it, vi } from "vitest";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// WAIT-v4 PR0 — the RANGE loader's half of the midnight buffer window.
//
// `getAvailableSlots` (the day loader) and `fetchPublicSlotsForDates` (the
// horizon loader) both read `studio_calendar_reservations`, and both filtered on
// the shadow's ACTUAL `ends_at` while `protectedIntervals` re-applies the buffer
// to reach the PROTECTED end. The day loader's repair is proved in
// slots-midnight-buffer-window.test.ts; this file proves the range loader's,
// which `reservationWindowStartUtc` now shares with it.
//
// WHY A SEPARATE FILE AND A SEPARATE MOCK. public-slot-range.test.ts declares its
// reservation chain as `gt: self` — the filter is DISCARDED. That mock models
// PostgREST's row cap faithfully, which is what it exists for, but it cannot
// observe a window bound: the range loader could revert to the old midnight bound
// and every assertion there would still pass. A test that cannot fail on the
// thing it names proves nothing about it, so this mock applies the predicate.

const TZ = "America/Toronto";

// DERIVED, NOT HARD-CODED. `fetchPublicSlotsForDates` skips any date outside the
// studio's booking horizon, measured from NOW — and a skipped date returns
// `byDate: []` having issued NO reservation read at all. A fixed past date
// therefore makes every assertion here vacuous, which is exactly how the first
// version of this file reported an empty bound list. 30 days out is inside the
// 3-month horizon and will stay inside it.
// MID-MONTH, deliberately. North American DST transitions fall in the first week
// of November and the second week of March, so the 1st-7th and 8th-14th are both
// unsafe for a test whose whole subject is local midnight. The 15th is clear of
// both, and ~45 days out keeps it inside the 3-month horizon.
const soon = new Date(Date.now() + 45 * 24 * 3600 * 1000);
soon.setUTCDate(15);
const DATE = soon.toISOString().slice(0, 10);
const PREV = new Date(soon.getTime() - 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);
const at = (hhmm: string) => utcInstantFromLocal(DATE, hhmm, TZ).toISOString();

// 23:50 the PREVIOUS day. Under a 30-minute buffer it is protected to 00:20, so
// it reaches into the searched day even though its own end does not.
const PREV_APPT = {
  starts_at: utcInstantFromLocal(PREV, "23:00", TZ).toISOString(),
  ends_at: utcInstantFromLocal(PREV, "23:50", TZ).toISOString(),
  source_kind: "appointment",
  source_id: "appt-prev",
};

const scenario = {
  bufferMinutes: 30,
  // Every `gt("ends_at", …)` bound the loader asked for, in order.
  endsAtBounds: [] as string[],
};

vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({
    id: "studio-1",
    slug: "studio-a",
    timezone: TZ,
    buffer_minutes: scenario.bufferMinutes,
    default_appointment_duration_minutes: 60,
    public_booking_horizon_months: 3,
  }),
}));

vi.mock("@/lib/booking/studio-wide-availability", () => ({
  // Open 00:00-08:00 every weekday: the only shape that reaches this, because the
  // open time must fall within `buffer` minutes of local midnight.
  getStudioWideDefaultsSafe: async () =>
    [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
      day_of_week: dow,
      is_open: true,
      open_time: "00:00",
      close_time: "08:00",
    })),
  getStudioWideOverridesSafe: async () => [],
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      // The reservation predicate, actually applied.
      let endsAtGt: string | null = null;
      let startsAtLt: string | null = null;

      const settle = () => {
        if (table === "services") {
          return {
            data: { default_duration_minutes: 60 },
            count: 1,
            error: null,
          };
        }
        if (table === "studio_availability_default") {
          // This read feeds isPubliclyBookable's open-days count. Returning []
          // short-circuits the whole function before the reservation read, which
          // is exactly how the first version of this test saw no `gt` at all.
          return {
            data: [0, 1, 2, 3, 4, 5, 6].map(() => ({
              is_open: true,
              open_time: "00:00",
              close_time: "08:00",
            })),
            error: null,
          };
        }
        if (table === "studio_blockouts") return { data: [], error: null };
        const rows = [PREV_APPT].filter(
          (r) =>
            (startsAtLt === null || r.starts_at < startsAtLt) &&
            (endsAtGt === null || r.ends_at > endsAtGt),
        );
        return { data: rows, error: null };
      };

      Object.assign(chain, {
        select: self,
        eq: self,
        lte: self,
        gte: self,
        is: self,
        order: self,
        range: () => chain,
        lt: (col: string, v: string) => {
          if (table === "studio_calendar_reservations" && col === "starts_at") {
            startsAtLt = v;
          }
          return chain;
        },
        gt: (col: string, v: string) => {
          if (table === "studio_calendar_reservations" && col === "ends_at") {
            endsAtGt = v;
            scenario.endsAtBounds.push(v);
          }
          return chain;
        },
        maybeSingle: async () => settle(),
        then: (r: (v: unknown) => unknown) => Promise.resolve(settle()).then(r),
      });
      return chain;
    },
  }),
}));

const { fetchPublicSlotsForDates } = await import("@/lib/booking/public-slot-range");

async function run(bufferMinutes: number) {
  scenario.bufferMinutes = bufferMinutes;
  scenario.endsAtBounds.length = 0;
  const out = await fetchPublicSlotsForDates({
    slug: "studio-a",
    serviceId: "svc",
    dates: [DATE],
  });
  return out;
}

const startsFor = (out: unknown): string[] => {
  const r = out as {
    ok?: boolean;
    error?: string;
    skippedOutsideHorizon?: unknown[];
    slots?: Array<{ start: string }>;
  };
  // `fetchPublicSlotsForDates` answers with a FLAT slot list for the dates it
  // scanned — not the grouped `byDate` its sibling returns. Reading the wrong key
  // yields `undefined`, which an `.includes` check would report as "no slots"
  // rather than as a mistake, so both shapes are asserted explicitly.
  expect(r.error, "the range loader refused before generating slots").toBeUndefined();
  expect(r.ok).toBe(true);
  // A date outside the horizon is SKIPPED before any reservation read, so an
  // empty slot list would otherwise look like a legitimately full day.
  expect(
    r.skippedOutsideHorizon,
    "the searched date was skipped as outside the horizon — nothing was exercised",
  ).toEqual([]);
  expect(Array.isArray(r.slots), "the result carried no slot list").toBe(true);
  return (r.slots ?? []).map((x) => x.start);
};

describe("WAIT-v4 PR0 · the RANGE loader widens its reservation window too", () => {
  it("asks for reservations from one buffer BEFORE the range start", async () => {
    await run(30);
    const rangeStart = utcInstantFromLocal(DATE, "00:00", TZ);
    const expected = new Date(rangeStart.getTime() - 30 * 60_000).toISOString();
    expect(
      scenario.endsAtBounds,
      "the range loader must widen its ends_at bound by the buffer",
    ).toContain(expected);
    // REVERT-DETECTING: the old midnight bound must NOT be what it asked for.
    expect(
      scenario.endsAtBounds,
      "the range loader reverted to the un-widened midnight bound",
    ).not.toContain(rangeStart.toISOString());
  });

  it("therefore LOADS the prior appointment and withholds 00:00", async () => {
    const out = await run(30);
    const starts = startsFor(out);
    expect(
      starts,
      "00:00 is protected until 00:20 — the DB refuses it with HB001",
    ).not.toContain(at("00:00"));
    // Withholds the illegal offer and nothing more: 00:20 is the protected end,
    // which is the earliest start the buffer validator accepts.
    expect(starts[0]).toBe(at("00:20"));
  });

  it("CONTROL — with no buffer the bound is the range start and 00:00 stands", async () => {
    const out = await run(0);
    const rangeStart = utcInstantFromLocal(DATE, "00:00", TZ);
    expect(scenario.endsAtBounds).toContain(rangeStart.toISOString());
    expect(startsFor(out)).toContain(at("00:00"));
  });
});
