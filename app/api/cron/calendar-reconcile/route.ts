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
import { reconcileHeartbeatFromRun, recordReconcileRun } from "@/lib/google-calendar/sync/reconcile-heartbeat";

// Google Calendar — Phase B2.3-b: the reconciliation-sweep route.
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest); unauthenticated
// requests get 401. No browser-supplied studio / connection / destination /
// calendar / provider identifier is ever trusted — the eligible studio set is
// derived SERVER-SIDE by the store.
//
// NOT gated on calendar_sync_control.worker_enabled. worker_enabled is the
// authoritative CLAIM/DISPATCH gate and must NOT be repurposed as the reconcile
// gate: reconciliation is enqueue-side (it generates intent), the worker is
// claim-side (it dispatches). This route stays DORMANT in production because
//   (1) it is NOT registered in vercel.json (no schedule),
//   (2) every production studio's outbound flag is OFF, so the INTENT gate makes
//       the eligible set empty and the sweep enqueues nothing,
//   (3) invocation requires CRON_SECRET, and
//   (4) the global worker is OFF, so even intentionally-queued work cannot dispatch.
// This separation lets a future controlled activation enable outbound intent for
// ONE studio, run bounded reconciliation, inspect the queue, and only LATER
// authorize the dispatch worker — without a second production flag.
//
// The route NEVER calls Google, NEVER enables the worker, and NEVER changes any
// studio sync flag. It only orchestrates the existing DB repair primitives, prunes
// append-only telemetry, and records a non-sensitive heartbeat.

const METRIC_RETENTION_DAYS = 30;
const METRIC_PRUNE_LIMIT = 1000;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const admin = createAdminClient();
    const store = createSupabaseReconcileStore(admin);
    const lock = createUpstashReconcileLock(); // fail-CLOSED when Upstash is absent
    const observability = createReconcileObservability(admin);

    const run = await runReconciliation({ store, lock, observability });

    // Bounded retention prune of append-only metric events (best-effort).
    let metricsPruned = 0;
    try {
      const cutoff = new Date(startedAt - METRIC_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      metricsPruned = await pruneMetricEvents(admin, cutoff, METRIC_PRUNE_LIMIT);
    } catch {
      // Retention is maintenance — a prune failure must not fail the run.
    }

    const durationMs = Date.now() - startedAt;
    // Heartbeat (fail-open, non-sensitive aggregate scalars only).
    await recordReconcileRun(
      reconcileHeartbeatFromRun(run, { at: new Date(startedAt).toISOString(), durationMs, outcome: "ok" }),
    );

    return NextResponse.json({
      ok: true,
      duration_ms: durationMs,
      eligible_studios: run.eligibleStudios,
      studios_swept: run.studiosSwept,
      studios_skipped_held: run.studiosSkippedHeld,
      studios_skipped_unavailable: run.studiosSkippedUnavailable,
      candidates: run.candidates,
      enqueued: run.enqueued,
      skipped: run.skipped,
      superseded: run.superseded,
      errors: run.errors,
      by_class: run.byClass,
      metrics_pruned: metricsPruned,
    });
  } catch (err) {
    await recordOpsAlert({
      severity: "critical",
      event: "cron_route_failed",
      message: err instanceof Error ? err.message : String(err ?? "unknown error"),
      route: "/api/cron/calendar-reconcile",
      safeDetails: { duration_ms: Date.now() - startedAt },
    });
    // Best-effort error heartbeat so a repeatedly-failing sweep is observable.
    try {
      await recordReconcileRun({
        at: new Date(startedAt).toISOString(),
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
