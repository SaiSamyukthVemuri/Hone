import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { runReconciliation } from "@/lib/google-calendar/sync/reconcile";
import {
  createReconcileObservability,
  createSupabaseReconcileStore,
  pruneMetricEvents,
} from "@/lib/google-calendar/sync/reconcile-store";
import {
  createUpstashReconcileCoordinator,
  createUpstashReconcileDeadAlertCoordinator,
  createUpstashReconcileLock,
} from "@/lib/google-calendar/sync/reconcile-lock";
import { createUpstashReconcileContinuationStore } from "@/lib/google-calendar/sync/reconcile-continuation";
import {
  finalHeartbeatOutcome,
  reconcileHeartbeatFromRun,
  recordReconcileRun,
  sweepCalendarDeadRowAlerts,
  type DeadRowSweepResult,
} from "@/lib/google-calendar/sync/reconcile-heartbeat";

// Google Calendar — Phase B2.3-b: the reconciliation-sweep route.
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest); 401 otherwise.
// No browser-supplied studio/connection/destination/calendar/provider id is trusted.
//
// NOT gated on calendar_sync_control.worker_enabled. Dormant in production: NOT
// cron-registered, every studio outbound flag OFF, CRON_SECRET required, worker OFF.
// It NEVER calls Google, enables the worker, or changes a flag.
//
// EXACTLY TWO coordinators, NEVER held simultaneously by one invocation:
//   * the MAIN reconciliation coordinator (owned by runReconciliation, released
//     before it returns), and
//   * the DEAD-ALERT coordinator (owned by the dead-row alert campaign afterwards).
// Metric pruning runs UNLOCKED between them. The heartbeat is recorded truthfully:
// a held/unavailable main coordinator writes NO heartbeat (a stale heartbeat after a
// crash is the intended monitoring consequence and must stay visible).

const METRIC_RETENTION_DAYS = 30;
const METRIC_PRUNE_LIMIT = 1000;
// Kept materially below the lock/coordinator TTL (120s) — but not a substitute for
// the per-actuator ownership check inside the sweep.
const ROUTE_BUDGET_MS = 50_000;
const DEAD_ROW_PAGE_SIZE = 100;
const DEAD_ROW_MAX_STUDIOS = 500;

// Best-effort, PHI-free, tenant-safe operational signal. FULLY guarded (recordOpsAlert
// is itself fail-open; the extra try/catch guarantees the sabotage property regardless).
async function emitRouteSignal(severity: "info" | "warning", event: string, safeDetails: Record<string, unknown>): Promise<void> {
  try {
    await recordOpsAlert({ severity, event, message: `Google Calendar reconcile route: ${event}`, route: "/api/cron/calendar-reconcile", safeDetails });
  } catch {
    // A failed signal write must never change route/lock/cursor behaviour.
  }
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const deadlineMs = startedAt + ROUTE_BUDGET_MS;
  try {
    const admin = createAdminClient();
    const store = createSupabaseReconcileStore(admin);
    const lock = createUpstashReconcileLock(); // fail-CLOSED when Upstash absent
    const coordinator = createUpstashReconcileCoordinator();
    const continuation = createUpstashReconcileContinuationStore();
    const observability = createReconcileObservability(admin);

    const run = await runReconciliation({ store, lock, coordinator, continuation, observability, deadlineMs });

    // ---- Case A: the MAIN coordinator was HELD by another invocation. Benign
    // concurrency — this invocation performed NO run. Do NOT prune, sweep, or write a
    // heartbeat (writing one would mask the active/crashed run). Return 202.
    if (run.coordinatorSkipped === "held") {
      await emitRouteSignal("info", "calendar_reconcile_skipped_held", { outcome: "skipped_held", coordinator: "main", duration_ms: Date.now() - startedAt });
      return NextResponse.json({ ok: true, outcome: "skipped_held", coordinator_skipped: "held" }, { status: 202 });
    }

    // ---- Case B: the MAIN coordinator backend was UNAVAILABLE. No unlocked run, no
    // maintenance, no successful heartbeat. Truthful degraded response.
    if (run.coordinatorSkipped === "unavailable") {
      await emitRouteSignal("warning", "calendar_reconcile_coordinator_unavailable", { outcome: "degraded", coordinator: "main", duration_ms: Date.now() - startedAt });
      return NextResponse.json({ ok: false, outcome: "degraded", coordinator_skipped: "unavailable" }, { status: 200 });
    }

    // ---- Case C: the main reconciliation ACTUALLY RAN (main coordinator acquired +
    // released inside runReconciliation).
    // 1. Bounded metric prune — UNLOCKED, best-effort, fail-open, idempotent.
    let metricsPruned = 0;
    try {
      const cutoff = new Date(startedAt - METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      metricsPruned = await pruneMetricEvents(admin, cutoff, METRIC_PRUNE_LIMIT);
    } catch {
      // maintenance — a prune failure must not fail the run
    }

    // 2-4. Dead-row alert campaign under the SEPARATE dead-alert coordinator.
    const deadAlertCoordinator = createUpstashReconcileDeadAlertCoordinator();
    const deadRows: DeadRowSweepResult = await sweepCalendarDeadRowAlerts(store, deadAlertCoordinator, {
      deadlineMs,
      pageSize: DEAD_ROW_PAGE_SIZE,
      maxStudios: DEAD_ROW_MAX_STUDIOS,
    });
    if (deadRows.outcome !== "completed") {
      const severity = deadRows.outcome === "skipped_held" || deadRows.outcome === "deferred" ? "info" : "warning";
      await emitRouteSignal(severity, "calendar_dead_alert_incomplete", {
        outcome: deadRows.outcome,
        coordinator: "dead_alert",
        coordinator_status: deadRows.coordinatorStatus,
        studios: deadRows.studios,
        alerted: deadRows.alerted,
        deduped: deadRows.deduped,
        deferred: deadRows.deferred,
        cursor_persist_failed: deadRows.cursorPersistFailed ?? false,
        error_class: deadRows.errorClass ?? null,
      });
    }

    // 5-6. Final heartbeat tier (§11) — a non-completed dead-row campaign degrades a
    // successful reconciliation; error is reserved for reconciliation-run failure.
    const outcome = finalHeartbeatOutcome(run.outcome, deadRows.outcome);
    const completedAt = Date.now();
    await recordReconcileRun(
      reconcileHeartbeatFromRun(run, {
        at: new Date(completedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: completedAt - startedAt,
        outcome,
        deadRowDeferred: deadRows.outcome !== "completed",
      }),
    );

    // 7. Truthful response.
    return NextResponse.json({
      ok: outcome === "ok",
      outcome,
      duration_ms: completedAt - startedAt,
      coordinator_skipped: run.coordinatorSkipped,
      coordinator_lost: run.coordinatorLost,
      cursor_read_failed: run.cursorReadFailed,
      cursor_persist_failed: run.cursorPersistFailed,
      eligible_studios: run.eligibleStudios,
      studios_attempted: run.studiosAttempted,
      studios_completed: run.studiosCompleted,
      studios_truncated: run.studiosTruncated,
      studios_deferred: run.studiosDeferred,
      studios_skipped_held: run.studiosSkippedHeld,
      studios_skipped_unavailable: run.studiosSkippedUnavailable,
      studios_continuation_failed: run.studiosContinuationFailed,
      candidates: run.candidates,
      enqueued: run.enqueued,
      skipped: run.skipped,
      superseded: run.superseded,
      intent_verify_failed: run.intentVerifyFailed,
      errors: run.errors,
      by_class: run.byClass,
      metrics_pruned: metricsPruned,
      dead_row: {
        outcome: deadRows.outcome,
        coordinator_status: deadRows.coordinatorStatus,
        studios: deadRows.studios,
        alerted: deadRows.alerted,
        deduped: deadRows.deduped,
        deferred: deadRows.deferred,
        cursor: deadRows.cursor,
      },
    });
  } catch (err) {
    // A reconciliation-run / route failure -> error heartbeat + cron_route_failed.
    await recordOpsAlert({
      severity: "critical",
      event: "cron_route_failed",
      message: err instanceof Error ? err.message : String(err ?? "unknown error"),
      route: "/api/cron/calendar-reconcile",
      safeDetails: { duration_ms: Date.now() - startedAt },
    });
    try {
      await recordReconcileRun({
        at: new Date(Date.now()).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        outcome: "error",
        durationMs: Date.now() - startedAt,
        errorClass: err instanceof Error ? err.name : "unknown",
      });
    } catch {
      // fail-open
    }
    return NextResponse.json({ ok: false, error: "cron_failed" }, { status: 500 });
  }
}
