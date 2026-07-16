import { NextResponse } from "next/server";
import { handleWorkerRoute } from "@/lib/google-calendar/sync/worker-runtime";

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
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
