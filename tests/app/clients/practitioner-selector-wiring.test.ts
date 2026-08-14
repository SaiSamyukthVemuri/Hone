import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B Part 4 Item 6, practitioner-aware internal booking UI wiring (client
// profile surface). The DB authorization (owner books another, member cannot
// forge, inactive/ineligible/cross-studio rejected) is proven in the v2 command
// DB suite; these pin the UI + slot-loader contract.

const root = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const BOOK = read("app/(app)/clients/[id]/BookAppointment.tsx");
const ACTIONS = read("app/(app)/clients/[id]/booking-actions.ts");
const PAGE = read("app/(app)/clients/[id]/page.tsx");

describe("target-aware slot loader + eligible-practitioners action", () => {
  it("the slot loader accepts a practitionerId and passes the capacity flag + target to the slot engine", () => {
    expect(ACTIONS).toMatch(/practitionerId\?: string \| null/);
    expect(ACTIONS).toMatch(/practitioner_capacity_enabled: studio\.practitioner_capacity_enabled/);
    // The effective target mirrors the booking action: owner + capacity ON honours
    // the requested id; everyone else resolves to self.
    expect(ACTIONS).toMatch(/practitioner\.role === "owner" && params\.practitionerId/);
    expect(ACTIONS).toMatch(/capacityOn \? target : null/);
  });
  it("the slot loader never leaks a raw DB message", () => {
    expect(ACTIONS).not.toMatch(/error:\s*serviceErr\.message/);
    expect(ACTIONS).toMatch(/booking_slot_db_error:/);
  });
  it("the eligible-practitioners action is owner + capacity-ON only and returns display names only", () => {
    expect(ACTIONS).toMatch(/export async function fetchEligiblePractitionersAction/);
    expect(ACTIONS).toMatch(/practitioner_capacity_enabled !== true \|\| practitioner\.role !== "owner"/);
    expect(ACTIONS).toMatch(/return \{ ok: true, practitioners: \[\] \}/);
    // Reads scope to the studio; returns id + displayName (no email/metadata).
    expect(ACTIONS).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(ACTIONS).toMatch(/displayName: p\.display_name/);
    // No email/metadata is ever SELECTED for the option list.
    expect(ACTIONS).not.toMatch(/\.select\([^)]*email/);
  });

  it("1A: validates the requested target (active same-studio + service-eligible) with safe codes, no enumeration", () => {
    // Target lookup: same-studio + active.
    expect(ACTIONS).toMatch(/\.from\("practitioners"\)[\s\S]{0,160}\.eq\("active", true\)/);
    // Eligibility lookup against service_practitioners.
    expect(ACTIONS).toMatch(/\.from\("service_practitioners"\)[\s\S]{0,160}\.eq\("service_id", params\.serviceId\)/);
    // Fixed safe codes; the message never reveals whether a foreign id exists.
    expect(ACTIONS).toMatch(/code: "invalid_practitioner"/);
    expect(ACTIONS).toMatch(/code: "practitioner_not_eligible"/);
    expect(ACTIONS).toMatch(/code: "could_not_load_times"/);
    expect(ACTIONS).toMatch(/That practitioner isn't available\./);
  });
});

describe("BookAppointment: fail-closed selector + latest-request-wins (Item 6 1B/1C)", () => {
  it("1B: an eligible-lookup error clears target/slots and never falls back to self slots", () => {
    expect(BOOK).toMatch(/setEligibleError\(r\.error\)/);
    expect(BOOK).toMatch(/setTarget\(""\)/);
    // Empty eligible list → no slot request.
    expect(BOOK).toMatch(/if \(!nextTarget\) \{[\s\S]{0,220}return;/);
    // Confirmation requires the target to be in the eligible list.
    expect(BOOK).toMatch(/const targetValid = !showSelector \|\| eligible\.some\(\(p\) => p\.id === target\)/);
    expect(BOOK).toMatch(/canConfirm =\s*\n?\s*targetValid &&/);
  });
  it("1C: latest-request-wins guards on both eligible + slot requests", () => {
    expect(BOOK).toMatch(/const eligibleReq = useRef\(0\)/);
    expect(BOOK).toMatch(/const slotReq = useRef\(0\)/);
    expect(BOOK).toMatch(/if \(req !== slotReq\.current\) return/);
    expect(BOOK).toMatch(/if \(req !== eligibleReq\.current\) return/);
  });
});

describe("BookAppointment: owner selector, member self-only, confirmation", () => {
  it("shows the selector ONLY for a capacity-ON owner", () => {
    expect(BOOK).toMatch(/const showSelector = practitionerCapacityEnabled && isOwner/);
    expect(BOOK).toMatch(/\{showSelector && \(/);
    expect(BOOK).toMatch(/fetchEligiblePractitionersAction/);
  });
  it("changing the practitioner refreshes target-specific slots and clears the picked time", () => {
    expect(BOOK).toMatch(/function handleTarget/);
    // handleTarget calls loadSlots, and loadSlots clears pickedSlot.
    expect(BOOK).toMatch(/loadSlots\(serviceId, date, v\)/);
    expect(BOOK).toMatch(/setPickedSlot\(null\)/);
    // The slot fetch passes the target only when the selector is active.
    expect(BOOK).toMatch(/practitionerId: showSelector \? nextTarget : undefined/);
  });
  it("submits practitioner_id only when a capacity-ON owner has a target; members send none", () => {
    expect(BOOK).toMatch(/if \(showSelector && target\) fd\.set\("practitioner_id", target\)/);
  });
  it("documents + implements the default-target rule (preserve valid → current owner → first eligible)", () => {
    expect(BOOK).toMatch(/function resolveDefaultTarget/);
    expect(BOOK).toMatch(/if \(list\.some\(\(p\) => p\.id === current\)\) return current/);
    expect(BOOK).toMatch(/if \(list\.some\(\(p\) => p\.id === currentPractitionerId\)\) return currentPractitionerId/);
    expect(BOOK).toMatch(/return list\[0\]\?\.id \?\? ""/);
  });
  it("confirmation shows the assigned practitioner (display name)", () => {
    expect(BOOK).toMatch(/With \{assignedName\}/);
    expect(BOOK).toMatch(/assignedName = showSelector/);
  });
  it("the page threads the capacity flag + current practitioner identity", () => {
    expect(PAGE).toMatch(/practitionerCapacityEnabled=\{studio\.practitioner_capacity_enabled === true\}/);
    expect(PAGE).toMatch(/currentPractitionerId=\{practitioner\.id\}/);
    expect(PAGE).toMatch(/currentPractitionerName=\{practitioner\.display_name\}/);
  });
});
