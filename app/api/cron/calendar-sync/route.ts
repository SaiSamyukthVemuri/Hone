import { NextResponse } from "next/server";
import { handleWorkerRoute } from "@/lib/google-calendar/sync/worker-runtime";
import { recordReminderSchedulerHealthAlert } from "@/lib/cron/reminder-heartbeat";

// Google Calendar — Phase B2.3-c2: the authenticated, bounded worker-drain route.
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest, inside the
// server-only seam); 401 otherwise, before any admin client / claim. No browser
// UI, no server action, no public mutation API, no caller-selected target.
//
// It delegates entirely to the ONE approved server-only seam
// lib/google-calendar/sync/worker-runtime, which wires the deployed
// claim -> handle -> record architecture to the c1 operations map. This route file
// itself references NO raw outbound-sync table or RPC — those stay behind the seam.
// The database claim RPC (invoked in the seam) is the sole work selector.
//
// DORMANT in production: NOT cron-registered (c3 owns scheduling), NOT gated code
// that enables the worker or any studio flag, worker_enabled OFF, every studio
// outbound flag OFF, outbox empty. An authorized invocation authenticates, claims
// zero rows, performs zero Google call and zero outbox mutation, and returns the
// PHI-free no-work result. It NEVER enables the worker, changes a flag, or reads a
// caller-supplied studio/connection/appointment/link/calendar/event id.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Platform function ceiling (a literal so Next.js/Vercel can statically detect it;
// NOT set via vercel.json). The seam's job-ADMISSION window (WORKER_JOB_ADMISSION_
// WINDOW_MS = 50s) only gates STARTING new work; this 180s ceiling guarantees at
// least 120s of completion headroom for the last in-flight job after the admission
// window closes (180000 - 50000 = 130000 ms >= 120000). Keep in sync with
// WORKER_PLATFORM_MAX_DURATION_SECONDS.
export const maxDuration = 180;

export async function GET(req: Request) {
  const { status, body } = await handleWorkerRoute(req);
  // PR OPS-01: THIRD independent detector for a dead external reminder
  // scheduler (this cron runs 09:30 UTC; materialize 08:00, reconcile 09:00).
  //
  // Auth for this route lives inside the worker seam, so there is no local gate
  // to sit behind. Gating on `status !== 401` preserves the same contract every
  // other caller has — an unauthorized request records nothing — without
  // reaching into the seam or duplicating its auth logic.
  //
  // Deliberately does NOT touch the seam, the outbound-sync tables, or the
  // worker flags; it only reads the reminder heartbeat and may record a deduped
  // ops alert. It NEVER sends a reminder and never calls
  // /api/cron/appointment-reminders. Best-effort: a health-check failure must
  // not alter this route's worker result, so the response is built after it and
  // the call is wrapped.
  if (status !== 401) {
    try {
      await recordReminderSchedulerHealthAlert();
    } catch (healthErr) {
      console.error(
        JSON.stringify({
          event: "reminder_scheduler_health_check_threw",
          route: "/api/cron/calendar-sync",
          err_message:
            healthErr instanceof Error ? healthErr.message : String(healthErr),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
