import { describe, expect, it } from "vitest";

import { EMAIL_SWEEP_EXPECTED_INTERVAL_SECONDS, EMAIL_SWEEP_INTERVAL_MARGIN, HEALTH_THRESHOLDS, healthFindings, type EmailDeliveryHealth } from "@/lib/email/delivery-health";

// ===========================================================================
// DELIVERY-VISIBILITY-01 — which health rows warrant an operator finding.
// Each finding has a purpose-specific threshold; a healthy row raises none.
// ===========================================================================

const healthy: EmailDeliveryHealth = {
  pendingReceipts: 0,
  oldestPendingSeconds: null,
  exhausted24h: 0,
  quarantined24h: 0,
  unmatched24h: 12,
  unreportedAccepted: 0,
  openIncidents: 3,
  lastSweepAt: "2026-10-12T00:00:00.000Z",
  lastSweepFailed: 0,
};

const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const findings = (h: EmailDeliveryHealth) => healthFindings(h, undefined, NOW);

const events = (h: Partial<EmailDeliveryHealth>) => findings({ ...healthy, ...h }).map((f) => `${f.event}:${f.severity}`);

describe("healthFindings", () => {
  it("raises nothing for a healthy row, including unattributed events and open incidents", () => {
    // Unmatched events (untracked sends) and incidents are visible elsewhere;
    // neither means the delivery-event machinery itself is unhealthy.
    expect(findings(healthy)).toEqual([]);
  });

  it("calls a receipt backlog stale past fifteen minutes, and critical past six hours", () => {
    expect(events({ pendingReceipts: 2, oldestPendingSeconds: HEALTH_THRESHOLDS.stalePendingSeconds })).toEqual([]);
    expect(events({ pendingReceipts: 2, oldestPendingSeconds: HEALTH_THRESHOLDS.stalePendingSeconds + 1 })).toEqual([
      "email_delivery_backlog_stale:warning",
    ]);
    expect(events({ pendingReceipts: 2, oldestPendingSeconds: HEALTH_THRESHOLDS.criticalPendingSeconds + 1 })).toEqual([
      "email_delivery_backlog_stale:critical",
    ]);
  });

  it("separates exhausted receipts from other quarantines, so neither is counted twice", () => {
    expect(events({ exhausted24h: 2, quarantined24h: 2 })).toEqual(["email_delivery_receipts_exhausted:warning"]);
    expect(events({ exhausted24h: 1, quarantined24h: 3 })).toEqual([
      "email_delivery_receipts_exhausted:warning",
      "email_delivery_receipts_quarantined:warning",
    ]);
  });

  it("reports accepted emails with no report as unknown, never as delivered", () => {
    const [finding] = findings({ ...healthy, unreportedAccepted: 4 });
    expect(finding!.event).toBe("email_delivery_unreported");
    expect(finding!.message).toMatch(/unknown, not delivered/);
  });

  it("reports a sweep that failed to process events", () => {
    expect(events({ lastSweepFailed: 2 })).toEqual(["email_delivery_sweep_failing:warning"]);
  });
});


describe("sweep heartbeat age (4307828020)", () => {
  it("uses the held daily activation cadence with a two-interval margin", () => {
    expect(EMAIL_SWEEP_EXPECTED_INTERVAL_SECONDS).toBe(24 * 60 * 60);
    expect(EMAIL_SWEEP_INTERVAL_MARGIN).toBe(2);
    expect(HEALTH_THRESHOLDS.staleSweepSeconds).toBe(48 * 60 * 60);
  });

  it.each([null, "invalid timestamp"])("reports an absent/unusable heartbeat %s even with no backlog or failures", (lastSweepAt) => {
    const [finding] = findings({ ...healthy, lastSweepAt, lastSweepFailed: null });
    expect(finding).toMatchObject({ event: "email_delivery_sweep_stale", severity: "warning",
      details: { last_sweep_at: lastSweepAt, sweep_age_seconds: null,
        expected_interval_seconds: 86400, stale_after_seconds: 172800 } });
  });

  it("keeps a fresh and exact-boundary heartbeat healthy, warning only past the margin", () => {
    for (const age of [0, 86400, 172800]) {
      expect(events({ lastSweepAt: new Date(NOW - age * 1000).toISOString() })).toEqual([]);
    }
    const [finding] = findings({ ...healthy, lastSweepAt: new Date(NOW - 172801000).toISOString() });
    expect(finding).toMatchObject({ event: "email_delivery_sweep_stale", severity: "warning",
      details: { sweep_age_seconds: 172801, stale_after_seconds: 172800 } });
    expect(finding.message).toContain("48 hours");
  });

  it("does not hide last-run failures behind a fresh heartbeat or replace them with stale age", () => {
    expect(events({ lastSweepFailed: 2 })).toEqual(["email_delivery_sweep_failing:warning"]);
    expect(events({ lastSweepAt: null, lastSweepFailed: 2 })).toEqual([
      "email_delivery_sweep_failing:warning", "email_delivery_sweep_stale:warning",
    ]);
  });
});
