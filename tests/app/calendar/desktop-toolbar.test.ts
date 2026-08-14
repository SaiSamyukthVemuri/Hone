import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { weekRangeLabel } from "@/app/(app)/calendar/calendar-format";

// Desktop PR A: a Google/Apple-style calendar toolbar (Today · ‹ › · visible
// date range · Week/Month toggle) shared by the week + month renders.
// Presentational only, no booking/view-resolution/param changes.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/calendar/page.tsx");
const TOOLBAR = read("app/(app)/calendar/CalendarToolbar.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");

describe("weekRangeLabel: Google-style visible date range", () => {
  it("same month", () => {
    expect(weekRangeLabel("2026-07-07", "2026-07-13")).toBe("Jul 7 – 13, 2026");
  });
  it("crosses a month, same year", () => {
    expect(weekRangeLabel("2026-06-29", "2026-07-05")).toBe(
      "Jun 29 – Jul 5, 2026",
    );
  });
  it("crosses a year", () => {
    expect(weekRangeLabel("2025-12-29", "2026-01-04")).toBe(
      "Dec 29, 2025 – Jan 4, 2026",
    );
  });
});

describe("toolbar renders Today, prev/next, date range, and the view toggle", () => {
  it("shows Today + accessible previous/next controls", () => {
    expect(TOOLBAR).toMatch(/>\s*Today\s*</);
    expect(TOOLBAR).toMatch(/aria-label="Previous"/);
    expect(TOOLBAR).toMatch(/aria-label="Next"/);
  });
  it("renders the visible date range as the heading", () => {
    expect(TOOLBAR).toMatch(/<h1[^>]*>\{rangeLabel\}<\/h1>/);
  });
  it("keeps the Week/Month toggle (Day deferred to PR D)", () => {
    expect(TOOLBAR).toMatch(/<CalendarViewToggle/);
    expect(TOOLBAR).toMatch(/currentView=\{view\}/);
  });
  it("week step nav is desktop-only; month step nav shows on all sizes", () => {
    expect(TOOLBAR).toMatch(/hideStepNavOnMobile \? "hidden md:flex" : "flex"/);
  });
});

describe("page wires the toolbar for both views with existing params", () => {
  it("week view passes the week range + week/month hrefs + hides step nav on mobile", () => {
    expect(PAGE).toMatch(
      /<CalendarToolbar[\s\S]*?view="week"[\s\S]*?rangeLabel=\{weekRangeLabel\(weekStart, weekEnd\)\}[\s\S]*?hideStepNavOnMobile/,
    );
    expect(PAGE).toMatch(/prevHref=\{`\/calendar\?week=\$\{prevWeek\}`\}/);
    expect(PAGE).toMatch(/todayHref="\/calendar"/);
  });
  it("month view passes the month label + month nav, step nav visible", () => {
    expect(PAGE).toMatch(
      /<CalendarToolbar[\s\S]*?view="month"[\s\S]*?rangeLabel=\{monthYearLabel\(monthAnchor\)\}/,
    );
    expect(PAGE).toMatch(/prevHref=\{`\/calendar\?view=month&month=\$\{prevMonth\}`\}/);
    expect(PAGE).toMatch(/hideStepNavOnMobile=\{false\}/);
  });
});

describe("nothing else changed", () => {
  it("mobile #380 day view + desktop week grid + month still render", () => {
    expect(PAGE).toMatch(/<CalendarMobileDayView/);
    expect(PAGE).toMatch(/<DayColumn/);
    expect(PAGE).toMatch(/renderMonthView/);
  });
  it("appointment preview #381 + empty-slot booking + block edit unchanged", () => {
    expect(DAYCOL).toMatch(/<AppointmentPreviewDrawer/);
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setPreview\(a\)\}/);
    expect(DAYCOL).toMatch(/<QuickBookDrawer/);
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setEditingBlock\(tb\)\}/);
  });
  it("the toolbar is presentational: no booking/server-action/mutation", () => {
    expect(TOOLBAR).not.toMatch(/"use server"|bookAppointment|createClient|supabase|<form|stripe/i);
  });
});
