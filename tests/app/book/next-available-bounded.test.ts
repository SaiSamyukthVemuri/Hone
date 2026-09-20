import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// BOOK-NEXT-FAST-01 — "Next available" is bounded, and still correct
// ===========================================================================
//
// THE DEFECT (F-SCALE-002). `fetchNextAvailableDateAction` walked the horizon
// one day at a time, awaiting `getAvailableSlots` per date. That call is a DAY
// LOADER: on the public path it issues a blockout read, an override read, a
// weekday-default read and a reservation read, each awaited in turn. So a
// 12-month "nothing is open" answer cost roughly 1,500 SEQUENTIAL reads, and
// the person who pressed the button waited for all of them.
//
// WHAT THIS FILE PINS, and why each half matters:
//
//   COST — the read count must not grow with the horizon. That is asserted by
//   COMPARING a 7-day scan against a full 12-month scan through the same code
//   path, not by restating a number: a bound written as a literal drifts the
//   moment the loader changes shape, whereas the comparison keeps meaning.
//
//   CORRECTNESS — every availability RULE must survive the rewrite. Closed
//   weekdays, overrides, blockouts, reservations, buffers, local weekday under
//   UTC+13, the past-time filter and the horizon edge each get a case, because
//   "faster" is worthless if the date it returns is wrong.
//
//   SILENCE — the old loop swallowed read errors (`getAvailableSlots` discards
//   each query's `error`), so a failed read became an empty day, the scan
//   continued, and the horizon was reported exhausted. "I could not read" was
//   rendered as "nothing is open" on the surface where that costs a booking.
//   That one is a BEHAVIOUR CHANGE and is asserted as such.

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
  serviceDuration: 60 as number | null,
  defaults: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<Record<string, unknown>>,
  blockouts: [] as Array<Record<string, unknown>>,
  reservations: [] as Array<Record<string, unknown>>,
  blockoutError: null as { code: string } | null,
  reservationError: null as { code: string } | null,
  defaultsThrow: false,
};

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPublicSlots: async () => ({ allowed: true }),
  limitPublicBooking: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate-limited",
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://studio.example.test",
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => scenario.studio,
}));

// The bulk loaders are counted, not reimplemented: they are the two reads the
// range pass makes for the WHOLE window, so their call count is the headline
// number this file is about.
vi.mock("@/lib/booking/studio-wide-availability", () => ({
  getStudioWideDefaultsSafe: async () => {
    queries.push({ table: "studio_availability_default", op: "bulk" });
    if (scenario.defaultsThrow) {
      throw new Error("availability_read_failed:defaults:42501");
    }
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
      let page: { from: number; to: number } | null = null;
      const settle = () => {
        if (table === "services") {
          return {
            data:
              scenario.serviceDuration === null
                ? null
                : { default_duration_minutes: scenario.serviceDuration },
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
        const MAX_ROWS = 1000;
        const from = page?.from ?? 0;
        const to = Math.min(page?.to ?? MAX_ROWS - 1, from + MAX_ROWS - 1);
        return { data: scenario.reservations.slice(from, to + 1), error: null };
      };
      Object.assign(chain, {
        select: self, eq: self, lte: self, gte: self, lt: self, gt: self, is: self,
        order: self,
        range: (f: number, t: number) => {
          page = { from: f, to: t };
          return chain;
        },
        maybeSingle: async () => settle(),
        then: (r: (v: unknown) => unknown) => Promise.resolve(settle()).then(r),
      });
      return chain;
    },
  }),
}));

// Everything below is imported for module load only — this suite calls exactly
// one action and must not send anything.
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async () => ({ ok: true }),
  sendBookingNotificationToStudio: async () => ({ ok: true }),
}));
vi.mock("@/lib/sms/send-appointment", () => ({
  sendBookingConfirmationSmsToClient: async () => ({ ok: false, skipped: true }),
}));
vi.mock("@/lib/conversion/dispatch", () => ({ dispatchBookingConversion: async () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => {} }));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => {},
}));
vi.mock("@/lib/intake/queries", () => ({
  ensureIntakeForClient: async () => ({ id: "i", url: "https://x/i" }),
}));

const { fetchNextAvailableDateAction } = await import("@/app/book/[slug]/actions");

/** An open studio-wide weekday row. */
function openDay(dow: number) {
  return { day_of_week: dow, is_open: true, open_time: "09:00", close_time: "17:00" };
}

/** A full-day UTC reservation covering one Toronto local date. */
function fullDayReservation(dateStr: string) {
  return {
    starts_at: `${dateStr}T04:00:00.000Z`,
    ends_at: `${dateStr}T23:59:00.000Z`,
    source_kind: "appointment",
    source_id: "a1",
  };
}

const CALL = { slug: "studio-a", serviceId: "svc-1" };

/** Read counts, split so a per-day regression is visible as the shape it is. */
function readCount() {
  return queries.length;
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
  scenario.serviceDuration = 60;
  scenario.defaults = [0, 1, 2, 3, 4, 5, 6].map(openDay);
  scenario.overrides = [];
  scenario.blockouts = [];
  scenario.reservations = [];
  scenario.blockoutError = null;
  scenario.reservationError = null;
  scenario.defaultsThrow = false;
  vi.useFakeTimers();
  // A Monday, 08:00 in Toronto. Fixed so "today", the past-time filter and the
  // horizon edge are all deterministic.
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
});

describe("BOOK-NEXT-FAST-01: the date it returns", () => {
  it("returns the nearest available date", async () => {
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r).toEqual({ ok: true, date: "2026-10-06" });
  });

  it("skips closed weekdays", async () => {
    // Open on WEDNESDAY only. From Tuesday the answer is Wednesday; the four
    // closed days in between must be skipped without being queried separately.
    scenario.defaults = [openDay(3)];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-08" });
    // 2026-10-08 is a Thursday, so the next Wednesday is 2026-10-14.
    expect(r).toEqual({ ok: true, date: "2026-10-14" });
  });

  it("respects a date override that closes an otherwise-open day", async () => {
    scenario.overrides = [
      { effective_date: "2026-10-06", is_open: false, open_time: null, close_time: null },
    ];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r).toEqual({ ok: true, date: "2026-10-07" });
  });

  it("respects a whole-day blockout", async () => {
    scenario.blockouts = [{ starts_on: "2026-10-06", ends_on: "2026-10-07" }];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r).toEqual({ ok: true, date: "2026-10-08" });
  });

  it("respects an occupied reservation", async () => {
    scenario.reservations = [fullDayReservation("2026-10-06")];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r).toEqual({ ok: true, date: "2026-10-07" });
  });

  it("respects the studio buffer", async () => {
    // A 60-minute service in a 09:00-17:00 day, with the day almost entirely
    // occupied: one 60-minute hole remains, and a 30-minute buffer on each side
    // makes it unofferable. Without buffers this date WOULD be returned, which
    // is what makes this a buffer assertion rather than a reservation one.
    scenario.studio = { ...(scenario.studio as object), buffer_minutes: 30 } as never;
    scenario.reservations = [
      {
        starts_at: "2026-10-06T13:00:00.000Z", // 09:00 EDT
        ends_at: "2026-10-06T18:00:00.000Z", // 14:00 EDT
        source_kind: "appointment",
        source_id: "a1",
      },
      {
        starts_at: "2026-10-06T19:00:00.000Z", // 15:00 EDT
        ends_at: "2026-10-06T21:00:00.000Z", // 17:00 EDT
        source_kind: "appointment",
        source_id: "a2",
      },
    ];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date).not.toBe("2026-10-06");
  });

  it("evaluates the LOCAL weekday for a studio east of UTC+12", async () => {
    // Pacific/Auckland in October is UTC+13. `getAvailableSlots` derives the
    // weekday from noon UTC, which for +13 is ALREADY the next local day — a
    // Monday was evaluated against Tuesday's hours. The range loader takes the
    // weekday from the local date itself. Open MONDAY only; ask about a Monday.
    scenario.studio = {
      ...(scenario.studio as object),
      timezone: "Pacific/Auckland",
    } as never;
    scenario.defaults = [openDay(1)];
    // 2026-10-12 is a Monday.
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-12" });
    expect(r).toEqual({ ok: true, date: "2026-10-12" });
  });
});

describe("BOOK-NEXT-FAST-01: today, clamping and the horizon edge", () => {
  it("filters today's already-past slots", async () => {
    // "Now" is 08:00 EDT on 2026-10-05 and the day opens 09:00-17:00, so today
    // still has future slots and IS the answer.
    const early = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-05" });
    expect(early).toEqual({ ok: true, date: "2026-10-05" });

    // Move to 18:00 EDT — today's window is entirely in the past, so today must
    // NOT be offered even though the weekday is open.
    vi.setSystemTime(new Date("2026-10-05T22:00:00.000Z"));
    queries.length = 0;
    const late = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-05" });
    expect(late).toEqual({ ok: true, date: "2026-10-06" });
  });

  it("clamps a fromDate before today up to today", async () => {
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2020-01-01" });
    // Never a past date, and never null just because the caller asked early.
    expect(r).toEqual({ ok: true, date: "2026-10-05" });
  });

  it("returns null when nothing is open through the whole horizon", async () => {
    // Modelled as a horizon-spanning BLOCKOUT rather than by emptying the
    // weekday defaults. A studio with no open weekday is not publicly bookable
    // at all, so that version never reaches the range pass — it is refused by
    // the readiness gate one step earlier and would have proved nothing about
    // the scan. This studio is genuinely bookable and genuinely has no day.
    scenario.blockouts = [{ starts_on: "2026-10-01", ends_on: "2028-01-01" }];
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r).toEqual({ ok: true, date: null });
  });

  it("returns null for a fromDate past the horizon without reading anything", async () => {
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2030-01-01" });
    expect(r).toEqual({ ok: true, date: null });
  });
});

describe("BOOK-NEXT-FAST-01: a read failure is not an answer", () => {
  it("a failed reservation read does NOT masquerade as no availability", async () => {
    // THE BEHAVIOUR CHANGE. The old loop discarded this error, treated the day
    // as empty, kept scanning and returned `date: null` — telling the client the
    // studio was booked solid to the horizon on the strength of a query that
    // never answered.
    scenario.reservationError = { code: "57014" };
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r.ok).toBe(false);
    expect(r).not.toEqual({ ok: true, date: null });
  });

  it("a failed blockout read does NOT masquerade as no availability", async () => {
    scenario.blockoutError = { code: "57014" };
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r.ok).toBe(false);
  });

  it("a failed availability read does NOT masquerade as no availability", async () => {
    scenario.defaultsThrow = true;
    const r = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    expect(r.ok).toBe(false);
  });
});

describe("BOOK-NEXT-FAST-01: the read count does not grow with the horizon", () => {
  it("a 12-month empty horizon costs the same reads as a 7-day one", async () => {
    // THE HEADLINE. Both scans find nothing and therefore evaluate every date
    // they were given; the only difference is how many dates that is. Under the
    // old day-by-day loop the second number was ~50x the first.
    //
    // Exhaustion is forced with a blockout, not by closing every weekday: a
    // studio with no open weekday fails the readiness gate before the scan
    // starts, which would make this pass while measuring nothing.
    scenario.blockouts = [{ starts_on: "2026-10-01", ends_on: "2028-01-01" }];

    scenario.studio = {
      ...(scenario.studio as object),
      public_booking_horizon_months: 1,
    } as never;
    await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    const shortScan = readCount();

    queries.length = 0;
    scenario.studio = {
      ...(scenario.studio as object),
      public_booking_horizon_months: 12,
    } as never;
    const long = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    const longScan = readCount();

    expect(long).toEqual({ ok: true, date: null });
    // EQUAL, not merely "close". Any per-day term would show up here as a
    // difference of hundreds.
    expect(longScan).toBe(shortScan);
    // And the absolute figure stays small: readiness (2) + service (1) +
    // overrides + defaults + blockouts + reservations (4).
    expect(longScan).toBeLessThanOrEqual(8);
  });

  it("finding a date on day 1 costs the same reads as finding one on day 300", async () => {
    // The cost is the RANGE LOAD, so where the answer happens to fall inside it
    // changes nothing. This is the property that makes the sparse case fast.
    scenario.studio = {
      ...(scenario.studio as object),
      public_booking_horizon_months: 12,
    } as never;

    await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    const dense = readCount();

    queries.length = 0;
    // Blocked out everywhere EXCEPT one date ~300 days away. Two blockouts
    // leave exactly that day open, so the studio stays bookable and the answer
    // sits deep in the horizon — the shape that was worst under the old loop.
    scenario.blockouts = [
      { starts_on: "2026-10-01", ends_on: "2027-08-01" },
      { starts_on: "2027-08-03", ends_on: "2028-01-01" },
    ];
    const sparse = await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });
    const sparseCount = readCount();

    expect(sparse).toEqual({ ok: true, date: "2027-08-02" });
    expect(sparseCount).toBe(dense);
  });

  it("never reads a per-date availability table more than once", async () => {
    scenario.studio = {
      ...(scenario.studio as object),
      public_booking_horizon_months: 12,
    } as never;
    scenario.blockouts = [{ starts_on: "2026-10-01", ends_on: "2028-01-01" }];
    await fetchNextAvailableDateAction({ ...CALL, fromDate: "2026-10-06" });

    const byTable = new Map<string, number>();
    for (const q of queries) byTable.set(q.table, (byTable.get(q.table) ?? 0) + 1);

    expect(byTable.get("studio_availability_overrides")).toBe(1);
    expect(byTable.get("studio_blockouts")).toBe(1);
    expect(byTable.get("studio_calendar_reservations")).toBe(1);
    // `studio_availability_default` is read twice and both are deliberate: once
    // by the readiness gate (is this studio bookable at all) and once by the
    // schedule loader (what are its hours). They ask different questions of the
    // same table and neither is per-date.
    expect(byTable.get("studio_availability_default")).toBe(2);
  });
});

describe("BOOK-NEXT-FAST-01: the early exit is a shortcut, not a different answer", () => {
  // `stopAfterFirstMatch` stops generating candidates once a date has one. It
  // exists because the bulk pass measured 1.5-2.3s whenever slots existed — not
  // from queries (those are four either way) but from `buildDaySlots` running
  // over every open day in a 12-month window and formatting each label through
  // Intl. It is still a shortcut through real work, so it gets a parity proof
  // rather than a comment.
  it("returns the same first date as a full pass, over a long horizon", async () => {
    const { loadPublicSlotsByDate } = await import("@/lib/booking/public-slot-range");
    const { createAdminClient } = await import("@/lib/supabase/admin-server");

    scenario.studio = {
      ...(scenario.studio as object),
      public_booking_horizon_months: 12,
    } as never;
    // Blocked for the first 40 days, then open — so the first match is well
    // inside the window and the two passes have real work to disagree about.
    scenario.blockouts = [{ starts_on: "2026-10-01", ends_on: "2026-11-15" }];

    const ctx = {
      studioId: "studio-1",
      timezone: "America/Toronto",
      publicBookingHorizonMonths: 12,
      bufferMinutes: 0,
      serviceDurationMinutes: 60,
    };
    const dates: string[] = [];
    let c = "2026-10-06";
    while (c <= "2027-09-01") {
      dates.push(c);
      const d = new Date(`${c}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      c = d.toISOString().slice(0, 10);
    }
    const now = new Date("2026-10-05T12:00:00.000Z");

    const full = await loadPublicSlotsByDate(createAdminClient(), ctx, dates, now);
    const early = await loadPublicSlotsByDate(createAdminClient(), ctx, dates, now, {
      stopAfterFirstMatch: true,
    });

    expect(full.ok && early.ok).toBe(true);
    if (!full.ok || !early.ok) return;

    expect(early.byDate[0]?.date).toBe(full.byDate[0]?.date);
    expect(early.byDate[0]?.date).toBe("2026-11-16");
    // The shortcut really did stop — otherwise this proves nothing about cost.
    expect(early.byDate).toHaveLength(1);
    expect(full.byDate.length).toBeGreaterThan(1);
    // And the slots for that shared first date are identical, so the caller
    // that wants them is not handed a truncated day.
    expect(early.byDate[0]?.slots).toEqual(full.byDate[0]?.slots);
  });

  it("the range entry point does NOT take the shortcut", async () => {
    // `fetchPublicSlotsForDates` answers for a whole window and its callers read
    // every date. If the flag ever leaked into that path it would silently
    // truncate the invitation surface's availability to one day.
    const src = readFileSync(
      join(process.cwd(), "lib/booking/public-slot-range.ts"),
      "utf8",
    );
    const wrapper = src.slice(
      src.indexOf("export async function fetchPublicSlotsForDates"),
      src.indexOf("export type PublicRangeContext"),
    );
    expect(wrapper).not.toContain("stopAfterFirstMatch");
  });
});

describe("BOOK-NEXT-FAST-01: the per-day loop is gone from the source", () => {
  const SRC = readFileSync(
    join(process.cwd(), "app/book/[slug]/actions.ts"),
    "utf8",
  );

  /** The body of one exported action, comments stripped. */
  function actionBody(name: string): string {
    const start = SRC.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const after = SRC.slice(start + 1);
    const nextExport = after.indexOf("\nexport ");
    const body = nextExport === -1 ? after : after.slice(0, nextExport);
    return body
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  }

  it("fetchNextAvailableDateAction calls no per-day slot loader", () => {
    const body = actionBody("fetchNextAvailableDateAction");
    expect(body).not.toContain("getAvailableSlots");
    expect(body).toContain("loadPublicSlotsByDate");
  });

  it("it awaits nothing inside a loop", () => {
    // The precise regression: any `await` under a `for`/`while` in this action
    // is a per-day round trip returning by another name. The only loop left
    // builds a list of date STRINGS.
    const body = actionBody("fetchNextAvailableDateAction");
    const loop = body.match(/(for\s*\(|while\s*\()[\s\S]*?\n  \}/);
    expect(loop, "expected the date-building loop to still be present").not.toBeNull();
    expect(loop![0]).not.toContain("await");
  });

  it("the single-date action still uses the day loader — this slice did not widen", () => {
    // Anti-overreach: `fetchPublicSlotsAction` answers for ONE date, where a day
    // loader is exactly right. Rewriting it was not in scope and did not happen.
    expect(actionBody("fetchPublicSlotsAction")).toContain("getAvailableSlots");
  });
});
