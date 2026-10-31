import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DayColumn } from "@/app/(app)/calendar/DayColumn";
import { CalendarViewToggle } from "@/app/(app)/calendar/ViewToggle";
import { NO_SHOW_CARD_CLASS } from "@/app/(app)/calendar/appointment-display-status";
import { buildCalendarReturnParams } from "@/app/(app)/calendar/calendar-return";
import type { AppointmentWithPractitionerColor } from "@/lib/booking/queries";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/calendar",
  useSearchParams: () => new URLSearchParams(),
}));

// HON-48 team day view: one DayColumn per practitioner. Synthetic data only.

const TZ = "America/Los_Angeles";
const NOW = "2030-03-02T20:00:00Z";
const ROOT = path.resolve(__dirname, "../../..");
const PAGE = readFileSync(path.join(ROOT, "app/(app)/calendar/page.tsx"), "utf8");
const DAYCOL = readFileSync(path.join(ROOT, "app/(app)/calendar/DayColumn.tsx"), "utf8");
const DRAWER = readFileSync(path.join(ROOT, "app/(app)/calendar/QuickBookDrawer.tsx"), "utf8");

function appt(id: string, status: string) {
  return {
    id, practitioner_id: "p-bo", starts_at: "2030-03-01T18:00:00Z", ends_at: "2030-03-01T19:00:00Z",
    duration_minutes: 60, status,
    client: { id: `c-${id}`, name: `Synthetic client ${id}` }, service: null,
    practitioner: { id: "p-bo", color: "amber", display_name: "Synthetic Bo" },
  } as unknown as AppointmentWithPractitionerColor;
}

function column(teamColumn?: { practitionerId: string | null; name: string; allowCreate: boolean }, appts = [appt("one", "no_show")]) {
  return renderToStaticMarkup(createElement(DayColumn, {
    date: "2030-03-01", appts, timedBlocks: [], recurringBreaks: [],
    blocked: false, tz: TZ, timeFormat: "12h", isOwner: true,
    practitionerCapacityEnabled: true, currentPractitionerId: "p-owner",
    currentPractitionerName: "Synthetic Owner", clients: [], services: [],
    isToday: false, availability: null, closedDay: false, teamColumn,
  } as unknown as Parameters<typeof DayColumn>[0]));
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); });

describe("team day column", () => {
  it("names the practitioner on its create controls", () => {
    const html = column({ practitionerId: "p-bo", name: "Synthetic Bo", allowCreate: true });
    expect(html).toContain('aria-label="Open quick-book draft for Synthetic Bo on 2030-03-01"');
    expect(html).toContain('aria-label="Book Synthetic Bo on 2030-03-01"');
  });

  it("renders no create control when the viewer may not book this practitioner", () => {
    const html = column({ practitionerId: "p-bo", name: "Synthetic Bo", allowCreate: false });
    expect(html).not.toContain("Open quick-book draft");
    expect(html).not.toContain("Book Synthetic Bo");
    // The appointment itself still renders and opens its preview.
    expect(html).toContain("Synthetic client one");
  });

  it("keeps the no-show cue from #1082/#1088", () => {
    const html = column({ practitionerId: "p-bo", name: "Synthetic Bo", allowCreate: true });
    expect(html).toContain(NO_SHOW_CARD_CLASS);
    expect(html).toContain("No-show");
  });

  it("the week column is unchanged without a team column", () => {
    const html = column(undefined);
    expect(html).toContain('aria-label="Open quick-book draft for 2030-03-01"');
    expect(html).toContain('aria-label="Book on 2030-03-01"');
  });

  it("drops the in-card practitioner tag only in a team column, and drags book directly there", () => {
    expect(DAYCOL).toMatch(/practitionerCapacityEnabled && !teamColumn\s*\?/);
    const drag = DAYCOL.slice(DAYCOL.indexOf("const openDraftFromDrag"), DAYCOL.indexOf("function handlePointerDown"));
    expect(drag.indexOf("if (teamColumn)")).toBeGreaterThan(-1);
    expect(drag.indexOf("if (teamColumn)")).toBeLessThan(drag.indexOf("setChooserDraft("));
    expect(DAYCOL).toContain("preferredPractitionerId={teamColumn?.practitionerId ?? undefined}");
  });

  it("the drawer starts on the column practitioner only when the owner selector is shown", () => {
    expect(DRAWER).toContain("const initialTarget = (showSelector && preferredPractitionerId) || currentPractitionerId;");
    expect(DRAWER).toContain("useState<string>(initialTarget)");
  });
});

describe("Day tab", () => {
  const toggle = (dayHref?: string, currentView: "day" | "week" | "month" = "week") =>
    renderToStaticMarkup(createElement(CalendarViewToggle, {
      currentView, weekHref: "/calendar?view=week", monthHref: "/calendar?view=month", dayHref,
    }));

  it("is absent for a studio that is not a team calendar", () => {
    const html = toggle(undefined);
    expect(html).not.toContain('data-testid="calendar-view-day"');
    expect(html).toContain('data-testid="calendar-view-week"');
  });

  it("is present, first and current on the team day view", () => {
    const html = toggle("/calendar?view=day&day=2030-03-01", "day");
    expect(html.indexOf('data-testid="calendar-view-day"')).toBeLessThan(html.indexOf('data-testid="calendar-view-week"'));
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="calendar-view-day"|data-testid="calendar-view-day"[^>]*aria-current="page"/);
  });
});

describe("team day page path", () => {
  const day = PAGE.slice(PAGE.indexOf("async function renderTeamDayView"));

  it("is offered to any studio with an active practitioner; only OPENING on it stays a team rule", () => {
    // The one rule moved to initial-view.ts with HON-48's default view, so the
    // page and the Day view's own guard share it.
    expect(readFileSync(path.join(ROOT, "app/(app)/calendar/initial-view.ts"), "utf8")).toContain(
      "return capacityEnabled && activePractitioners.length > 1;",
    );
    expect(PAGE).toContain("isTeamCalendar");
    expect(PAGE).not.toMatch(/studio\.id\s*===/);
    expect(day).toContain("if (!hasDayView(capacityEnabled, activePractitioners))");
    // The week and month renderers load the active list for EVERY studio, so a solo capacity-off
    // studio is offered the Day tab; the availability input stays capacity-gated as before.
    expect(PAGE).not.toMatch(/practitioner_capacity_enabled === true \? getPractitionersForStudio/);
    expect((PAGE.match(/hasDayView\(studio\.practitioner_capacity_enabled === true, activePractitioners\)/g) ?? []).length).toBe(2);
    expect(day).not.toContain("if (!capacityEnabled) redirect");
    // The real capacity flag reaches the column and the block scope names, never a hard-coded true.
    expect(day).toContain("practitionerCapacityEnabled={capacityEnabled}");
    expect(day).toContain("blockScopeNamesFor(capacityEnabled, activePractitioners)");
    // Hours follow the same flag: capacity OFF reads studio-wide rows only, as the slot engine does.
    expect(day).toMatch(/buildTeamDay\(\{[\s\S]*?capacityEnabled,\s*\}\);/);
  });

  it("reads through the week view's own studio-scoped loaders, nothing new", () => {
    for (const loader of [
      "getAppointmentsForRange(studio.id,",
      "getTimedBlocksForRange(studio.id,",
      "getRecurringBreakOccurrencesForRange(",
      "getAvailabilityDefaults(studio.id)",
      "getOverridesForRange(studio.id, date, date)",
      "getPractitionersForStudio(studio.id)",
    ]) expect(day).toContain(loader);
    expect(day).not.toContain("createClient");
    expect(day).not.toContain("createAdminClient");
  });

  it("a member may book only their own column; owners any active one", () => {
    // The rule lives in teamColumnAllowsCreate (capacity on: own column or owner; capacity off: any
    // active column, as the week grid allows); its cases are in capacity-off-scoped-sources.test.ts.
    expect(day).toContain("allowCreate: teamColumnAllowsCreate({");
    expect(day).toContain("viewerPractitionerId: practitioner.id");
  });

  it("returns appointment details to the same day", () => {
    expect(day).toContain('buildCalendarReturnParams({ view: "day", day: date })');
    expect(buildCalendarReturnParams({ view: "day", day: "2030-03-01" })).toBe("?view=day&day=2030-03-01");
    expect(buildCalendarReturnParams({ view: "day", day: "2030-03-01;evil" })).toBe("?view=day");
  });
});
