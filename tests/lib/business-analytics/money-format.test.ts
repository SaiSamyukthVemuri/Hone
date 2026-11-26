import { describe, expect, it } from "vitest";

import { formatExact, formatWhole } from "@/lib/business-analytics/money-format";

const plain = (s: string): number => Number(s.split("$").join("").split(",").join(""));

describe("analytics money display", () => {
  it("exact keeps every cent and groups thousands", () => {
    expect(formatExact(146170)).toBe("$1,461.70");
    expect(formatExact(5)).toBe("$0.05");
    expect(formatExact(100000000)).toBe("$1,000,000.00");
    expect(formatExact(-1234)).toBe("-$12.34");
    expect(formatExact(0)).toBe("$0.00");
  });
  it("whole rounds half away from zero, groups thousands, and never shows a negative zero", () => {
    expect(formatWhole(814800)).toBe("$8,148");
    expect(formatWhole(8749)).toBe("$87");
    expect(formatWhole(8750)).toBe("$88");
    expect(formatWhole(149)).toBe("$1");
    expect(formatWhole(49)).toBe("$0");
    expect(formatWhole(-49)).toBe("$0");
    expect(formatWhole(-8750)).toBe("-$88");
    expect(formatWhole(146170)).toBe("$1,462");
  });
  it("rounding is display only: whole dollars are within 50 cents of the exact figure, and exact round-trips to the cent", () => {
    for (const c of [0, 1, 49, 50, 99, 100, 101, 8749, 8750, 146170, 99999999]) {
      expect(Math.abs(plain(formatWhole(c)) * 100 - c)).toBeLessThanOrEqual(50);
      expect(Math.round(plain(formatExact(c)) * 100)).toBe(c);
    }
  });
});

describe("Analytics headline money is dollars AND cents (Sam, 26 Nov 2026)", () => {
  it("a last-month total of 27550 cents reads $275.50 and never $276, the figure the Overview shows", () => {
    expect(formatExact(27550)).toBe("$275.50");
    expect(formatExact(27550)).not.toBe(formatWhole(27550));
    expect(formatExact(9000)).toBe("$90.00");
    expect(formatExact(146170)).toBe("$1,461.70");
    expect(formatExact(0)).toBe("$0.00");
  });
});

