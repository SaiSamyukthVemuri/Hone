import { describe, expect, it } from "vitest";
import {
  RECONCILE_STALE_AFTER_MINUTES,
  computeReconcileStatus,
  decideDeadRowAlert,
  decideReconcileAlert,
  deadRowAlertSafeDetails,
  reconcileAlertSafeDetails,
  reconcileHeartbeatFromRun,
  type ReconcileHeartbeat,
  type ReconcileSchedulerStatus,
} from "@/lib/google-calendar/sync/reconcile-heartbeat";
import type { ReconcileRunResult } from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — heartbeat outcome model + alert deciders + dead-row alert. Pure
// cores are deterministic (nowMs injected). Observability is fail-open.

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

function run(over: Partial<ReconcileRunResult> = {}): ReconcileRunResult {
  return {
    runStartedAtIso: new Date(NOW).toISOString(),
    outcome: "ok",
    eligibleStudios: 0,
    studiosSwept: 0,
    studiosCompleted: 0,
    studiosTruncated: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    studiosContinuationFailed: 0,
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

const status = (over: Partial<ReconcileSchedulerStatus>): ReconcileSchedulerStatus => ({
  status: "healthy",
  lastRunAt: new Date(NOW).toISOString(),
  outcome: "ok",
  ageMinutes: 1,
  staleAfterMinutes: RECONCILE_STALE_AFTER_MINUTES,
  ...over,
});

describe("computeReconcileStatus — recency AND outcome", () => {
  it("no heartbeat -> missing", () => {
    expect(computeReconcileStatus(null, NOW).status).toBe("missing");
  });
  it("recent + ok -> healthy", () => {
    const hb: ReconcileHeartbeat = { at: new Date(NOW - 60_000).toISOString(), outcome: "ok" };
    expect(computeReconcileStatus(hb, NOW).status).toBe("healthy");
  });
  it("recent + degraded -> degraded (NOT healthy just because recent)", () => {
    const hb: ReconcileHeartbeat = { at: new Date(NOW - 60_000).toISOString(), outcome: "degraded" };
    expect(computeReconcileStatus(hb, NOW).status).toBe("degraded");
  });
  it("recent + error -> error", () => {
    const hb: ReconcileHeartbeat = { at: new Date(NOW - 60_000).toISOString(), outcome: "error" };
    expect(computeReconcileStatus(hb, NOW).status).toBe("error");
  });
  it("old -> stale regardless of outcome", () => {
    const hb: ReconcileHeartbeat = { at: new Date(NOW - (RECONCILE_STALE_AFTER_MINUTES + 5) * 60_000).toISOString(), outcome: "ok" };
    expect(computeReconcileStatus(hb, NOW).status).toBe("stale");
  });
});

describe("decideReconcileAlert", () => {
  it("healthy -> none", () => {
    expect(decideReconcileAlert(status({ status: "healthy" }), false)).toEqual({ shouldAlert: false, reason: "healthy" });
  });
  it("error/missing -> critical; degraded/stale -> warning", () => {
    expect(decideReconcileAlert(status({ status: "error", outcome: "error" }), false)).toMatchObject({ severity: "critical", event: "calendar_reconcile_error" });
    expect(decideReconcileAlert(status({ status: "missing", outcome: null }), false)).toMatchObject({ severity: "critical", event: "calendar_reconcile_missing" });
    expect(decideReconcileAlert(status({ status: "degraded", outcome: "degraded" }), false)).toMatchObject({ severity: "warning", event: "calendar_reconcile_degraded" });
    expect(decideReconcileAlert(status({ status: "stale" }), false)).toMatchObject({ severity: "warning", event: "calendar_reconcile_stale" });
  });
  it("unresolved existing alert -> deduped", () => {
    expect(decideReconcileAlert(status({ status: "degraded", outcome: "degraded" }), true)).toEqual({ shouldAlert: false, reason: "deduped" });
  });
});

describe("PHI-free payloads", () => {
  it("heartbeat carries only aggregate scalars + outcome", () => {
    const hb = reconcileHeartbeatFromRun(run({ outcome: "degraded", enqueued: 3, studiosTruncated: 1 }), {
      at: new Date(NOW).toISOString(),
      startedAt: new Date(NOW - 5000).toISOString(),
      durationMs: 5000,
    });
    expect(hb).toMatchObject({ outcome: "degraded", enqueued: 3, studiosTruncated: 1 });
    expect(JSON.stringify(hb)).not.toMatch(/@|client|name|email|phone|token|google_event|calendar_id/i);
  });
  it("alert safe details are scalars only", () => {
    const d = reconcileAlertSafeDetails(status({ status: "degraded", outcome: "degraded" }), NOW);
    expect(JSON.stringify(d)).not.toMatch(/@|client|name|email|phone|token/i);
    expect(d).toMatchObject({ status: "degraded", outcome: "degraded" });
  });
});

describe("§8 dead-row alert deciders", () => {
  it("no dead rows -> no alert", () => {
    expect(decideDeadRowAlert(0, false)).toEqual({ shouldAlert: false });
  });
  it("dead rows + no unresolved -> alert; + unresolved -> deduped", () => {
    expect(decideDeadRowAlert(3, false)).toEqual({ shouldAlert: true });
    expect(decideDeadRowAlert(3, true)).toEqual({ shouldAlert: false });
  });
  it("safe details carry only studio_id + count + timestamp", () => {
    const d = deadRowAlertSafeDetails("studio-1", 4, NOW);
    expect(Object.keys(d).sort()).toEqual(["checked_at", "dead_count", "studio_id"]);
    expect(JSON.stringify(d)).not.toMatch(/@|client|name|email|phone|token|google_event/i);
  });
});
