import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalendarMiniMonth } from "@/app/(app)/calendar/CalendarMiniMonth";

// HON-48 sidebar: the DOM hooks Team's browser spec builds on, the persistence wiring, the empty
// state and the view-only guarantee, pinned from source (there is no DOM test environment).

const SIDEBAR = readFileSync("app/(app)/calendar/CalendarSidebar.tsx", "utf8");
const PAGE = readFileSync("app/(app)/calendar/page.tsx", "utf8");
const MONTH = readFileSync("app/(app)/calendar/MonthView.tsx", "utf8");
const LAYOUT = readFileSync("app/(app)/layout.tsx", "utf8");
const APPMAIN = readFileSync("app/(app)/AppMain.tsx", "utf8");

describe("DOM hooks", () => {
  it("sidebar, toggle, a checkbox per practitioner, the list, and the empty-selection message", () => {
    for (const id of [
      "calendar-sidebar",
      "calendar-sidebar-toggle",
      "calendar-sidebar-practitioners",
      "calendar-sidebar-practitioner",
      "calendar-sidebar-checkbox",
      "calendar-sidebar-backdrop",
    ]) {
      expect(SIDEBAR, id).toContain(`data-testid="${id}"`);
    }
    expect(SIDEBAR).toContain("data-practitioner-id={p.id}");
    expect(SIDEBAR).toMatch(/aria-expanded=\{expanded\}/);
    expect(PAGE).toContain('data-testid="calendar-empty-selection"');
    expect(PAGE).toContain("EMPTY_SELECTION_MESSAGE");
  });

  it("the empty message is shown by all three views when nothing is selected", () => {
    expect([...PAGE.matchAll(/<EmptySelection \/>/g)].length).toBe(3);
    expect([...PAGE.matchAll(/sidebar\.selection\.mode === "none"/g)].length).toBe(3);
  });

  it("every view is wrapped in the sidebar with its own view name and anchor date", () => {
    expect([...PAGE.matchAll(/<CalendarSidebar\b/g)].length).toBe(3);
    for (const v of ['view="week"', 'view="month"', 'view="day"']) expect(PAGE).toContain(v);
    expect(PAGE).toContain("anchorDate={initialSelectedDate}");
    expect(PAGE).toContain("anchorDate={monthAnchor}");
    expect(PAGE).toContain("anchorDate={date}");
  });

  it("the toggle collapses on desktop (remembered) and opens a modal drawer on mobile", () => {
    expect(SIDEBAR).toContain("SIDEBAR_STORAGE_KEY");
    expect(SIDEBAR).toContain('role={drawerOpen && !isDesktop ? "dialog" : undefined}');
    expect(SIDEBAR).toContain("md:hidden"); // collapsed hands the space back on md+
    expect(SIDEBAR).toContain('e.key === "Escape"');
  });
});

describe("persistence and the URL", () => {
  it("a checkbox writes the URL param and the local preference, with no server call", () => {
    expect(SIDEBAR).toContain("writeStoredSelection(");
    expect(SIDEBAR).toContain("router.replace(");
    expect(SIDEBAR).not.toMatch(/fetch\(|\.rpc\(|from "@\/lib\/supabase|"use server"|actions"/);
  });
  it("a link with no param restores the viewer's own last selection, once", () => {
    expect(SIDEBAR).toContain("restoreParam(readStoredSelection(");
    expect(SIDEBAR).toContain("restored.current");
  });
  it("every toolbar link in all three views carries the selection", () => {
    // None of the 17 toolbar hrefs (6 per view, the week view's day link included) is a bare string.
    expect(PAGE).not.toMatch(/(?:weekHref|monthHref|prevHref|todayHref|nextHref)=\{?["`]/);
    expect(PAGE).not.toMatch(/dayHref=\{`/);
    expect([...PAGE.matchAll(/(?:weekHref|monthHref|dayHref|prevHref|todayHref|nextHref)=\{\s*(?:hasDayView|withSelection)/g)].length).toBeGreaterThanOrEqual(17);
  });
  it("the month day links carry it too", () => {
    expect(MONTH).toMatch(/withSelection\(\s*`\/calendar\?view=week/);
    expect(PAGE).toContain("selectionParam={sidebar.param}");
  });
});

describe("what is shown for each selection", () => {
  it("Week, Month and Day draw only the filtered appointments", () => {
    expect(PAGE).toContain("for (const a of visibleAppointments)");
    expect(PAGE).toContain("groupMonthAppointmentsByDate(\n    visibleAppointments,");
    expect(PAGE).toContain("practitioners: shownPractitioners");
    expect(PAGE).toContain("appointments: shownAppointments");
  });
  it("blockouts, timed blocks and breaks are not filtered by the selection", () => {
    expect(PAGE).not.toMatch(/filterBySelection\((?:blockouts|timedBlocks|recurringOccurrences)/);
  });
  it("month chips name their practitioner in the title and the accessible text, with a swatch", () => {
    expect(MONTH).toContain("a.practitioner?.name");
    expect(MONTH).toContain('className="sr-only"');
    expect(MONTH).toContain('data-testid="month-chip-swatch"');
  });
});

describe("full width", () => {
  it("the app shell main uses AppMain, which is full width for the calendar grid only", () => {
    expect(LAYOUT).toContain("<AppMain>{children}</AppMain>");
    expect(LAYOUT).not.toContain('<main className="mx-auto max-w-5xl');
    expect(APPMAIN).toContain("calendarUsesFullWidth(usePathname())");
    expect(APPMAIN).toContain("APP_MAIN_FULL");
    expect(APPMAIN).toContain("APP_MAIN_NORMAL");
  });
});

describe("the mini calendar", () => {
  const html = (view: "day" | "week" | "month", selectionParam?: string) =>
    renderToStaticMarkup(createElement(CalendarMiniMonth, { anchorDate: "2026-11-08", today: "2026-10-31", view, selectionParam }));
  it("shows the month of the anchor date with 42 day links, the anchor marked and today distinguishable", () => {
    const h = html("day");
    expect(h).toContain('data-testid="calendar-mini-month"');
    expect(h).toContain("November 2026");
    expect([...h.matchAll(/data-testid="calendar-mini-day"/g)].length).toBe(42);
    expect(h).toMatch(/data-date="2026-11-08"[^>]*aria-current="date"|aria-current="date"[^>]*data-date="2026-11-08"/);
    expect(h).toContain('data-testid="calendar-mini-prev"');
    expect(h).toContain('data-testid="calendar-mini-next"');
  });
  it("a date navigates the current view to it and keeps the selection", () => {
    expect(html("day", "p1,p2")).toContain('href="/calendar?view=day&amp;day=2026-11-18&amp;people=p1%2Cp2"');
    expect(html("week")).toContain('href="/calendar?view=week&amp;day=2026-11-18"');
    expect(html("month", "none")).toContain('href="/calendar?view=month&amp;month=2026-11-01&amp;people=none"');
  });
});
