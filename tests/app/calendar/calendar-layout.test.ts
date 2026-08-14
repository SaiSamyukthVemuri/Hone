import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B: calendar layout usability (layout-only; no booking logic). The calendar
// body now scrolls INTERNALLY (fits the viewport) with a sticky day header and a
// sticky-left time rail so hour labels stay visible while scrolling across days.
// vitest env is "node" (no DOM) → verified by source pins. Drag/positioning math
// lives in DayColumn and is unchanged (viewport-relative getBoundingClientRect).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/calendar/page.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");

describe("A. desktop: calendar body scrolls internally (not the whole page)", () => {
  it("the grid scroll container is height-bounded + ONE clean vertical scroll (no horizontal)", () => {
    // PR B: single vertical scroll; the horizontal-scroll machinery is gone.
    expect(PAGE).toMatch(/max-h-\[calc\(100dvh-13rem\)\][^"]*overflow-y-auto/);
    expect(PAGE).not.toMatch(/max-h-\[calc\(100dvh-13rem\)\][^"]*overflow-x-auto/);
  });
  it("the day-of-week header row is sticky at the top", () => {
    // PR B: no more min-w-[760px] forcing, columns flex (minmax(0,1fr)).
    expect(PAGE).toMatch(/className="sticky top-0 z-20 grid grid-cols-\[60px_repeat\(7/);
  });
  it("no desktop horizontal min-width forcing remains", () => {
    expect(PAGE).not.toMatch(/min-w-\[840px\]/);
    expect(PAGE).not.toMatch(/min-w-\[760px\]/);
  });
});

describe("B. mobile: time rail stays visible while scrolling across days", () => {
  it("the time rail is sticky-left with an opaque background + z above cards", () => {
    expect(PAGE).toMatch(/className="sticky left-0 z-30 border-r border-neutral-200 bg-white/);
  });
  it("the header corner cell is sticky-left too (stays in the top-left corner)", () => {
    expect(PAGE).toMatch(/<div className="sticky left-0 z-30 border-r[^"]*bg-neutral-50[^"]*" \/>/);
  });
  it("the sticky rail still establishes the positioning context for absolute hour labels", () => {
    // sticky (a positioned value) preserves the containing block; the hour-label
    // top offsets are UNCHANGED (same row math as DayColumn).
    expect(PAGE).toMatch(/top: \(h - HOUR_START\) \* 2 \* ROW_HEIGHT_PX/);
    expect(PAGE).toMatch(/style=\{\{ height: GRID_HEIGHT \}\}/);
  });
});

describe("drag / positioning math is preserved (DayColumn untouched)", () => {
  it("pointer math still reads viewport-relative getBoundingClientRect", () => {
    expect(DAYCOL).toMatch(/getBoundingClientRect\(\)/);
  });
  it("appointment/block cards still position by minute offset (unchanged)", () => {
    expect(DAYCOL).toMatch(/startMinutesFromGridTop/);
    expect(DAYCOL).toMatch(/const localTime = localTimeString\(start, tz\); \/\/ 24h/);
  });
  it("drag overlay still positioned by top/height, not by any label", () => {
    expect(DAYCOL).toMatch(/style=\{\{ top: overlay\.top, height: overlay\.height \}\}/);
  });
});

describe("layout-only: no booking/server logic in the calendar page change", () => {
  it("the page change does not add booking/action/slot logic", () => {
    // page.tsx renders the grid; the layout change must not introduce booking calls
    expect(PAGE).not.toMatch(/bookAppointmentForClientAction|getAvailableSlots|allow_outside_availability|fetchSlotsForClientBookingAction/);
  });
});
