import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// SCH-005 at the PAGE level. The loader (getAppointmentsForRange) is proved in
// tests/lib/booking/calendar-color-migration-order.test.ts: it pages past the
// API's 1000-row ceiling and refuses a partial range. Two things were not
// pinned: that the real week and month views HAND every loaded appointment to
// their children (nothing in the page re-caps or truncates), and that a failed
// read makes the page throw, so the app's error boundary renders, instead of
// the page catching it and drawing an empty calendar. The boundary's own
// render is covered by tests/app/reliability/authenticated-error-boundary.test.ts.
// Synthetic ids only; the loader is faked, the real page runs.

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  fail: false,
  calls: [] as Array<[string, string]>,
}));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "p-owner", role: "owner", display_name: "Owner" },
    studio: { id: "studio-1", timezone: "America/Toronto", practitioner_capacity_enabled: false },
  }),
  getClientsForStudio: async () => [],
  getPractitionersForStudio: async () => [],
}));

vi.mock("@/lib/booking/queries", () => ({
  getActiveServices: async () => [],
  getAppointmentsForRange: async (_studio: string, start: string, end: string) => {
    state.calls.push([start, end]);
    if (state.fail) throw new Error("Failed to load appointments");
    return state.rows.filter((r) => (r.starts_at as string) >= start && (r.starts_at as string) < end);
  },
  getAvailabilityDefaults: async () => [],
  getBlockouts: async () => [],
  getOverridesForRange: async () => [],
  getRecurringBreakOccurrencesForRange: async () => [],
  getTimedBlocksForRange: async () => [],
}));

const { default: CalendarPage } = await import("@/app/(app)/calendar/page");
const { DayColumn } = await import("@/app/(app)/calendar/DayColumn");
const { MonthView } = await import("@/app/(app)/calendar/MonthView");

type Props = Record<string, unknown>;

// Visit every element the page itself returned (children are not rendered).
function elements(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return out; }
  if (isValidElement(node)) {
    out.push(node as ReactElement<Props>);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

function appt(i: number, startsAt: string, status = "confirmed") {
  return {
    id: `a-${String(i).padStart(5, "0")}`, studio_id: "studio-1", status,
    starts_at: startsAt, ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    practitioner_id: "p-owner", practitioner: { id: "p-owner", color: "blue" },
    client: { id: "c-1", name: "Synthetic" }, service: { id: "s-1", name: "Service", modality: "electrolysis", calendar_color: null },
  };
}

// Noon Toronto (16:00Z) on the given October 2026 days, so no row sits near a
// local-date boundary.
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T16:00:00Z`;

beforeEach(() => { state.rows = []; state.fail = false; state.calls = []; });

describe("SCH-005 the real views receive every loaded appointment", () => {
  it("week view: 1,100 appointments in one week all reach the day columns (none re-capped at 1,000)", async () => {
    // Week of Sunday 2026-10-18; spread over the seven days.
    state.rows = Array.from({ length: 1100 }, (_, i) => appt(i, at(18 + (i % 7))));
    const tree = await CalendarPage({ searchParams: Promise.resolve({ week: "2026-10-18" }) });
    const columns = elements(tree as ReactNode).filter((e) => e.type === DayColumn);
    expect(columns).toHaveLength(7);
    const shown = columns.flatMap((c) => c.props.appts as Array<{ id: string }>);
    expect(shown).toHaveLength(1100);
    expect(new Set(shown.map((a) => a.id)).size).toBe(1100);
  });

  it("week view: a cancelled appointment is the only thing left off the grid", async () => {
    state.rows = [appt(0, at(19)), appt(1, at(19), "cancelled"), appt(2, at(20), "completed"), appt(3, at(21), "no_show")];
    const tree = await CalendarPage({ searchParams: Promise.resolve({ week: "2026-10-18" }) });
    const shown = elements(tree as ReactNode).filter((e) => e.type === DayColumn)
      .flatMap((c) => c.props.appts as Array<{ id: string }>);
    expect(shown.map((a) => a.id).sort()).toEqual(["a-00000", "a-00002", "a-00003"]);
  });

  it("month view: 1,100 appointments in one month all reach the month grid", async () => {
    state.rows = Array.from({ length: 1100 }, (_, i) => appt(i, at(1 + (i % 28))));
    const tree = await CalendarPage({ searchParams: Promise.resolve({ view: "month", month: "2026-10-01" }) });
    const [month] = elements(tree as ReactNode).filter((e) => e.type === MonthView);
    expect(month).toBeDefined();
    const byDate = month.props.appointmentsByDate as Map<string, Array<{ id: string }>>;
    const shown = [...byDate.values()].flat();
    expect(shown).toHaveLength(1100);
    expect(new Set(shown.map((a) => a.id)).size).toBe(1100);
  });
});

describe("SCH-005 a failed read throws to the error boundary, never an empty calendar", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["week", { week: "2026-10-18" }],
    ["month", { view: "month", month: "2026-10-01" }],
  ];

  it.each(cases)("%s view: the page rejects and returns no tree", async (_view, search) => {
    state.rows = [appt(0, at(19))];
    state.fail = true;
    await expect(CalendarPage({ searchParams: Promise.resolve(search) })).rejects.toThrow("Failed to load appointments");
    expect(state.calls.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s view control: the same page renders normally when the read succeeds", async (_view, search) => {
    state.rows = [appt(0, at(19))];
    const tree = await CalendarPage({ searchParams: Promise.resolve(search) });
    expect(isValidElement(tree)).toBe(true);
  });
});
