import { describe, expect, it } from "vitest";

import { HEALTH_THRESHOLDS, healthFindings, type EmailDeliveryHealth } from "@/lib/email/delivery-health";

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

const events = (h: Partial<EmailDeliveryHealth>) => healthFindings({ ...healthy, ...h }).map((f) => `${f.event}:${f.severity}`);

describe("healthFindings", () => {
  it("raises nothing for a healthy row, including unattributed events and open incidents", () => {
    // Unmatched events (untracked sends) and incidents are visible elsewhere;
    // neither means the delivery-event machinery itself is unhealthy.
    expect(healthFindings(healthy)).toEqual([]);
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
    const [finding] = healthFindings({ ...healthy, unreportedAccepted: 4 });
    expect(finding!.event).toBe("email_delivery_unreported");
    expect(finding!.message).toMatch(/unknown, not delivered/);
  });

  it("reports a sweep that failed to process events", () => {
    expect(events({ lastSweepFailed: 2 })).toEqual(["email_delivery_sweep_failing:warning"]);
  });
});
