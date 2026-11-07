import { describe, expect, it } from "vitest";
import { STUDIO_LOCAL_DISCONNECT_NOTICE } from "@/lib/google-calendar/studio-local-disconnect-notice";
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
  it("Google access is a NOTICE, not a failure: Hone no longer holds it, no 'could not clear', no 'contact support'; only the person can remove Hone at Google", () => {
    const m = removalLeftoverMessage(["google_access"]);
    expect(m).not.toMatch(/contact support/i);
    expect(m).not.toMatch(/could not also clear/i);
    expect(m).toContain(STUDIO_LOCAL_DISCONNECT_NOTICE);
    expect(m).toMatch(/Third-party apps and services/);
    expect(m).not.toMatch(/disconnected from Google/i);
  });
  it("invitations and the Google Calendar connection still say contact support", () => {
    expect(removalLeftoverMessage(["invitations"])).toMatch(/Contact support/);
    expect(removalLeftoverMessage(["google_connection"])).toMatch(/Contact support/);
  });
  it("names the real failures with a plain list and still adds the Google notice", () => {
    const m = removalLeftoverMessage(["invitations", "google_connection", "google_access"]);
    expect(m).toMatch(/pending invitations and Google Calendar connection/);
    expect(m).not.toMatch(/Google access\b.*could not/);
    expect(m).toContain(STUDIO_LOCAL_DISCONNECT_NOTICE);
  });
});
