import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Desktop PR B: the week body is ONE clean vertical scroll, the leftover
// horizontal-scroll / min-width machinery is removed. Layout-only (CSS); the
// DayColumn positioning math, now-line, preview, booking, and block interactions
// are unchanged, and the mobile #380 day view + month view are untouched.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/calendar/page.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");

describe("desktop week body: one clean vertical scroll, no horizontal machinery", () => {
  it("the container is height-bounded + vertical-scroll only (no overflow-x)", () => {
    expect(PAGE).toMatch(/max-h-\[calc\(100dvh-13rem\)\][^"]*overflow-y-auto/);
    expect(PAGE).not.toMatch(/overflow-x-auto/);
  });
  it("no min-width forcing remains (no min-w-[840px] / min-w-[760px])", () => {
    expect(PAGE).not.toMatch(/min-w-\[840px\]/);
    expect(PAGE).not.toMatch(/min-w-\[760px\]/);
  });
  it("columns still flex to fit (minmax(0,1fr)), so no horizontal overflow at md+", () => {
    expect(PAGE).toMatch(/grid-cols-\[60px_repeat\(7,_minmax\(0,1fr\)\)\]/);
  });
});

describe("sticky header + time rail preserved (predictable)", () => {
  it("day-of-week header row is sticky at the top", () => {
    expect(PAGE).toMatch(/sticky top-0 z-20 grid grid-cols-\[60px_repeat\(7/);
  });
  it("time rail + corner cell stay sticky-left with opaque backgrounds", () => {
    expect(PAGE).toMatch(/sticky left-0 z-30 border-r border-neutral-200 bg-white/);
    expect(PAGE).toMatch(/sticky left-0 z-30 border-r[^"]*bg-neutral-50/);
  });
  it("the rail still establishes the positioning context for absolute hour labels", () => {
    expect(PAGE).toMatch(/top: \(h - HOUR_START\) \* 2 \* ROW_HEIGHT_PX/);
    expect(PAGE).toMatch(/style=\{\{ height: GRID_HEIGHT \}\}/);
  });
});

describe("DayColumn positioning + interactions unchanged (layout-only PR)", () => {
  it("cards still position by minute offset via viewport-relative rect", () => {
    expect(DAYCOL).toMatch(/getBoundingClientRect\(\)/);
    expect(DAYCOL).toMatch(/startMinutesFromGridTop/);
    expect(DAYCOL).toMatch(/const localTime = localTimeString\(start, tz\); \/\/ 24h/);
  });
  it("now-line, appointment preview, empty-slot booking + block edit all preserved", () => {
    expect(DAYCOL).toMatch(/isToday && <NowLine tz=\{tz\}/);
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setPreview\(a\)\}/);
    expect(DAYCOL).toMatch(/<AppointmentPreviewDrawer/);
    expect(DAYCOL).toMatch(/<QuickBookDrawer/);
    expect(DAYCOL).toMatch(/openDraftAtY/);
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setEditingBlock\(tb\)\}/);
  });
});

describe("mobile #380 + month view untouched; layout-only", () => {
  it("mobile day view + month render path preserved", () => {
    expect(PAGE).toMatch(/<CalendarMobileDayView/);
    expect(PAGE).toMatch(/renderMonthView/);
    expect(PAGE).toMatch(/<DayColumn/);
  });
  it("the page change adds no booking/server/slot logic", () => {
    expect(PAGE).not.toMatch(
      /bookAppointmentForClientAction|getAvailableSlots|fetchSlotsForClientBookingAction|"use server"/,
    );
  });
});
