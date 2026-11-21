import { describe, expect, it } from "vitest";
import { invitationExpiryLabel } from "@/lib/waitlist/invitation-deadline";
import { openUntil } from "@/lib/waitlist/invitation-offer";

describe("invitation deadline in the studio's timezone", () => {
  it.each([
    ["2026-11-20T13:30:00Z", "America/Toronto", "November 20, 2026", "8:30 AM", "EST"],
    ["2026-07-20T13:30:00Z", "America/Toronto", "July 20, 2026", "9:30 AM", "EDT"],
    ["2026-11-20T13:30:00Z", "America/Los_Angeles", "November 20, 2026", "5:30 AM", "PST"],
    ["2026-11-20T02:30:00Z", "America/Toronto", "November 19, 2026", "9:30 PM", "EST"],
    ["2026-11-20T13:30:00Z", "Asia/Kolkata", "November 20, 2026", "7:00 PM", "GMT+5:30"],
    ["2026-03-08T06:30:00Z", "America/Toronto", "March 8, 2026", "1:30 AM", "EST"],
    ["2026-03-08T07:30:00Z", "America/Toronto", "March 8, 2026", "3:30 AM", "EDT"],
    ["2026-11-01T05:30:00Z", "America/Toronto", "November 1, 2026", "1:30 AM", "EDT"],
    ["2026-11-01T06:30:00Z", "America/Toronto", "November 1, 2026", "1:30 AM", "EST"],
  ])("email and page agree for %s in %s", (iso, zone, day, time, abbreviation) => {
    const instant = new Date(iso);
    const before = instant.getTime();
    const label = invitationExpiryLabel(instant, zone);
    expect(label).toContain(day);
    expect(label).toContain(time);
    expect(label).toContain(abbreviation);
    expect(label).toContain(`(${zone})`);
    expect(openUntil(iso, zone)).toEqual({ inviteOpenUntil: label });
    expect(instant.getTime()).toBe(before);
  });

  it.each([undefined, null, "", "  ", "not/a-zone"])(
    "labels the fallback honestly for timezone %s", (zone) => {
      const label = invitationExpiryLabel(new Date("2026-11-20T13:30:00Z"), zone);
      expect(label).toContain("1:30 PM UTC");
      expect(label).not.toContain("Toronto");
      expect(label).not.toContain("studio time");
    },
  );

  it("does not inherit the runtime's timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      const a = invitationExpiryLabel(new Date("2026-11-20T13:30:00Z"), "America/Toronto");
      process.env.TZ = "Pacific/Honolulu";
      expect(invitationExpiryLabel(new Date("2026-11-20T13:30:00Z"), "America/Toronto")).toBe(a);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("omits an unreadable stored expiry on the page", () => {
    expect(openUntil("not a date", "America/Toronto")).toEqual({});
  });
});
