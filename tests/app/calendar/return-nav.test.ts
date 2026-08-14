import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCalendarReturnParams,
  calendarReturnHref,
} from "@/app/(app)/calendar/calendar-return";

// Calendar return-to-date navigation (Chloe pilot feedback). When a
// practitioner opens an appointment from the calendar and returns, the back
// link must restore the view/date they came from, without ever becoming an
// external/open-redirect URL.

describe("buildCalendarReturnParams", () => {
  it("preserves the week view + week anchor", () => {
    expect(buildCalendarReturnParams({ view: "week", week: "2026-07-06" })).toBe(
      "?view=week&week=2026-07-06",
    );
  });

  it("preserves the month view + month anchor", () => {
    expect(buildCalendarReturnParams({ view: "month", month: "2026-07-01" })).toBe(
      "?view=month&month=2026-07-01",
    );
  });

  it("returns an empty string when there is no valid context (→ /calendar fallback)", () => {
    expect(buildCalendarReturnParams({})).toBe("");
    expect(buildCalendarReturnParams({ view: undefined, week: undefined })).toBe("");
  });

  it("drops an unknown view and malformed date anchors", () => {
    expect(buildCalendarReturnParams({ view: "evil", week: "not-a-date" })).toBe("");
    expect(
      buildCalendarReturnParams({ view: "week", week: "2026-07-06; DROP" }),
    ).toBe("?view=week");
  });

  it("normalizes array-valued params to the first entry", () => {
    expect(
      buildCalendarReturnParams({ view: ["week"], week: ["2026-07-06"] }),
    ).toBe("?view=week&week=2026-07-06");
  });
});

describe("calendarReturnHref", () => {
  it("builds an internal /calendar href from valid context", () => {
    expect(calendarReturnHref({ view: "week", week: "2026-07-06" })).toBe(
      "/calendar?view=week&week=2026-07-06",
    );
  });

  it("falls back to bare /calendar when context is missing", () => {
    expect(calendarReturnHref({})).toBe("/calendar");
  });

  it("NEVER produces an external/absolute URL, even from hostile input", () => {
    for (const hostile of [
      { view: "https://evil.com" },
      { view: "//evil.com" },
      { week: "https://evil.com" },
      { month: "javascript:alert(1)" },
      { view: ["//evil.com", "week"] },
      { week: "/etc/passwd" },
    ]) {
      const href = calendarReturnHref(hostile);
      expect(href.startsWith("/calendar")).toBe(true);
      expect(href).not.toMatch(/^https?:|^\/\/|evil\.com|javascript:/);
    }
  });
});

describe("calendar return-nav wiring (source pins)", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  const PAGE = read("app/(app)/calendar/page.tsx");
  const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
  const DETAIL = read("app/(app)/calendar/[id]/page.tsx");

  it("the week page computes a return context and passes it to DayColumn", () => {
    expect(PAGE).toMatch(/buildCalendarReturnParams\(\{ view: "week", week: weekStart \}\)/);
    expect(PAGE).toMatch(/returnTo=\{returnTo\}/);
  });

  it("the appointment preview carries the return context on its full-details link", () => {
    // PR C-lite: the card now opens an in-context preview (no navigation);
    // DayColumn passes returnTo into the preview, whose "Open full details" deep
    // link preserves the return context to /calendar/[id].
    expect(DAYCOL).toMatch(/<AppointmentPreviewDrawer[\s\S]*?returnTo=\{returnTo\}/);
    const PREVIEW = read("app/(app)/calendar/AppointmentPreviewDrawer.tsx");
    expect(PREVIEW).toMatch(/href=\{`\/calendar\/\$\{a\.id\}\$\{returnTo\}`\}/);
  });

  it("the detail page reads searchParams and uses a safe back href", () => {
    expect(DETAIL).toMatch(/calendarReturnHref\(await searchParams\)/);
    expect(DETAIL).toMatch(/href=\{backHref\}/);
    // The old hard-coded back link is gone.
    expect(DETAIL).not.toMatch(/href="\/calendar"/);
  });
});
