import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { runReconciliation, type RunOutcome } from "@/lib/google-calendar/sync/reconcile";
import {
  createReconcileObservability,
  createSupabaseReconcileStore,
  pruneMetricEvents,
} from "@/lib/google-calendar/sync/reconcile-store";
import { createUpstashReconcileLock, createUpstashReconcileCoordinator } from "@/lib/google-calendar/sync/reconcile-lock";
import { createUpstashReconcileContinuationStore } from "@/lib/google-calendar/sync/reconcile-continuation";
import { reconcileHeartbeatFromRun, recordReconcileRun, sweepCalendarDeadRowAlerts } from "@/lib/google-calendar/sync/reconcile-heartbeat";

// Google Calendar — Phase B2.3-b: the reconciliation-sweep route.
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest); 401 otherwise.
// No browser-supplied studio/connection/destination/calendar/provider id is trusted
// — the eligible studio set is derived SERVER-SIDE.
//
// NOT gated on calendar_sync_control.worker_enabled. Dormant in production: NOT
// cron-registered, every studio outbound flag OFF, CRON_SECRET required, worker OFF.
// It NEVER calls Google, enables the worker, or changes a flag.
//
// A single route COORDINATOR lock serializes invocations and owns a durable global
// studio cursor so every eligible studio eventually gets a turn even when every run
// hits its deadline; per-studio locks remain the mutation-safety boundary; the
// continuation/cursor are durable correctness state (fail-closed). Heartbeat, metric
// prune, and the bounded dead-row alert sweep are fail-open.

const METRIC_RETENTION_DAYS = 30;
const METRIC_PRUNE_LIMIT = 1000;
// The route deadline is kept materially below the lock/coordinator TTL (120s), but is
// NOT a substitute for the final ownership check before each actuator.
const ROUTE_BUDGET_MS = 50_000;
const DEAD_ROW_PAGE_SIZE = 100;
const DEAD_ROW_MAX_STUDIOS = 500;

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

    // Bounded retention prune of append-only metric events (best-effort).
    let metricsPruned = 0;
    try {
      const cutoff = new Date(startedAt - METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      metricsPruned = await pruneMetricEvents(admin, cutoff, METRIC_PRUNE_LIMIT);
    } catch {
      // maintenance — a prune failure must not fail the run
    }

    // Bounded, deadline-aware dead-row alert sweep (fail-open; coordinator-serialized).
    const deadRows = await sweepCalendarDeadRowAlerts(store, {
      deadlineMs,
      pageSize: DEAD_ROW_PAGE_SIZE,
      maxStudios: DEAD_ROW_MAX_STUDIOS,
    });

    // Truthful final outcome: degrade if dead-row alert work was deferred.
    const outcome: RunOutcome = deadRows.deferred && run.outcome === "ok" ? "degraded" : run.outcome;

    const completedAt = Date.now();
    await recordReconcileRun(
      reconcileHeartbeatFromRun(run, {
        at: new Date(completedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: completedAt - startedAt,
        outcome,
        deadRowDeferred: deadRows.deferred,
      }),
    );

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
      dead_row_alerts: deadRows,
    });
  } catch (err) {
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
