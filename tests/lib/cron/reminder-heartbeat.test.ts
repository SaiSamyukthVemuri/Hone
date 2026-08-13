import { describe, expect, it } from "vitest";
import {
  computeReminderSchedulerStatus,
  decideReminderSchedulerAlert,
  reminderSchedulerAlertEventFor,
  reminderSchedulerAlertSafeDetails,
  REMINDER_DEGRADED_AFTER_MINUTES,
  REMINDER_STALE_AFTER_MINUTES,
  type ReminderHeartbeat,
  type ReminderSchedulerHealth,
  type ReminderSchedulerStatus,
} from "@/lib/cron/reminder-heartbeat";
import { CRON_INTERVAL_MINUTES } from "@/lib/cron/reminder-schedule";

// PR #265 / #283, hardened by PR OPS-01. Pure, time-independent classifier for
// the external reminder scheduler's "last successful run" heartbeat.
//
//   healthy  <= 2x cadence (30 min)  — cadence contract met
//   degraded <= 3x cadence (45 min)  — cadence margin lost (2h window is 30 min wide)
//   stale     > 3x cadence           — three missed cycles; CRITICAL
//   missing   no valid heartbeat     — CRITICAL

const NOW = Date.parse("2026-06-26T12:00:00.000Z");
const atMinutesAgo = (m: number): ReminderHeartbeat => ({
  at: new Date(NOW - m * 60_000).toISOString(),
});

// ---------------------------------------------------------------------------
// Thresholds are DERIVED from the shipped cadence, not restated as literals.
// If CRON_INTERVAL_MINUTES ever changes, these assertions force the monitoring
// contract to move with it instead of silently drifting.
// ---------------------------------------------------------------------------
describe("health thresholds derive from the shipped cadence contract", () => {
  it("degraded = 2x cadence, stale = 3x cadence", () => {
    expect(REMINDER_DEGRADED_AFTER_MINUTES).toBe(CRON_INTERVAL_MINUTES * 2);
    expect(REMINDER_STALE_AFTER_MINUTES).toBe(CRON_INTERVAL_MINUTES * 3);
  });

  it("degraded is strictly tighter than stale (the band must be non-empty)", () => {
    expect(REMINDER_DEGRADED_AFTER_MINUTES).toBeLessThan(
      REMINDER_STALE_AFTER_MINUTES,
    );
  });

  it("the current 15-minute contract yields 30 / 45", () => {
    expect(CRON_INTERVAL_MINUTES).toBe(15);
    expect(REMINDER_DEGRADED_AFTER_MINUTES).toBe(30);
    expect(REMINDER_STALE_AFTER_MINUTES).toBe(45);
  });
});

describe("computeReminderSchedulerStatus", () => {
  it("is healthy for a recent success", () => {
    const s = computeReminderSchedulerStatus(atMinutesAgo(10), NOW);
    expect(s.status).toBe("healthy");
    expect(s.ageMinutes).toBe(10);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it("is healthy exactly at the degraded boundary (inclusive)", () => {
    const s = computeReminderSchedulerStatus(
      atMinutesAgo(REMINDER_DEGRADED_AFTER_MINUTES),
      NOW,
    );
    expect(s.status).toBe("healthy");
    expect(s.ageMinutes).toBe(REMINDER_DEGRADED_AFTER_MINUTES);
  });

  // THE REGRESSION THIS PR EXISTS TO CATCH. Before OPS-01 every age from 0 to
  // 45 minutes reported "healthy", so a scheduler silently running at a 31-45
  // minute cadence was indistinguishable from a correct 15-minute one — while
  // the 30-minute-wide 2h window was already missing appointment offsets.
  it("is DEGRADED one minute past the degraded boundary (not healthy)", () => {
    const s = computeReminderSchedulerStatus(
      atMinutesAgo(REMINDER_DEGRADED_AFTER_MINUTES + 1),
      NOW,
    );
    expect(s.status).toBe("degraded");
    expect(s.status).not.toBe("healthy");
  });

  it("reports degraded across the whole 31-45 minute band", () => {
    for (
      let age = REMINDER_DEGRADED_AFTER_MINUTES + 1;
      age <= REMINDER_STALE_AFTER_MINUTES;
      age++
    ) {
      expect(computeReminderSchedulerStatus(atMinutesAgo(age), NOW).status).toBe(
        "degraded",
      );
    }
  });

  it("is degraded exactly at the stale boundary (inclusive)", () => {
    const s = computeReminderSchedulerStatus(
      atMinutesAgo(REMINDER_STALE_AFTER_MINUTES),
      NOW,
    );
    expect(s.status).toBe("degraded");
  });

  it("is stale one minute past the stale boundary", () => {
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

  it("always reports the cadence + both thresholds so the card cannot drift", () => {
    const s = computeReminderSchedulerStatus(atMinutesAgo(1), NOW);
    expect(s.cadenceMinutes).toBe(CRON_INTERVAL_MINUTES);
    expect(s.degradedAfterMinutes).toBe(REMINDER_DEGRADED_AFTER_MINUTES);
    expect(s.staleAfterMinutes).toBe(REMINDER_STALE_AFTER_MINUTES);
  });
});

// ---------------------------------------------------------------------------
// PR #283 decision core, re-pinned for four states. The side-effecting
// recordReminderSchedulerHealthAlert() wraps this; the decision + safe_details
// are pinned here (the codebase tests lib via pure core + source-grep wiring
// rather than DB/ops mocks).
// ---------------------------------------------------------------------------
const statusOf = (s: ReminderSchedulerHealth): ReminderSchedulerStatus =>
  computeReminderSchedulerStatus(
    s === "missing"
      ? null
      : atMinutesAgo(
          s === "healthy"
            ? 10
            : s === "degraded"
              ? REMINDER_DEGRADED_AFTER_MINUTES + 1
              : REMINDER_STALE_AFTER_MINUTES + 60,
        ),
    NOW,
  );

describe("statusOf helper actually produces the state it claims (non-vacuity)", () => {
  it.each(["healthy", "degraded", "stale", "missing"] as const)(
    "%s",
    (state) => {
      expect(statusOf(state).status).toBe(state);
    },
  );
});

describe("reminderSchedulerAlertEventFor", () => {
  it("maps every unhealthy state to a distinct event, healthy to none", () => {
    expect(reminderSchedulerAlertEventFor("healthy")).toBeNull();
    expect(reminderSchedulerAlertEventFor("degraded")).toBe(
      "reminder_scheduler_degraded",
    );
    expect(reminderSchedulerAlertEventFor("stale")).toBe(
      "reminder_scheduler_stale",
    );
    expect(reminderSchedulerAlertEventFor("missing")).toBe(
      "reminder_scheduler_missing",
    );
  });

  it("the three unhealthy events are distinct (so dedupe cannot collapse them)", () => {
    const events = (["degraded", "stale", "missing"] as const).map((s) =>
      reminderSchedulerAlertEventFor(s),
    );
    expect(new Set(events).size).toBe(3);
  });
});

describe("decideReminderSchedulerAlert", () => {
  it("healthy never alerts", () => {
    const plan = decideReminderSchedulerAlert(statusOf("healthy"), false);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("healthy");
  });

  it("degraded (no existing unresolved alert) -> one warning reminder_scheduler_degraded", () => {
    const plan = decideReminderSchedulerAlert(statusOf("degraded"), false);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("warning");
      expect(plan.event).toBe("reminder_scheduler_degraded");
    }
  });

  // THE ESCALATION. recordOpsAlert only emails OPS_ALERT_EMAILS on critical
  // severity, so a warning-level stale alert never reached an operator inbox —
  // a dead scheduler stayed silent until the 24h heartbeat TTL expired it into
  // "missing" (up to ~48h). Stale must be CRITICAL.
  it("stale (no existing unresolved alert) -> one CRITICAL reminder_scheduler_stale", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), false);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("critical");
      expect(plan.severity).not.toBe("warning");
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

  it("every state that needs an operator email is critical", () => {
    for (const state of ["stale", "missing"] as const) {
      const plan = decideReminderSchedulerAlert(statusOf(state), false);
      expect(plan.shouldAlert).toBe(true);
      if (plan.shouldAlert) expect(plan.severity).toBe("critical");
    }
  });

  it.each(["degraded", "stale", "missing"] as const)(
    "%s with an existing unresolved alert is deduped (no new alert)",
    (state) => {
      const plan = decideReminderSchedulerAlert(statusOf(state), true);
      expect(plan.shouldAlert).toBe(false);
      if (!plan.shouldAlert) expect(plan.reason).toBe("deduped");
    },
  );

  // Several daily crons call the same helper. Dedupe is what keeps three
  // callers from producing three alerts for one outage.
  it("repeated same-day checks after the first alert record nothing (multi-caller spam guard)", () => {
    const status = statusOf("stale");
    const first = decideReminderSchedulerAlert(status, false);
    expect(first.shouldAlert).toBe(true);
    // callers 2 and 3 of the day now see the unresolved row the first recorded
    for (const _caller of [2, 3]) {
      const later = decideReminderSchedulerAlert(status, true);
      expect(later.shouldAlert).toBe(false);
    }
  });

  // Dedupe must NOT suppress an escalation: degraded and stale are separate
  // events, so a worsening outage still reaches the operator.
  it("an unresolved degraded alert does NOT suppress the stale escalation", () => {
    // `hasUnresolvedAlertForEvent` is looked up per-event by the caller, so a
    // degraded row means "no unresolved row for the stale event".
    const plan = decideReminderSchedulerAlert(statusOf("stale"), false);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.event).toBe("reminder_scheduler_stale");
      expect(plan.severity).toBe("critical");
    }
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
        "degraded_after_minutes",
        "last_success_at",
        "stale_after_minutes",
        "status",
      ].sort(),
    );
    expect(details.status).toBe("stale");
    expect(details.cadence_minutes).toBe(CRON_INTERVAL_MINUTES);
    expect(details.degraded_after_minutes).toBe(REMINDER_DEGRADED_AFTER_MINUTES);
    expect(details.stale_after_minutes).toBe(REMINDER_STALE_AFTER_MINUTES);
    expect(details.checked_at).toBe(new Date(NOW).toISOString());
  });

  it("degraded status reports its own age + both thresholds", () => {
    const details = reminderSchedulerAlertSafeDetails(statusOf("degraded"), NOW);
    expect(details.status).toBe("degraded");
    expect(details.age_minutes).toBe(REMINDER_DEGRADED_AFTER_MINUTES + 1);
  });

  it("missing status reports null last_success_at + age (no fabricated values)", () => {
    const details = reminderSchedulerAlertSafeDetails(statusOf("missing"), NOW);
    expect(details.status).toBe("missing");
    expect(details.last_success_at).toBeNull();
    expect(details.age_minutes).toBeNull();
  });

  it.each(["degraded", "stale", "missing"] as const)(
    "%s contains no secret / PII / reminder-content keys or values",
    (state) => {
      const serialized = JSON.stringify(
        reminderSchedulerAlertSafeDetails(statusOf(state), NOW),
      );
      expect(serialized).not.toMatch(
        /cron_secret|authorization|bearer|email|phone|\bname\b|client|token|message|body|reminder_text/i,
      );
    },
  );
});
