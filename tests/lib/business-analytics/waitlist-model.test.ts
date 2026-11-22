import { describe, expect, it } from "vitest";
import { buildWaitlistAnalytics, parseWaitlistParams, summarizeWaitingPool } from "@/lib/business-analytics/waitlist-model";
import type { CommandCounts, OutcomeCounts } from "@/lib/waitlist/invitation-booking-summary";

const now = new Date("2026-11-22T12:00:00Z");
const command: CommandCounts = { invitationsTotal: 10, peopleInvited: 8, bookedLinkedLive: 3, bookedThenCancelled: 1, convertedUnlinked: 1 };
const outcomes: OutcomeCounts = { total: 10, linkUsed: 5, declined: 1, expiredRecorded: 1, deadlinePassed: 1, released: 1, open: 1 };
const build = (over: Partial<Parameters<typeof buildWaitlistAnalytics>[0]> = {}) => buildWaitlistAnalytics({ now, timezone: "UTC", periodStartIso: "2026-10-23T12:00:00Z", command, outcomes, pool: null, delivery: { accepted: 10, refused: 0, unknown: 0, unrecorded: 0 }, ...over });

describe("waitlist analytics counts what can be proved", () => {
  it("counts linked bookings including later cancellation, with all issued invitations as denominator", () => {
    expect(build().conversion).toEqual({ booked: 4, invitations: 10, percent: 40 });
    expect(build().summary.rows.find((r) => r.key === "open")?.value).toBe(1);
  });
  it("does not turn a missing booking command into zero bookings or use link redemptions as bookings", () => {
    const view = build({ command: null });
    expect(view.conversion).toBeNull();
    expect(view.summary.peopleInvited).toBeNull();
    expect(view.summary.rows.find((r) => r.key === "booked")?.value).toBeNull();
    expect(view.summary.rows.find((r) => r.key === "link-used")?.value).toBe(5);
  });
  it("a resolved zero-booking cohort is zero percent, but an empty cohort has no rate", () => {
    expect(build({ command: { ...command, bookedLinkedLive: 0, bookedThenCancelled: 0 } }).conversion?.percent).toBe(0);
    const empty = Object.fromEntries(Object.keys(outcomes).map((k) => [k, 0])) as OutcomeCounts;
    expect(build({ outcomes: empty, command: { invitationsTotal: 0, peopleInvited: 0, bookedLinkedLive: 0, bookedThenCancelled: 0, convertedUnlinked: 0 } }).conversion).toBeNull();
  });
  it.each([
    { outcomes: { ...outcomes, total: 11 } },
    { outcomes: { ...outcomes, open: 2 } },
    { outcomes: { ...outcomes, declined: null } },
    { command: { ...command, bookedLinkedLive: 9 } },
    { command: { ...command, peopleInvited: 11 } },
  ])("withholds the rate when counts cannot reconcile: %j", (over) => expect(build(over).conversion).toBeNull());
});

describe("the current waiting pool", () => {
  it("keeps claimed/invited distinct and includes them in current wait ages", () => {
    const pool = summarizeWaitingPool([
      { status: "waiting", joinedAt: "2026-11-20T12:00:00Z" },
      { status: "claimed", joinedAt: "2026-11-18T12:00:00Z" },
      { status: "invited", joinedAt: "2026-11-10T12:00:00Z" },
      { status: "waiting", joinedAt: "2026-11-14T12:00:00Z" },
    ], now);
    expect(pool).toEqual({ total: 4, waiting: 2, claimed: 1, invited: 1, medianDays: 6, longestDays: 12 });
  });
  it("does not invent a wait age for invalid or future joins", () => {
    for (const joinedAt of ["bad", "2027-01-01T00:00:00Z"]) expect(summarizeWaitingPool([{ status: "waiting", joinedAt }], now)).toBeNull();
  });
  it("empty is known empty", () => expect(summarizeWaitingPool([], now)?.total).toBe(0));
});

describe("capacity filters", () => {
  const services = [{ id: "own-consult", name: "Consultation" }];
  it("defaults to a loaded eligible service and 7 days", () => expect(parseWaitlistParams({}, services)).toEqual({ serviceId: "own-consult", days: 7, notices: [] }));
  it("rejects foreign or repeated service params instead of selecting another service", () => {
    for (const service of ["foreign-service", ["own-consult", "foreign-service"]]) expect(parseWaitlistParams({ service }, services).serviceId).toBeNull();
  });
  it("accepts only the supported horizons", () => {
    for (const days of ["7", "14", "28"]) expect(parseWaitlistParams({ days }, services).days).toBe(Number(days));
    for (const days of ["900", "-1", ["7", "28"], "junk"]) expect(parseWaitlistParams({ days }, services).notices.length).toBeGreaterThan(0);
  });
});
