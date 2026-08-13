import { describe, expect, it } from "vitest";
import {
  computeReminderSchedulerStatus,
  decideReminderSchedulerAlert,
  reminderSchedulerAlertEventFor,
  reminderSchedulerAlertSafeDetails,
  isAtLeastAsSevere,
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

const NONE = null;
const openWarning = { severity: "warning" as const };
const openCritical = { severity: "critical" as const };

describe("decideReminderSchedulerAlert", () => {
  it("healthy never alerts", () => {
    const plan = decideReminderSchedulerAlert(statusOf("healthy"), NONE);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("healthy");
  });

  // D2
  it("degraded + nothing open -> one warning reminder_scheduler_degraded", () => {
    const plan = decideReminderSchedulerAlert(statusOf("degraded"), NONE);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("warning");
      expect(plan.event).toBe("reminder_scheduler_degraded");
    }
  });

  // THE ESCALATION. recordOpsAlert only emails OPS_ALERT_EMAILS on critical
  // severity, so a warning-level stale alert never reached an operator inbox.
  it("stale + nothing open -> one CRITICAL reminder_scheduler_stale", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), NONE);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("critical");
      expect(plan.severity).not.toBe("warning");
      expect(plan.event).toBe("reminder_scheduler_stale");
    }
  });

  it("missing + nothing open -> one critical reminder_scheduler_missing", () => {
    const plan = decideReminderSchedulerAlert(statusOf("missing"), NONE);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("critical");
      expect(plan.event).toBe("reminder_scheduler_missing");
    }
  });

  it("every state that needs an operator email is critical", () => {
    for (const state of ["stale", "missing"] as const) {
      const plan = decideReminderSchedulerAlert(statusOf(state), NONE);
      expect(plan.shouldAlert).toBe(true);
      if (plan.shouldAlert) expect(plan.severity).toBe("critical");
    }
  });

  // ---------------------------------------------------------------------
  // OPS-01.1 / review 3774540599 — SEVERITY-AWARE DEDUPE.
  // ---------------------------------------------------------------------

  // D1 — same severity already open: dedupe.
  it("D1 degraded warning + open degraded warning -> dedupe", () => {
    const plan = decideReminderSchedulerAlert(statusOf("degraded"), openWarning);
    expect(plan.shouldAlert).toBe(false);
    if (!plan.shouldAlert) expect(plan.reason).toBe("deduped");
  });

  // D3 / D5 — equal-severity critical already open: dedupe.
  it.each(["stale", "missing"] as const)(
    "D3/D5 %s critical + open critical -> dedupe",
    (state) => {
      const plan = decideReminderSchedulerAlert(statusOf(state), openCritical);
      expect(plan.shouldAlert).toBe(false);
      if (!plan.shouldAlert) expect(plan.reason).toBe("deduped");
    },
  );

  // D4 — THE FINDING. Before OPS-01, reminder_scheduler_stale was recorded at
  // severity WARNING. An unresolved row from that era must NOT swallow the new
  // critical escalation, because only critical reaches OPS_ALERT_EMAILS.
  it("D4 stale critical + open LEGACY stale WARNING -> records the critical escalation", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), openWarning);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) {
      expect(plan.severity).toBe("critical");
      expect(plan.event).toBe("reminder_scheduler_stale");
    }
  });

  it("D4b missing critical + open legacy warning -> records the critical escalation", () => {
    const plan = decideReminderSchedulerAlert(statusOf("missing"), openWarning);
    expect(plan.shouldAlert).toBe(true);
    if (plan.shouldAlert) expect(plan.severity).toBe("critical");
  });

  // A critical open row must still suppress a *lower* severity alert.
  it("degraded warning + open critical -> dedupe (never downgrade-spam)", () => {
    const plan = decideReminderSchedulerAlert(statusOf("degraded"), openCritical);
    expect(plan.shouldAlert).toBe(false);
  });

  it("severity ordering is explicit: warning < critical", () => {
    expect(isAtLeastAsSevere("critical", "warning")).toBe(true);
    expect(isAtLeastAsSevere("critical", "critical")).toBe(true);
    expect(isAtLeastAsSevere("warning", "warning")).toBe(true);
    expect(isAtLeastAsSevere("warning", "critical")).toBe(false);
  });

  // Several daily crons call the same helper. Dedupe is what keeps three
  // callers from producing three alerts for one outage.
  it("repeated same-severity checks after the first alert record nothing (multi-caller spam guard)", () => {
    const status = statusOf("stale");
    expect(decideReminderSchedulerAlert(status, NONE).shouldAlert).toBe(true);
    for (const _caller of [2, 3]) {
      expect(decideReminderSchedulerAlert(status, openCritical).shouldAlert).toBe(false);
    }
  });

  // degraded and stale are separate EVENTS, so the caller looks each up
  // independently: a degraded row is simply absent from the stale lookup.
  it("an unresolved degraded alert does NOT suppress the stale escalation", () => {
    const plan = decideReminderSchedulerAlert(statusOf("stale"), NONE);
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
        "cadence_evidence",
        "cadence_minutes",
        "checked_at",
        "degraded_after_minutes",
        "last_success_at",
        "observed_interval_minutes",
        "previous_success_at",
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

// ---------------------------------------------------------------------------
// OPS-01.1 / review 3774540589 — CADENCE IS MEASURED, NOT INFERRED.
//
// The finding: a recent heartbeat is not evidence of cadence. A scheduler
// firing at 07:50 / 08:30 / 09:10 / 09:50 runs a 40-MINUTE cadence — wide
// enough to miss appointment offsets in the 30-minute 2h window — yet health
// checks at 08:00 / 09:00 / 09:30 observe ages of only 10 / 30 / 20 minutes.
// Recency sampling can never see the gap BETWEEN runs.
// ---------------------------------------------------------------------------
const isoAt = (hhmm: string) => `2026-08-13T${hhmm}:00.000Z`;
const msAt = (hhmm: string) => Date.parse(isoAt(hhmm));

// Build a heartbeat carrying real inter-run evidence.
const beat = (lastSuccess: string, previousSuccess?: string): ReminderHeartbeat => ({
  at: isoAt(lastSuccess),
  ...(previousSuccess ? { previousSuccessAt: isoAt(previousSuccess) } : {}),
});

describe("P1-A: the reported 40-minute-cadence scenario", () => {
  // Exactly the invocations and observation times from the review comment.
  const scenario = [
    { checkAt: "08:00", last: "07:50", prev: "07:10", age: 10 },
    { checkAt: "09:00", last: "08:30", prev: "07:50", age: 30 },
    { checkAt: "09:30", last: "09:10", prev: "08:30", age: 20 },
  ];

  it("recency alone would call every one of these observations healthy", () => {
    for (const o of scenario) {
      // No cadence evidence => recency-only, which is the pre-fix behaviour.
      const s = computeReminderSchedulerStatus(beat(o.last), msAt(o.checkAt));
      expect(s.ageMinutes).toBe(o.age);
      expect(s.status).toBe("healthy");
    }
  });

  it("with real inter-run evidence NONE of them is healthy", () => {
    for (const o of scenario) {
      const s = computeReminderSchedulerStatus(
        beat(o.last, o.prev),
        msAt(o.checkAt),
      );
      expect(s.observedIntervalMinutes).toBe(40);
      expect(s.cadenceEvidence).toBe("measured");
      expect(s.status).toBe("degraded");
      expect(s.status).not.toBe("healthy");
    }
  });
});

describe("P1-A regression matrix: worst of (recency, observed interval)", () => {
  // C1
  it("C1 age 10 + interval 15 => healthy", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:45"), msAt("09:10"));
    expect(s.ageMinutes).toBe(10);
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).toBe("healthy");
  });

  // C2
  it("C2 age 30 + interval 40 => degraded", () => {
    const s = computeReminderSchedulerStatus(beat("08:30", "07:50"), msAt("09:00"));
    expect(s.ageMinutes).toBe(30);
    expect(s.observedIntervalMinutes).toBe(40);
    expect(s.status).toBe("degraded");
  });

  // C3 — the headline: recency looks perfect, cadence does not.
  it("C3 age 10 + interval 40 => degraded (NOT healthy)", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:20"), msAt("09:10"));
    expect(s.ageMinutes).toBe(10);
    expect(s.observedIntervalMinutes).toBe(40);
    expect(s.status).toBe("degraded");
  });

  // C4
  it("C4 age 10 + interval 46 => stale (critical-bound)", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:14"), msAt("09:10"));
    expect(s.ageMinutes).toBe(10);
    expect(s.observedIntervalMinutes).toBe(46);
    expect(s.status).toBe("stale");
  });

  // C5
  it("C5 age 31 + interval 15 => degraded", () => {
    const s = computeReminderSchedulerStatus(beat("08:29", "08:14"), msAt("09:00"));
    expect(s.ageMinutes).toBe(31);
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).toBe("degraded");
  });

  // C6
  it("C6 age 46 + interval 15 => stale", () => {
    const s = computeReminderSchedulerStatus(beat("08:14", "07:59"), msAt("09:00"));
    expect(s.ageMinutes).toBe(46);
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).toBe("stale");
  });

  it("the worse axis always wins, in both directions", () => {
    // recency worse than cadence
    expect(
      computeReminderSchedulerStatus(beat("08:00", "07:45"), msAt("09:00")).status,
    ).toBe("stale");
    // cadence worse than recency
    expect(
      computeReminderSchedulerStatus(beat("09:00", "08:00"), msAt("09:05")).status,
    ).toBe("stale");
  });

  it("a healthy cadence never rescues bad recency", () => {
    const s = computeReminderSchedulerStatus(beat("08:00", "07:45"), msAt("09:00"));
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).not.toBe("healthy");
  });
});

describe("P1-A backward compatibility and corrupt evidence", () => {
  // C7 — every heartbeat written before this hotfix has no previousSuccessAt.
  it("C7 old heartbeat shape still classifies on recency, and says so", () => {
    const healthy = computeReminderSchedulerStatus(beat("09:00"), msAt("09:10"));
    expect(healthy.status).toBe("healthy");
    expect(healthy.observedIntervalMinutes).toBeNull();
    expect(healthy.previousSuccessAt).toBeNull();
    expect(healthy.cadenceEvidence).toBe("unavailable");

    const stale = computeReminderSchedulerStatus(beat("08:00"), msAt("09:00"));
    expect(stale.status).toBe("stale");
    expect(stale.cadenceEvidence).toBe("unavailable");
  });

  it("C7b an old-shape heartbeat object with extra unknown keys still works", () => {
    const s = computeReminderSchedulerStatus(
      { at: isoAt("09:00"), emailAttempted: 3, smsFailed: 0 },
      msAt("09:10"),
    );
    expect(s.status).toBe("healthy");
    expect(s.cadenceEvidence).toBe("unavailable");
  });

  // C8 — never crash, never fabricate.
  it.each([
    ["unparseable", "not-a-timestamp"],
    ["empty", ""],
  ])("C8 %s previousSuccessAt => no crash, no fabricated interval", (_label, bad) => {
    const s = computeReminderSchedulerStatus(
      { at: isoAt("09:00"), previousSuccessAt: bad },
      msAt("09:10"),
    );
    expect(s.observedIntervalMinutes).toBeNull();
    expect(s.cadenceEvidence).toBe("unavailable");
    expect(s.status).toBe("healthy");
  });

  it("C8b a FUTURE-dated previousSuccessAt is corrupt, not a 0-minute interval", () => {
    const s = computeReminderSchedulerStatus(
      { at: isoAt("09:00"), previousSuccessAt: isoAt("09:30") },
      msAt("09:10"),
    );
    expect(s.observedIntervalMinutes).toBeNull();
    expect(s.cadenceEvidence).toBe("unavailable");
  });

  it("never claims cadence was proven when it was not", () => {
    const s = computeReminderSchedulerStatus(beat("09:00"), msAt("09:10"));
    expect(s.cadenceEvidence).not.toBe("measured");
  });
});

describe("P1-A safe details carry the cadence evidence, non-sensitively", () => {
  it("includes the interval scalars", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:20"), msAt("09:10"));
    const d = reminderSchedulerAlertSafeDetails(s, msAt("09:10"));
    expect(d.observed_interval_minutes).toBe(40);
    expect(d.previous_success_at).toBe(isoAt("08:20"));
    expect(d.cadence_evidence).toBe("measured");
  });

  it("reports nulls rather than invented values when evidence is absent", () => {
    const s = computeReminderSchedulerStatus(beat("09:00"), msAt("09:10"));
    const d = reminderSchedulerAlertSafeDetails(s, msAt("09:10"));
    expect(d.observed_interval_minutes).toBeNull();
    expect(d.previous_success_at).toBeNull();
    expect(d.cadence_evidence).toBe("unavailable");
  });

  it("the new fields introduce no secret or PII", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:20"), msAt("09:10"));
    const serialized = JSON.stringify(reminderSchedulerAlertSafeDetails(s, msAt("09:10")));
    expect(serialized).not.toMatch(
      /cron_secret|authorization|bearer|email|phone|\bname\b|client|token|message|body|reminder_text/i,
    );
  });
});
