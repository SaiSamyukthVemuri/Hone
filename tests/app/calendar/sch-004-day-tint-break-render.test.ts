import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DayColumn } from "@/app/(app)/calendar/DayColumn";
import { GRID_HEIGHT, HOUR_START } from "@/app/(app)/calendar/calendar-constants";
import { groupMonthBlockedByDate } from "@/app/(app)/calendar/month-blocked";
import { resolveCalendarDayAvailability } from "@/lib/calendar/day-availability";
import type { RecurringBreakOccurrenceWithRule } from "@/lib/booking/queries";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/calendar",
  useSearchParams: () => new URLSearchParams(),
}));

// SCH-004 E-gap: the per-day neutral tint and the recurring-break overlay,
// RENDERED by the child components from what the resolver hands them. Until
// now these were covered only through resolveCalendarDayAvailability itself.
// Each case runs the resolver exactly as page.tsx does, passes its
// `availability` / `closedDay` into DayColumn (week) or its closed lookup into
// groupMonthBlockedByDate (month), and asserts what is drawn. Synthetic data.

const TZ = "UTC";
const DATE = "2030-03-04"; // a Monday
const DOW = 1;
const P1 = "practitioner-one";
const P2 = "practitioner-two";

type Row = { practitioner_id: string | null; is_open: boolean; open_time: string | null; close_time: string | null };

function weekday(row: Row) {
  return { id: `d-${row.practitioner_id}`, studio_id: "studio-1", day_of_week: DOW, created_at: "", updated_at: "", ...row };
}
function override(row: Row) {
  return { id: `o-${row.practitioner_id}`, studio_id: "studio-1", effective_date: DATE, note: null, created_at: "", updated_at: "", ...row };
}
const open = (practitioner_id: string | null, from: string, to: string): Row =>
  ({ practitioner_id, is_open: true, open_time: `${from}:00`, close_time: `${to}:00` });
const closed = (practitioner_id: string | null): Row =>
  ({ practitioner_id, is_open: false, open_time: null, close_time: null });

// A standing 12:00-12:30 lunch break materialized for this date.
const LUNCH: RecurringBreakOccurrenceWithRule = {
  id: "break-1", rule_id: "rule-1", studio_id: "studio-1", occurrence_date: DATE,
  starts_at: `${DATE}T12:00:00Z`, ends_at: `${DATE}T12:30:00Z`, created_at: "",
  practitioner_id: null, rule: { label: "Synthetic lunch" },
};

function resolve(defaults: Row[], overrides: Row[] = [], capacityEnabled = true) {
  return resolveCalendarDayAvailability({
    date: DATE, dayOfWeek: DOW,
    defaults: defaults.map(weekday), overrides: overrides.map(override),
    capacityEnabled, activePractitionerIds: capacityEnabled ? [P1, P2] : [],
  });
}

function renderDay(resolved: ReturnType<typeof resolve>) {
  return renderToStaticMarkup(createElement(DayColumn, {
    date: DATE, appts: [], timedBlocks: [], recurringBreaks: [LUNCH],
    blocked: false, tz: TZ, timeFormat: "24h", isOwner: true,
    practitionerCapacityEnabled: true, currentPractitionerId: P1,
    currentPractitionerName: "Synthetic Owner", clients: [], services: [],
    isToday: false, availability: resolved.availability, closedDay: resolved.closedDay,
  } as unknown as Parameters<typeof DayColumn>[0]));
}

/** Every drawn tint as "top+height" in px (1 px = 1 minute). */
function tints(html: string): string[] {
  return [...html.matchAll(/data-availability-tint=""[^>]*style="top:(\d+)(?:px)?;height:(\d+)(?:px)?"/g)].map((m) => `${m[1]}+${m[2]}`);
}
const minutesFromGridTop = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h - HOUR_START) * 60 + m;
};
const showsLunch = (html: string) => html.includes("Synthetic lunch");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2030-03-01T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("SCH-004 week DayColumn renders the resolver's tint and breaks", () => {
  it("shared open hours: out-of-hours tint above open and below close; the break is drawn", () => {
    const resolved = resolve([open(P1, "09:00", "17:00"), open(P2, "09:00", "17:00")]);
    expect(resolved.hoursVary).toBe(false);
    const html = renderDay(resolved);
    const close = minutesFromGridTop("17:00");
    expect(tints(html)).toEqual([`0+${minutesFromGridTop("09:00")}`, `${close}+${GRID_HEIGHT - close}`]);
    expect(showsLunch(html)).toBe(true);
  });

  it("shared closed day: one full-height tint, and the standing break is hidden", () => {
    const resolved = resolve([closed(P1), closed(P2)]);
    const html = renderDay(resolved);
    expect(tints(html)).toEqual([`0+${GRID_HEIGHT}`]);
    expect(showsLunch(html)).toBe(false);
  });

  it("hours vary (different windows): NO tint at all, and the break stays visible", () => {
    const resolved = resolve([open(P1, "09:00", "17:00"), open(P2, "12:00", "20:00")]);
    expect(resolved).toEqual({ availability: null, closedDay: false, hoursVary: true });
    const html = renderDay(resolved);
    expect(tints(html)).toEqual([]);
    expect(showsLunch(html)).toBe(true);
  });

  it("hours vary (one open, one closed): no full-day closed tint, and the break stays visible", () => {
    const resolved = resolve([open(P1, "09:00", "17:00"), closed(P2)]);
    expect(resolved.hoursVary).toBe(true);
    const html = renderDay(resolved);
    expect(tints(html)).toEqual([]);
    expect(showsLunch(html)).toBe(true);
  });

  it("a studio date override that closes a shared open weekday tints the whole day and hides the break", () => {
    const resolved = resolve([open(null, "09:00", "17:00")], [closed(null)]);
    const html = renderDay(resolved);
    expect(tints(html)).toEqual([`0+${GRID_HEIGHT}`]);
    expect(showsLunch(html)).toBe(false);
  });

  it("a personal date override that diverges from the colleague's hours makes the day neutral", () => {
    const resolved = resolve([open(null, "09:00", "17:00")], [open(P2, "13:00", "18:00")]);
    expect(resolved.hoursVary).toBe(true);
    const html = renderDay(resolved);
    expect(tints(html)).toEqual([]);
    expect(showsLunch(html)).toBe(true);
  });

  it("capacity off: the studio row alone draws the tint (one studio timeline)", () => {
    const resolved = resolve([open(null, "10:00", "18:00")], [], false);
    const html = renderDay(resolved);
    const close = minutesFromGridTop("18:00");
    expect(tints(html)).toEqual([`0+${minutesFromGridTop("10:00")}`, `${close}+${GRID_HEIGHT - close}`]);
  });

  it("NON-VACUITY: the tint matcher sees a hand-built closed availability", () => {
    const html = renderDay({ availability: { isOpen: false, openTime: null, closeTime: null }, closedDay: true, hoursVary: false });
    expect(tints(html)).toHaveLength(1);
  });
});

describe("SCH-004 month grouping uses the same closed-day projection", () => {
  const month = (resolved: ReturnType<typeof resolve>) =>
    groupMonthBlockedByDate([], [], [LUNCH], TZ, () => resolved.closedDay).get(DATE)?.labels ?? [];

  it("hours vary: the break label is kept", () => {
    expect(month(resolve([open(P1, "09:00", "17:00"), closed(P2)]))).toEqual(["Synthetic lunch"]);
  });

  it("shared closed day: the break label is dropped", () => {
    expect(month(resolve([closed(P1), closed(P2)]))).toEqual([]);
  });

  it("shared open day: the break label is kept", () => {
    expect(month(resolve([open(P1, "09:00", "17:00"), open(P2, "09:00", "17:00")]))).toEqual(["Synthetic lunch"]);
  });
});
