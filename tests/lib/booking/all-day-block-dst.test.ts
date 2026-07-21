import { describe, expect, it } from "vitest";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// PR B 3E defect #1 — a practitioner-scoped all-day block is built as the
// half-open range [local midnight, next local midnight) via utcInstantFromLocal
// for BOTH endpoints (createTimedBlockAction / buildAllDayBlockUtcRange). This
// pins the DST correctness of that primitive: because each midnight resolves its
// own tz offset, a spring-forward day is 23h and a fall-back day is 25h — never
// a naive start+24h.

const TZ = "America/Toronto";
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

// Mirrors buildAllDayBlockUtcRange (a local, non-exported action helper).
function allDay(date: string, next: string) {
  return {
    start: utcInstantFromLocal(date, "00:00", TZ),
    end: utcInstantFromLocal(next, "00:00", TZ),
  };
}

describe("all-day block UTC interval is DST-correct", () => {
  it("a normal day is exactly 24 hours", () => {
    const { start, end } = allDay("2026-06-10", "2026-06-11");
    expect(hours(start, end)).toBe(24);
  });

  it("the spring-forward day (Toronto 2026-03-08) is 23 hours", () => {
    const { start, end } = allDay("2026-03-08", "2026-03-09");
    expect(hours(start, end)).toBe(23);
    // 00:00 EST = 05:00Z; next 00:00 EDT = 04:00Z.
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("the fall-back day (Toronto 2026-11-01) is 25 hours", () => {
    const { start, end } = allDay("2026-11-01", "2026-11-02");
    expect(hours(start, end)).toBe(25);
    // 00:00 EDT = 04:00Z; next 00:00 EST = 05:00Z.
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});
