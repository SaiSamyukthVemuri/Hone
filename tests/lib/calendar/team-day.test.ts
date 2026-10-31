import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTeamDay } from "@/lib/calendar/team-day";
import { buildDaySlots } from "@/lib/booking/slots";
import { resolveCalendarDayAvailability, resolvePractitionerDayAvailability } from "@/lib/calendar/day-availability";
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
    appointments: [], timedBlocks: [], recurringBreaks: [], defaults: DEFAULTS, overrides: OVERRIDES, capacityEnabled: true,
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
    expect(resolvePractitionerDayAvailability({ date: DATE, dayOfWeek: TUE, defaults: DEFAULTS, overrides: OVERRIDES, practitionerId: P[4], capacityEnabled: true }))
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
      appointments: [late], timedBlocks: [], recurringBreaks: [], defaults: [], overrides: [], capacityEnabled: true,
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
      appointments: [a], timedBlocks: [], recurringBreaks: [], defaults: [], overrides: [], capacityEnabled: true,
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
      appointments, timedBlocks: [], recurringBreaks: [], defaults, overrides: [], capacityEnabled: true,
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

// Codex P2 on #1280: a capacity-OFF solo studio can keep personal rows from when capacity was
// on. The slot engine (lib/booking/slots.ts, OFF branch) and the week grid read STUDIO-WIDE rows
// only; the Day column must too, or Day says "No practitioner is working" where booking is open.
describe("buildTeamDay: capacity OFF reads studio-wide hours only (parity with the week grid and slots.ts)", () => {
  const SOLO = [PRACTITIONERS[0]];
  const conflicting = {
    defaults: [def(null, TUE, true, "09:00:00", "17:00:00"), def(P[0], TUE, false, null, null)],
    overrides: [ovr(P[0], DATE, false, null, null)],
  };
  const run = (capacityEnabled: boolean, over: Partial<Parameters<typeof buildTeamDay>[0]> = {}) =>
    buildTeamDay({
      date: DATE, dayOfWeek: TUE, tz: TZ, practitioners: SOLO,
      appointments: [], timedBlocks: [], recurringBreaks: [], ...conflicting, capacityEnabled, ...over,
    });

  it("personal CLOSED, studio OPEN: capacity OFF keeps the column open with the studio hours", () => {
    const day = run(false);
    expect(day.columns.map((c) => c.practitionerId)).toEqual([P[0]]);
    expect(day.notWorking).toEqual([]);
    expect(day.columns[0].availability).toEqual({ isOpen: true, openTime: "09:00", closeTime: "17:00" });
    expect(day.columns[0].closedDay).toBe(false);
  });

  it("the same rows with capacity ON still honour the personal closure (unchanged behaviour)", () => {
    const day = run(true);
    expect(day.columns).toEqual([]);
    expect(day.notWorking.map((n) => n.practitionerId)).toEqual([P[0]]);
  });

  it("personal OPEN, studio CLOSED: capacity OFF stays closed, as booking does", () => {
    const day = run(false, {
      defaults: [def(null, TUE, false, null, null), def(P[0], TUE, true, "10:00:00", "12:00:00")],
      overrides: [],
    });
    expect(day.columns).toEqual([]);
    expect(day.notWorking.map((n) => n.practitionerId)).toEqual([P[0]]);
  });

  it("a personal date override is ignored too (studio override wins, else studio weekday)", () => {
    const day = run(false, {
      overrides: [ovr(P[0], DATE, false, null, null), ovr(null, DATE, true, "11:00:00", "15:00:00")],
    });
    expect(day.columns[0].availability).toEqual({ isOpen: true, openTime: "11:00", closeTime: "15:00" });
  });

  it("agrees with the week grid's resolver for every conflicting case, capacity OFF", () => {
    for (const rows of [
      conflicting,
      { defaults: [def(null, TUE, false, null, null), def(P[0], TUE, true, "10:00:00", "12:00:00")], overrides: [] },
      { defaults: conflicting.defaults, overrides: [ovr(P[0], DATE, false, null, null), ovr(null, DATE, true, "11:00:00", "15:00:00")] },
    ]) {
      const week = resolveCalendarDayAvailability({
        date: DATE, dayOfWeek: TUE, defaults: rows.defaults, overrides: rows.overrides,
        capacityEnabled: false, activePractitionerIds: [],
      });
      const column = resolvePractitionerDayAvailability({
        date: DATE, dayOfWeek: TUE, defaults: rows.defaults, overrides: rows.overrides,
        practitionerId: P[0], capacityEnabled: false,
      });
      expect(column).toEqual({ availability: week.availability, closedDay: week.closedDay });
    }
  });

  it("the slot engine's OFF branch reads studio-wide rows only (the rule this mirrors)", () => {
    const slots = readFileSync("lib/booking/slots.ts", "utf8");
    const off = slots.slice(slots.indexOf("  } else {\n    // OFF: studio-wide window only."));
    expect(off.slice(0, 600)).toMatch(/getStudioWideOverrideDaySafe/);
    expect(off.slice(0, 600)).toMatch(/getStudioWideDaySafe/);
    expect(off.slice(0, 600)).not.toMatch(/practitionerId/);
  });
});

// Codex P2 #2 on #1280: with capacity OFF a practitioner-scoped block or recurring break is
// DORMANT (0137 writes zero reservations for it), so the slot engine offers that time and the
// Day column must not draw it as unavailable. Studio-wide ones stay in both modes.
describe("buildTeamDay: capacity OFF draws studio-wide blocks and breaks only (parity with 0137 and slots.ts)", () => {
  const SOLO = [PRACTITIONERS[0]];
  const hours = [def(null, TUE, true, "09:00:00", "17:00:00")];
  // 11:00-12:00 PST on DATE.
  const START = "2026-11-17T19:00:00Z";
  const END = "2026-11-17T20:00:00Z";
  const scopedBlock = block(P[0], START, END);
  const wideBlock = block(null, START, END);
  const scopedBreak = brk(P[0], START, END, "Scoped break");
  const wideBreak = brk(null, START, END, "Studio break");
  const run = (capacityEnabled: boolean) =>
    buildTeamDay({
      date: DATE, dayOfWeek: TUE, tz: TZ, practitioners: SOLO,
      appointments: [], timedBlocks: [scopedBlock, wideBlock], recurringBreaks: [scopedBreak, wideBreak],
      defaults: hours, overrides: [], capacityEnabled,
    }).columns[0];

  it("capacity OFF: the scoped block and break are not drawn; the studio-wide ones are", () => {
    const c = run(false);
    expect(c.timedBlocks.map((b) => b.id)).toEqual([wideBlock.id]);
    expect(c.recurringBreaks.map((b) => b.id)).toEqual([wideBreak.id]);
  });

  it("capacity ON: scoped and studio-wide are both drawn (unchanged)", () => {
    const c = run(true);
    expect(c.timedBlocks.map((b) => b.id)).toEqual([scopedBlock.id, wideBlock.id]);
    expect(c.recurringBreaks.map((b) => b.id)).toEqual([scopedBreak.id, wideBreak.id]);
  });

  it("the slot engine offers the time under the reservations 0137 writes for each case", () => {
    const offers = (reservations: Array<{ starts_at: string; ends_at: string }>) =>
      buildDaySlots({ dateStr: DATE, tz: TZ, duration: 60, buffer: 0, openTime: "09:00", closeTime: "17:00", reservations })
        .some((s) => Date.parse(s.start) === Date.parse(START));
    // Capacity OFF, scoped source: dormant, zero reservations, time offered (and not drawn above).
    expect(offers([])).toBe(true);
    // Capacity OFF, studio-wide source: one reservation, time not offered (and drawn above).
    expect(offers([{ starts_at: START, ends_at: END }])).toBe(false);
  });

  it("0137 keeps a scoped source dormant when capacity is off (the rule this mirrors)", () => {
    const sql = readFileSync("supabase/migrations/0137_scoped_blocks_and_breaks.sql", "utf8");
    const scoped = sql.slice(sql.indexOf("if p_practitioner_id is not null then"));
    expect(scoped.slice(0, 400)).toMatch(/Capacity OFF => retained but DORMANT/);
    expect(scoped.slice(0, 600)).toMatch(/if public\.studio_capacity_enabled\(p_studio_id\) then/);
  });
});
