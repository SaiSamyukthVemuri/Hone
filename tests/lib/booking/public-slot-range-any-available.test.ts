import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "ANY AVAILABLE" OVER A RANGE — Codex P2 4265796486.
//
// `loadPublicSlotsByDate` was studio-wide by construction: its context carried
// no practitioner and its reservation read filtered on `studio_id` alone. Under
// capacity-ON that is wrong in BOTH directions, and `fetchNextAvailableDateAction`
// is built on it, so the "Next available" control could take a visitor somewhere
// the grid beneath it disagreed with:
//
//   FALSE NEGATIVE -- 0134 fans a studio-wide closure out to one reservation row
//   per practitioner, so a studio-wide filter collects EVERYONE's conflicts and
//   the scan skips the earliest date another eligible practitioner is free on.
//
//   FALSE POSITIVE -- the studio fallback window can report a day open that
//   every eligible practitioner has individually closed, landing the caller on a
//   date whose own grid is empty.
//
// THE COST BOUND IS PART OF THE CONTRACT, not an afterthought: this path carries
// BOOK-NEXT-FAST-01, which exists because an earlier version walked the horizon
// one day at a time. The scoped reads are `.in("practitioner_id", ids)` over the
// whole window, so scoping adds TWO bulk queries in total -- not two per
// practitioner, and none per day. That is asserted here rather than described,
// because a regression to per-day reads would otherwise pass every behavioural
// test in this file.

const queries: Array<{ table: string; scoped: boolean }> = [];

const scenario = {
  /** Studio-wide weekday rows, served through the mocked helpers. */
  studioDefaults: [] as Array<Record<string, unknown>>,
  studioOverrides: [] as Array<Record<string, unknown>>,
  /** Per-practitioner rows, served through the admin client with `.in`. */
  scopedDefaults: [] as Array<Record<string, unknown>>,
  scopedOverrides: [] as Array<Record<string, unknown>>,
  blockouts: [] as Array<Record<string, unknown>>,
  reservations: [] as Array<Record<string, unknown>>,
  scopedError: null as { code: string } | null,
};

vi.mock("@/lib/booking/studio-wide-availability", () => ({
  getStudioWideDefaultsSafe: async () => scenario.studioDefaults,
  getStudioWideOverridesSafe: async () => scenario.studioOverrides,
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      let scoped = false;
      let page: { from: number; to: number } | null = null;
      const settle = () => {
        // `.in("practitioner_id", …)` is the only thing that distinguishes a
        // scoped availability read from a studio-wide one.
        queries.push({ table, scoped });
        if (table === "studio_availability_default") {
          return scenario.scopedError
            ? { data: null, error: scenario.scopedError }
            : { data: scenario.scopedDefaults, error: null };
        }
        if (table === "studio_availability_overrides") {
          return scenario.scopedError
            ? { data: null, error: scenario.scopedError }
            : { data: scenario.scopedOverrides, error: null };
        }
        if (table === "studio_blockouts") {
          return { data: scenario.blockouts, error: null };
        }
        const from = page?.from ?? 0;
        const to = Math.min(page?.to ?? 999, from + 999);
        return { data: scenario.reservations.slice(from, to + 1), error: null };
      };
      Object.assign(chain, {
        select: self,
        eq: self,
        lte: self,
        gte: self,
        lt: self,
        gt: self,
        is: self,
        order: self,
        in: () => {
          scoped = true;
          return chain;
        },
        range: (f: number, t: number) => {
          page = { from: f, to: t };
          return chain;
        },
        then: (r: (v: unknown) => unknown) => Promise.resolve(settle()).then(r),
      });
      return chain;
    },
  }),
}));

const { loadPublicSlotsByDate } = await import("@/lib/booking/public-slot-range");
const { createAdminClient } = await import("@/lib/supabase/admin-server");

const A = "pract-a";
const B = "pract-b";
const TZ = "America/Toronto";

const ctx = (practitionerIds?: readonly string[]) => ({
  studioId: "studio-1",
  timezone: TZ,
  publicBookingHorizonMonths: 3,
  bufferMinutes: 0,
  serviceDurationMinutes: 60,
  ...(practitionerIds ? { practitionerIds } : {}),
});

const openDay = (dow: number, extra: Record<string, unknown> = {}) => ({
  day_of_week: dow,
  is_open: true,
  open_time: "09:00",
  close_time: "17:00",
  ...extra,
});

/** A reservation occupying a whole studio-local day, owned by `resourceKey`. */
const allDay = (date: string, resourceKey: string) => ({
  starts_at: `${date}T04:00:00.000Z`, // 00:00 Toronto (EDT)
  ends_at: `${date}T23:59:00.000Z`,
  source_kind: "appointment",
  source_id: `appt-${date}-${resourceKey}`,
  resource_key: resourceKey,
});

// 2026-10-05 is a Monday; 06 Tue, 07 Wed.
const MON = "2026-10-05";
const TUE = "2026-10-06";
const DATES = [MON, TUE, "2026-10-07"];
const NOW = new Date("2026-10-01T12:00:00Z");

beforeEach(() => {
  // The horizon filter reads the real clock, so the scan drops every date in
  // the past. Pinned, exactly as the sibling range and next-available suites
  // do -- without it this file goes green-by-emptiness the day it is written.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  queries.length = 0;
  scenario.studioDefaults = [1, 2, 3].map((d) => openDay(d));
  scenario.studioOverrides = [];
  scenario.scopedDefaults = [];
  scenario.scopedOverrides = [];
  scenario.blockouts = [];
  scenario.reservations = [];
  scenario.scopedError = null;
});

afterEach(() => {
  vi.useRealTimers();
});

const run = (ids?: readonly string[]) =>
  loadPublicSlotsByDate(
    createAdminClient() as never,
    ctx(ids) as never,
    DATES,
    NOW,
    { stopAfterFirstMatch: true },
  );

describe("the FALSE NEGATIVE: one practitioner busy must not hide the date", () => {
  it("studio-wide skips Monday; the eligible union still offers it", async () => {
    // A is booked solid on Monday. Under capacity-ON that row carries A's
    // resource_key, and a studio-wide filter counts it for everyone.
    scenario.reservations = [allDay(MON, A)];

    const wide = await run();
    expect(wide.ok).toBe(true);
    if (wide.ok) {
      expect(
        wide.byDate[0]?.date,
        "the studio-wide scan counts A's conflict against the whole studio",
      ).toBe(TUE);
    }

    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) {
      expect(
        union.byDate[0]?.date,
        "B is free on Monday, so Monday is the earliest available date",
      ).toBe(MON);
    }
  });

  it("a reservation keyed to ANOTHER practitioner does not block this one", async () => {
    scenario.reservations = [allDay(MON, "pract-c")];
    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) expect(union.byDate[0]?.date).toBe(MON);
  });

  it("but when EVERY eligible practitioner is busy, the date is skipped", async () => {
    // The control. "Still offered" alone would also pass on a scan that had
    // simply stopped reading reservations.
    scenario.reservations = [allDay(MON, A), allDay(MON, B)];
    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) expect(union.byDate[0]?.date).toBe(TUE);
  });
});

describe("the FALSE POSITIVE: a studio-open day every practitioner has closed", () => {
  it("skips Monday when both eligible practitioners close it themselves", async () => {
    // The studio-wide row says Monday is open; each practitioner's OWN row says
    // otherwise, and their own row wins for them.
    scenario.scopedDefaults = [
      { practitioner_id: A, day_of_week: 1, is_open: false, open_time: null, close_time: null },
      { practitioner_id: B, day_of_week: 1, is_open: false, open_time: null, close_time: null },
      { practitioner_id: A, day_of_week: 2, is_open: true, open_time: "09:00", close_time: "17:00" },
      { practitioner_id: B, day_of_week: 2, is_open: true, open_time: "09:00", close_time: "17:00" },
    ];

    const wide = await run();
    expect(wide.ok).toBe(true);
    if (wide.ok) expect(wide.byDate[0]?.date).toBe(MON);

    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) {
      expect(
        union.byDate[0]?.date,
        "a date no eligible practitioner is open on is not an available date",
      ).toBe(TUE);
    }
  });

  it("a practitioner with NO rows of their own inherits the studio window", async () => {
    // The fallback `getAvailableSlots` applies under capacity-ON, mirrored here.
    // Without it, every practitioner who has never set their own hours would
    // contribute nothing and the union would be empty for most studios.
    scenario.scopedDefaults = [
      { practitioner_id: A, day_of_week: 1, is_open: false, open_time: null, close_time: null },
    ];
    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) {
      expect(union.byDate[0]?.date, "B falls back to the open studio window").toBe(MON);
    }
  });

  it("a practitioner's own OVERRIDE beats the studio override", async () => {
    scenario.studioOverrides = [
      { effective_date: MON, is_open: false, open_time: null, close_time: null },
    ];
    scenario.scopedOverrides = [
      { practitioner_id: A, effective_date: MON, is_open: true, open_time: "09:00", close_time: "17:00" },
    ];
    const union = await run([A, B]);
    expect(union.ok).toBe(true);
    if (union.ok) {
      expect(
        union.byDate[0]?.date,
        "A is open on Monday by their own override, so Monday is available",
      ).toBe(MON);
    }
  });
});

describe("legacy is untouched, and the cost bound holds", () => {
  it("without practitionerIds the answer is byte-for-byte the studio-wide one", async () => {
    scenario.reservations = [allDay(MON, A)];
    const absent = await run();
    const empty = await run([]);
    expect(absent.ok && empty.ok).toBe(true);
    if (absent.ok && empty.ok) {
      // An EMPTY eligible set is treated as unscoped on purpose: a caller that
      // passes no ids wants today's answer, not an empty grid.
      expect(empty.byDate[0]?.date).toBe(absent.byDate[0]?.date);
      expect(empty.byDate[0]?.date).toBe(TUE);
    }
  });

  it("scoping adds exactly TWO reads, and none per day — BOOK-NEXT-FAST-01", async () => {
    // THE ASSERTION THAT WOULD CATCH A REGRESSION TO PER-DAY QUERIES, which
    // every behavioural test above would happily pass.
    await run();
    const wideReads = queries.length;

    queries.length = 0;
    await run([A, B]);
    const scopedReads = queries.length;

    expect(
      scopedReads - wideReads,
      "the scoped path must add exactly two bulk reads",
    ).toBe(2);
    expect(
      queries.filter((q) => q.scoped).length,
      "both added reads must be `.in(practitioner_id, …)` over the window",
    ).toBe(2);
    // And the count must not grow with the number of practitioners.
    queries.length = 0;
    await run([A, B, "pract-c", "pract-d", "pract-e"]);
    expect(
      queries.length,
      "five practitioners must cost the same as two -- one `.in` per table",
    ).toBe(scopedReads);
  });

  it("a scoped availability read that FAILS is not an open day", async () => {
    scenario.scopedError = { code: "42501" };
    const r = await run([A, B]);
    expect(r.ok, "an unreadable availability row must fail closed").toBe(false);
  });
});
