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
    renderToStaticMarkup(createElement(CalendarMiniMonth, { anchorDate: "2026-11-08", selectedDate: "2026-11-08", today: "2026-10-31", view, selectionParam }));
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

describe("mini calendar: today vs selected, Today action", () => {
  const mini = (over: { anchorDate?: string; selectedDate?: string | null; today?: string; view?: "day" | "week" | "month"; selectionParam?: string }) =>
    renderToStaticMarkup(createElement(CalendarMiniMonth, { anchorDate: "2026-11-08", selectedDate: "2026-11-08", today: "2026-10-31", view: "day", selectionParam: undefined, ...over }));
  const cell = (h: string, date: string) => h.match(new RegExp(`<a[^>]*data-date="${date}"[^>]*>`))?.[0] ?? "";
  it("selected and today are two states on different days", () => {
    const h = mini({ anchorDate: "2026-10-31", selectedDate: "2026-10-20" });
    expect(cell(h, "2026-10-20")).toContain('data-mini-selected="true"');
    expect(cell(h, "2026-10-20")).not.toContain("data-mini-today");
    expect(cell(h, "2026-10-31")).toContain('data-mini-today="true"');
    expect(cell(h, "2026-10-31")).not.toContain("data-mini-selected");
  });
  it("both can apply to one day", () => {
    const c = cell(mini({ anchorDate: "2026-10-31", selectedDate: "2026-10-31" }), "2026-10-31");
    expect(c).toContain('data-mini-today="true"');
    expect(c).toContain('data-mini-selected="true"');
    expect(c).toContain("today, selected");
  });
  it("Month has no single selected date: nothing is marked selected", () => {
    expect(mini({ view: "month", selectedDate: null })).not.toContain("data-mini-selected");
  });
  it("the Today action goes to today in the current view and keeps the selection", () => {
    const today = (view: "day" | "week" | "month", selectionParam?: string) =>
      mini({ view, selectionParam }).match(/<a[^>]*data-testid="calendar-mini-today"[^>]*>/)?.[0] ?? "";
    expect(today("day")).toContain('href="/calendar?view=day&amp;day=2026-10-31"');
    expect(today("week", "p1")).toContain('href="/calendar?view=week&amp;day=2026-10-31&amp;people=p1"');
    expect(today("month")).toContain('href="/calendar?view=month&amp;month=2026-10-01"');
  });
  it("marks come from the server's studio-timezone keys: the mini calendar never builds a Date", () => {
    const src = readFileSync("app/(app)/calendar/CalendarMiniMonth.tsx", "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/new Date\(|Date\.now|toLocale|getTimezoneOffset|Intl\./);
  });
});

describe("time insights in the sidebar", () => {
  it("the collapsible section, label and total carry hooks and the exact numbers", () => {
    for (const id of ["calendar-time-insights", "time-insights-label", "time-insights-total"]) expect(SIDEBAR, id).toContain(`data-testid="${id}"`);
    expect(SIDEBAR).toContain("data-minutes={insights.minutes}");
    expect(SIDEBAR).toContain("data-count={insights.count}");
    expect(SIDEBAR).toContain("INSIGHTS_RULE");
    expect(SIDEBAR).toMatch(/<details open/);
  });
  it("all three views compute it from the loaded appointments plus boundary crossers, and pass it on", () => {
    expect([...PAGE.matchAll(/insights=\{insights\}/g)].length).toBe(3);
    expect([...PAGE.matchAll(/getBoundaryCrossingAppointments\(studio\.id, startUtc\)/g)].length).toBe(3);
    expect(PAGE).toContain("periodLabel: monthYearLabel(monthAnchor)");
    expect(PAGE).toContain("periodLabel: weekRangeLabel(weekStart, weekEnd)");
  });
  it("the boundary read uses the view's own query function, so it cannot widen access", () => {
    const src = readFileSync("lib/calendar/boundary-appointments.ts", "utf8");
    expect(src).toContain("getAppointmentsForRange(");
    expect(src).not.toMatch(/\.from\(|createClient|service_role/);
  });
});

describe("selection and date stay in step on mobile and across navigation (Codex P2 follow-ups)", () => {
  const MOBILE_VIEW = readFileSync("app/(app)/calendar/CalendarMobileDayView.tsx", "utf8");
  const MINI = readFileSync("app/(app)/calendar/CalendarMiniMonth.tsx", "utf8");
  it("every URL the mobile day view pushes carries the practitioner selection", () => {
    const pushes = [...MOBILE_VIEW.matchAll(/router\.push\(([^;]*)\);/g)].map((m) => m[1]);
    expect(pushes.length).toBe(3); // prev past the week, next past the week, Today outside the week
    for (const p of pushes) expect(p, p).toMatch(/^withSelection\(.*selectionParam\)$/);
  });
  it("the page hands the mobile view the selection", () => {
    expect(PAGE).toMatch(/<CalendarMobileDayView[\s\S]*?selectionParam=\{sidebar\.param\}/);
  });
  it("the mobile timeline follows the server date when a mini-calendar pick changes it, and ignores strip taps", () => {
    expect(MOBILE_VIEW).toMatch(/const \[seenInitialDate, setSeenInitialDate\] = useState\(initialDate\)/);
    expect(MOBILE_VIEW).toMatch(/if \(seenInitialDate !== initialDate\) \{\s*setSeenInitialDate\(initialDate\);\s*setSelectedDate\(initialDate\);/);
    // A strip tap sets local state only and never touches the tracked server date.
    expect(MOBILE_VIEW).toMatch(/onClick=\{\(\) => setSelectedDate\(d\.date\)\}/);
  });
  it("the mini calendar follows its anchor when the page navigates, and keeps independent month browsing between navigations", () => {
    expect(MINI).toMatch(/const \[seenAnchor, setSeenAnchor\] = useState\(anchorDate\)/);
    expect(MINI).toMatch(/if \(seenAnchor !== anchorDate\) \{\s*setSeenAnchor\(anchorDate\);\s*setShown\(anchorDate\);/);
    expect(MINI).toMatch(/onClick=\{\(\) => setShown\(firstOfPreviousMonthString\(shown\)\)\}/);
  });
});

describe("Insurance Y2 and Y7 follow-ups", () => {
  const MOBILE = readFileSync("app/(app)/calendar/CalendarMobileDayView.tsx", "utf8");
  const MINI_SRC = readFileSync("app/(app)/calendar/CalendarMiniMonth.tsx", "utf8");
  const SIDEBAR = readFileSync("app/(app)/calendar/CalendarSidebar.tsx", "utf8");
  it("Y2: every mini-calendar pick is announced and the mobile view resets to a date in its week", () => {
    expect((MINI_SRC.match(/announceMiniPick\(/g) ?? []).length).toBe(2); // Today and the day cells
    expect(MOBILE).toMatch(/addEventListener\(MINI_PICK_EVENT, onPick\)/);
    expect(MOBILE).toMatch(/removeEventListener\(MINI_PICK_EVENT, onPick\)/);
    expect(MOBILE).toMatch(/days\.some\(\(d\) => d\.date === date\)\) setSelectedDate\(date\)/);
  });
  it("Y7: the drawer takes focus when it opens and returns it to the toggle when it closes", () => {
    expect(SIDEBAR).toMatch(/if \(drawerOpen\) asideRef\.current\?\.focus\(\)/);
    expect(SIDEBAR).toMatch(/else if \(drawerWasOpen\.current\) toggleRef\.current\?\.focus\(\)/);
    expect(SIDEBAR).toMatch(/ref=\{toggleRef\}/);
    expect(SIDEBAR).toMatch(/tabIndex=\{drawerOpen && !isDesktop \? -1 : undefined\}/);
  });
  it("HON-69: a mini-calendar pick never scrolls the page (every link is scroll={false})", () => {
    const links = MINI_SRC.match(/<Link\b[\s\S]*?>/g) ?? [];
    expect(links.length).toBe(2); // Today and the day cells
    for (const l of links) expect(l, l).toMatch(/scroll=\{false\}/);
  });
});
