import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_UNAVAILABLE,
  buildInvitationBookingSummary,
  countText,
  NOT_AVAILABLE,
  NOT_TRACKED,
  OTHER_NOT_ATTRIBUTABLE,
  periodLabel,
  periodStart,
  SUMMARY_PERIOD_DAYS,
  type CommandCounts,
  type OutcomeCounts,
} from "@/lib/waitlist/invitation-booking-summary";

const START = "2026-10-23T12:00:00.000Z";
const outcomes = (over: Partial<OutcomeCounts> = {}): OutcomeCounts => ({
  total: 20, declined: 3, linkUsed: 8, expiredRecorded: 2, released: 1, open: 4, deadlinePassed: 2, ...over,
});
const command = (over: Partial<CommandCounts> = {}): CommandCounts => ({
  invitationsTotal: 20, peopleInvited: 17, bookedLinkedLive: 5, bookedThenCancelled: 1, convertedUnlinked: 1, ...over,
});
const build = (c: CommandCounts | null = command(), o: OutcomeCounts = outcomes()) => buildInvitationBookingSummary({ periodStartIso: START, command: c, outcomes: o });
const row = (s: ReturnType<typeof build>, key: string) => s.rows.find((r) => r.key === key)!;

describe("the figures", () => {
  it("states invitations sent and different people separately, from the command", () => {
    const s = build();
    expect(s.invitationsSent).toBe(20);
    expect(s.peopleInvited).toBe(17);
    expect(s.bookingUnavailable).toBe(false);
  });
  it("shows booked, booked-then-cancelled and attribution-unavailable from the command's own counts", () => {
    const s = build();
    expect(row(s, "booked").value).toBe(5);
    expect(row(s, "booked-cancelled").value).toBe(1);
    expect(row(s, "attribution-unavailable").value).toBe(1);
    expect(row(s, "attribution-unavailable").label).toBe(ATTRIBUTION_UNAVAILABLE);
  });
  it("a used link with no booking recorded is the remainder of the used links: other or not attributable", () => {
    const s = build();
    expect(row(s, "link-used").value).toBe(8);
    expect(row(s, "link-used-other").value).toBe(8 - 5 - 1 - 1);
    expect(row(s, "link-used-other").label).toBe(OTHER_NOT_ATTRIBUTABLE);
  });
  it("expired is the recorded expiry PLUS the deadline passed with none recorded", () => {
    expect(row(build(), "expired").value).toBe(2 + 2);
  });
  it("the whole adds up when nothing was left over: the top-level other row is 0", () => {
    // used 8 + declined 3 + expired 4 + released 1 + open 4 = 20
    expect(row(build(), "other").value).toBe(0);
  });
  it("anything left over from the whole is shown as other or not attributable, never lost", () => {
    expect(row(build(command({ invitationsTotal: 23 }), outcomes()), "other").value).toBe(3);
  });
  it("the booking figures never sum to the invitations sent by assumption: the rows are separate and the remainder is its own row", () => {
    const keys = build().rows.map((r) => r.key);
    expect(keys).toEqual([
      "link-used", "booked", "booked-cancelled", "attribution-unavailable", "link-used-other",
      "declined", "expired", "released", "open", "other", "email-opens", "page-visits",
    ]);
  });
});

describe("what could not be read is never 0", () => {
  it("without the command, the booking figures and the people count are Not available, the outcomes still show, and the denominator is the direct count", () => {
    const s = build(null);
    expect(s.bookingUnavailable).toBe(true);
    expect(s.peopleInvited).toBeNull();
    expect(s.invitationsSent).toBe(20);
    for (const k of ["booked", "booked-cancelled", "attribution-unavailable", "link-used-other"]) expect(row(s, k).value, k).toBeNull();
    expect(row(s, "declined").value).toBe(3);
    expect(row(s, "link-used").value).toBe(8);
    expect(countText(row(s, "booked").value)).toBe(NOT_AVAILABLE);
  });
  it("an outcome count that could not be read is null, and so is anything computed from it", () => {
    const s = build(command(), outcomes({ declined: null }));
    expect(row(s, "declined").value).toBeNull();
    expect(row(s, "other").value).toBeNull();
    const t = build(command(), outcomes({ deadlinePassed: null }));
    expect(row(t, "expired").value).toBeNull();
    expect(row(t, "other").value).toBeNull();
  });
  it("with neither the command nor a direct total there is no denominator at all", () => {
    const s = build(null, outcomes({ total: null }));
    expect(s.invitationsSent).toBeNull();
    expect(row(s, "other").value).toBeNull();
  });
});

describe("email opens and booking-page visits", () => {
  it("are always Not tracked, with no number", () => {
    for (const s of [build(), build(null)]) {
      for (const k of ["email-opens", "page-visits"]) {
        expect(row(s, k).fixedText).toBe(NOT_TRACKED);
        expect(row(s, k).value).toBeNull();
      }
    }
  });
});

describe("counts that moved while the page loaded", () => {
  it("parts larger than the whole are flagged, and no row is negative", () => {
    const s = build(command({ invitationsTotal: 10 }), outcomes());
    expect(s.inconsistent).toBe(true);
    for (const r of s.rows) if (r.value !== null) expect(r.value).toBeGreaterThanOrEqual(0);
  });
  it("used links smaller than their own booking parts are flagged too", () => {
    const s = build(command({ bookedLinkedLive: 9 }), outcomes({ linkUsed: 8 }));
    expect(s.inconsistent).toBe(true);
    expect(row(s, "link-used-other").value).toBe(0);
  });
  it("consistent counts are not flagged", () => {
    expect(build().inconsistent).toBe(false);
  });
});

describe("the period", () => {
  it("is the last 30 days, counted back from now", () => {
    expect(SUMMARY_PERIOD_DAYS).toBe(30);
    expect(periodStart(Date.parse("2026-11-22T12:00:00Z"))).toBe("2026-10-23T12:00:00.000Z");
  });
  it("is stated in words in the studio's time zone", () => {
    expect(periodLabel(START, "America/Toronto")).toBe("Invitations sent in the last 30 days (since Oct 23, 2026, up to now)");
  });
  it("a bad time zone falls back to the date, never throws", () => {
    expect(periodLabel(START, "Not/AZone")).toContain("2026-10-23");
  });
});
