import { describe, expect, it } from "vitest";
import { consultationsThatFit } from "@/lib/waitlist/consultation-capacity";
import {
  OVER_INVITE_CLIENT_COPY,
  OVER_INVITE_OWNER_COPY,
  buildOverInvitePreview,
  countUpcomingExpirations,
  isMaterialChange,
} from "@/lib/waitlist/over-invite-preview";

const at = (h: number, m = 0) => `2026-12-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const slot = (h: number, m: number, minutes: number) => {
  const start = at(h, m);
  return { start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() };
};

describe("the fit that feeds the preview: durations and overlap", () => {
  const starts: Array<[number, number]> = [[9, 0], [9, 30], [10, 0], [10, 30], [11, 0], [11, 30]];
  it("a shorter consultation fits more of the same window than a longer one", () => {
    const thirty = starts.map(([h, m]) => slot(h, m, 30));
    const sixty = starts.map(([h, m]) => slot(h, m, 60));
    expect(consultationsThatFit(thirty, 0)).toBe(6);
    expect(consultationsThatFit(sixty, 0)).toBe(3);
    expect(consultationsThatFit(thirty, 0)).toBeGreaterThan(consultationsThatFit(sixty, 0));
  });
  it("overlapping potential times count ONCE: four legal starts inside one 90-minute stretch hold one", () => {
    const slots = [slot(9, 0, 90), slot(9, 15, 90), slot(9, 30, 90), slot(9, 45, 90)];
    expect(consultationsThatFit(slots, 0)).toBe(1);
  });
  it("two overlapping stretches and one separate time hold two", () => {
    expect(consultationsThatFit([slot(9, 0, 60), slot(9, 30, 60), slot(13, 0, 60)], 0)).toBe(2);
  });
  it("the buffer after each consultation reduces what fits, and an adjacent start needs the gap", () => {
    const slots = [slot(9, 0, 60), slot(10, 0, 60), slot(11, 0, 60)];
    expect(consultationsThatFit(slots, 0)).toBe(3);
    expect(consultationsThatFit(slots, 15)).toBe(2);
  });
});

describe("upcoming expirations", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  const inv = (iso: string) => ({ expiresAt: iso });
  it("counts those expiring after now and up to the horizon (inclusive at the horizon); one expiring exactly now is already expired", () => {
    const list = [inv("2026-12-01T11:59:59Z"), inv("2026-12-01T12:00:00Z"), inv("2026-12-01T12:00:01Z"), inv("2026-12-02T12:00:00Z"), inv("2026-12-02T12:00:01Z")];
    expect(countUpcomingExpirations(list, now, 24)).toBe(2); // 12:00:01 and the horizon edge; not 11:59:59, not 12:00:00, not 12:00:01 next day
  });
  it("is zero for none, for a zero horizon and for malformed dates", () => {
    expect(countUpcomingExpirations([], now, 24)).toBe(0);
    expect(countUpcomingExpirations([inv("2026-12-01T12:30:00Z")], now, 0)).toBe(0);
    expect(countUpcomingExpirations([inv("not a date")], now, 24)).toBe(0);
  });
});

describe("the preview", () => {
  it("is Sam's example line exactly", () => {
    const p = buildOverInvitePreview({ fit: 5, active: 8, expiringSoon: 2, extra: 10 });
    expect(p.line).toBe("5 estimated appointments available · 8 invitations active · Send 10 more → 18 active invitations");
    expect(p).toMatchObject({ resultingTotal: 18, beyondCapacity: true, expiringSoon: 2 });
  });
  it("uses singular nouns for one, and is not beyond capacity when the total fits", () => {
    const p = buildOverInvitePreview({ fit: 1, active: 0, expiringSoon: 0, extra: 1 });
    expect(p.line).toBe("1 estimated appointment available · 0 invitations active · Send 1 more → 1 active invitation");
    expect(p.beyondCapacity).toBe(false);
  });
  it("never shows negative, fractional or non-finite numbers, and expiring never exceeds active", () => {
    const p = buildOverInvitePreview({ fit: -3, active: 2.9, expiringSoon: 9, extra: Number.NaN });
    expect(p).toMatchObject({ fit: 0, active: 2, extra: 0, expiringSoon: 2, resultingTotal: 2 });
  });
  it("carries the owner copy verbatim and the client copy is verbatim", () => {
    expect(buildOverInvitePreview({ fit: 0, active: 0, expiringSoon: 0, extra: 1 }).ownerCopy).toBe(
      "Invitations do not reserve appointments. Some clients may find no availability.",
    );
    expect(OVER_INVITE_OWNER_COPY).toBe("Invitations do not reserve appointments. Some clients may find no availability.");
    expect(OVER_INVITE_CLIENT_COPY).toBe(
      "Choose from current availability. Appointment times are not reserved and may fill before your invitation expires.",
    );
  });
});

describe("a material change between the preview and the send", () => {
  const shown = { fit: 5, active: 8, extra: 10 };
  it("is none when the three numbers are unchanged", () => {
    expect(isMaterialChange(shown, { ...shown })).toBe(false);
  });
  it.each([
    ["capacity fell", { fit: 4, active: 8, extra: 10 }],
    ["capacity rose", { fit: 6, active: 8, extra: 10 }],
    ["an invitation was added", { fit: 5, active: 9, extra: 10 }],
    ["an invitation expired", { fit: 5, active: 7, extra: 10 }],
    ["the quantity changed", { fit: 5, active: 8, extra: 9 }],
  ])("is material when %s", (_n, fresh) => {
    expect(isMaterialChange(shown, fresh)).toBe(true);
  });
});
