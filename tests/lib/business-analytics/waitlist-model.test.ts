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
  const form = (status: "waiting" | "claimed" | "invited", joinedAt: string) => ({ status, joinedAt, provenance: "form" });
  it("keeps claimed/invited distinct and includes them in current wait ages", () => {
    const pool = summarizeWaitingPool([
      form("waiting", "2026-11-20T12:00:00Z"), form("claimed", "2026-11-18T12:00:00Z"),
      form("invited", "2026-11-10T12:00:00Z"), form("waiting", "2026-11-14T12:00:00Z"),
    ], now);
    expect(pool).toEqual({ total: 4, waiting: 2, claimed: 1, invited: 1, agedCount: 4, medianDays: 6, longestDays: 12 });
  });
  it("does not invent a wait age for invalid or future joins", () => {
    for (const joinedAt of ["bad", "2027-01-01T00:00:00Z"]) expect(summarizeWaitingPool([form("waiting", joinedAt)], now)).toBeNull();
  });
  it("empty is known empty, with no wait", () => {
    const pool = summarizeWaitingPool([], now);
    expect(pool).toMatchObject({ total: 0, agedCount: 0, medianDays: null, longestDays: null });
  });
  it("an imported entry with an unknown join date is counted but adds no wait", () => {
    // The import time is stamped into joined_at; here 0 days ago, which would drag a median toward zero.
    const pool = summarizeWaitingPool([
      form("waiting", "2026-11-12T12:00:00Z"), form("waiting", "2026-11-02T12:00:00Z"),
      { status: "waiting", joinedAt: "2026-11-22T11:00:00Z", provenance: "unknown" },
      { status: "invited", joinedAt: "2026-11-22T11:00:00Z", provenance: "unknown" },
    ], now);
    expect(pool).toEqual({ total: 4, waiting: 3, claimed: 0, invited: 1, agedCount: 2, medianDays: 15, longestDays: 20 });
  });
  it("a studio-supplied join date counts as known", () => {
    expect(summarizeWaitingPool([{ status: "waiting", joinedAt: "2026-11-12T12:00:00Z", provenance: "operator_supplied" }], now)).toMatchObject({ agedCount: 1, longestDays: 10 });
  });
  it("missing or unrecognised provenance is treated as unknown, never as a date", () => {
    for (const provenance of [undefined, null, "", "something-new"]) {
      expect(summarizeWaitingPool([{ status: "waiting", joinedAt: "2026-11-01T12:00:00Z", provenance }], now))
        .toMatchObject({ total: 1, agedCount: 0, medianDays: null, longestDays: null });
    }
  });
  it("only unknown dates: counts survive, waits are absent, and a bad import timestamp does not void the pool", () => {
    const pool = summarizeWaitingPool([{ status: "waiting", joinedAt: "not-a-date", provenance: "unknown" }, { status: "claimed", joinedAt: "2027-01-01T00:00:00Z", provenance: "unknown" }], now);
    expect(pool).toMatchObject({ total: 2, waiting: 1, claimed: 1, agedCount: 0, medianDays: null, longestDays: null });
  });
});

describe("capacity filters", () => {
  const services = [{ id: "own-consult", name: "Consultation" }];
  it("defaults to a loaded eligible service and 7 days", () => expect(parseWaitlistParams({}, services)).toEqual({ serviceId: "own-consult", days: 7, notices: [] }));
  it("rejects foreign or repeated service params instead of selecting another service", () => {
    for (const service of ["foreign-service", ["own-consult", "foreign-service"]]) expect(parseWaitlistParams({ service }, services).serviceId).toBeNull();
  });
  it("accepts only the supported horizons", () => {
    for (const days of ["7", "14", "28"]) expect(parseWaitlistParams({ days }, services).days).toBe(Number(days));
    for (const days of ["900", "-1", ["7", "28"], "junk"]) {
      const parsed = parseWaitlistParams({ days }, services);
      expect(parsed.notices.length).toBeGreaterThan(0);
      expect(parsed.days).toBe(7);
    }
  });
});
