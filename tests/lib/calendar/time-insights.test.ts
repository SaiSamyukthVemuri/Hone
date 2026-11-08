import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";
import { parseSelection } from "@/lib/calendar/practitioner-selection";
import { crossesInto } from "@/lib/calendar/boundary-appointments";
import {
  INSIGHTS_RULE,
  buildTimeInsights,
  computeTimeInsights,
  formatInsightHours,
  formatInsightSummary,
  insightPeriod,
  selectionPhrase,
  type InsightAppointment,
} from "@/lib/calendar/time-insights";

const TORONTO = "America/Toronto";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14: the studio's day is well ahead of a browser in the Americas
const P = ["p1", "p2", "p3"];
const ALL = parseSelection(undefined, P);

// A studio-local day as the page builds it: local midnight to the next local midnight.
const day = (date: string, tz = TORONTO) =>
  insightPeriod(utcInstantFromLocal(date, "00:00", tz), utcInstantFromLocal(addDays(date, 1), "00:00", tz));
const range = (from: string, toExclusive: string, tz = TORONTO) =>
  insightPeriod(utcInstantFromLocal(from, "00:00", tz), utcInstantFromLocal(toExclusive, "00:00", tz));
const at = (date: string, time: string, tz = TORONTO) => utcInstantFromLocal(date, time, tz).toISOString();
const appt = (over: Partial<InsightAppointment> & { starts_at: string; ends_at: string }): InsightAppointment => ({
  status: "confirmed",
  practitioner_id: "p1",
  ...over,
});
const total = (a: InsightAppointment[], period = day("2026-11-03"), selection = ALL) =>
  computeTimeInsights({ appointments: a, period, selection });

describe("which appointments count (statuses)", () => {
  const base = { starts_at: at("2026-11-03", "10:00"), ends_at: at("2026-11-03", "11:00") };
  it("scheduled (confirmed), completed and no-show count: they were booked", () => {
    for (const status of ["confirmed", "completed", "no_show"]) {
      expect(total([appt({ ...base, status })]), status).toEqual({ minutes: 60, count: 1 });
    }
  });
  it("cancelled and voided do not", () => {
    for (const status of ["cancelled", "voided"]) {
      expect(total([appt({ ...base, status })]), status).toEqual({ minutes: 0, count: 0 });
    }
  });
  it("a mixed day: only the booked ones add up", () => {
    const rows = [
      appt({ ...base, id: "a", status: "confirmed" }),
      appt({ ...base, id: "b", status: "completed", starts_at: at("2026-11-03", "12:00"), ends_at: at("2026-11-03", "12:30") }),
      appt({ ...base, id: "c", status: "no_show", starts_at: at("2026-11-03", "14:00"), ends_at: at("2026-11-03", "15:15") }),
      appt({ ...base, id: "d", status: "cancelled", starts_at: at("2026-11-03", "16:00"), ends_at: at("2026-11-03", "18:00") }),
      appt({ ...base, id: "e", status: "voided", starts_at: at("2026-11-03", "18:00"), ends_at: at("2026-11-03", "19:00") }),
    ];
    expect(total(rows)).toEqual({ minutes: 60 + 30 + 75, count: 3 });
  });
});

describe("blocks, breaks, blockouts and closures are never counted", () => {
  it("the module has no input for them, and the page feeds it appointments only", () => {
    const src = readFileSync("lib/calendar/time-insights.ts", "utf8");
    const imports = src.split("\n").filter((l) => /^import /.test(l)).join("\n");
    expect(imports).not.toMatch(/block|break|recurring|closure/i);
    expect(src).not.toMatch(/\b(timedBlocks?|StudioTimedBlock|blockouts?)\b\s*[:,)]/);
    const page = readFileSync("app/(app)/calendar/page.tsx", "utf8");
    const calls = [...page.matchAll(/buildTimeInsights\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c).toContain("appointments: [...appointments, ...boundaryCrossers]");
      expect(c).not.toMatch(/timedBlocks|blockouts|recurringOccurrences/);
    }
  });
  it("a block-shaped row (no appointment status) does not change a total", () => {
    const rows = [appt({ id: "a", starts_at: at("2026-11-03", "10:00"), ends_at: at("2026-11-03", "11:00") })];
    const withBlock = [...rows, { ...appt({ id: "blk", starts_at: at("2026-11-03", "12:00"), ends_at: at("2026-11-03", "13:00") }), status: "cancelled" }];
    expect(total(withBlock)).toEqual(total(rows));
  });
});

describe("the displayed period", () => {
  it("Day: only that studio-local day", () => {
    const rows = [
      appt({ id: "in", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") }),
      appt({ id: "before", starts_at: at("2026-11-02", "09:00"), ends_at: at("2026-11-02", "10:00") }),
      appt({ id: "after", starts_at: at("2026-11-04", "09:00"), ends_at: at("2026-11-04", "10:00") }),
    ];
    expect(total(rows)).toEqual({ minutes: 60, count: 1 });
  });
  it("Week: the displayed 7 days", () => {
    const rows = [0, 1, 6].map((i) =>
      appt({ id: `w${i}`, starts_at: at(addDays("2026-11-01", i), "09:00"), ends_at: at(addDays("2026-11-01", i), "10:30") }),
    ).concat(appt({ id: "next", starts_at: at("2026-11-08", "09:00"), ends_at: at("2026-11-08", "10:00") }));
    expect(total(rows, range("2026-11-01", "2026-11-08"))).toEqual({ minutes: 270, count: 3 });
  });
  it("an empty or inverted period counts nothing", () => {
    const p = day("2026-11-03");
    expect(total([appt({ starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") })], { startMs: p.startMs, endMs: p.startMs })).toEqual({ minutes: 0, count: 0 });
    expect(total([appt({ starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") })], { startMs: p.endMs, endMs: p.startMs })).toEqual({ minutes: 0, count: 0 });
  });
});

describe("boundary crossing: only the minutes inside, counted once", () => {
  const crossing = appt({ id: "x", starts_at: at("2026-11-02", "23:30"), ends_at: at("2026-11-03", "00:30") });
  it("a midnight-crossing appointment gives 30 min to each day, and is counted in each", () => {
    expect(total([crossing], day("2026-11-02"))).toEqual({ minutes: 30, count: 1 });
    expect(total([crossing], day("2026-11-03"))).toEqual({ minutes: 30, count: 1 });
  });
  it("over a week that holds both days it is one appointment and 60 minutes", () => {
    expect(total([crossing], range("2026-11-01", "2026-11-08"))).toEqual({ minutes: 60, count: 1 });
  });
  it("one that only touches the boundary is not inside it", () => {
    const ends = appt({ starts_at: at("2026-11-02", "22:00"), ends_at: at("2026-11-03", "00:00") });
    const starts = appt({ starts_at: at("2026-11-04", "00:00"), ends_at: at("2026-11-04", "01:00") });
    expect(total([ends, starts], day("2026-11-03"))).toEqual({ minutes: 0, count: 0 });
  });
  it("a row loaded only as a boundary crosser (began the day before) is kept; one that ended before is not", () => {
    const rows = [
      { ends_at: at("2026-11-03", "00:30") },
      { ends_at: at("2026-11-02", "23:59") },
      { ends_at: at("2026-11-03", "00:00") },
    ];
    expect(crossesInto(rows, day("2026-11-03").startMs)).toEqual([rows[0]]);
  });
});

describe("Month is the calendar month only (no spill-over days)", () => {
  const nov = range("2026-11-01", "2026-12-01");
  it("appointments on the October and December days drawn in the grid are not counted", () => {
    const rows = [
      appt({ id: "oct", starts_at: at("2026-10-31", "10:00"), ends_at: at("2026-10-31", "11:00") }),
      appt({ id: "nov", starts_at: at("2026-11-15", "10:00"), ends_at: at("2026-11-15", "11:00") }),
      appt({ id: "dec", starts_at: at("2026-12-01", "10:00"), ends_at: at("2026-12-01", "11:00") }),
    ];
    expect(total(rows, nov)).toEqual({ minutes: 60, count: 1 });
  });
  it("one crossing out of the month counts only the November minutes, one crossing in likewise", () => {
    const out = appt({ id: "out", starts_at: at("2026-11-30", "23:00"), ends_at: at("2026-12-01", "01:00") });
    const into = appt({ id: "in", starts_at: at("2026-10-31", "23:15"), ends_at: at("2026-11-01", "00:45") });
    expect(total([out], nov)).toEqual({ minutes: 60, count: 1 });
    expect(total([into], nov)).toEqual({ minutes: 45, count: 1 });
  });
});

describe("timezone edges: the studio's day, never the browser's", () => {
  // 2026-11-02T23:30Z is Nov 2 18:30 in Toronto but Nov 3 13:30 in Kiritimati.
  const row = appt({ starts_at: "2026-11-02T23:30:00.000Z", ends_at: "2026-11-03T00:30:00.000Z" });
  it("the same instants land on different studio days", () => {
    expect(total([row], day("2026-11-02", TORONTO))).toEqual({ minutes: 60, count: 1 });
    expect(total([row], day("2026-11-03", TORONTO))).toEqual({ minutes: 0, count: 0 });
    expect(total([row], day("2026-11-03", KIRITIMATI))).toEqual({ minutes: 60, count: 1 });
    expect(total([row], day("2026-11-02", KIRITIMATI))).toEqual({ minutes: 0, count: 0 });
  });
  it("a DST fall-back day is 25 hours long and an appointment across the fold is its real 90 minutes", () => {
    const p = day("2026-11-01", TORONTO);
    expect((p.endMs - p.startMs) / 3_600_000).toBe(25);
    const fold = appt({ starts_at: "2026-11-01T05:00:00.000Z", ends_at: "2026-11-01T06:30:00.000Z" });
    expect(total([fold], p)).toEqual({ minutes: 90, count: 1 });
  });
  it("a DST spring-forward day is 23 hours long", () => {
    const p = day("2026-03-08", TORONTO);
    expect((p.endMs - p.startMs) / 3_600_000).toBe(23);
  });
});

describe("zero is shown honestly, with no averages or estimates", () => {
  it("no appointments: 0 h · 0 appointments", () => {
    const t = total([]);
    expect(t).toEqual({ minutes: 0, count: 0 });
    expect(formatInsightSummary(t)).toBe("0 h · 0 appointments");
  });
  it("only cancelled ones: still zero", () => {
    const rows = [appt({ status: "cancelled", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") })];
    expect(formatInsightSummary(total(rows))).toBe("0 h · 0 appointments");
  });
  it("the result carries nothing but minutes and a count", () => {
    expect(Object.keys(total([])).sort()).toEqual(["count", "minutes"]);
    expect(Object.keys(buildTimeInsights({ appointments: [], period: day("2026-11-03"), selection: ALL, periodLabel: "x", practitioners: [] })).sort())
      .toEqual(["count", "hoursText", "label", "minutes", "summary"]);
  });
});

describe("only the selected practitioners", () => {
  const rows = [
    appt({ id: "a", practitioner_id: "p1", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") }),
    appt({ id: "b", practitioner_id: "p2", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:30") }),
    appt({ id: "c", practitioner_id: "p3", starts_at: at("2026-11-03", "11:00"), ends_at: at("2026-11-03", "12:00") }),
    appt({ id: "u", practitioner_id: null, starts_at: at("2026-11-03", "13:00"), ends_at: at("2026-11-03", "14:00") }),
  ];
  it("everyone selected = exactly what the unfiltered view draws, unassigned included", () => {
    expect(total(rows)).toEqual({ minutes: 60 + 90 + 60 + 60, count: 4 });
  });
  it("one, two and a subset", () => {
    expect(total(rows, day("2026-11-03"), parseSelection("p2", P))).toEqual({ minutes: 90, count: 1 });
    expect(total(rows, day("2026-11-03"), parseSelection("p1,p3", P))).toEqual({ minutes: 120, count: 2 });
  });
  it("nobody selected = zero", () => {
    expect(total(rows, day("2026-11-03"), parseSelection("none", P))).toEqual({ minutes: 0, count: 0 });
  });
  it("a practitioner the viewer is not offered cannot be counted in by a hand-edited link", () => {
    expect(total(rows, day("2026-11-03"), parseSelection("p2,stranger", P))).toEqual({ minutes: 90, count: 1 });
  });
  it("a capacity-off studio counts its single timeline (everyone selected, every row)", () => {
    expect(total(rows).count).toBe(4);
  });
});

describe("robustness", () => {
  it("the same appointment id is counted once", () => {
    const a = appt({ id: "dup", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") });
    expect(total([a, a])).toEqual({ minutes: 60, count: 1 });
  });
  it("a zero-length appointment inside the period counts once and adds no time; bad data is ignored", () => {
    const z = appt({ id: "z", starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "09:00") });
    const bad1 = appt({ id: "b1", starts_at: "garbage", ends_at: at("2026-11-03", "10:00") });
    const bad2 = appt({ id: "b2", starts_at: at("2026-11-03", "11:00"), ends_at: at("2026-11-03", "10:00") });
    expect(total([z, bad1, bad2])).toEqual({ minutes: 0, count: 1 });
  });
  it("buffers are not booked time: only starts_at to ends_at", () => {
    const a = { ...appt({ starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") }), blocked_ends_at: at("2026-11-03", "10:30") };
    expect(total([a])).toEqual({ minutes: 60, count: 1 });
  });
});

describe("how the totals read", () => {
  it("hours", () => {
    expect(formatInsightHours(0)).toBe("0 h");
    expect(formatInsightHours(Number.NaN)).toBe("0 h");
    expect(formatInsightHours(-5)).toBe("0 h");
    expect(formatInsightHours(45)).toBe("45 min");
    expect(formatInsightHours(60)).toBe("1 h");
    expect(formatInsightHours(135)).toBe("2 h 15 min");
    expect(formatInsightHours(1500)).toBe("25 h");
  });
  it("singular and plural", () => {
    expect(formatInsightSummary({ minutes: 60, count: 1 })).toBe("1 h · 1 appointment");
    expect(formatInsightSummary({ minutes: 150, count: 3 })).toBe("2 h 30 min · 3 appointments");
  });
  it("the label names the period and the selection", () => {
    const three = [{ id: "p1", name: "Ann" }, { id: "p2", name: "Sam" }, { id: "p3", name: "Lee" }, { id: "p4", name: "Kim" }];
    const l = (sel: string | undefined, label: string) =>
      buildTimeInsights({ appointments: [], period: day("2026-11-03"), selection: parseSelection(sel, three.map((p) => p.id)), periodLabel: label, practitioners: three }).label;
    expect(l("p1,p2,p3", "Tue, Nov 3")).toBe("Tue, Nov 3 · 3 practitioners selected");
    expect(l("p2", "Nov 1–7")).toBe("Nov 1–7 · Sam selected");
    expect(l(undefined, "November 2026")).toBe("November 2026 · all selected");
    expect(l("none", "November 2026")).toBe("November 2026 · no practitioner selected");
  });
  it("a studio with one practitioner names them instead of 'all'", () => {
    expect(selectionPhrase({ mode: "all", selectedNames: ["Sam"], listedCount: 1 })).toBe("Sam selected");
  });
  it("states its rule for the tooltip", () => {
    expect(INSIGHTS_RULE).toMatch(/Cancelled and voided/);
    expect(INSIGHTS_RULE).toMatch(/Blocks, breaks and closures/);
  });
});
