import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

// SCH-004 regression at the PAGE level. The resolver is unit-tested in
// tests/lib/booking/practitioner-availability-model.test.ts; the "Hours vary"
// banner predicates for the week and month views live inline in
// app/(app)/calendar/page.tsx and were pinned only by a source regex. These
// cases invoke the real page with fake reads and inspect the returned tree
// (child components are not rendered), including the date and timezone
// boundaries the predicates depend on. Synthetic ids only.

const state = vi.hoisted(() => ({
  studio: {
    id: "studio-1",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: true,
  } as { id: string; timezone: string; practitioner_capacity_enabled: boolean },
  defaults: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<Record<string, unknown>>,
  active: [] as Array<{ id: string }>,
  ranges: [] as Array<[string, string]>,
}));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "p-owner", role: "owner", display_name: "Owner" },
    studio: state.studio,
  }),
  getClientsForStudio: async () => [],
  getPractitionersForStudio: async () => state.active,
}));

vi.mock("@/lib/booking/queries", () => ({
  getActiveServices: async () => [],
  getAppointmentsForRange: async (_studio: string, start: string, end: string) => {
    state.ranges.push([start, end]);
    return [];
  },
  getAvailabilityDefaults: async () => state.defaults,
  getBlockouts: async () => [],
  getOverridesForRange: async () => state.overrides,
  getRecurringBreakOccurrencesForRange: async () => [],
  getTimedBlocksForRange: async () => [],
}));

const { default: CalendarPage } = await import("@/app/(app)/calendar/page");

const BANNER = "Hours vary by practitioner";

function day(day_of_week: number, open: string | null, close: string | null, practitioner_id: string | null = null) {
  return {
    id: `d${day_of_week}-${practitioner_id ?? "studio"}`,
    studio_id: "studio-1",
    day_of_week,
    is_open: open !== null,
    open_time: open,
    close_time: close,
    practitioner_id,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function ov(effective_date: string, open: string | null, close: string | null, practitioner_id: string | null = null) {
  return {
    id: `o-${effective_date}-${practitioner_id ?? "studio"}`,
    studio_id: "studio-1",
    effective_date,
    is_open: open !== null,
    open_time: open,
    close_time: close,
    note: null,
    practitioner_id,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// Text placed directly in the page's own JSX. Child components are not
// invoked, so this sees only what the page itself decided to render.
function pageText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(pageText).join("");
  if (isValidElement(node)) {
    return pageText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

async function render(search: Record<string, string>) {
  const tree = await CalendarPage({ searchParams: Promise.resolve(search) });
  return pageText(tree as ReactNode);
}

// Every weekday open 09:00-17:00 at studio level.
const STUDIO_WEEK = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, "09:00", "17:00"));

beforeEach(() => {
  state.studio = { id: "studio-1", timezone: "America/Toronto", practitioner_capacity_enabled: true };
  state.defaults = [...STUDIO_WEEK];
  state.overrides = [];
  state.active = [{ id: "P" }, { id: "Q" }];
  state.ranges = [];
});

describe("SCH-004 week view banner", () => {
  it("shows Hours vary when two active practitioners differ on one weekday", async () => {
    state.defaults.push(day(3, "11:00", "15:00", "P"));
    expect(await render({ week: "2026-07-05" })).toContain(BANNER);
  });

  it("does not show it when active schedules agree", async () => {
    state.defaults.push(day(3, "09:00", "17:00", "P"), day(3, "09:00", "17:00", "Q"));
    expect(await render({ week: "2026-07-05" })).not.toContain(BANNER);
  });

  it("does not let an inactive practitioner's retained row cause it", async () => {
    state.defaults.push(day(3, null, null, "INACTIVE"));
    expect(await render({ week: "2026-07-05" })).not.toContain(BANNER);
  });

  it("does not show it when capacity is off, even with differing personal rows", async () => {
    state.studio.practitioner_capacity_enabled = false;
    state.active = [];
    state.defaults.push(day(3, "11:00", "15:00", "P"));
    expect(await render({ week: "2026-07-05" })).not.toContain(BANNER);
  });

  it("shows it for a one-date personal override inside the loaded week", async () => {
    state.overrides = [ov("2026-07-11", null, null, "P")];
    expect(await render({ week: "2026-07-05" })).toContain(BANNER);
  });

  it("maps a Saturday-only difference onto the week's Saturday column (Sunday-start index)", async () => {
    // Index i in the week loop is used as day_of_week. A Wednesday ?week=
    // must anchor back to Sunday so index 6 is the real Saturday.
    state.defaults.push(day(6, "10:00", "14:00", "P"));
    expect(await render({ week: "2026-07-08" })).toContain(BANNER);
    // A ?day= link loads the week that contains it.
    expect(await render({ day: "2026-07-11" })).toContain(BANNER);
  });

  it("loads the week by studio-local midnights across the November DST change", async () => {
    // America/Toronto falls back on Sunday 2026-11-01: EDT (-4) to EST (-5).
    await render({ week: "2026-11-01" });
    expect(state.ranges).toContainEqual(["2026-11-01T04:00:00.000Z", "2026-11-08T05:00:00.000Z"]);
    // The time-insights lookback reads the 24 h BEFORE the period and ends exactly where it starts.
    expect(state.ranges).toContainEqual(["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
  });
});

describe("SCH-004 month view banner", () => {
  it("shows Hours vary for a differing weekly schedule", async () => {
    state.defaults.push(day(2, null, null, "Q"));
    expect(await render({ view: "month", month: "2026-07-01" })).toContain(BANNER);
  });

  it("does not show it when active schedules agree", async () => {
    expect(await render({ view: "month", month: "2026-07-01" })).not.toContain(BANNER);
  });

  it("counts a personal override on the last day of the month", async () => {
    state.overrides = [ov("2026-02-28", "12:00", "16:00", "P")];
    expect(await render({ view: "month", month: "2026-02-01" })).toContain(BANNER);
  });

  it("ignores an override on the first day of the next month", async () => {
    state.overrides = [ov("2026-03-01", "12:00", "16:00", "P")];
    expect(await render({ view: "month", month: "2026-02-01" })).not.toContain(BANNER);
  });

  it("counts 29 February in a leap year", async () => {
    state.overrides = [ov("2028-02-29", "12:00", "16:00", "P")];
    expect(await render({ view: "month", month: "2028-02-01" })).toContain(BANNER);
  });

  it("derives the weekday from the date, not the viewer clock, in a far-east studio", async () => {
    // Pacific/Kiritimati is UTC+14. A Sunday-only difference must still be
    // found on the month's Sundays.
    state.studio.timezone = "Pacific/Kiritimati";
    state.defaults.push(day(0, null, null, "P"));
    expect(await render({ view: "month", month: "2026-07-01" })).toContain(BANNER);
    expect(state.ranges).toContainEqual(["2026-06-30T10:00:00.000Z", "2026-07-31T10:00:00.000Z"]);
  });
});
