import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileRunResult } from "@/lib/google-calendar/sync/reconcile";
import type { DeadRowSweepResult } from "@/lib/google-calendar/sync/reconcile-heartbeat";

// Phase B2.3-b: the reconcile route flow (§5/§6/§11/§12). Dependencies are mocked so
// the Case A/B/C control flow + heartbeat tiers are proven directly. finalHeartbeatOutcome
// and reconcileHeartbeatFromRun stay REAL (via importActual).

const h = vi.hoisted(() => ({
  runReconciliation: vi.fn(),
  sweepCalendarDeadRowAlerts: vi.fn(),
  recordReconcileRun: vi.fn(async (_i?: unknown) => {}),
  pruneMetricEvents: vi.fn(async () => 3),
  recordOpsAlert: vi.fn(async (_i?: unknown) => {}),
  // PR OPS-01: this route now also evaluates reminder-scheduler health in a
  // `finally`. Mocked here so these cases stay about RECONCILE behaviour,
  // unmocked it reads an unconfigured Upstash, classifies "missing", and adds
  // a second recordOpsAlert call to every case. The wiring itself is proven in
  // tests/app/cron/reminder-heartbeat-wiring.test.ts.
  recordReminderSchedulerHealthAlert: vi.fn(async () => ({
    status: "healthy" as const,
    alerted: false,
    deduped: false,
  })),
}));

vi.mock("@/lib/cron/auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("@/lib/cron/reminder-heartbeat", async (io) => ({
  ...(await (io() as Promise<object>)),
  recordReminderSchedulerHealthAlert: h.recordReminderSchedulerHealthAlert,
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: h.recordOpsAlert }));
vi.mock("@/lib/google-calendar/sync/reconcile", async (io) => ({ ...(await (io() as Promise<object>)), runReconciliation: h.runReconciliation }));
vi.mock("@/lib/google-calendar/sync/reconcile-store", () => ({
  createSupabaseReconcileStore: () => ({}),
  createReconcileObservability: () => ({}),
  pruneMetricEvents: h.pruneMetricEvents,
}));
vi.mock("@/lib/google-calendar/sync/reconcile-lock", () => ({
  createUpstashReconcileLock: () => ({}),
  createUpstashReconcileCoordinator: () => ({}),
  createUpstashReconcileDeadAlertCoordinator: () => ({}),
}));
vi.mock("@/lib/google-calendar/sync/reconcile-continuation", () => ({ createUpstashReconcileContinuationStore: () => ({}) }));
vi.mock("@/lib/google-calendar/sync/reconcile-heartbeat", async (io) => ({
  ...(await (io() as Promise<object>)),
  recordReconcileRun: h.recordReconcileRun,
  sweepCalendarDeadRowAlerts: h.sweepCalendarDeadRowAlerts,
}));

import { GET } from "@/app/api/cron/calendar-reconcile/route";

function runResult(over: Partial<ReconcileRunResult> = {}): ReconcileRunResult {
  return {
    runStartedAtIso: "2026-07-15T00:00:00.000Z",
    outcome: "ok",
    coordinatorSkipped: null,
    coordinatorLost: false,
    cursorReadFailed: false,
    cursorPersistFailed: false,
    eligibleStudios: 0,
    studiosAttempted: 0,
    studiosCompleted: 0,
    studiosTruncated: 0,
    studiosDeferred: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    studiosContinuationFailed: 0,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    intentVerifyFailed: 0,
    errors: 0,
    byClass: { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 },
    results: [],
    ...over,
  };
}
const deadResult = (over: Partial<DeadRowSweepResult> = {}): DeadRowSweepResult => ({
  outcome: "completed",
  coordinatorStatus: "ok",
  studios: 0,
  alerted: 0,
  deduped: 0,
  deferred: false,
  cursor: null,
  ...over,
});
const req = () => new Request("http://x/api/cron/calendar-reconcile");
const hbOutcome = () => (h.recordReconcileRun.mock.calls[0]?.[0] as { outcome: string } | undefined)?.outcome;

beforeEach(() => {
  for (const f of Object.values(h)) (f as ReturnType<typeof vi.fn>).mockClear();
  h.pruneMetricEvents.mockResolvedValue(3);
  h.sweepCalendarDeadRowAlerts.mockResolvedValue(deadResult());
});

describe("Case A: main coordinator HELD", () => {
  it("returns 202 skipped_held; writes NO heartbeat, runs NO sweep, prunes NOTHING; emits a signal", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ coordinatorSkipped: "held", outcome: "ok" }));
    const res = await GET(req());
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ ok: true, outcome: "skipped_held", coordinator_skipped: "held" });
    expect(h.recordReconcileRun).not.toHaveBeenCalled(); // stale heartbeat is NOT refreshed
    expect(h.sweepCalendarDeadRowAlerts).not.toHaveBeenCalled();
    expect(h.pruneMetricEvents).not.toHaveBeenCalled();
    expect(h.recordOpsAlert).toHaveBeenCalledTimes(1);
    expect((h.recordOpsAlert.mock.calls[0][0] as { event: string }).event).toBe("calendar_reconcile_skipped_held");
  });
});

describe("Case B: main coordinator UNAVAILABLE", () => {
  it("returns degraded; no maintenance, no successful heartbeat", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ coordinatorSkipped: "unavailable", outcome: "degraded" }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: false, outcome: "degraded", coordinator_skipped: "unavailable" });
    expect(h.recordReconcileRun).not.toHaveBeenCalled();
    expect(h.sweepCalendarDeadRowAlerts).not.toHaveBeenCalled();
    expect(h.pruneMetricEvents).not.toHaveBeenCalled();
  });
});

describe("Case C: the main reconciliation ran", () => {
  it("run ok + dead-row completed -> heartbeat ok; prune + sweep both run", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    h.sweepCalendarDeadRowAlerts.mockResolvedValue(deadResult({ outcome: "completed" }));
    const res = await GET(req());
    expect(await res.json().then((b: { outcome: string; ok: boolean }) => b)).toMatchObject({ outcome: "ok", ok: true });
    expect(h.pruneMetricEvents).toHaveBeenCalledTimes(1);
    expect(h.sweepCalendarDeadRowAlerts).toHaveBeenCalledTimes(1);
    expect(h.recordReconcileRun).toHaveBeenCalledTimes(1);
    expect(hbOutcome()).toBe("ok");
  });

  it("run ok + dead-row UNAVAILABLE -> heartbeat degraded", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    h.sweepCalendarDeadRowAlerts.mockResolvedValue(deadResult({ outcome: "unavailable", coordinatorStatus: "unavailable" }));
    await GET(req());
    expect(hbOutcome()).toBe("degraded");
  });

  it("run ok + dead-row ERROR -> heartbeat degraded (error reserved for reconciliation failure)", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    h.sweepCalendarDeadRowAlerts.mockResolvedValue(deadResult({ outcome: "error", errorClass: "Error" }));
    await GET(req());
    expect(hbOutcome()).toBe("degraded");
  });

  it("run ok + dead-row deferred -> heartbeat degraded; a signal is emitted", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    h.sweepCalendarDeadRowAlerts.mockResolvedValue(deadResult({ outcome: "deferred", deferred: true, cursor: "s5" }));
    await GET(req());
    expect(hbOutcome()).toBe("degraded");
    expect((h.recordOpsAlert.mock.calls.at(-1)![0] as { event: string }).event).toBe("calendar_dead_alert_incomplete");
  });

  it("run degraded + dead-row completed -> heartbeat degraded", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "degraded", studiosDeferred: 2 }));
    await GET(req());
    expect(hbOutcome()).toBe("degraded");
  });

  it("run error -> heartbeat error", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "error" }));
    await GET(req());
    expect(hbOutcome()).toBe("error");
  });
});

describe("reconciliation-run failure", () => {
  it("runReconciliation throws -> 500, cron_route_failed + error heartbeat", async () => {
    h.runReconciliation.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(h.recordOpsAlert).toHaveBeenCalled();
    expect((h.recordOpsAlert.mock.calls[0][0] as { event: string }).event).toBe("cron_route_failed");
    expect(hbOutcome()).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// PR OPS-01. This cron is one of three independent detectors for a dead
// external reminder scheduler. The detection value comes entirely from it
// running on EVERY exit path, including the early returns that bypass the
// reconciliation work, so it is asserted here behaviourally, not just by
// source grep.
// ---------------------------------------------------------------------------
describe("reminder-scheduler health is evaluated on every exit path (PR OPS-01)", () => {
  it("on the normal completed run", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    await GET(req());
    expect(h.recordReminderSchedulerHealthAlert).toHaveBeenCalledTimes(1);
  });

  it("on the 202 skipped_held early return", async () => {
    h.runReconciliation.mockResolvedValue(
      runResult({ coordinatorSkipped: "held", outcome: "ok" }),
    );
    const res = await GET(req());
    expect(res.status).toBe(202);
    expect(h.recordReminderSchedulerHealthAlert).toHaveBeenCalledTimes(1);
  });

  it("on the coordinator-unavailable early return", async () => {
    h.runReconciliation.mockResolvedValue(
      runResult({ coordinatorSkipped: "unavailable", outcome: "ok" }),
    );
    await GET(req());
    expect(h.recordReminderSchedulerHealthAlert).toHaveBeenCalledTimes(1);
  });

  it("even when the reconciliation run THROWS and the route 500s", async () => {
    h.runReconciliation.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    // The whole point: an unrelated reconcile failure must not remove that
    // day's reminder-scheduler monitoring.
    expect(h.recordReminderSchedulerHealthAlert).toHaveBeenCalledTimes(1);
  });

  it("a throwing health check does not change the route's real result", async () => {
    h.runReconciliation.mockResolvedValue(runResult({ outcome: "ok" }));
    h.recordReminderSchedulerHealthAlert.mockRejectedValueOnce(
      new Error("health check exploded"),
    );
    const res = await GET(req());
    // Still the route's genuine success, not a 500 and not a false success.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("a throwing health check does not mask a real 500", async () => {
    h.runReconciliation.mockRejectedValue(new Error("boom"));
    h.recordReminderSchedulerHealthAlert.mockRejectedValueOnce(
      new Error("health check exploded"),
    );
    const res = await GET(req());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });
});
