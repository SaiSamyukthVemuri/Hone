import { describe, expect, it } from "vitest";
import { CAPACITY_NOTE, consultationsThatFit, estimateCapacity } from "@/lib/waitlist/consultation-capacity";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();
const slot = (h: number, m: number, mins: number) => ({
  start: at(h, m),
  end: new Date(Date.parse(at(h, m)) + mins * 60_000).toISOString(),
});

describe("consultationsThatFit", () => {
  it("counts non-overlapping starts, not every legal start", () => {
    // A 60-minute service offers 9:00, 9:30, 10:00, 10:30: two fit, not four.
    const slots = [slot(9, 0, 60), slot(9, 30, 60), slot(10, 0, 60), slot(10, 30, 60)];
    expect(consultationsThatFit(slots, 0)).toBe(2);
  });

  it("a buffer between consultations reduces what fits", () => {
    const slots = [slot(9, 0, 60), slot(10, 0, 60), slot(11, 0, 60)];
    expect(consultationsThatFit(slots, 0)).toBe(3);
    expect(consultationsThatFit(slots, 30)).toBe(2); // 9:00, then 10:30 is not a start
  });

  it("is zero for no slots and ignores malformed spans", () => {
    expect(consultationsThatFit([], 15)).toBe(0);
    expect(consultationsThatFit([{ start: "x", end: "y" }, slot(9, 0, 0)], 0)).toBe(0);
  });

  it("does not depend on input order", () => {
    const a = [slot(11, 0, 60), slot(9, 0, 60), slot(10, 0, 60)];
    expect(consultationsThatFit(a, 0)).toBe(consultationsThatFit([...a].reverse(), 0));
  });
});

describe("estimateCapacity", () => {
  it("subtracts outstanding invitations once and never goes below zero", () => {
    expect(estimateCapacity(5, 2)).toEqual({ fit: 5, outstanding: 2, open: 3 });
    expect(estimateCapacity(2, 6)).toEqual({ fit: 2, outstanding: 6, open: 0 });
    expect(estimateCapacity(-1, -1)).toEqual({ fit: 0, outstanding: 0, open: 0 });
  });

  it("states plainly that nothing is reserved", () => {
    expect(CAPACITY_NOTE).toMatch(/Nothing is reserved/);
    expect(CAPACITY_NOTE).toMatch(/Availability can change/);
  });
});

import { capacityLines } from "@/lib/waitlist/consultation-capacity";

describe("capacityLines", () => {
  it("says 'at least', mentions outstanding invitations, and ends with the not-reserved note", () => {
    const l = capacityLines({ fit: 5, outstanding: 2, open: 3 });
    expect(l[0]).toBe("At least 5 consultations fit this window.");
    expect(l[1]).toMatch(/2 invitations are already out and not yet booked, so about 3 more/);
    expect(l[l.length - 1]).toMatch(/Nothing is reserved/);
  });

  it("is honest when nothing fits and never presents a lower bound as exact", () => {
    expect(capacityLines({ fit: 0, outstanding: 0, open: 0 })[0]).toMatch(/No consultation times fit/);
    expect(capacityLines({ fit: 1, outstanding: 0, open: 1 })[0]).toBe("At least 1 consultation fits this window.");
    for (const f of [1, 2, 9]) expect(capacityLines({ fit: f, outstanding: 0, open: f })[0]).not.toMatch(/exactly/i);
  });
});
