import { describe, expect, it, vi } from "vitest";
import { buildWaitlistInvitationSms } from "@/lib/sms/templates";
import { GSM7_SEGMENT_UNITS, gsm7CharUnits, gsm7Units } from "@/lib/sms/gsm7";
import { invitationExpiryLabel } from "@/lib/waitlist/invitation-deadline";

vi.mock("server-only", () => ({}));

// The invitation text now names the studio's timezone, which makes it longer. Carriers count GSM-7 units: 160 in a single segment, 153 per segment
// once a message is split (so 2 segments hold 306, 3 hold 459). Any character outside GSM-7 would turn the WHOLE text into UCS-2 (70 per segment, 67 once
// split), so every character the label can produce for every zone must be GSM-7. The template's own policy accepts more than one segment ("if a long studio
// name does, that is acceptable"), so the budget pinned here is: a normal studio name stays within TWO segments, and the longest studio name (100) within THREE.
const SPLIT_SEGMENT_UNITS = 153;
const URL = `https://app.honecare.com/invitation/${"A".repeat(43)}`; // a 256-bit token is 43 base64url characters
const ZONES = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
const SEASONS = ["2026-01-15T20:00:00Z", "2026-07-15T20:00:00Z"]; // standard time and daylight time

const labelFor = (tz: string, at: string) => invitationExpiryLabel(new Date(at), tz);
const sms = (studioName: string, label: string) => buildWaitlistInvitationSms({ studioName, expiresAtLabel: label, invitationUrl: URL });
const segments = (units: number) => (units <= GSM7_SEGMENT_UNITS ? 1 : Math.ceil(units / SPLIT_SEGMENT_UNITS));

describe("the invitation text with a studio-local deadline", () => {
  it("every character the label can produce, for every zone in both seasons, is GSM-7 (so the text is never UCS-2)", () => {
    expect(ZONES.length).toBeGreaterThan(300);
    const bad: string[] = [];
    for (const tz of ZONES) for (const at of SEASONS) for (const ch of labelFor(tz, at)) if (gsm7CharUnits(ch) === null) bad.push(`${tz}:U+${ch.codePointAt(0)!.toString(16)}`);
    expect(bad).toEqual([]);
  });

  it("a normal studio name (up to 25 characters) stays within TWO segments for every zone and season", () => {
    const name = "Willow Electrolysis Care ".slice(0, 25);
    let worst = 0;
    for (const tz of ZONES) for (const at of SEASONS) {
      const units = gsm7Units(sms(name, labelFor(tz, at)));
      expect(units, tz).not.toBeNull();
      worst = Math.max(worst, units as number);
    }
    expect(segments(worst)).toBeLessThanOrEqual(2);
  });

  it("the longest possible studio name (100 characters) with the longest zone stays within THREE segments", () => {
    const longest = ZONES.flatMap((tz) => SEASONS.map((at) => labelFor(tz, at))).sort((a, b) => b.length - a.length)[0];
    const units = gsm7Units(sms("W".repeat(100), longest)) as number;
    expect(units).not.toBeNull();
    expect(segments(units)).toBeLessThanOrEqual(3);
  });

  it("the label is the only thing that grew: it is a fixed, bounded string (at most 80 characters)", () => {
    const longest = Math.max(...ZONES.flatMap((tz) => SEASONS.map((at) => labelFor(tz, at).length)));
    expect(longest).toBeLessThanOrEqual(80);
  });
});
