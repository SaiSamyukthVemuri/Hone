import { describe, expect, it } from "vitest";
import { parseRemovalLeftovers, removalLeftoverMessage } from "@/lib/team/removal-leftovers";

describe("parseRemovalLeftovers (the URL is untrusted input)", () => {
  it("keeps only the whitelisted codes, in canonical order", () => {
    expect(parseRemovalLeftovers("google_access,invitations")).toEqual(["invitations", "google_access"]);
  });
  it("drops anything unknown, including markup", () => {
    expect(parseRemovalLeftovers("<script>alert(1)</script>,google_access,../x")).toEqual(["google_access"]);
  });
  it("handles undefined, empty and an array", () => {
    expect(parseRemovalLeftovers(undefined)).toEqual([]);
    expect(parseRemovalLeftovers("")).toEqual([]);
    expect(parseRemovalLeftovers(["invitations", "google_connection"])).toEqual(["invitations", "google_connection"]);
  });
});

describe("removalLeftoverMessage", () => {
  it("always says the member WAS removed and access is already blocked", () => {
    for (const code of ["invitations", "google_connection", "google_access"] as const) {
      expect(removalLeftoverMessage([code])).toMatch(/was removed and can no longer open anything/);
      expect(removalLeftoverMessage([code])).toMatch(/access is already blocked/i);
    }
  });
  it("Google access: NO 'contact support' (the token is already deleted); the remedy is the person's own Google Account connected apps", () => {
    const m = removalLeftoverMessage(["google_access"]);
    expect(m).not.toMatch(/contact support/i);
    expect(m).toMatch(/Third-party apps and services/);
    expect(m).toMatch(/remove Hone/);
  });
  it("invitations and the Google Calendar connection still say contact support", () => {
    expect(removalLeftoverMessage(["invitations"])).toMatch(/Contact support/);
    expect(removalLeftoverMessage(["google_connection"])).toMatch(/Contact support/);
  });
  it("names several leftovers with a plain list", () => {
    expect(removalLeftoverMessage(["invitations", "google_access"])).toMatch(/pending invitations and Google access/);
  });
});
