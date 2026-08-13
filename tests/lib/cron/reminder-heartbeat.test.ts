import { describe, expect, it } from "vitest";
import {
  computeReminderSchedulerStatus,
  decideReminderSchedulerAlert,
  reminderSchedulerAlertEventFor,
  reminderSchedulerAlertSafeDetails,
  isAtLeastAsSevere,
  mergeReminderHeartbeat,
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
        "failing_axis",
        "invoked_at",
        "last_success_at",
        "observed_interval_minutes",
        "previous_invoked_at",
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
// Cadence is invocation-to-invocation. For these classifier tests the run is
// treated as instantaneous (invokedAt == completion) unless a test says
// otherwise, so the existing expectations keep their meaning.
const beat = (lastSuccess: string, previousSuccess?: string): ReminderHeartbeat => ({
  at: isoAt(lastSuccess),
  invokedAt: isoAt(lastSuccess),
  ...(previousSuccess ? { previousInvokedAt: isoAt(previousSuccess) } : {}),
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
  // C7 — every heartbeat written before this hotfix has no previousInvokedAt.
  it("C7 old heartbeat shape still classifies on recency, and says so", () => {
    const healthy = computeReminderSchedulerStatus(beat("09:00"), msAt("09:10"));
    expect(healthy.status).toBe("healthy");
    expect(healthy.observedIntervalMinutes).toBeNull();
    expect(healthy.previousInvokedAt).toBeNull();
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
  ])("C8 %s previousInvokedAt => no crash, no fabricated interval", (_label, bad) => {
    const s = computeReminderSchedulerStatus(
      { at: isoAt("09:00"), previousInvokedAt: bad },
      msAt("09:10"),
    );
    expect(s.observedIntervalMinutes).toBeNull();
    expect(s.cadenceEvidence).toBe("unavailable");
    expect(s.status).toBe("healthy");
  });

  it("C8b a FUTURE-dated previousInvokedAt is corrupt, not a 0-minute interval", () => {
    const s = computeReminderSchedulerStatus(
      { at: isoAt("09:00"), previousInvokedAt: isoAt("09:30") },
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
    expect(d.previous_invoked_at).toBe(isoAt("08:20"));
    expect(d.cadence_evidence).toBe("measured");
  });

  it("reports nulls rather than invented values when evidence is absent", () => {
    const s = computeReminderSchedulerStatus(beat("09:00"), msAt("09:10"));
    const d = reminderSchedulerAlertSafeDetails(s, msAt("09:10"));
    expect(d.observed_interval_minutes).toBeNull();
    expect(d.previous_invoked_at).toBeNull();
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

// ---------------------------------------------------------------------------
// OPS-01.1 follow-up, Codex review 3774838345 (P2):
// the reported cause must match the axis that actually failed. A cadence-only
// failure previously read "last success was over 30 minutes ago" while the same
// alert displayed an age of 10 minutes.
// ---------------------------------------------------------------------------
describe("failing axis is attributed, so operator copy cannot contradict itself", () => {
  it("cadence-only failure is attributed to cadence, not recency", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:20"), msAt("09:10"));
    expect(s.ageMinutes).toBe(10);
    expect(s.observedIntervalMinutes).toBe(40);
    expect(s.status).toBe("degraded");
    expect(s.failingAxis).toBe("cadence");
  });

  it("recency-only failure is attributed to recency", () => {
    const s = computeReminderSchedulerStatus(beat("08:00", "07:45"), msAt("09:00"));
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.failingAxis).toBe("recency");
  });

  it("both-bad is attributed to both", () => {
    const s = computeReminderSchedulerStatus(beat("08:00", "07:00"), msAt("09:00"));
    expect(s.failingAxis).toBe("both");
  });

  it("healthy and missing have no failing axis", () => {
    expect(
      computeReminderSchedulerStatus(beat("09:00", "08:45"), msAt("09:10")).failingAxis,
    ).toBeNull();
    expect(computeReminderSchedulerStatus(null, msAt("09:00")).failingAxis).toBeNull();
  });

  it("no-cadence-evidence failures attribute to recency (never a phantom cadence)", () => {
    const s = computeReminderSchedulerStatus(beat("08:00"), msAt("09:00"));
    expect(s.cadenceEvidence).toBe("unavailable");
    expect(s.failingAxis).toBe("recency");
  });

  it("safe_details carry the attribution", () => {
    const s = computeReminderSchedulerStatus(beat("09:00", "08:20"), msAt("09:10"));
    expect(reminderSchedulerAlertSafeDetails(s, msAt("09:10")).failing_axis).toBe(
      "cadence",
    );
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 follow-up, Codex review 3775029882 (P2):
// classify the RAW elapsed interval, not a rounded minute count. Math.round
// pulled 30:01-30:29 back to 30 (healthy) and 45:01-45:29 back to 45
// (degraded), letting a genuinely over-threshold gap dodge its classification
// — and, at the stale boundary, dodge the operator email.
// ---------------------------------------------------------------------------
describe("sub-minute precision at the threshold boundaries", () => {
  const at = (msFromEpoch: number) => new Date(msFromEpoch).toISOString();
  const T0 = Date.parse("2026-08-13T09:00:00.000Z");
  const MIN = 60_000;

  // CADENCE axis — the reported case.
  it.each([
    ["exactly 30:00", 30 * MIN, "healthy"],
    ["30:01", 30 * MIN + 1_000, "degraded"],
    ["30:29 (would round DOWN to 30)", 30 * MIN + 29_000, "degraded"],
    ["exactly 45:00", 45 * MIN, "degraded"],
    ["45:01", 45 * MIN + 1_000, "stale"],
    ["45:29 (would round DOWN to 45)", 45 * MIN + 29_000, "stale"],
  ])("cadence interval %s => %s", (_label, deltaMs, expected) => {
    const s = computeReminderSchedulerStatus(
      { at: at(T0), invokedAt: at(T0), previousInvokedAt: at(T0 - (deltaMs as number)) },
      T0 + 60_000, // recency healthy, so cadence alone decides
    );
    expect(s.status).toBe(expected);
  });

  // RECENCY axis — the same rounding bug existed here since #569.
  it.each([
    ["exactly 30:00", 30 * MIN, "healthy"],
    ["30:29 (would round DOWN to 30)", 30 * MIN + 29_000, "degraded"],
    ["exactly 45:00", 45 * MIN, "degraded"],
    ["45:29 (would round DOWN to 45)", 45 * MIN + 29_000, "stale"],
  ])("recency age %s => %s", (_label, deltaMs, expected) => {
    const s = computeReminderSchedulerStatus(
      { at: at(T0) },
      T0 + (deltaMs as number),
    );
    expect(s.status).toBe(expected);
  });

  it("the DISPLAYED value is still a friendly rounded minute count", () => {
    const s = computeReminderSchedulerStatus(
      { at: at(T0), invokedAt: at(T0), previousInvokedAt: at(T0 - (30 * MIN + 29_000)) },
      T0 + 60_000,
    );
    // classification used the raw interval...
    expect(s.status).toBe("degraded");
    // ...while the operator-facing number stays readable.
    expect(s.observedIntervalMinutes).toBe(30);
  });

  it("a 29:59 interval is still healthy (no over-correction)", () => {
    const s = computeReminderSchedulerStatus(
      { at: at(T0), invokedAt: at(T0), previousInvokedAt: at(T0 - (29 * MIN + 59_000)) },
      T0 + 60_000,
    );
    expect(s.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 — Codex review 3775042692 (P2):
// scheduler cadence is INVOCATION-to-INVOCATION, never completion-to-completion.
// ---------------------------------------------------------------------------
describe("P2-A: cadence comes from invocation times, not completion times", () => {
  const T = (s: string) => `2026-08-13T${s}.000Z`;
  const M = (s: string) => Date.parse(T(s));

  // The reported scenario.
  //   run A invoked 10:00:00, completed 10:02:00
  //   run B invoked 10:31:00, completed 10:32:00
  //   real scheduler interval = 31 min  => degraded
  //   completion-to-completion = 30 min => would have read healthy
  it("a 31-minute scheduler interval is degraded even though completions are 30 apart", () => {
    const s = computeReminderSchedulerStatus(
      {
        at: T("10:32:00"),
        invokedAt: T("10:31:00"),
        previousInvokedAt: T("10:00:00"),
      },
      M("10:33:00"),
    );
    expect(s.observedIntervalMinutes).toBe(31);
    expect(s.status).toBe("degraded");
  });

  it("completion spacing of exactly 30 does not rescue it", () => {
    const completionSpacingMinutes =
      (M("10:32:00") - M("10:02:00")) / 60000;
    expect(completionSpacingMinutes).toBe(30); // the misleading number
  });

  // The reverse direction: on-time invocations must stay healthy no matter how
  // long the runs themselves take.
  it("invocations exactly 30 min apart are healthy even with very different durations", () => {
    const s = computeReminderSchedulerStatus(
      {
        at: T("10:30:10"), // run B took 10s
        invokedAt: T("10:30:00"),
        previousInvokedAt: T("10:00:00"), // run A took 5 min
      },
      M("10:31:00"),
    );
    expect(s.observedIntervalMinutes).toBe(30);
    expect(s.status).toBe("healthy");
  });

  it("a slow run cannot fabricate a slow scheduler", () => {
    // A invoked 10:00 and took 14 minutes; B invoked 10:15 and took 10s.
    // Completion-to-completion would be ~1 minute — also wrong, in the other
    // direction. Invocation spacing is the only honest number.
    const s = computeReminderSchedulerStatus(
      { at: T("10:15:10"), invokedAt: T("10:15:00"), previousInvokedAt: T("10:00:00") },
      M("10:16:00"),
    );
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).toBe("healthy");
  });

  it("a legacy heartbeat (no invocation fields) reports cadence unavailable", () => {
    const s = computeReminderSchedulerStatus({ at: T("10:30:00") }, M("10:31:00"));
    expect(s.cadenceEvidence).toBe("unavailable");
    expect(s.observedIntervalMinutes).toBeNull();
    expect(s.status).toBe("healthy"); // recency only, truthfully
  });

  it("an invocation-bearing heartbeat with no predecessor is still unavailable", () => {
    const s = computeReminderSchedulerStatus(
      { at: T("10:30:00"), invokedAt: T("10:29:00") },
      M("10:31:00"),
    );
    expect(s.cadenceEvidence).toBe("unavailable");
    expect(s.invokedAt).toBe(T("10:29:00"));
    expect(s.previousInvokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 — Codex review 3775070631 (P2):
// the heartbeat update must be monotonic under overlapping runs. Redis
// completion order is NOT invocation order.
// ---------------------------------------------------------------------------
describe("P2-B: monotonic heartbeat merge", () => {
  const T = (s: string) => `2026-08-13T${s}.000Z`;
  const run = (invoked: string, completed: string): ReminderHeartbeat => ({
    at: T(completed),
    invokedAt: T(invoked),
  });

  // RACE 1 — B's Redis update lands first, A's arrives afterwards.
  it("RACE 1: a late-arriving OLDER invocation does not regress the cadence point", () => {
    const A = run("10:00:00", "10:02:00");
    const B = run("10:15:00", "10:16:00");
    const afterB = mergeReminderHeartbeat(null, B);
    const afterA = mergeReminderHeartbeat(afterB, A);
    expect(afterA.invokedAt).toBe(T("10:15:00")); // never regresses to 10:00
    expect(afterA.previousInvokedAt).toBe(T("10:00:00"));
  });

  it("RACE 1b: the in-order arrival produces the same cadence state", () => {
    const A = run("10:00:00", "10:02:00");
    const B = run("10:15:00", "10:16:00");
    const inOrder = mergeReminderHeartbeat(mergeReminderHeartbeat(null, A), B);
    expect(inOrder.invokedAt).toBe(T("10:15:00"));
    expect(inOrder.previousInvokedAt).toBe(T("10:00:00"));
  });

  // RACE 2 — completion order differs from invocation order.
  it("RACE 2: cadence is 15 min regardless of which run finished first", () => {
    // A invoked 10:00 but finished at 10:20; B invoked 10:15 and finished 10:16.
    const A = run("10:00:00", "10:20:00");
    const B = run("10:15:00", "10:16:00");
    const merged = mergeReminderHeartbeat(mergeReminderHeartbeat(null, B), A);
    const s = computeReminderSchedulerStatus(merged, Date.parse(T("10:21:00")));
    expect(s.observedIntervalMinutes).toBe(15);
    expect(s.status).toBe("healthy");
    // recency followed the LATER completion, so it never moved backwards
    expect(merged.at).toBe(T("10:20:00"));
  });

  it("RACE 2b: recency never moves backwards when an older completion arrives late", () => {
    const newer = run("10:15:00", "10:16:00");
    const olderCompletion = run("10:00:00", "10:02:00");
    const merged = mergeReminderHeartbeat(
      mergeReminderHeartbeat(null, newer),
      olderCompletion,
    );
    expect(merged.at).toBe(T("10:16:00"));
  });

  // RACE 3 — idempotency.
  it("RACE 3: replaying the same update is non-regressive", () => {
    const A = run("10:00:00", "10:02:00");
    const B = run("10:15:00", "10:16:00");
    const once = mergeReminderHeartbeat(mergeReminderHeartbeat(null, A), B);
    const twice = mergeReminderHeartbeat(once, B);
    const thrice = mergeReminderHeartbeat(twice, B);
    expect(thrice.at).toBe(once.at);
    expect(thrice.invokedAt).toBe(once.invokedAt);
    expect(thrice.previousInvokedAt).toBe(once.previousInvokedAt);
  });

  // RACE 4 — no readable prior state must not suppress this run's recency.
  it("RACE 4: an absent or corrupt current value still records the new success", () => {
    const B = run("10:15:00", "10:16:00");
    const fromNothing = mergeReminderHeartbeat(null, B);
    expect(fromNothing.at).toBe(T("10:16:00"));
    expect(fromNothing.invokedAt).toBe(T("10:15:00"));

    const fromCorrupt = mergeReminderHeartbeat({ at: "not-a-date" }, B);
    expect(fromCorrupt.at).toBe(T("10:16:00"));
  });

  it("a legacy stored value (no invocation) is upgraded by the first new run", () => {
    const legacy: ReminderHeartbeat = { at: T("10:00:00") };
    const B = run("10:15:00", "10:16:00");
    const merged = mergeReminderHeartbeat(legacy, B);
    expect(merged.invokedAt).toBe(T("10:15:00"));
    // no invocation predecessor can be honestly reconstructed from a bare `at`
    expect(merged.previousInvokedAt).toBeUndefined();
    expect(
      computeReminderSchedulerStatus(merged, Date.parse(T("10:17:00")))
        .cadenceEvidence,
    ).toBe("unavailable");
  });

  it("an out-of-order arrival improves the predecessor when it is closer", () => {
    // stored: latest 10:30, previous 10:00. A 10:15 invocation arrives late —
    // it is the true immediate predecessor of 10:30.
    const stored: ReminderHeartbeat = {
      at: T("10:31:00"),
      invokedAt: T("10:30:00"),
      previousInvokedAt: T("10:00:00"),
    };
    const merged = mergeReminderHeartbeat(stored, run("10:15:00", "10:16:00"));
    expect(merged.invokedAt).toBe(T("10:30:00"));
    expect(merged.previousInvokedAt).toBe(T("10:15:00"));
  });

  it("a far-older straggler does not worsen a good predecessor", () => {
    const stored: ReminderHeartbeat = {
      at: T("10:31:00"),
      invokedAt: T("10:30:00"),
      previousInvokedAt: T("10:15:00"),
    };
    const merged = mergeReminderHeartbeat(stored, run("10:00:00", "10:01:00"));
    expect(merged.previousInvokedAt).toBe(T("10:15:00"));
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 — Codex review 3775193411 (P2):
// timestamps must be shape-validated before any ordering comparison. Canonical
// ISO strings sort chronologically, but a corrupt-yet-valid-JSON value like
// "not-a-date" sorts AFTER every real "2026-..." timestamp — so a naive
// comparison would keep the corrupt value forever and the heartbeat could never
// self-heal.
// ---------------------------------------------------------------------------
describe("P2: a corrupt stored heartbeat is replaced, not preserved", () => {
  const T = (s: string) => `2026-08-13T${s}.000Z`;
  const good: ReminderHeartbeat = {
    at: T("10:16:00"),
    invokedAt: T("10:15:00"),
  };

  it("lexicographic order alone would keep the corrupt value (the defect)", () => {
    // Demonstrates why the guard is required, not that the code does this.
    expect(T("10:16:00") >= "not-a-date").toBe(false);
  });

  it("a corrupt `at` is replaced by the successful run", () => {
    const merged = mergeReminderHeartbeat({ at: "not-a-date" }, good);
    expect(merged.at).toBe(T("10:16:00"));
    expect(merged.invokedAt).toBe(T("10:15:00"));
  });

  it("a corrupt `at` AND `invokedAt` are both replaced", () => {
    const merged = mergeReminderHeartbeat(
      { at: "not-a-date", invokedAt: "not-a-date" },
      good,
    );
    expect(merged.at).toBe(T("10:16:00"));
    expect(merged.invokedAt).toBe(T("10:15:00"));
  });

  it("a valid `at` with a corrupt `invokedAt` still adopts the new invocation", () => {
    const merged = mergeReminderHeartbeat(
      { at: T("10:00:00"), invokedAt: "not-a-date" },
      good,
    );
    expect(merged.invokedAt).toBe(T("10:15:00"));
  });

  it("a corrupt `previousInvokedAt` does not poison the cadence axis", () => {
    const merged = mergeReminderHeartbeat(
      { at: T("10:00:00"), invokedAt: T("10:00:00"), previousInvokedAt: "junk" },
      good,
    );
    expect(merged.invokedAt).toBe(T("10:15:00"));
    expect(merged.previousInvokedAt).toBe(T("10:00:00"));
    const s = computeReminderSchedulerStatus(merged, Date.parse(T("10:17:00")));
    expect(s.observedIntervalMinutes).toBe(15);
  });

  it("the heartbeat can therefore self-heal on the very next successful run", () => {
    const healed = mergeReminderHeartbeat({ at: "not-a-date" }, good);
    const s = computeReminderSchedulerStatus(healed, Date.parse(T("10:17:00")));
    expect(s.status).not.toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// OPS-01.1 — Codex review 3775413510 (P2): a digit-shaped IMPOSSIBLE date must
// not be treated as orderable. "9999-99-99T99:99:99.000Z" matches a naive
// prefix pattern and sorts after every real timestamp, so it would wedge the
// heartbeat exactly like "not-a-date" did.
// ---------------------------------------------------------------------------
describe("P2: impossible dates are rejected, not merely ill-shaped ones", () => {
  const T = (s: string) => `2026-08-13T${s}.000Z`;
  const good: ReminderHeartbeat = { at: T("10:16:00"), invokedAt: T("10:15:00") };

  it("the impossible value sorts AFTER a real one (why it is dangerous)", () => {
    expect("9999-99-99T99:99:99.000Z" >= T("10:16:00")).toBe(true);
  });

  it.each([
    "9999-99-99T99:99:99.000Z",
    "2026-13-01T00:00:00.000Z", // month 13
    "2026-00-10T00:00:00.000Z", // month 0
    "2026-08-00T00:00:00.000Z", // day 0
    "2026-08-13T25:00:00.000Z", // hour 25
    "2026-08-13T10:60:00.000Z", // minute 60
    "2026-08-13T10:00:60.000Z", // second 60
  ])("a stored `at` of %s is replaced by a successful run", (bad) => {
    const merged = mergeReminderHeartbeat({ at: bad }, good);
    expect(merged.at).toBe(T("10:16:00"));
    expect(merged.invokedAt).toBe(T("10:15:00"));
  });

  it("an impossible invokedAt does not block the cadence point", () => {
    const merged = mergeReminderHeartbeat(
      { at: T("10:00:00"), invokedAt: "9999-99-99T99:99:99.000Z" },
      good,
    );
    expect(merged.invokedAt).toBe(T("10:15:00"));
  });

  it("health recovers rather than staying missing", () => {
    const healed = mergeReminderHeartbeat({ at: "9999-99-99T99:99:99.000Z" }, good);
    const s = computeReminderSchedulerStatus(healed, Date.parse(T("10:17:00")));
    expect(s.status).not.toBe("missing");
  });

  it("genuinely valid timestamps are still accepted (no over-correction)", () => {
    const merged = mergeReminderHeartbeat({ at: T("10:00:00") }, good);
    expect(merged.at).toBe(T("10:16:00"));
  });
});
