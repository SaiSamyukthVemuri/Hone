import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { profileNameLines } from "@/lib/clients/profile-name";
import { clientAvatarInitials } from "@/lib/clients/profile-avatar";

describe("profileNameLines: one display identity for the profile (HON-58, Privacy C2)", () => {
  it("a preferred name is the display name; the stored name appears once as Name on file", () => {
    const n = profileNameLines({ name: "Margaret Ann Doe", preferred_name: "Maggie" });
    expect(n.display).toBe("Maggie");
    expect(n.nameOnFile).toBe("Margaret Ann Doe");
    expect(clientAvatarInitials(n.display)).toBe("M");
  });
  it("no preferred name: the stored name, no Name on file line", () => {
    expect(profileNameLines({ name: "Jo Park", preferred_name: null })).toEqual({ display: "Jo Park", nameOnFile: null });
    expect(profileNameLines({ name: "Jo Park", preferred_name: "  " })).toEqual({ display: "Jo Park", nameOnFile: null });
    expect(profileNameLines({ name: "Jo Park" })).toEqual({ display: "Jo Park", nameOnFile: null });
  });
  it("a preferred name equal to the stored name shows no duplicate line", () => {
    expect(profileNameLines({ name: "Jo Park", preferred_name: "Jo Park" }).nameOnFile).toBeNull();
  });
  it("never reads a legal name", () => {
    const n = profileNameLines({ name: "Jo Park", preferred_name: "Joey", legal_given_name: "Josephine" });
    expect(JSON.stringify(n)).not.toContain("Josephine");
  });
});

describe("the profile page uses the display identity everywhere, never the stored name", () => {
  const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  it("heading, initials and every clientName prop come from the display name", () => {
    expect(page).toMatch(/profileNameLines\(client\)/);
    expect(page).toMatch(/clientAvatarInitials\(clientDisplay\)/);
    expect(page).not.toMatch(/clientName=\{client\.name\}/);
    expect(page).not.toMatch(/clientAvatarInitials\(client\.name\)/);
    expect(page).not.toMatch(/\{client\.name\}/);
    expect((page.match(/clientName=\{clientDisplay\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("the stored name is shown only as a labelled Name on file line", () => {
    expect(page).toMatch(/Name on file: \{nameOnFile\}/);
  });
});
