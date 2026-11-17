import { describe, expect, it } from "vitest";
import { dayUrl, everyoneQuery, monthUrl, weekUrl } from "../../e2e/hon48-support/calendar-urls";
import { parseSelection } from "../../lib/calendar/practitioner-selection";
import { firstOfMonthString } from "../../lib/booking/month-grid";

const IDS = ["a1", "b2", "c3", "d4", "e5"];

describe("the calendar URLs of the five-user spec", () => {
  it("an explicit list of every practitioner is read by the page as EVERYONE, not as a narrowing", () => {
    const raw = new URLSearchParams(everyoneQuery(IDS)).get("people");
    const sel = parseSelection(raw, IDS);
    expect(sel.mode).toBe("all");
    expect([...sel.ids].sort()).toEqual([...IDS].sort());
  });
  it("it is a param, so a member's stored own-calendar-only selection is not restored over it", () => {
    for (const u of [dayUrl("2026-11-20", IDS), weekUrl("2026-11-20", IDS), monthUrl("2026-11-20", IDS)]) {
      expect(new URL(u, "http://x").searchParams.get("people")).toBe(IDS.join(","));
    }
  });
  it("the Month view is anchored to the month of the seeded day, not of today", () => {
    // The last days of a month: the seeded day (a few days ahead) falls in the NEXT month.
    for (const [day, month] of [
      ["2026-12-02", "2026-12-01"],
      ["2027-01-01", "2027-01-01"],
      ["2026-11-30", "2026-11-01"],
    ] as const) {
      const url = new URL(monthUrl(day, IDS), "http://x");
      expect(url.searchParams.get("month")).toBe(month);
      expect(url.searchParams.get("month")).toBe(firstOfMonthString(day));
      expect(url.searchParams.get("view")).toBe("month");
    }
  });
  it("the anchor is not the day itself or today's month: a day in a different month than a late-month today gets its own", () => {
    expect(new URL(monthUrl("2026-12-02", IDS), "http://x").searchParams.get("month")).not.toBe("2026-11-01");
  });
});
