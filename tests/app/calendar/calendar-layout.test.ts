import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { appointmentLanes, appointmentCollisionGroups } from "@/lib/calendar/appointment-lanes";

// PR B — calendar layout usability (layout-only; no booking logic). The calendar
// body now scrolls INTERNALLY (fits the viewport) with a sticky day header and a
// sticky-left time rail so hour labels stay visible while scrolling across days.
// vitest env is "node" (no DOM) → verified by source pins. Drag/positioning math
// lives in DayColumn and is unchanged (viewport-relative getBoundingClientRect).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const PAGE = read("app/(app)/calendar/page.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");

describe("A. desktop — calendar body scrolls internally (not the whole page)", () => {
  it("the grid scroll container is height-bounded + ONE clean vertical scroll (no horizontal)", () => {
    // PR B: single vertical scroll; the horizontal-scroll machinery is gone.
    expect(PAGE).toMatch(/max-h-\[calc\(100dvh-13rem\)\][^"]*overflow-y-auto/);
    expect(PAGE).not.toMatch(/max-h-\[calc\(100dvh-13rem\)\][^"]*overflow-x-auto/);
  });
  it("the day-of-week header row is sticky at the top", () => {
    // PR B: no more min-w-[760px] forcing — columns flex (minmax(0,1fr)).
    expect(PAGE).toMatch(/className="sticky top-0 z-20 grid grid-cols-\[60px_repeat\(7/);
  });
  it("no desktop horizontal min-width forcing remains", () => {
    expect(PAGE).not.toMatch(/min-w-\[840px\]/);
    expect(PAGE).not.toMatch(/min-w-\[760px\]/);
  });
});

describe("B. mobile — time rail stays visible while scrolling across days", () => {
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


describe("fine-pointer appointment collision layout", () => {
  it("gives five same-instant cards distinct nonoverlapping horizontal lanes", () => {
    const cards = Array.from({ length: 5 }, (_, index) => ({ id: String(index), top: 840, height: 28 }));
    const lanes = appointmentLanes(cards);
    expect(lanes.size).toBe(5);
    expect(new Set([...lanes.values()].map((lane) => lane.column)).size).toBe(5);
    for (const lane of lanes.values()) {
      expect(lane.columns).toBe(5);
      expect(lane.column).toBeGreaterThanOrEqual(0);
      expect(lane.column).toBeLessThan(lane.columns);
    }
  });
  it("keeps disjoint and exactly adjacent rendered intervals full-width", () => {
    const lanes = appointmentLanes([
      { id: "a", top: 0, height: 28 },
      { id: "b", top: 28, height: 28 },
      { id: "c", top: 90, height: 28 },
    ]);
    expect([...lanes.values()]).toEqual(Array(3).fill({ column: 0, columns: 1 }));
  });
  it("shares a stable lane count across partial/bridge overlaps and reuses a free lane", () => {
    const lanes = appointmentLanes([
      { id: "a", top: 0, height: 30 },
      { id: "b", top: 20, height: 30 },
      { id: "c", top: 40, height: 30 },
    ]);
    expect(lanes.get("a")).toEqual({ column: 0, columns: 2 });
    expect(lanes.get("b")).toEqual({ column: 1, columns: 2 });
    expect(lanes.get("c")).toEqual({ column: 0, columns: 2 });
  });
  it("is deterministic under input permutation without mutating input", () => {
    const cards = [{ id: "b", top: 0, height: 28 }, { id: "a", top: 0, height: 28 }];
    const original = structuredClone(cards);
    expect([...appointmentLanes(cards)]).toEqual([...appointmentLanes([...cards].reverse())]);
    expect(cards).toEqual(original);
    expect(appointmentLanes([]).size).toBe(0);
  });
  it("wires lanes to the original appointment preview without changing vertical or booking behavior", () => {
    expect(DAYCOL).toContain("appointmentLanes(positionedAppointments.map");
    expect(DAYCOL).toContain("{ appointment: a, start, top, height }");
    expect(DAYCOL).toContain("onClick={() => setPreview(a)}");
    expect(DAYCOL).toContain('"--appointment-lane-left"');
    expect(DAYCOL).toContain('"--appointment-lane-right"');
  });
  it("compiles lane offsets ONLY under fine-pointer media; coarse keeps original four-pixel insets", async () => {
    const classes = ["left-1", "right-1",
      "pointer-fine:left-[var(--appointment-lane-left)]",
      "pointer-fine:right-[var(--appointment-lane-right)]"];
    for (const value of classes) expect(DAYCOL).toContain(value);
    const compiler = await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;");
    const css = compiler.build(classes);
    expect(css).toContain(".left-1 {\n  left: calc(var(--spacing) * 1);\n}");
    expect(css).toContain(".right-1 {\n  right: calc(var(--spacing) * 1);\n}");
    expect(css.match(/@media \(pointer: fine\)/g)).toHaveLength(2);
    expect(css).toMatch(/@media \(pointer: fine\) \{\s+left: var\(--appointment-lane-left\);\s+\}/);
    expect(css).toMatch(/@media \(pointer: fine\) \{\s+right: var\(--appointment-lane-right\);\s+\}/);
  });
});


describe("coarse-pointer rendered collision ranges", () => {
  it("groups five equal appointments into one full-height target with every original id", () => {
    expect(appointmentCollisionGroups(Array.from({ length: 5 }, (_, i) => ({ id: String(i), top: 840, height: 28 })))).toEqual([
      { ids: ["0", "1", "2", "3", "4"], top: 840, height: 44 },
    ]);
  });
  it("groups adjacent short cards using actual44px targets and preserves the ENTIRE occupied span", () => {
    expect(appointmentCollisionGroups([
      { id: "a", top: 0, height: 28 }, { id: "b", top: 30, height: 28 }, { id: "c", top: 60, height: 28 },
    ])).toEqual([{ ids: ["a", "b", "c"], top: 0, height: 104 }]);
  });
  it("keeps separated or exactly44px-adjacent singletons and long duration geometry", () => {
    expect(appointmentCollisionGroups([
      { id: "a", top: 0, height: 28 }, { id: "b", top: 44, height: 28 }, { id: "c", top: 100, height: 120 },
    ])).toEqual([
      { ids: ["a"], top: 0, height: 44 }, { ids: ["b"], top: 44, height: 44 }, { ids: ["c"], top: 100, height: 120 },
    ]);
  });
  it("does not mutate appointments/rectangles and is deterministic under permutations", () => {
    const rectangles = [{ id: "b", top: 0, height: 28 }, { id: "a", top: 0, height: 28 }];
    const original = structuredClone(rectangles);
    expect(appointmentCollisionGroups(rectangles)).toEqual(appointmentCollisionGroups([...rectangles].reverse()));
    expect(rectangles).toEqual(original);
    expect(appointmentCollisionGroups([])).toEqual([]);
  });
  it("fine cards are CSS-hidden on coarse/none; coarse groups are hidden on fine", async () => {
    expect(DAYCOL).toContain("hidden pointer-fine:block absolute");
    expect(DAYCOL).toContain("pointer-fine:hidden absolute");
    const c = await compile("@tailwind utilities;");
    const css = c.build(["hidden", "pointer-fine:block", "pointer-fine:hidden", "min-h-[44px]", "min-w-[44px]"]);
    expect(css).toContain("min-height: 44px;");
    expect(css).toContain("min-width: 44px;");
    expect(css).toMatch(/\.hidden \{\s+display: none;/);
    expect(css).toMatch(/@media \(pointer: fine\) \{\s+display: block;/);
    expect(css).toMatch(/@media \(pointer: fine\) \{\s+display: none;/);
  });
});
