import { describe, expect, it } from "vitest";
import {
  DASHBOARD_DAY_MAX_OFFSET_DAYS,
  calendarHrefForDashboardDay,
  canNavigateNext,
  canNavigatePrevious,
  dashboardDayBounds,
  dashboardDayHref,
  dayHeading,
  emptyDayMessage,
  formatSelectedDayLabel,
  isViewingToday,
  nextDay,
  parseDashboardDay,
  previousDay,
  resolveSelectedDay,
} from "@/lib/dashboard/day-navigation";
import { addDays, utcInstantFromLocal } from "@/lib/booking/tz";

// Chloe: "I want an option to go to the next day."
//
// The whole module is pure and takes actual-today as an argument, so there is
// no clock to stub and no way for a caller to introduce a second one.

const TODAY = "2026-08-20"; // a Thursday
const TZ = "America/Toronto";

describe("parseDashboardDay — browser input, calendar-aware", () => {
  it("accepts a canonical real date", () => {
    expect(parseDashboardDay("2026-08-20")).toBe("2026-08-20");
  });

  it("REJECTS an impossible date that every shape regex accepts", () => {
    // This is the one that matters. `2026-02-31` passes /^\d{4}-\d{2}-\d{2}$/
    // and silently ROLLS OVER to 2026-03-03 in Date maths, so the header would
    // name one day while the roster queried another.
    for (const impossible of [
      "2026-02-31",
      "2026-02-30",
      "2026-06-31",
      "2026-13-01",
      "2026-00-10",
    ]) {
      expect(parseDashboardDay(impossible), impossible).toBeNull();
    }
  });

  it("REJECTS non-canonical shapes that would THROW inside the date helpers", () => {
    // `2026-8-2` makes utcInstantFromLocal/addDays raise RangeError, which in
    // an async Server Component with no boundary is a 500 for the whole page.
    for (const bad of [
      "2026-8-2",
      "26-08-20",
      "2026/08/20",
      "2026-08-20T00:00:00Z",
      "1755600000000",
      "not-a-date",
      "",
    ]) {
      expect(parseDashboardDay(bad), bad).toBeNull();
    }
  });

  it("handles the array Next hands through for a repeated param", () => {
    expect(parseDashboardDay(["2026-08-21", "2026-08-22"])).toBe("2026-08-21");
    expect(parseDashboardDay([])).toBeNull();
    expect(parseDashboardDay(undefined)).toBeNull();
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(parseDashboardDay("2028-02-29")).toBe("2028-02-29");
    expect(parseDashboardDay("2026-02-29")).toBeNull();
  });

  it("the round-trip is the authority: only a date's OWN canonical rendering survives", () => {
    // Stated as a property rather than a list, because the guarantee the page
    // depends on is "whatever comes back is exactly what will be queried".
    for (const s of [
      "2026-8-20",
      "2026-08-2",
      "2026-08-020",
      " 2026- 08-20",
      "+002026-08-20",
      "2026-08-20T00:00:00Z",
      "٢٠٢٦-٠٨-٢٠",
    ]) {
      const out = parseDashboardDay(s);
      expect(out === null || out === s.trim(), s).toBe(true);
    }
  });

  it("every accepted value is safe to hand to the real date helpers", () => {
    for (const d of ["2026-08-20", "2028-02-29", "2026-12-31", "2026-01-01"]) {
      const parsed = parseDashboardDay(d)!;
      expect(() => addDays(parsed, 1)).not.toThrow();
      expect(() => utcInstantFromLocal(parsed, "00:00", TZ)).not.toThrow();
      expect(addDays(parsed, 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("resolveSelectedDay — always yields a usable day, never throws", () => {
  it("absent ⇒ actual today", () => {
    expect(resolveSelectedDay(undefined, TODAY)).toBe(TODAY);
  });

  it("valid ⇒ that day", () => {
    expect(resolveSelectedDay("2026-08-27", TODAY)).toBe("2026-08-27");
  });

  it("malformed or impossible ⇒ actual today, silently and safely", () => {
    for (const bad of ["foo", "2026-99-99", "2026-02-31", "2026-8-2", "1755600000000"]) {
      expect(resolveSelectedDay(bad, TODAY), bad).toBe(TODAY);
    }
  });

  it("beyond the horizon in either direction ⇒ actual today", () => {
    expect(resolveSelectedDay("9999-12-31", TODAY)).toBe(TODAY);
    expect(resolveSelectedDay("0001-01-01", TODAY)).toBe(TODAY);
    const justInside = addDays(TODAY, DASHBOARD_DAY_MAX_OFFSET_DAYS);
    expect(resolveSelectedDay(justInside, TODAY)).toBe(justInside);
    expect(resolveSelectedDay(addDays(TODAY, DASHBOARD_DAY_MAX_OFFSET_DAYS + 1), TODAY)).toBe(TODAY);
  });
});

describe("navigation arithmetic", () => {
  it("steps forward and back without skipping or repeating", () => {
    expect(nextDay(TODAY)).toBe("2026-08-21");
    expect(previousDay(TODAY)).toBe("2026-08-19");
    expect(previousDay(nextDay(TODAY))).toBe(TODAY);
  });

  it("crosses month, year and leap boundaries", () => {
    expect(nextDay("2026-08-31")).toBe("2026-09-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2028-02-29")).toBe("2028-03-01");
  });

  it("crosses BOTH Toronto DST transitions by calendar date, not by hours", () => {
    expect(nextDay("2026-03-07")).toBe("2026-03-08"); // spring forward
    expect(nextDay("2026-03-08")).toBe("2026-03-09");
    expect(nextDay("2026-10-31")).toBe("2026-11-01"); // fall back
    expect(nextDay("2026-11-01")).toBe("2026-11-02");
  });
});

describe("the one-day window is two local midnights, never start + 24h", () => {
  const dayLengthHours = (day: string) =>
    (utcInstantFromLocal(addDays(day, 1), "00:00", TZ).getTime() -
      utcInstantFromLocal(day, "00:00", TZ).getTime()) /
    3_600_000;

  it("an ordinary Toronto day is 24 hours", () => {
    expect(dayLengthHours("2026-06-10")).toBe(24);
  });

  it("the SPRING-FORWARD day is 23 hours — a fixed 24h window would overrun it", () => {
    expect(dayLengthHours("2026-03-08")).toBe(23);
  });

  it("the FALL-BACK day is 25 hours — a fixed 24h window would DROP a late appointment", () => {
    expect(dayLengthHours("2026-11-01")).toBe(25);
  });
});

describe("dashboardDayHref — the URL contract", () => {
  it("actual today canonicalizes to /dashboard, with no redundant day", () => {
    expect(dashboardDayHref({ day: TODAY, todayLocal: TODAY })).toBe("/dashboard");
  });

  it("another day carries the day", () => {
    expect(dashboardDayHref({ day: "2026-08-21", todayLocal: TODAY })).toBe(
      "/dashboard?day=2026-08-21",
    );
  });

  it("PRESERVES period in both directions", () => {
    expect(dashboardDayHref({ day: "2026-08-21", todayLocal: TODAY, period: "month" })).toBe(
      "/dashboard?period=month&day=2026-08-21",
    );
    // …and returning to today keeps the period rather than resetting it.
    expect(dashboardDayHref({ day: TODAY, todayLocal: TODAY, period: "month" })).toBe(
      "/dashboard?period=month",
    );
  });

  it("omits period when there is none", () => {
    expect(dashboardDayHref({ day: TODAY, todayLocal: TODAY, period: null })).toBe("/dashboard");
  });
});

describe("the horizon is ONE authority, and the CONTROLS respect it", () => {
  const { min, max } = dashboardDayBounds(TODAY);

  it("the bounds are derived from the exported constant, not a second copy", () => {
    expect(min).toBe(addDays(TODAY, -DASHBOARD_DAY_MAX_OFFSET_DAYS));
    expect(max).toBe(addDays(TODAY, DASHBOARD_DAY_MAX_OFFSET_DAYS));
  });

  it("today + 364: Next is available and targets +365", () => {
    const day = addDays(TODAY, DASHBOARD_DAY_MAX_OFFSET_DAYS - 1);
    expect(canNavigateNext(day, TODAY)).toBe(true);
    expect(nextDay(day)).toBe(max);
    expect(resolveSelectedDay(nextDay(day), TODAY)).toBe(max);
  });

  it("today + 365 (the MAX): Next is refused; Previous and Today still work", () => {
    expect(canNavigateNext(max, TODAY)).toBe(false);
    expect(canNavigatePrevious(max, TODAY)).toBe(true);
    expect(resolveSelectedDay(previousDay(max), TODAY)).toBe(previousDay(max));
    expect(dashboardDayHref({ day: TODAY, todayLocal: TODAY })).toBe("/dashboard");
  });

  it("today - 364: Previous is available and targets -365", () => {
    const day = addDays(TODAY, -(DASHBOARD_DAY_MAX_OFFSET_DAYS - 1));
    expect(canNavigatePrevious(day, TODAY)).toBe(true);
    expect(previousDay(day)).toBe(min);
    expect(resolveSelectedDay(previousDay(day), TODAY)).toBe(min);
  });

  it("today - 365 (the MIN): Previous is refused; Next and Today still work", () => {
    expect(canNavigatePrevious(min, TODAY)).toBe(false);
    expect(canNavigateNext(min, TODAY)).toBe(true);
    expect(resolveSelectedDay(nextDay(min), TODAY)).toBe(nextDay(min));
  });

  it("NO offered control ever produces a day the resolver rejects", () => {
    // The property, stated directly: walk the edges, both directions. A link
    // to a rejected day does not error — it silently lands on today, which
    // from a button reads as a year-long jump with no explanation.
    for (const day of [min, addDays(min, 1), addDays(max, -1), max, TODAY]) {
      if (canNavigateNext(day, TODAY)) {
        const target = nextDay(day);
        expect(resolveSelectedDay(target, TODAY), `next from ${day}`).toBe(target);
      }
      if (canNavigatePrevious(day, TODAY)) {
        const target = previousDay(day);
        expect(resolveSelectedDay(target, TODAY), `prev from ${day}`).toBe(target);
      }
    }
  });
});

describe("copy is truthful for the day on screen", () => {
  it("headings", () => {
    expect(dayHeading(TODAY, TODAY)).toBe("Today");
    expect(dayHeading("2026-08-21", TODAY)).toBe("Tomorrow");
    expect(dayHeading("2026-08-27", TODAY)).toBe("Thursday, August 27");
  });

  it("the empty sentence never says 'today' about another day", () => {
    expect(emptyDayMessage(TODAY, TODAY)).toBe("No appointments today.");
    expect(emptyDayMessage("2026-08-21", TODAY)).toBe("No appointments tomorrow.");
    expect(emptyDayMessage("2026-08-27", TODAY)).toBe("No appointments on Thursday, August 27.");
  });

  it("the today branch is the EXACT pre-existing literal", () => {
    expect(emptyDayMessage(TODAY, TODAY)).toBe("No appointments today.");
  });

  it("the label is rendered from the bare date, so it cannot shift a day", () => {
    expect(formatSelectedDayLabel("2026-08-20")).toBe("Thursday, August 20");
    expect(formatSelectedDayLabel("2026-01-01")).toBe("Thursday, January 1");
  });
});

describe("isViewingToday", () => {
  it("is true only on the real present day", () => {
    expect(isViewingToday(TODAY, TODAY)).toBe(true);
    expect(isViewingToday(nextDay(TODAY), TODAY)).toBe(false);
    expect(isViewingToday(previousDay(TODAY), TODAY)).toBe(false);
  });
});

describe("leaving for the Calendar keeps the day you were looking at", () => {
  // The defect: both Dashboard exits to the Calendar targeted bare
  // `/calendar`. The Calendar anchors its week from `?day=` and falls back to
  // today's week without it, and the mobile day view opens on today — so
  // stepping to a date and pressing the obvious "book" button landed
  // somewhere else entirely.

  it("1. on actual today the URL stays canonical — no redundant day", () => {
    expect(
      calendarHrefForDashboardDay({ selectedDay: TODAY, todayLocal: TODAY }),
    ).toBe("/calendar");
  });

  it("2. tomorrow carries the day", () => {
    expect(
      calendarHrefForDashboardDay({ selectedDay: "2026-08-21", todayLocal: TODAY }),
    ).toBe("/calendar?day=2026-08-21");
  });

  it("3. a distant day carries that EXACT canonical date", () => {
    for (const day of ["2026-12-15", "2027-01-01", "2028-02-29", "2025-11-02"]) {
      expect(
        calendarHrefForDashboardDay({ selectedDay: day, todayLocal: TODAY }),
        day,
      ).toBe(`/calendar?day=${day}`);
    }
  });

  it("4. Dashboard-only `period` is NOT forwarded", () => {
    // The Calendar owns no such parameter for this workflow; carrying it would
    // be noise. The helper takes no period at all, so it cannot leak.
    const href = calendarHrefForDashboardDay({
      selectedDay: "2026-08-21",
      todayLocal: TODAY,
    });
    expect(href).not.toMatch(/period/);
    expect(href).toBe("/calendar?day=2026-08-21");
  });

  it("5. RAW browser input is never forwarded — only the resolved day is", () => {
    // The load-bearing guarantee. A hand-typed `?day=2026-02-31` resolves to
    // actual today on the Dashboard, so the Calendar link is plain
    // `/calendar` and the malformed text never leaves the page. The Calendar's
    // own `?day=` parsing is deliberately not this PR's validation authority.
    for (const hostile of [
      "2026-02-31",
      "2026-8-2",
      "not-a-date",
      "9999-12-31",
      "<script>",
      "2026-08-21' or '1'='1",
    ]) {
      const resolved = resolveSelectedDay(hostile, TODAY);
      const href = calendarHrefForDashboardDay({
        selectedDay: resolved,
        todayLocal: TODAY,
      });
      expect(href, hostile).toBe("/calendar");
      expect(href, hostile).not.toContain(hostile);
    }
  });

  it("anything it DOES emit is a day the resolver would accept back", () => {
    // Round-trip: the Calendar can only ever be handed a canonical date.
    for (const offset of [-365, -40, -1, 1, 7, 40, 365]) {
      const day = addDays(TODAY, offset);
      const href = calendarHrefForDashboardDay({ selectedDay: day, todayLocal: TODAY });
      const emitted = new URL(href, "https://x.test").searchParams.get("day")!;
      expect(emitted).toBe(day);
      expect(resolveSelectedDay(emitted, TODAY)).toBe(day);
    }
  });
});
