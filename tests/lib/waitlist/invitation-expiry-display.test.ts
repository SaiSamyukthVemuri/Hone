import { describe, expect, it } from "vitest";
import {
  expirySummary,
  parseExpiry,
  rowExpiry,
  summaryText,
  timeRemainingLabel,
} from "@/lib/waitlist/invitation-expiry-display";

const NOW = new Date("2026-11-21T12:00:00Z").getTime();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

describe("timeRemainingLabel", () => {
  it.each([
    [30_000, "under 1 min"],
    [min, "1 min"],
    [59 * min, "59 min"],
    [hour, "1 h"],
    [5 * hour + 10 * min, "5 h 10 min"],
    [23 * hour + 59 * min, "23 h 59 min"],
    [day, "1 day"],
    [day + hour, "1 day 1 h"],
    [2 * day + 3 * hour, "2 days 3 h"],
    [3 * day, "3 days"],
  ])("%d ms left reads %s", (left, text) => {
    expect(timeRemainingLabel(NOW + left, NOW)).toBe(text);
  });
  it("has nothing for a passed or exactly-now deadline", () => {
    expect(timeRemainingLabel(NOW, NOW)).toBeNull();
    expect(timeRemainingLabel(NOW - 1, NOW)).toBeNull();
  });
});

describe("parseExpiry", () => {
  it.each([null, undefined, 5, "", "nope", {}])("%s is unreadable, never now", (v) => {
    expect(parseExpiry(v)).toBeNull();
  });
  it("reads an ISO instant", () => {
    expect(parseExpiry("2026-11-21T12:00:00Z")).toBe(NOW);
  });
});

describe("rowExpiry", () => {
  it("states the exact deadline in the studio zone with the time left", () => {
    const r = rowExpiry("2026-11-21T18:30:00Z", "America/Toronto", NOW);
    expect(r).toMatchObject({ kind: "open", remaining: "6 h 30 min" });
    expect(r?.label).toContain("1:30 PM EST");
    expect(r?.label).toContain("(America/Toronto)");
  });
  it("follows DST: the same wall clock is EDT in summer", () => {
    const r = rowExpiry("2026-07-21T17:30:00Z", "America/Toronto", new Date("2026-07-21T12:00:00Z").getTime());
    expect(r?.label).toContain("1:30 PM EDT");
  });
  it("labels a missing or invalid zone as UTC, never the runtime's", () => {
    for (const z of [null, undefined, "", "not/a-zone"]) {
      expect(rowExpiry("2026-11-21T18:30:00Z", z, NOW)?.label).toContain("6:30 PM UTC");
    }
  });
  it("a passed deadline is deadline_passed with no countdown", () => {
    const r = rowExpiry("2026-11-21T11:59:00Z", "UTC", NOW);
    expect(r?.kind).toBe("deadline_passed");
    expect(r).not.toHaveProperty("remaining");
  });
  it("unreadable input gives null", () => {
    expect(rowExpiry("garbage", "UTC", NOW)).toBeNull();
  });
});

describe("expirySummary", () => {
  it("counts within 24 h inclusive of exactly 24 h, excludes beyond and passed", () => {
    const s = expirySummary(
      [
        new Date(NOW + day).toISOString(), // exactly 24 h: in
        new Date(NOW + day + 1000).toISOString(), // out
        new Date(NOW + hour).toISOString(), // in, and the next
        new Date(NOW - hour).toISOString(), // passed: not counted
        new Date(NOW).toISOString(), // exactly now: passed
        "garbage",
      ],
      "UTC",
      NOW,
    );
    expect(s.withinDay).toBe(2);
    expect(s.open).toBe(3);
    expect(s.next?.remaining).toBe("1 h");
  });
  it("picks the soonest regardless of order", () => {
    const s = expirySummary(
      [new Date(NOW + 5 * hour).toISOString(), new Date(NOW + 2 * hour).toISOString()],
      "UTC",
      NOW,
    );
    expect(s.next?.remaining).toBe("2 h");
  });
  it("empty or all-passed has no next and no line", () => {
    expect(expirySummary([], "UTC", NOW)).toEqual({ next: null, withinDay: 0, open: 0 });
    expect(summaryText(expirySummary([new Date(NOW - 1).toISOString()], "UTC", NOW))).toBeNull();
  });
  it("writes one sentence, singular and plural", () => {
    const one = summaryText(expirySummary([new Date(NOW + hour).toISOString()], "UTC", NOW));
    expect(one).toContain("in 1 h.");
    expect(one).toContain("1 expires within 24 hours.");
    const two = summaryText(
      expirySummary([new Date(NOW + hour).toISOString(), new Date(NOW + 2 * hour).toISOString()], "UTC", NOW),
    );
    expect(two).toContain("2 expire within 24 hours.");
    const zero = summaryText(expirySummary([new Date(NOW + 3 * day).toISOString()], "UTC", NOW));
    expect(zero).toContain("0 expire within 24 hours.");
  });
});
