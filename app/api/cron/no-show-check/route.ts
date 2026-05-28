import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";

// ---------------------------------------------------------------------------
// /api/cron/no-show-check (DISABLED PRE-STRIPE HARDENING)
// ---------------------------------------------------------------------------
//
// The previous implementation mutated appointments.status='no_show' for
// any confirmed appointment whose `starts_at` was more than 30 minutes
// in the past, gated only by `studios.auto_mark_no_shows`. That heuristic
// has two defects:
//
//   1. starts_at + 30min can still be DURING the appointment. Treatment
//      sessions can run long, and a real client may not show up on time
//      but does show up. The cron flipped many such rows to no_show.
//
//   2. There was no application UI calling mark_appointment_complete(),
//      so even a correctly-attended appointment ended its lifecycle as
//      'confirmed' forever. The cron then promoted those to 'no_show'
//      too.
//
// The first safe no-show path is the manual practitioner-initiated
// mark_appointment_no_show() RPC (added in migration 0033). When that
// path is in production and has been validated, auto no-show can be
// re-enabled with the following non-negotiable design:
//
//   * cutoff = appointments.ends_at + studio-configurable grace period
//     (default 60 min), NOT starts_at + 30min.
//   * mutation goes through public.mark_appointment_no_show() so the
//     state machine, terminal-safety and audit row are atomic.
//   * duplicate-send protection: claim the row in a single UPDATE with
//     a non-null no_show_email_send_attempts limit AND a row-level
//     advisory lock keyed on appointment_id.
//
// Until then this endpoint is non-mutating. It still requires the
// CRON_SECRET so probing the URL surface from outside is rejected.
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    disabled: true,
    reason:
      "Auto no-show is intentionally disabled. Use the practitioner-initiated " +
      "Mark no-show action on the appointment detail page, which calls the " +
      "mark_appointment_no_show RPC and respects ends_at.",
    scanned: 0,
    marked: 0,
    followups_sent: 0,
  });
}
