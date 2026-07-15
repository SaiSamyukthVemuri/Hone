import { describe, expect, it } from "vitest";
import {
  RECONCILE_STALE_AFTER_MINUTES,
  computeReconcileStatus,
  decideReconcileAlert,
  reconcileAlertSafeDetails,
  reconcileHeartbeatFromRun,
  type ReconcileHeartbeat,
} from "@/lib/google-calendar/sync/reconcile-heartbeat";
import type { ReconcileRunResult } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — heartbeat classifier + alert decider + PHI-free payloads.
// Observability is FAIL-OPEN; these pure cores are deterministic (nowMs injected).

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

function run(over: Partial<ReconcileRunResult> = {}): ReconcileRunResult {
  return {
    runStartedAtIso: new Date(NOW).toISOString(),
    eligibleStudios: 0,
    studiosSwept: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    errors: 0,
    byClass: { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 },
    results: [],
    ...over,
  };
}

describe("computeReconcileStatus", () => {
  it("no heartbeat -> missing", () => {
    expect(computeReconcileStatus(null, NOW).status).toBe("missing");
    expect(computeReconcileStatus({ at: "not-a-date", outcome: "ok" }, NOW).status).toBe("missing");
  });
  it("recent -> healthy", () => {
    const hb: ReconcileHeartbeat = { at: new Date(NOW - 60_000).toISOString(), outcome: "ok" };
    const s = computeReconcileStatus(hb, NOW);
    expect(s.status).toBe("healthy");
    expect(s.ageMinutes).toBe(1);
  });
  it("older than the stale threshold -> stale", () => {
    const hb: ReconcileHeartbeat = {
      at: new Date(NOW - (RECONCILE_STALE_AFTER_MINUTES + 5) * 60_000).toISOString(),
      outcome: "ok",
    };
    expect(computeReconcileStatus(hb, NOW).status).toBe("stale");
  });
});

describe("decideReconcileAlert", () => {
  const stale = { status: "stale" as const, lastRunAt: "x", ageMinutes: 9999, staleAfterMinutes: 1 };
  const missing = { status: "missing" as const, lastRunAt: null, ageMinutes: null, staleAfterMinutes: 1 };
  const healthy = { status: "healthy" as const, lastRunAt: "x", ageMinutes: 1, staleAfterMinutes: 1 };

  it("healthy -> no alert", () => {
    expect(decideReconcileAlert(healthy, false)).toEqual({ shouldAlert: false, reason: "healthy" });
  });
  it("missing + no dupe -> critical", () => {
    expect(decideReconcileAlert(missing, false)).toEqual({
      shouldAlert: true,
      event: "calendar_reconcile_missing",
      severity: "critical",
    });
  });
  it("stale + no dupe -> warning", () => {
    expect(decideReconcileAlert(stale, false)).toEqual({
      shouldAlert: true,
      event: "calendar_reconcile_stale",
      severity: "warning",
    });
  });
  it("unhealthy but an unresolved alert exists -> deduped", () => {
    expect(decideReconcileAlert(stale, true)).toEqual({ shouldAlert: false, reason: "deduped" });
    expect(decideReconcileAlert(missing, true)).toEqual({ shouldAlert: false, reason: "deduped" });
  });
});

describe("PHI-free payloads", () => {
  it("reconcileHeartbeatFromRun carries only aggregate scalars", () => {
    const hb = reconcileHeartbeatFromRun(
      run({ eligibleStudios: 2, enqueued: 3, superseded: 1, studiosSkippedUnavailable: 1 }),
      { at: new Date(NOW).toISOString(), durationMs: 42, outcome: "ok" },
    );
    expect(hb).toMatchObject({ outcome: "ok", eligibleStudios: 2, enqueued: 3, superseded: 1, studiosSkippedUnavailable: 1 });
    const blob = JSON.stringify(hb);
    expect(blob).not.toMatch(/@|client|name|email|phone|token|calendar_id|google_event/i);
  });

  it("reconcileAlertSafeDetails carries only status + timing scalars", () => {
    const d = reconcileAlertSafeDetails(
      { status: "stale", lastRunAt: new Date(NOW).toISOString(), ageMinutes: 100, staleAfterMinutes: 1 },
      NOW,
    );
    expect(Object.keys(d).sort()).toEqual(["age_minutes", "checked_at", "last_run_at", "stale_after_minutes", "status"]);
    expect(JSON.stringify(d)).not.toMatch(/@|client|name|email|phone|token/i);
  });
});
