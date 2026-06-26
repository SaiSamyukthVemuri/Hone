import { describe, expect, it } from "vitest";
import {
  computeReminderSchedulerStatus,
  REMINDER_STALE_AFTER_MINUTES,
  type ReminderHeartbeat,
} from "@/lib/cron/reminder-heartbeat";

// PR #265. Pure, time-independent classifier for the external reminder
// scheduler's "last successful run" heartbeat. healthy if the last success is
// within REMINDER_STALE_AFTER_MINUTES (3 missed */15 cycles = 45 min), stale
// if older, missing if there is no valid heartbeat.

const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const atMinutesAgo = (m: number): ReminderHeartbeat => ({
  at: new Date(NOW - m * 60_000).toISOString(),
});

describe("computeReminderSchedulerStatus", () => {
  it("is healthy for a recent success", () => {
    const s = computeReminderSchedulerStatus(atMinutesAgo(10), NOW);
    expect(s.status).toBe("healthy");
    expect(s.ageMinutes).toBe(10);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it("is healthy exactly at the stale boundary (inclusive)", () => {
    const s = computeReminderSchedulerStatus(
      atMinutesAgo(REMINDER_STALE_AFTER_MINUTES),
      NOW,
    );
    expect(s.status).toBe("healthy");
    expect(s.ageMinutes).toBe(REMINDER_STALE_AFTER_MINUTES);
  });

  it("is stale one minute past the boundary", () => {
    const s = computeReminderSchedulerStatus(
      atMinutesAgo(REMINDER_STALE_AFTER_MINUTES + 1),
      NOW,
    );
    expect(s.status).toBe("stale");
  });

  it("is stale for a long-ago success", () => {
    expect(computeReminderSchedulerStatus(atMinutesAgo(180), NOW).status).toBe(
      "stale",
    );
  });

  it("is missing when there is no heartbeat", () => {
    const s = computeReminderSchedulerStatus(null, NOW);
    expect(s.status).toBe("missing");
    expect(s.lastSuccessAt).toBeNull();
    expect(s.ageMinutes).toBeNull();
  });

  it("is missing when the heartbeat timestamp is invalid", () => {
    expect(
      computeReminderSchedulerStatus({ at: "not-a-timestamp" }, NOW).status,
    ).toBe("missing");
    expect(
      computeReminderSchedulerStatus({ at: "" } as ReminderHeartbeat, NOW).status,
    ).toBe("missing");
  });

  it("never reports a negative age (clock skew)", () => {
    const s = computeReminderSchedulerStatus(atMinutesAgo(-5), NOW);
    expect(s.ageMinutes).toBe(0);
    expect(s.status).toBe("healthy");
  });

  it("always reports the cadence + threshold so the card cannot drift", () => {
    const s = computeReminderSchedulerStatus(atMinutesAgo(1), NOW);
    expect(s.cadenceMinutes).toBe(15);
    expect(s.staleAfterMinutes).toBe(REMINDER_STALE_AFTER_MINUTES);
    expect(REMINDER_STALE_AFTER_MINUTES).toBe(45);
  });
});
