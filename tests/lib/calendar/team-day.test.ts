import { describe, expect, it } from "vitest";
import { buildTeamDay } from "@/lib/calendar/team-day";
import { resolvePractitionerDayAvailability } from "@/lib/calendar/day-availability";
import type { AppointmentWithPractitionerColor, RecurringBreakOccurrenceWithRule } from "@/lib/booking/queries";
import type { StudioAvailabilityDefault, StudioAvailabilityOverride, StudioTimedBlock } from "@/lib/types/database";

// HON-48 team day view: one column per working practitioner. Five synthetic
// practitioners in America/Los_Angeles. Synthetic names only.

const TZ = "America/Los_Angeles";
// 2026-11-17 is a Tuesday in PST (UTC-8): local 00:00 is 08:00Z, and every
// local time from 16:00 on falls on the NEXT UTC date.
const DATE = "2026-11-17";
const TUE = 2;

const P = ["p-ana", "p-bo", "p-cy", "p-di", "p-ed"] as const;
const PRACTITIONERS = [
  { id: P[0], display_name: "Synthetic Ana", color: "teal" },
  { id: P[1], display_name: "Synthetic Bo", color: "amber" },
  { id: P[2], display_name: "Synthetic Cy", color: "violet" },
  { id: P[3], display_name: "Synthetic Di", color: "sky" },
  { id: P[4], display_name: "Synthetic Ed", color: "rose" },
];

let seq = 0;
function appt(practitionerId: string | null, startIso: string, minutes = 60, status = "confirmed") {
  const id = `a${++seq}`;
  return {
    id,
    practitioner_id: practitionerId,
    starts_at: startIso,
    ends_at: new Date(Date.parse(startIso) + minutes * 60_000).toISOString(),
    duration_minutes: minutes,
    status,
    client: { id: `c-${id}`, name: `Synthetic client ${id}` },
    service: { id: "s1", name: "Synthetic consult", modality: null, calendar_color: null },
    practitioner: practitionerId ? { id: practitionerId, color: "neutral", display_name: `Joined ${practitionerId}` } : null,
  } as unknown as AppointmentWithPractitionerColor;
}
function block(practitionerId: string | null, startIso: string, endIso: string): StudioTimedBlock {
  return {
    id: `b${++seq}`, studio_id: "s", starts_at: startIso, ends_at: endIso, category: "other",
    private_note: null, created_by: null, created_at: startIso, updated_at: startIso, practitioner_id: practitionerId,
  };
}
function brk(practitionerId: string | null, startIso: string, endIso: string, label: string): RecurringBreakOccurrenceWithRule {
  return {
    id: `r${++seq}`, rule_id: "rule", studio_id: "s", occurrence_date: DATE, starts_at: startIso, ends_at: endIso,
    created_at: startIso, practitioner_id: practitionerId, rule: { label },
  };
}
function def(practitionerId: string | null, dow: number, open: boolean, from: string | null, to: string | null) {
  return {
    id: `d${++seq}`, studio_id: "s", day_of_week: dow, is_open: open, open_time: from, close_time: to,
    practitioner_id: practitionerId,
  } as unknown as StudioAvailabilityDefault & { practitioner_id: string | null };
}
function ovr(practitionerId: string | null, date: string, open: boolean, from: string | null, to: string | null) {
  return {
    id: `o${++seq}`, studio_id: "s", effective_date: date, is_open: open, open_time: from, close_time: to, note: null,
    practitioner_id: practitionerId,
  } as unknown as StudioAvailabilityOverride & { practitioner_id: string | null };
}

// Studio 09:00-17:00 Tuesday. Bo works 12:00-20:00, Cy is off Tuesdays, Di
// has a date override 10:00-14:00 for this date only.
const DEFAULTS = [
  def(null, TUE, true, "09:00:00", "17:00:00"),
  def(P[1], TUE, true, "12:00:00", "20:00:00"),
  def(P[2], TUE, false, null, null),
];
const OVERRIDES = [ovr(P[3], DATE, true, "10:00:00", "14:00:00")];

function build(over: Partial<Parameters<typeof buildTeamDay>[0]> = {}) {
  return buildTeamDay({
    date: DATE, dayOfWeek: TUE, tz: TZ, practitioners: PRACTITIONERS,
    appointments: [], timedBlocks: [], recurringBreaks: [], defaults: DEFAULTS, overrides: OVERRIDES,
    ...over,
  });
}
const col = (day: ReturnType<typeof build>, id: string | null) => {
  const c = day.columns.find((x) => x.practitionerId === id);
  expect(c, `column ${id}`).toBeDefined();
  return c!;
};

describe("buildTeamDay: columns and attribution", () => {
  it("puts simultaneous appointments for different practitioners each in its own column", () => {
    // 10:00 PST = 18:00Z for Ana, Bo, Di and Ed at once.
    const same = [P[0], P[1], P[3], P[4]].map((id) => appt(id, "2026-11-17T18:00:00Z"));
    const day = build({ appointments: same });
    for (const a of same) {
      const owner = day.columns.filter((c) => c.appts.some((x) => x.id === a.id));
      expect(owner.map((c) => c.practitionerId)).toEqual([a.practitioner_id]);
    }
    expect(day.columns.flatMap((c) => c.appts)).toHaveLength(4);
  });

  it("gives every working practitioner a column in roster order, header coloured by their own colour", () => {
    const day = build();
    expect(day.columns.map((c) => c.practitionerId)).toEqual([P[0], P[1], P[3], P[4]]);
    expect(col(day, P[0])).toMatchObject({ name: "Synthetic Ana", headerBgClass: "bg-teal-700", headerTextClass: "text-white", colorLabel: "Teal" });
    expect(col(day, P[4]).headerBgClass).toBe("bg-rose-700");
  });

  it("names an off-all-day practitioner as not working instead of drawing an empty column", () => {
    expect(build().notWorking).toEqual([{ practitionerId: P[2], name: "Synthetic Cy" }]);
  });

  it("still gives an off-day practitioner a column when they hold an appointment that day", () => {
    const a = appt(P[2], "2026-11-17T19:00:00Z");
    const day = build({ appointments: [a] });
    expect(col(day, P[2]).appts.map((x) => x.id)).toEqual([a.id]);
    expect(col(day, P[2]).closedDay).toBe(true);
    expect(day.notWorking).toEqual([]);
  });

  it("hides cancelled appointments, keeps completed and no-show", () => {
    const cancelled = appt(P[0], "2026-11-17T18:00:00Z", 60, "cancelled");
    const noShow = appt(P[0], "2026-11-17T19:00:00Z", 60, "no_show");
    const completed = appt(P[0], "2026-11-17T20:00:00Z", 60, "completed");
    const day = build({ appointments: [cancelled, noShow, completed] });
    expect(col(day, P[0]).appts.map((x) => x.id)).toEqual([noShow.id, completed.id]);
  });

  it("keeps an appointment held by someone outside the active roster in a column of its own", () => {
    const a = appt("p-former", "2026-11-17T18:00:00Z");
    const day = build({ appointments: [a] });
    expect(col(day, "p-former")).toMatchObject({ active: false, name: "Joined p-former", availability: null });
    expect(col(day, "p-former").appts.map((x) => x.id)).toEqual([a.id]);
  });

  it("keeps an appointment with no practitioner in an Unassigned column", () => {
    const a = appt(null, "2026-11-17T18:00:00Z");
    const day = build({ appointments: [a] });
    expect(col(day, null)).toMatchObject({ name: "Unassigned", active: false });
    expect(col(day, null).appts.map((x) => x.id)).toEqual([a.id]);
    for (const c of day.columns.filter((x) => x.practitionerId !== null)) expect(c.appts).toEqual([]);
  });
});

describe("buildTeamDay: individual off-time per column", () => {
  it("resolves each practitioner's own hours: studio default, personal default, date override", () => {
    const day = build();
    expect(col(day, P[0]).availability).toEqual({ isOpen: true, openTime: "09:00", closeTime: "17:00" });
    expect(col(day, P[1]).availability).toEqual({ isOpen: true, openTime: "12:00", closeTime: "20:00" });
    expect(col(day, P[3]).availability).toEqual({ isOpen: true, openTime: "10:00", closeTime: "14:00" });
  });

  it("puts a scoped block or break only in its own column and a studio-wide one in every column", () => {
    const sterilization = brk(P[1], "2026-11-17T21:00:00Z", "2026-11-17T21:30:00Z", "Sterilization");
    const own = block(P[3], "2026-11-17T19:00:00Z", "2026-11-17T20:00:00Z");
    const studioWide = block(null, "2026-11-17T20:00:00Z", "2026-11-17T20:15:00Z");
    const day = build({ timedBlocks: [own, studioWide], recurringBreaks: [sterilization] });
    expect(col(day, P[1]).recurringBreaks.map((b) => b.id)).toEqual([sterilization.id]);
    for (const id of [P[0], P[3], P[4]]) expect(col(day, id).recurringBreaks).toEqual([]);
    expect(col(day, P[3]).timedBlocks.map((b) => b.id)).toEqual([own.id, studioWide.id]);
    for (const id of [P[0], P[1], P[4]]) expect(col(day, id).timedBlocks.map((b) => b.id)).toEqual([studioWide.id]);
  });

  it("matches the shared resolver for a practitioner with no personal rows (inherits the studio)", () => {
    expect(resolvePractitionerDayAvailability({ date: DATE, dayOfWeek: TUE, defaults: DEFAULTS, overrides: OVERRIDES, practitionerId: P[4] }))
      .toEqual({ availability: { isOpen: true, openTime: "09:00", closeTime: "17:00" }, closedDay: false });
  });

  it("leaves hours unknown (no tint, still a column) when no row applies", () => {
    const day = build({ defaults: [], overrides: [] });
    expect(day.columns).toHaveLength(5);
    for (const c of day.columns) expect(c.availability).toBeNull();
  });
});

describe("buildTeamDay: America/Los_Angeles date boundaries", () => {
  it("keeps a late-evening appointment that crosses UTC midnight on its local date", () => {
    // 21:00 PST on the 17th is 05:00Z on the 18th.
    const late = appt(P[1], "2026-11-18T05:00:00Z");
    expect(col(build({ appointments: [late] }), P[1]).appts.map((x) => x.id)).toEqual([late.id]);
    // And it is NOT on the 18th's local day.
    const next = buildTeamDay({
      date: "2026-11-18", dayOfWeek: 3, tz: TZ, practitioners: PRACTITIONERS,
      appointments: [late], timedBlocks: [], recurringBreaks: [], defaults: [], overrides: [],
    });
    expect(next.columns.flatMap((c) => c.appts)).toEqual([]);
  });

  it("excludes the previous local evening even though it is the same UTC date", () => {
    // 23:30 PST on the 16th is 07:30Z on the 17th.
    const previousEvening = appt(P[0], "2026-11-17T07:30:00Z", 30);
    // 00:00 PST on the 17th is 08:00Z: the first instant that belongs.
    const midnight = appt(P[0], "2026-11-17T08:00:00Z", 30);
    const day = build({ appointments: [previousEvening, midnight] });
    expect(col(day, P[0]).appts.map((x) => x.id)).toEqual([midnight.id]);
  });

  it("uses the PDT offset across the spring-forward date", () => {
    // 2026-03-08 is the US spring-forward Sunday; 20:00 PDT is 03:00Z next day.
    const a = appt(P[0], "2026-03-09T03:00:00Z");
    const day = buildTeamDay({
      date: "2026-03-08", dayOfWeek: 0, tz: TZ, practitioners: PRACTITIONERS,
      appointments: [a], timedBlocks: [], recurringBreaks: [], defaults: [], overrides: [],
    });
    expect(col(day, P[0]).appts.map((x) => x.id)).toEqual([a.id]);
  });
});

// HON-48 compact column: how many columns the day view draws for 1 active, 1 working of 3,
// 0 working and 5 working. The page sizes each from teamDayGridTemplate, so a lone column is
// the same compact width as any other, and zero columns is an explicit empty state.
describe("buildTeamDay: column counts the layout depends on", () => {
  const open = (id: string) => def(id, TUE, true, "09:00:00", "17:00:00");
  const closed = (id: string) => def(id, TUE, false, null, null);
  const run = (roster: typeof PRACTITIONERS, defaults: ReturnType<typeof def>[], appointments: ReturnType<typeof appt>[] = []) =>
    buildTeamDay({
      date: DATE, dayOfWeek: TUE, tz: TZ, practitioners: roster,
      appointments, timedBlocks: [], recurringBreaks: [], defaults, overrides: [],
    });

  it("one active practitioner: one column, with their hours", () => {
    const day = run([PRACTITIONERS[0]], [open(P[0])]);
    expect(day.columns.map((c) => c.practitionerId)).toEqual([P[0]]);
    expect(day.notWorking).toEqual([]);
    expect(day.columns[0].availability?.isOpen).toBe(true);
  });

  it("one working of three active: one column, the other two listed as not working", () => {
    const day = run(PRACTITIONERS.slice(0, 3), [open(P[1]), closed(P[0]), closed(P[2])]);
    expect(day.columns.map((c) => c.practitionerId)).toEqual([P[1]]);
    expect(day.notWorking.map((n) => n.practitionerId)).toEqual([P[0], P[2]]);
  });

  it("nobody working: no columns (the page shows its empty state) and everyone listed", () => {
    const day = run(PRACTITIONERS.slice(0, 3), PRACTITIONERS.slice(0, 3).map((p) => closed(p.id)));
    expect(day.columns).toEqual([]);
    expect(day.notWorking).toHaveLength(3);
  });

  it("a practitioner who is off but holds an appointment still gets their column", () => {
    const day = run(PRACTITIONERS.slice(0, 2), [closed(P[0]), closed(P[1])], [appt(P[0], "2026-11-17T18:00:00Z")]);
    expect(day.columns.map((c) => c.practitionerId)).toEqual([P[0]]);
  });

  it("five working: five columns", () => {
    const day = run(PRACTITIONERS, PRACTITIONERS.map((p) => open(p.id)));
    expect(day.columns).toHaveLength(5);
    expect(day.notWorking).toEqual([]);
  });
});
