import { describe, expect, it } from "vitest";
import {
  computeReminderSchedulerStatus,
  decideReminderSchedulerAlert,
  reminderSchedulerAlertSafeDetails,
  REMINDER_STALE_AFTER_MINUTES,
  type ReminderHeartbeat,
  type ReminderSchedulerStatus,
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

// ---------------------------------------------------------------------------
// PR #283. Pure decision core for the stale/missing reminder-scheduler alert.
// The side-effecting recordReminderSchedulerHealthAlert() wraps this; the
// decision + safe_details are pinned here (the codebase tests lib via pure
// core + source-grep wiring rather than DB/ops mocks).
// ---------------------------------------------------------------------------
const statusOf = (s: "healthy" | "stale" | "missing"): ReminderSchedulerStatus =>
  computeReminderSchedulerStatus(
    s === "missing"
      ? null
      : atMinutesAgo(s === "healthy" ? 10 : REMINDER_STALE_AFTER_MINUTES + 60),
    NOW,
  );

describe("decideReminderSchedulerAlert", () => {
  it("healthy never alerts", () => {
    const plan = decideReminderSchedulerAlert(statusOf("healthy"), false);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("healthy");
  });

  it("stale (no existing unresolved alert) -> one warning reminder_scheduler_stale", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), false);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("warning");
      expect(plan.event).toBe("reminder_scheduler_stale");
    }
  });

  it("missing (no existing unresolved alert) -> one critical reminder_scheduler_missing", () => {
    const plan = decideReminderSchedulerAlert(statusOf("missing"), false);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("critical");
      expect(plan.event).toBe("reminder_scheduler_missing");
    }
  });

  it("stale with an existing unresolved alert is deduped (no new alert)", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), true);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("deduped");
  });

  it("missing with an existing unresolved alert is deduped (no new alert)", () => {
    const plan = decideReminderSchedulerAlert(statusOf("missing"), true);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("deduped");
  });
});

describe("reminderSchedulerAlertSafeDetails is non-sensitive", () => {
  it("carries exactly the safe timing keys, nothing else", () => {
    const details = reminderSchedulerAlertSafeDetails(statusOf("stale"), NOW);
    expect(Object.keys(details).sort()).toEqual(
      [
        "age_minutes",
        "cadence_minutes",
        "checked_at",
        "last_success_at",
        "stale_after_minutes",
        "status",
      ].sort(),
    );
    expect(details.status).toBe("stale");
    expect(details.cadence_minutes).toBe(15);
    expect(details.stale_after_minutes).toBe(REMINDER_STALE_AFTER_MINUTES);
    expect(details.checked_at).toBe(new Date(NOW).toISOString());
  });

  it("missing status reports null last_success_at + age (no fabricated values)", () => {
    const details = reminderSchedulerAlertSafeDetails(statusOf("missing"), NOW);
    expect(details.status).toBe("missing");
    expect(details.last_success_at).toBeNull();
    expect(details.age_minutes).toBeNull();
  });

  it("contains no secret / PII / reminder-content keys or values", () => {
    const serialized = JSON.stringify(
      reminderSchedulerAlertSafeDetails(statusOf("stale"), NOW),
    );
    expect(serialized).not.toMatch(
      /cron_secret|authorization|bearer|email|phone|\bname\b|client|token|message|body|reminder_text/i,
    );
  });
});
