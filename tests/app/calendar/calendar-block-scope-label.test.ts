import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DayColumn } from "@/app/(app)/calendar/DayColumn";
import { MobileDayTimeline } from "@/app/(app)/calendar/MobileDayTimeline";
import { AppointmentOverlapChooser } from "@/app/(app)/calendar/AppointmentOverlapChooser";
import { TimedBlockEditDrawer } from "@/app/(app)/calendar/TimedBlockEditDrawer";
import { groupMonthBlockedByDate } from "@/app/(app)/calendar/month-blocked";
import {
  ALL_PRACTITIONERS_LABEL,
  blockScopeNamesFor,
  calendarBlockScopeLabel,
} from "@/lib/calendar/block-scope";
import { scopeLabel } from "@/lib/booking/scoped-unavailability";
import { buildTeamDay } from "@/lib/calendar/team-day";
import type { RecurringBreakOccurrenceWithRule } from "@/lib/booking/queries";
import type { StudioTimedBlock } from "@/lib/types/database";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));

// BLOCK-SCOPE F3: under practitioner capacity every calendar block says whom it
// closes time for. Studio-wide (practitioner_id NULL) reads "All practitioners";
// a scoped one reads "Only <name>". Capacity off (one studio timeline) shows no
// scope label. Display only. Synthetic data.

const TZ = "America/Los_Angeles";
const DATE = "2031-05-12"; // PDT (UTC-7)
const NAMES = { "p-ana": "Synthetic Ana", "p-bo": "Synthetic Bo" };

function block(id: string, practitionerId: string | null, startUtc: string, endUtc: string, category = "lunch"): StudioTimedBlock {
  return {
    id, studio_id: "s", starts_at: startUtc, ends_at: endUtc, category: category as StudioTimedBlock["category"],
    private_note: null, created_by: null, created_at: startUtc, updated_at: startUtc, practitioner_id: practitionerId,
  };
}
function brk(id: string, practitionerId: string | null, startUtc: string, endUtc: string, label: string): RecurringBreakOccurrenceWithRule {
  return {
    id, rule_id: "r", studio_id: "s", occurrence_date: DATE, starts_at: startUtc, ends_at: endUtc,
    created_at: startUtc, practitioner_id: practitionerId, rule: { label },
  };
}
// 12:00-13:00 and 15:00-15:30 local.
const WIDE = block("b-wide", null, "2031-05-12T19:00:00Z", "2031-05-12T20:00:00Z");
const BO_ONLY = block("b-bo", "p-bo", "2031-05-12T17:00:00Z", "2031-05-12T18:00:00Z", "admin");
const FORMER = block("b-former", "p-gone", "2031-05-12T23:00:00Z", "2031-05-13T00:00:00Z", "meeting");
const STERILIZATION = brk("r-ana", "p-ana", "2031-05-12T22:00:00Z", "2031-05-12T22:30:00Z", "Sterilization");

function weekColumn(blockScopeNames?: Record<string, string>) {
  return renderToStaticMarkup(createElement(DayColumn, {
    date: DATE, appts: [], timedBlocks: [WIDE, BO_ONLY, FORMER], recurringBreaks: [STERILIZATION],
    blocked: false, tz: TZ, timeFormat: "12h", isOwner: true, practitionerCapacityEnabled: !!blockScopeNames,
    currentPractitionerId: "p-ana", currentPractitionerName: "Synthetic Ana", clients: [], services: [],
    isToday: false, availability: null, closedDay: false, blockScopeNames,
  } as unknown as Parameters<typeof DayColumn>[0]));
}
const scopes = (html: string) => [...html.matchAll(/data-block-scope=""[^>]*>(?:<!-- -->)? · (?:<!-- -->)?([^<]+)</g)].map((m) => m[1]);

describe("calendarBlockScopeLabel", () => {
  it("names studio-wide, scoped and former-practitioner blocks", () => {
    expect(calendarBlockScopeLabel(null, NAMES)).toBe(ALL_PRACTITIONERS_LABEL);
    expect(calendarBlockScopeLabel(undefined, NAMES)).toBe("All practitioners");
    expect(calendarBlockScopeLabel("p-bo", NAMES)).toBe("Only Synthetic Bo");
    expect(calendarBlockScopeLabel("p-gone", NAMES)).toBe("A former practitioner");
  });

  it("uses the same words as the Settings scope label", () => {
    const directory = { byId: new Map([["p-bo", { id: "p-bo", display_name: "Synthetic Bo", active: true }]]) } as unknown as Parameters<typeof scopeLabel>[1];
    for (const id of [null, "p-bo", "p-gone"]) {
      expect(calendarBlockScopeLabel(id, { "p-bo": "Synthetic Bo" })).toBe(scopeLabel(id, directory));
    }
  });

  it("gives names only under practitioner capacity", () => {
    const roster = [{ id: "p-ana", display_name: "Synthetic Ana" }, { id: "p-bo", display_name: " " }];
    expect(blockScopeNamesFor(false, roster)).toBeUndefined();
    expect(blockScopeNamesFor(true, roster)).toEqual({ "p-ana": "Synthetic Ana", "p-bo": "Practitioner" });
  });
});

describe("week column", () => {
  it("labels each block and break with its scope under capacity", () => {
    const html = weekColumn(NAMES);
    expect(scopes(html).sort()).toEqual(["A former practitioner", "All practitioners", "Only Synthetic Ana", "Only Synthetic Bo"]);
    expect(html).toContain('title="Lunch · All practitioners"');
    expect(html).toContain('title="Sterilization · Only Synthetic Ana"');
  });

  it("shows no scope label on a one-timeline studio", () => {
    const html = weekColumn(undefined);
    expect(html).not.toContain("data-block-scope");
    expect(html).not.toContain("All practitioners");
    expect(html).toContain('title="Lunch"');
  });
});

describe("mobile day timeline", () => {
  const render = (blockScopeNames?: Record<string, string>) => renderToStaticMarkup(createElement(MobileDayTimeline, {
    date: DATE, appts: [], timedBlocks: [WIDE, BO_ONLY], recurringBreaks: [STERILIZATION],
    availability: null, closedDay: false, isToday: false, tz: TZ, timeFormat: "12h", returnTo: "",
    showPractitioner: !!blockScopeNames, blockScopeNames, onBookAt: () => {}, onEditBlock: () => {},
  }));
  it("labels scope under capacity and not otherwise", () => {
    expect(scopes(render(NAMES)).sort()).toEqual(["All practitioners", "Only Synthetic Ana", "Only Synthetic Bo"]);
    expect(render(undefined)).not.toContain("data-block-scope");
  });
});

describe("chooser and block drawer", () => {
  it("the overlap chooser names each block's scope", () => {
    const html = renderToStaticMarkup(createElement(AppointmentOverlapChooser, {
      appointments: [], timedBlocks: [WIDE, BO_ONLY], onSelectBlock: () => {},
      tz: TZ, timeFormat: "12h", returnTo: "", onClose: () => {}, blockScopeNames: NAMES,
    }));
    expect(html).toContain(">All practitioners<");
    expect(html).toContain(">Only Synthetic Bo<");
  });

  it("the block drawer says whom the block closes time for", () => {
    const html = (b: StudioTimedBlock, names?: Record<string, string>) => renderToStaticMarkup(createElement(TimedBlockEditDrawer, {
      block: b, isOwner: false, studioTimezone: TZ, timeFormat: "12h", onClose: () => {}, blockScopeNames: names,
    }));
    expect(html(WIDE, NAMES)).toMatch(/data-block-scope="">All practitioners</);
    expect(html(BO_ONLY, NAMES)).toMatch(/data-block-scope="">Only Synthetic Bo</);
    expect(html(WIDE)).not.toContain("data-block-scope");
  });
});

describe("month grid", () => {
  it("carries the scope in each day label under capacity only", () => {
    const withScope = groupMonthBlockedByDate([], [WIDE, BO_ONLY], [STERILIZATION], TZ, () => false, NAMES);
    expect(withScope.get(DATE)?.labels).toEqual(["Lunch · All practitioners", "Admin · Only Synthetic Bo", "Sterilization · Only Synthetic Ana"]);
    const bare = groupMonthBlockedByDate([], [WIDE, BO_ONLY], [STERILIZATION], TZ, () => false);
    expect(bare.get(DATE)?.labels).toEqual(["Lunch", "Admin", "Sterilization"]);
  });
});

describe("team day view columns", () => {
  it("a studio-wide block greys every column, labelled All practitioners; a scoped one only its own", () => {
    const day = buildTeamDay({
      date: DATE, dayOfWeek: 1, tz: TZ,
      practitioners: [{ id: "p-ana", display_name: "Synthetic Ana", color: "teal" }, { id: "p-bo", display_name: "Synthetic Bo", color: "amber" }],
      appointments: [], timedBlocks: [WIDE, BO_ONLY], recurringBreaks: [STERILIZATION], overrides: [],
      // Studio open Monday, so neither column is a closed day (a closed day hides its breaks).
      defaults: [{ id: "d", studio_id: "s", day_of_week: 1, is_open: true, open_time: "06:00:00", close_time: "22:00:00", practitioner_id: null }] as unknown as Parameters<typeof buildTeamDay>[0]["defaults"],
    });
    const render = (id: string) => {
      const c = day.columns.find((x) => x.practitionerId === id)!;
      return renderToStaticMarkup(createElement(DayColumn, {
        date: DATE, appts: c.appts, timedBlocks: c.timedBlocks, recurringBreaks: c.recurringBreaks,
        blocked: false, tz: TZ, timeFormat: "12h", isOwner: true, practitionerCapacityEnabled: true,
        currentPractitionerId: "p-ana", currentPractitionerName: "Synthetic Ana", clients: [], services: [],
        isToday: false, availability: c.availability, closedDay: c.closedDay, blockScopeNames: NAMES,
        teamColumn: { practitionerId: id, name: c.name, allowCreate: true },
      } as unknown as Parameters<typeof DayColumn>[0]));
    };
    expect(scopes(render("p-ana")).sort()).toEqual(["All practitioners", "Only Synthetic Ana"]);
    expect(scopes(render("p-bo")).sort()).toEqual(["All practitioners", "Only Synthetic Bo"]);
  });
});
