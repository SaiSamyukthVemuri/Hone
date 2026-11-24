import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B Part 4 Item 6 — calendar Quick Book practitioner-aware booking wiring.
// The DB authorization is proven in the v2 command DB suite; these pin the
// drawer's target-aware slots + selector + the desktop/mobile threading, while
// preserving the intricate drag/override contract.

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const DRAWER = read("app/(app)/calendar/QuickBookDrawer.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const MOBILE = read("app/(app)/calendar/CalendarMobileDayView.tsx");
const PAGE = read("app/(app)/calendar/page.tsx");

describe("QuickBookDrawer — owner selector, target-aware slots, member/Legacy", () => {
  it("shows the selector ONLY for an owner (either capacity mode) and loads eligible practitioners", () => {
    expect(DRAWER).toMatch(/const showSelector = isOwner;/);
    expect(DRAWER).toMatch(/\{showSelector && \(/);
    expect(DRAWER).toMatch(/fetchEligiblePractitionersAction/);
  });
  it("the slot effect is target-aware: target in deps + practitionerId only when the selector is active", () => {
    expect(DRAWER).toMatch(/practitionerId: showSelector \? target : undefined/);
    expect(DRAWER).toMatch(/\}, \[open, draft\?\.localDate, draft\?\.localTime, serviceId, showSelector, target\]\)/);
    // Fail closed: no self-slot fetch when the selector is shown but no target.
    expect(DRAWER).toMatch(/showSelector && !target/);
  });
  it("submits practitioner_id on BOTH paths, and the failure refetch keeps the target", () => {
    expect(DRAWER).toMatch(/if \(showSelector && target\) fd\.set\("practitioner_id", target\)/);
    // The practitioner_id is appended once, before the override/normal branch, so
    // both paths carry it (idx-order check: service_id set, then practitioner_id,
    // then the override branch).
    const svc = DRAWER.indexOf('fd.set("service_id", serviceId)');
    const prac = DRAWER.indexOf('fd.set("practitioner_id", target)');
    const branch = DRAWER.indexOf("if (overrideEnabled) {", svc);
    expect(svc).toBeGreaterThan(0);
    expect(prac).toBeGreaterThan(svc);
    expect(branch).toBeGreaterThan(prac); // practitioner_id set BEFORE the override/normal split
    // The failure refetch is scoped to the current target.
    expect(DRAWER).toMatch(/practitionerId: showSelector \? target : undefined,[\s\S]{0,60}if \(refetch\.ok\)/);
  });
  it("blocks booking without a resolved eligible target and shows the assigned practitioner", () => {
    expect(DRAWER).toMatch(/const targetValid = !showSelector \|\| eligible\.some\(\(p\) => p\.id === target\)/);
    expect(DRAWER).toMatch(/canBook = !booking && !!selectedClient && !!serviceId && targetValid &&/);
    expect(DRAWER).toMatch(/With \{assignedName\}/);
    expect(DRAWER).toMatch(/if \(showSelector && !eligible\.some\(\(p\) => p\.id === target\)\) return/);
  });
  it("latest-request-wins for eligible loads (stale service response cannot overwrite)", () => {
    expect(DRAWER).toMatch(/const eligibleReq = useRef\(0\)/);
    expect(DRAWER).toMatch(/if \(req !== eligibleReq\.current\) return/);
  });
  it("uses the SAME shared actions (no parallel drawer/booking implementation)", () => {
    expect(DRAWER).toMatch(/import \{[\s\S]{0,120}fetchSlotsForClientBookingAction/);
    expect(DRAWER).toMatch(/bookAppointmentForClientAction/);
    // The default-target rule matches the client-profile surface.
    expect(DRAWER).toMatch(/function resolveDefaultTarget/);
  });
});

describe("desktop + mobile thread identical targeting context", () => {
  for (const [name, src] of [
    ["DayColumn", DAYCOL],
    ["CalendarMobileDayView", MOBILE],
  ] as const) {
    it(`${name} accepts + forwards the capacity/target props to QuickBookDrawer`, () => {
      expect(src).toMatch(/practitionerCapacityEnabled: boolean/);
      expect(src).toMatch(/currentPractitionerId: string/);
      expect(src).toMatch(/currentPractitionerName: string/);
      expect(src).toMatch(/practitionerCapacityEnabled=\{practitionerCapacityEnabled\}/);
      expect(src).toMatch(/currentPractitionerId=\{currentPractitionerId\}/);
      expect(src).toMatch(/currentPractitionerName=\{currentPractitionerName\}/);
      expect(src).toMatch(/isOwner=\{isOwner\}/);
    });
  }
  // Every component on the calendar page that is handed the acting practitioner, BY NAME and by the function that
  // renders it. A new path has to be added here on purpose, with the same server-resolved values.
  const scopes = {
    CalendarPage: PAGE.slice(PAGE.indexOf("export default async function CalendarPage"), PAGE.indexOf("async function renderMonthView")),
    renderMonthView: PAGE.slice(PAGE.indexOf("async function renderMonthView"), PAGE.indexOf("async function renderTeamDayView")),
    renderTeamDayView: PAGE.slice(PAGE.indexOf("async function renderTeamDayView"), PAGE.indexOf("function EmptySelection")),
  } as const;
  const elements = (scope: string, component: string) => scope.match(new RegExp(`<${component}\\b[\\s\\S]*?/>|<${component}\\b[^>]*>`, "g")) ?? [];
  const names = (scope: string) => [...scope.matchAll(/<(\w+)\b[^>]*?currentPractitionerId=/g)].map(m => m[1]);
  const server = {
    id: /currentPractitionerId=\{practitioner\.id\}/, name: /currentPractitionerName=\{practitioner\.display_name\}/,
    capacity: /practitionerCapacityEnabled=\{studio\.practitioner_capacity_enabled === true\}/,
  };
  it("the week hands the acting practitioner and studio capacity to the mobile day view, the week grid and the Block time button", () => {
    const week = scopes.CalendarPage;
    expect(names(week).sort()).toEqual(["CalendarBlockTime", "CalendarMobileDayView", "DayColumn"]);
    for (const component of ["CalendarMobileDayView", "DayColumn"]) {
      const [tag] = elements(week, component);
      expect(tag, component).toMatch(server.id); expect(tag, component).toMatch(server.name); expect(tag, component).toMatch(server.capacity);
    }
    const [block] = elements(week, "CalendarBlockTime");
    expect(block).toMatch(server.id); expect(block).toMatch(server.name);
    expect(block).toMatch(/studioTimezone=\{studio\.timezone\}/); expect(block).toMatch(/isOwner=\{isOwner\}/);
  });
  it("the week's Block time button exists only on the By practitioner layout, never beside a time grid whose day can change on a phone", () => {
    const week = scopes.CalendarPage;
    // The button's date is the day the page loaded on. The phone time grid changes its own day without a reload, so a button
    // beside it would block the wrong day; that grid has its own date-aware "+" (CalendarMobileDayView).
    expect(week).toMatch(/\{byPractitioner && <CalendarBlockTime\b/);
    expect(week.match(/<CalendarBlockTime\b/g)).toHaveLength(1);
    expect(MOBILE).toMatch(/localDate: chooserDraft\.localDate/);
    expect(MOBILE).toMatch(/setChooserDraft\(\{\s*localDate: day\.date/);
  });
  it("the month hands the Block time button the signed-in viewer, resolved on the server from the same practitioner", () => {
    expect(names(scopes.renderMonthView)).toEqual(["CalendarBlockTime"]);
    const [block] = elements(scopes.renderMonthView, "CalendarBlockTime");
    expect(block).toMatch(/currentPractitionerId=\{viewerId\}/);
    expect(block).toMatch(/studioTimezone=\{studio\.timezone\}/); expect(block).toMatch(/isOwner=\{isOwner\}/);
    expect(scopes.CalendarPage).toMatch(/viewerId: practitioner\.id/);
  });
  it("the team day hands the acting practitioner to the day columns and to the Block time button, with the studio's real capacity flag", () => {
    const day = scopes.renderTeamDayView;
    expect(names(day).sort()).toEqual(["CalendarBlockTime", "DayColumn"]);
    const [column] = elements(day, "DayColumn");
    expect(column).toMatch(server.id); expect(column).toMatch(server.name);
    // The Day view also serves a lone practitioner with capacity off, so the flag is the studio's REAL value, never a literal true.
    expect(column).toContain("practitionerCapacityEnabled={capacityEnabled}");
    expect(day).toContain("const capacityEnabled = studio.practitioner_capacity_enabled === true;");
    expect(day).not.toMatch(/practitionerCapacityEnabled\n/);
    const [block] = elements(day, "CalendarBlockTime");
    expect(block).toMatch(server.id); expect(block).toMatch(server.name);
    expect(block).toMatch(/studioTimezone=\{studio\.timezone\}/); expect(block).toMatch(/isOwner=\{isOwner\}/);
  });
});
