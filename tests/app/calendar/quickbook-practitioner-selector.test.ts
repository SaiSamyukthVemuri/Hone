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
  it("shows the selector ONLY for a capacity-ON owner and loads eligible practitioners", () => {
    expect(DRAWER).toMatch(/const showSelector = practitionerCapacityEnabled && isOwner/);
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
    // The practitioner_id is appended once, before the manual/suggestion branch,
    // so both paths carry it (idx-order check: service_id set, then
    // practitioner_id, then the branch).
    const svc = DRAWER.indexOf('fd.set("service_id", serviceId)');
    const prac = DRAWER.indexOf('fd.set("practitioner_id", target)');
    const branch = DRAWER.indexOf("if (manualTimeEnabled) {", svc);
    expect(svc).toBeGreaterThan(0);
    expect(prac).toBeGreaterThan(svc);
    expect(branch).toBeGreaterThan(prac); // practitioner_id set BEFORE the manual/suggestion split
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
  it("the calendar page feeds both render paths from the server-resolved practitioner + studio", () => {
    expect((PAGE.match(/practitionerCapacityEnabled=\{studio\.practitioner_capacity_enabled === true\}/g) ?? []).length).toBe(2);
    expect((PAGE.match(/currentPractitionerId=\{practitioner\.id\}/g) ?? []).length).toBe(2);
    expect((PAGE.match(/currentPractitionerName=\{practitioner\.display_name\}/g) ?? []).length).toBe(2);
  });
});
