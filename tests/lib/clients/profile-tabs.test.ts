import { describe, expect, it } from "vitest";
import { canViewClientBilling, isLegacyProfileTab, profileTabsFor, resolveProfileTab } from "@/lib/clients/profile-tabs";

const owner = { isOwner: true };
const member = { isOwner: false };

describe("legacy and current ?tab= values all resolve", () => {
  it.each([
    ["overview", "overview", undefined],
    ["sessions", "sessions", undefined],
    ["treatment", "treatment", undefined],
    ["health", "health", undefined],
    ["messages", "messages", undefined],
    ["photos", "photos", undefined],
    ["notes", "notes", undefined],
    ["personal", "notes", undefined],
    ["consultation", "treatment", undefined],
  ])("%s -> %s", (raw, tab, anchor) => {
    for (const viewer of [owner, member]) {
      expect(resolveProfileTab(raw, viewer)).toEqual({ tab, ...(anchor ? { anchor } : {}), denied: false });
    }
  });
  it("is case- and space-tolerant, and an unknown, empty or missing value is Overview", () => {
    expect(resolveProfileTab(" Sessions ", member).tab).toBe("sessions");
    for (const raw of ["", "nonsense", "__proto__", "constructor", undefined, null]) {
      expect(resolveProfileTab(raw as string | undefined, owner)).toEqual({ tab: "overview", denied: false });
    }
  });
});

describe("billing is owner-only", () => {
  it("an owner opens it", () => {
    expect(resolveProfileTab("billing", owner)).toEqual({ tab: "billing", denied: false });
  });
  it("a non-owner lands on Overview and is marked denied, so the page never runs the billing reads", () => {
    expect(resolveProfileTab("billing", member)).toEqual({ tab: "overview", denied: true });
  });
  it("the tab is not listed for a non-owner", () => {
    expect(profileTabsFor(owner).map((t) => t.value)).toEqual(["overview", "sessions", "treatment", "photos", "health", "messages", "notes", "billing"]);
    expect(profileTabsFor(member).map((t) => t.value)).toEqual(["overview", "sessions", "treatment", "photos", "health", "messages", "notes"]);
  });
  it("labels match the redesign", () => {
    expect(profileTabsFor(owner).map((t) => t.label)).toEqual(["Overview", "Sessions", "Treatment", "Photos", "Health & Forms", "Messages", "Notes", "Billing"]);
  });
  it("the gate is the role string 'owner' and nothing else", () => {
    expect(canViewClientBilling("owner")).toBe(true);
    for (const r of ["member", "practitioner", "receptionist", "", null, undefined, "OWNER"]) expect(canViewClientBilling(r as string | null)).toBe(false);
  });
});

describe("legacy values are redirected, with no anchor (nothing scrolls)", () => {
  it("only consultation and personal are legacy", () => {
    expect(isLegacyProfileTab("consultation")).toBe(true);
    expect(isLegacyProfileTab(" Personal ")).toBe(true);
    for (const v of ["overview", "treatment", "notes", "billing", "", undefined, "nope"]) {
      expect(isLegacyProfileTab(v)).toBe(false);
    }
  });
  it("the resolver never returns an anchor", () => {
    for (const raw of ["consultation", "personal", "treatment"]) {
      expect(resolveProfileTab(raw, owner)).not.toHaveProperty("anchor");
    }
  });
});
