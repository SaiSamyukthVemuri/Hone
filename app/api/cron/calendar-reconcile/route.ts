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
import { createUpstashReconcileLock } from "@/lib/google-calendar/sync/reconcile-lock";
import { createUpstashReconcileContinuationStore } from "@/lib/google-calendar/sync/reconcile-continuation";
import {
  reconcileHeartbeatFromRun,
  recordReconcileRun,
  sweepCalendarDeadRowAlerts,
} from "@/lib/google-calendar/sync/reconcile-heartbeat";

// Google Calendar — Phase B2.3-b: the reconciliation-sweep route.
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest); 401 otherwise.
// No browser-supplied studio/connection/destination/calendar/provider id is trusted
// — the eligible studio set is derived SERVER-SIDE.
//
// NOT gated on calendar_sync_control.worker_enabled (that is the authoritative
// CLAIM/DISPATCH gate; reconciliation is enqueue-side). Dormant in production: NOT
// cron-registered, every studio outbound flag OFF (intent gate yields nothing),
// CRON_SECRET required, worker OFF. It NEVER calls Google, enables the worker, or
// changes a flag.
//
// The run is BOUNDED by a wall-clock deadline; unfinished studios persist a durable
// continuation (Upstash) and resume on the next invocation. Mutation safety is
// fail-closed on the per-studio lock + continuation; the heartbeat / metric prune /
// dead-row alert are fail-open.

const METRIC_RETENTION_DAYS = 30;
const METRIC_PRUNE_LIMIT = 1000;
// Leave headroom under the platform function timeout; the lock TTL (120s) exceeds
// this so the lease never expires mid-route, and renewal covers longer studios.
const ROUTE_BUDGET_MS = 50_000;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const store = createSupabaseReconcileStore(admin);
    const lock = createUpstashReconcileLock(); // fail-CLOSED when Upstash absent
    const continuation = createUpstashReconcileContinuationStore(); // fail-CLOSED when Upstash absent
    const observability = createReconcileObservability(admin);

    const run = await runReconciliation({
      store,
      lock,
      continuation,
      observability,
      deadlineMs: startedAt + ROUTE_BUDGET_MS,
    });

    // Bounded retention prune of append-only metric events (best-effort).
    let metricsPruned = 0;
    try {
      const cutoff = new Date(startedAt - METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      metricsPruned = await pruneMetricEvents(admin, cutoff, METRIC_PRUNE_LIMIT);
    } catch {
      // Retention is maintenance — a prune failure must not fail the run.
    }

    // Dead-row operational alert sweep (fail-open; only fires for real dead rows).
    const deadRows = await sweepCalendarDeadRowAlerts(store, startedAt);

    const completedAt = Date.now();
    // Heartbeat (fail-open). `at` = completion time; startedAt retained separately.
    await recordReconcileRun(
      reconcileHeartbeatFromRun(run, {
        at: new Date(completedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: completedAt - startedAt,
      }),
    );

    // A degraded/error run is reported truthfully (HTTP still 200 — the route ran).
    return NextResponse.json({
      ok: run.outcome === "ok",
      outcome: run.outcome,
      duration_ms: completedAt - startedAt,
      eligible_studios: run.eligibleStudios,
      studios_swept: run.studiosSwept,
      studios_completed: run.studiosCompleted,
      studios_truncated: run.studiosTruncated,
      studios_skipped_held: run.studiosSkippedHeld,
      studios_skipped_unavailable: run.studiosSkippedUnavailable,
      studios_continuation_failed: run.studiosContinuationFailed,
      candidates: run.candidates,
      enqueued: run.enqueued,
      skipped: run.skipped,
      superseded: run.superseded,
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
