import { describe, expect, it } from "vitest";
import { nextCalendarDay } from "@/lib/portal/rebook-dates";

// EMERG-PORTAL-REBOOK-01 — the date step, run rather than grepped.
//
// The inline version this replaced had two wrong answers, and NEITHER was
// visible in source: one threw, and the other returned a confident value from
// 1900. Both are pinned here by execution.

describe("nextCalendarDay", () => {
  it("advances an ordinary date", () => {
    expect(nextCalendarDay("2026-10-07")).toBe("2026-10-08");
  });

  it("crosses a month boundary", () => {
    expect(nextCalendarDay("2026-10-31")).toBe("2026-11-01");
  });

  it("crosses a year boundary", () => {
    expect(nextCalendarDay("2026-12-31")).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(nextCalendarDay("2028-02-28")).toBe("2028-02-29");
    expect(nextCalendarDay("2028-02-29")).toBe("2028-03-01");
  });

  it("handles a NON-leap February", () => {
    expect(nextCalendarDay("2026-02-28")).toBe("2026-03-01");
  });

  // -------------------------------------------------------------------------
  // The two historical wrong answers. These are the regression pins.
  // -------------------------------------------------------------------------

  it("REGRESSION: an empty string is not a date, and is not 1900", () => {
    // The old version computed `Date.UTC(0, 0, 2)` — a VALID 1900 date — so it
    // answered "1900-01-02" with no error anywhere. Pressing Next available
    // with a cleared date searched from 1900, which the server clamped to
    // today: a silently different question from the one the control asks.
    expect(nextCalendarDay("")).toBeNull();
    expect(nextCalendarDay("")).not.toBe("1900-01-02");
  });

  it("REGRESSION: a non-date does not throw", () => {
    // The old version threw RangeError from toISOString(), which on a client
    // surface escapes to the route's error boundary.
    expect(() => nextCalendarDay("not-a-date")).not.toThrow();
    expect(nextCalendarDay("not-a-date")).toBeNull();
  });

  it("rejects anything that is not exactly YYYY-MM-DD", () => {
    for (const bad of [
      " ",
      "2026",
      "2026-10",
      "2026-1-7",
      "26-10-07",
      "2026/10/07",
      "2026-10-07T00:00:00Z",
      " 2026-10-07",
      "2026-10-07 ",
    ]) {
      expect(nextCalendarDay(bad), bad).toBeNull();
    }
  });

  it("rejects a well-shaped but impossible calendar date", () => {
    // Shape alone is not enough: `Date.UTC` rolls these over silently, so
    // without the round-trip check the function answers confidently for a day
    // that does not exist. 2026-13-01 would have become 2027-01-02.
    expect(nextCalendarDay("2026-13-01")).toBeNull();
    expect(nextCalendarDay("2026-00-10")).toBeNull();
    expect(nextCalendarDay("2026-02-30")).toBeNull();
    expect(nextCalendarDay("2026-04-31")).toBeNull();
  });

  it("REGRESSION: a sub-100 year is not silently mapped into the 1900s", () => {
    // The same `Date.UTC` two-digit-year rule that produced the original "1900"
    // answer: `Date.UTC(26, ...)` is 1926, not 26.
    expect(nextCalendarDay("0026-01-01")).toBeNull();
    expect(nextCalendarDay("0099-06-15")).toBeNull();
  });

  it("NON-VACUITY: the rejection set does not swallow valid input", () => {
    // Without this, "returns null for bad input" could pass by returning null
    // for everything.
    const valid = ["2026-01-01", "2026-06-15", "2099-12-30"];
    for (const v of valid) expect(nextCalendarDay(v), v).not.toBeNull();
  });

  it("always answers a well-formed date or null — never a partial result", () => {
    const inputs = ["2026-10-07", "", "junk", "2026-13-01", "2026-02-30"];
    for (const i of inputs) {
      const out = nextCalendarDay(i);
      if (out !== null) expect(out, i).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
