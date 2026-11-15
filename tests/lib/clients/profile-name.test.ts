import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { profileNameLines } from "@/lib/clients/profile-name";
import { clientAvatarInitials } from "@/lib/clients/profile-avatar";

describe("profileNameLines: parity with the directory (HON-58, OPS option A)", () => {
  it("a preferred name is shown ALONE: no stored name, no Name on file label", () => {
    const n = profileNameLines({ name: "Margaret Ann Doe", preferred_name: "Maggie" });
    expect(n.display).toBe("Maggie");
    expect(n.labelAsNameOnFile).toBe(false);
    expect(JSON.stringify(n)).not.toContain("Margaret");
    expect(clientAvatarInitials(n.display)).toBe("M");
  });
  it("no preferred name: the stored name is the heading, labelled Name on file", () => {
    expect(profileNameLines({ name: "Jo Park", preferred_name: null })).toEqual({ display: "Jo Park", labelAsNameOnFile: true });
    expect(profileNameLines({ name: "Jo Park", preferred_name: "  " })).toEqual({ display: "Jo Park", labelAsNameOnFile: true });
    expect(profileNameLines({ name: "Jo Park" })).toEqual({ display: "Jo Park", labelAsNameOnFile: true });
  });
  it("a preferred name equal to the stored name is still a preferred name: shown alone, no label", () => {
    expect(profileNameLines({ name: "Jo Park", preferred_name: "Jo Park" })).toEqual({ display: "Jo Park", labelAsNameOnFile: false });
  });
  it("never reads a legal name", () => {
    const n = profileNameLines({ name: "Jo Park", preferred_name: "Joey", legal_given_name: "Josephine" });
    expect(JSON.stringify(n)).not.toContain("Josephine");
  });
});

describe("the profile page uses the display identity everywhere and never prints the stored name beside a preferred one", () => {
  const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  it("heading, initials and every clientName prop come from the display name", () => {
    expect(page).toMatch(/profileNameLines\(client\)/);
    expect(page).toMatch(/clientAvatarInitials\(clientDisplay\)/);
    expect(page).not.toMatch(/clientName=\{client\.name\}/);
    expect(page).not.toMatch(/clientAvatarInitials\(client\.name\)/);
    expect(page).not.toMatch(/\{client\.name\}/);
    expect((page.match(/clientName=\{clientDisplay\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("the only header label is a bare Name on file caption, gated on there being no preferred name", () => {
    expect(page).toMatch(/\{labelAsNameOnFile && \(/);
    expect(page).not.toMatch(/Name on file: \{/);
    expect(page).not.toMatch(/nameOnFile\b/);
  });
});
