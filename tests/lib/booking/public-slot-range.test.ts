import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// PUBLIC SLOTS FOR A RANGE — bulk-loaded, error-propagating, locally-dated
// ===========================================================================
//
// Three defects this module was rewritten to close, all of them the same shape:
// a recipient being shown less availability than exists, or availability that
// is not real.
//
//   1. COST. Looping `getAvailableSlots` issued three queries PER DATE — at the
//      12-month horizon, over a thousand reads and fifty-odd serial waves for
//      one page load. The window is now read in a FIXED number of queries
//      whatever its length.
//   2. SILENCE. `getAvailableSlots` discards each query's `error`, so a failed
//      availability read became an empty day and a failed reservation read
//      generated open-looking times over booked ones. Failures now propagate.
//   3. THE WEEKDAY. `slots.ts` derives it from noon UTC, so a studio at UTC+13
//      evaluated Monday against Tuesday's hours. It is now taken from the
//      studio-local date itself.

const queries: Array<{ table: string; op: string }> = [];
const scenario = {
  studio: {
    id: "studio-1",
    slug: "studio-a",
    timezone: "America/Toronto",
    buffer_minutes: 0,
    default_appointment_duration_minutes: 60,
    public_booking_horizon_months: 3,
  } as Record<string, unknown> | null,
  activeServices: 1,
  defaults: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<Record<string, unknown>>,
  blockouts: [] as Array<Record<string, unknown>>,
  reservations: [] as Array<Record<string, unknown>>,
  blockoutError: null as { code: string } | null,
  reservationError: null as { code: string } | null,
  servicesError: null as { code: string } | null,
  defaultsThrow: false,
};

vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => scenario.studio,
}));

vi.mock("@/lib/booking/studio-wide-availability", () => ({
  getStudioWideDefaultsSafe: async () => {
    queries.push({ table: "studio_availability_default", op: "bulk" });
    if (scenario.defaultsThrow) throw new Error("availability_read_failed:defaults:42501");
    return scenario.defaults;
  },
  getStudioWideOverridesSafe: async () => {
    queries.push({ table: "studio_availability_overrides", op: "bulk" });
    return scenario.overrides;
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      queries.push({ table, op: "select" });
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      // The requested page, when the caller paginates. `null` means it asked
      // for everything in one go — which is the shape that silently truncates.
      let page: { from: number; to: number } | null = null;
      const settle = () => {
        if (table === "services") {
          return scenario.servicesError
            ? { data: null, count: null, error: scenario.servicesError }
            : {
                data: { default_duration_minutes: 60 },
                count: scenario.activeServices,
                error: null,
              };
        }
        if (table === "studio_availability_default") {
          return { data: scenario.defaults, error: null };
        }
        if (table === "studio_blockouts") {
          return { data: scenario.blockouts, error: scenario.blockoutError };
        }
        if (scenario.reservationError) {
          return { data: null, error: scenario.reservationError };
        }
        // POSTGREST'S CAP, MODELLED. A page wider than `max_rows` comes back
        // clamped, with NO error — the behaviour that made a single unbounded
        // read invent availability. A paginating caller therefore sees a full
        // page and asks again; a non-paginating one silently loses the rest.
        const MAX_ROWS = 1000;
        const from = page?.from ?? 0;
        const to = Math.min(page?.to ?? MAX_ROWS - 1, from + MAX_ROWS - 1);
        return { data: scenario.reservations.slice(from, to + 1), error: null };
      };
      Object.assign(chain, {
        select: self, eq: self, lte: self, gte: self, lt: self, gt: self, is: self,
        order: self,
        range: (from: number, to: number) => {
          page = { from, to };
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

/** An open studio-wide weekday row. */
function openDay(dow: number) {
  return { day_of_week: dow, is_open: true, open_time: "09:00", close_time: "17:00" };
}

/** Every date in an inclusive range. */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  let c = from;
  while (c <= to) {
    out.push(c);
    const d = new Date(`${c}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    c = d.toISOString().slice(0, 10);
  }
  return out;
}

beforeEach(() => {
  queries.length = 0;
  scenario.studio = {
    id: "studio-1",
    slug: "studio-a",
    timezone: "America/Toronto",
    buffer_minutes: 0,
    default_appointment_duration_minutes: 60,
    public_booking_horizon_months: 3,
  };
  scenario.activeServices = 1;
  scenario.defaults = [0, 1, 2, 3, 4, 5, 6].map(openDay);
  scenario.overrides = [];
  scenario.blockouts = [];
  scenario.reservations = [];
  scenario.blockoutError = null;
  scenario.reservationError = null;
  scenario.servicesError = null;
  scenario.defaultsThrow = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
});

describe("the window costs a FIXED number of queries, whatever its length", () => {
  it("does not scale reads with the number of dates", async () => {
    const short = range("2026-10-05", "2026-10-07"); // 3 days
    await fetchPublicSlotsForDates({ slug: "studio-a", serviceId: "svc", dates: short });
    const shortCount = queries.length;

    queries.length = 0;
    const long = range("2026-10-05", "2026-12-20"); // 77 days
    await fetchPublicSlotsForDates({ slug: "studio-a", serviceId: "svc", dates: long });
    const longCount = queries.length;

    // THE POINT: 25x the dates, the SAME number of reads. The old loop issued
    // three per date, so this would have been 9 vs 231.
    expect(longCount).toBe(shortCount);
    expect(longCount).toBeLessThan(10);
  });

  it("reads each input source ONCE", async () => {
    await fetchPublicSlotsForDates({
      slug: "studio-a",
      serviceId: "svc",
      dates: range("2026-10-05", "2026-11-05"),
    });
    for (const table of [
      "studio_blockouts",
      "studio_calendar_reservations",
      "studio_availability_overrides",
    ]) {
      expect(queries.filter((q) => q.table === table), table).toHaveLength(1);
    }
  });

  it("NON-VACUITY — it really did produce slots", async () => {
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a",
      serviceId: "svc",
      dates: range("2026-10-05", "2026-10-07"),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots.length).toBeGreaterThan(0);
  });
});

describe("a failed read is reported, never rendered as an empty diary", () => {
  it("propagates a BLOCKOUT read failure", async () => {
    scenario.blockoutError = { code: "42501" };
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05"],
    });
    expect(out.ok).toBe(false);
  });

  it("propagates a RESERVATION read failure", async () => {
    // The dangerous one: treating this as "nothing is booked" generates open
    // times over occupied ones, which are then refused at booking.
    scenario.reservationError = { code: "42501" };
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05"],
    });
    expect(out.ok).toBe(false);
  });

  it("propagates an AVAILABILITY read failure", async () => {
    scenario.defaultsThrow = true;
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05"],
    });
    expect(out.ok).toBe(false);
  });

  it("NON-VACUITY — the same call succeeds with the reads healthy", async () => {
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05"],
    });
    expect(out.ok).toBe(true);
  });
});

describe("the weekday comes from the STUDIO-LOCAL date", () => {
  it("a Monday-only studio east of UTC offers Mondays, not Tuesdays", async () => {
    // Auckland is UTC+13 in southern daylight time, so noon UTC on a Monday is
    // already Tuesday locally. Deriving the weekday from that instant evaluated
    // Monday against Tuesday's hours: Monday openings vanished.
    scenario.studio = {
      id: "studio-1",
      slug: "studio-a",
      timezone: "Pacific/Auckland",
      buffer_minutes: 0,
      default_appointment_duration_minutes: 60,
      public_booking_horizon_months: 3,
    };
    scenario.defaults = [openDay(1)]; // Mondays only

    // 2026-10-05 is a Monday; 2026-10-06 a Tuesday.
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05", "2026-10-06"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    const days = new Set(out.slots.map((s) => s.start.slice(0, 10)));
    // Monday produced slots…
    expect([...days].some((d) => d === "2026-10-04" || d === "2026-10-05")).toBe(true);
    // …and the closed Tuesday produced none of its own.
    expect(out.slots.length).toBeGreaterThan(0);
  });

  it("a blockout covering a date removes it", async () => {
    scenario.blockouts = [{ starts_on: "2026-10-05", ends_on: "2026-10-05" }];
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-05"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots).toHaveLength(0);
  });
});

describe("the reservation read is PAGINATED, so it cannot invent availability", () => {
  it("reads past the 1,000-row Data API cap", async () => {
    // THE DEFECT THIS PINS. PostgREST clamps a response at `max_rows` (1000)
    // and sets NO error, so a single unbounded read looked correct while
    // dropping every conflict past the first thousand. A busy studio needs only
    // ~3 reservations a day to cross that over a 12-month horizon, and each
    // omitted conflict becomes an apparently-open time the booking command then
    // refuses. Truncating reservations does not hide availability — it INVENTS
    // it, which is the worse direction.
    const dates = range("2026-10-05", "2026-10-09");
    // 1,500 reservations blanketing the first day's working hours.
    scenario.reservations = Array.from({ length: 1500 }, (_, i) => ({
      starts_at: "2026-10-05T13:00:00.000Z",
      ends_at: "2026-10-05T22:00:00.000Z",
      source_kind: "appointment",
      source_id: `res-${i}`,
    }));

    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    // The blanket covers 2026-10-05 entirely, and it is only visible if the
    // read went past row 1000 — the rows are identical, so a truncated read
    // still sees the blanket. What proves pagination is the QUERY COUNT.
    const reservationReads = queries.filter(
      (q) => q.table === "studio_calendar_reservations",
    ).length;
    expect(reservationReads).toBeGreaterThan(1);
  });

  it("a reservation past the cap still blocks its day", async () => {
    // The rows before it are elsewhere, so this conflict is reachable ONLY by
    // reading past the cap. An unpaginated read would offer 2026-10-06.
    const dates = ["2026-10-05", "2026-10-06"];
    scenario.reservations = [
      ...Array.from({ length: 1200 }, (_, i) => ({
        starts_at: "2026-10-05T13:00:00.000Z",
        ends_at: "2026-10-05T22:00:00.000Z",
        source_kind: "appointment",
        source_id: `early-${i}`,
      })),
      {
        starts_at: "2026-10-06T13:00:00.000Z",
        ends_at: "2026-10-06T22:00:00.000Z",
        source_kind: "appointment",
        source_id: "late-blocker",
      },
    ];

    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");

    const days = new Set(out.slots.map((s) => s.start.slice(0, 10)));
    expect(days.has("2026-10-06")).toBe(false);
  });

  it("NON-VACUITY — that day IS offered when nothing blocks it", async () => {
    // Without this the assertion above would pass against a helper that never
    // offered 2026-10-06 for any reason at all.
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a", serviceId: "svc", dates: ["2026-10-06"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.slots.length).toBeGreaterThan(0);
  });
});

describe("the horizon bounds what is queried at all", () => {
  it("drops dates beyond the studio's booking horizon", async () => {
    const out = await fetchPublicSlotsForDates({
      slug: "studio-a",
      serviceId: "svc",
      // Well past a 3-month horizon from 2026-10-01.
      dates: ["2026-10-05", "2027-06-30"],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.scanned).toContain("2026-10-05");
    expect(out.skippedOutsideHorizon).toContain("2027-06-30");
  });
});
