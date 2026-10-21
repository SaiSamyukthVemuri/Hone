import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { drainEmailProviderEvents } from "@/lib/email/delivery-events";
import {
  hasOpenOpsAlert,
  healthFindings,
  readEmailDeliveryHealth,
  recordEmailSweepRun,
} from "@/lib/email/delivery-health";

// DELIVERY-VISIBILITY-01 — the email delivery-event recovery sweep and its
// heartbeat (migrations 0212 and 0215).
//
// The Resend webhook route finishes receipts opportunistically, as a side
// effect of the next delivery. This route is the scheduled half: it drains
// receipts whose processing never finished, records a heartbeat, reads
// delivery health and raises a DEDUPED ops alert per finding (an open,
// unresolved alert for the same event suppresses a repeat).
//
// AUTH: constant-time Bearer CRON_SECRET (isAuthorizedCronRequest); 401
// otherwise. No browser-supplied id is trusted or accepted.
//
// DORMANT: not registered in vercel.json. Registering a schedule is part of the
// delivery-events activation, a separate decision. It never sends an email or
// an SMS and never calls a provider.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never "critical": a critical ops alert is emailed (see below, and #828). */
const MAX_ALERT_SEVERITY = "warning" as const;

/** Bounded per run; the next run takes the rest. */
const SWEEP_LIMIT = 50;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const sweep = await drainEmailProviderEvents(admin, { limit: SWEEP_LIMIT });
  const heartbeat = sweep
    ? await recordEmailSweepRun(admin, sweep)
    : false;

  const health = await readEmailDeliveryHealth(admin);
  const raised: string[] = [];

  // A FAILED HEARTBEAT WRITE IS A FAILED RUN (Codex P2 4307534331). `heartbeat`
  // was absent from this condition, so when `record_email_sweep_run` alone
  // failed the else-branch ran, no alert was raised and the response still said
  // `ok: true` — the heartbeat going silent was invisible precisely when its
  // own write path was unavailable, which is the one failure it exists to
  // surface.
  if (!health || !sweep || !heartbeat) {
    // Unknown is not success: a sweep, heartbeat or health read that failed is
    // itself reported, never treated as a healthy run.
    const event = "email_delivery_sweep_failing";
    if (!(await hasOpenOpsAlert(admin, event))) {
      await recordOpsAlert({
        severity: "warning",
        event,
        message:
          "The email delivery recovery sweep could not run, could not record its heartbeat, or could not read delivery health.",
        route: "/api/cron/email-delivery-sweep",
        safeDetails: {
          sweep_ran: sweep !== null,
          heartbeat_written: heartbeat,
          health_read: health !== null,
        },
      });
      raised.push(event);
    }
  }

  // EVALUATED INDEPENDENTLY, not in an `else`. This was an if/else, so ANY one
  // failure suppressed the other signal entirely: a heartbeat write failure
  // would now have cost this run its health findings too, and a sweep failure
  // already did. One failure hiding another's signal is the same defect this
  // branch was just fixed for, so the two are decoupled — the alert above is
  // about the RUN, these findings are about the DATA, and health being readable
  // is the only precondition for reading them.
  if (health) {
    for (const finding of healthFindings(health)) {
      if (await hasOpenOpsAlert(admin, finding.event)) continue;
      // Recorded at WARNING at most: recordOpsAlert emails every critical
      // alert to OPS_ALERT_EMAILS, and emailed delivery alerts stay off until
      // the #828 routing decision (D-4). A critical assessment is kept as a
      // detail, so /admin and the ops_alerts row still show it.
      await recordOpsAlert({
        severity: MAX_ALERT_SEVERITY,
        event: finding.event,
        message: finding.message,
        route: "/api/cron/email-delivery-sweep",
        safeDetails:
          finding.severity === "critical" ? { ...finding.details, assessed_severity: "critical" } : finding.details,
      });
      raised.push(finding.event);
    }
  }

  // A NON-2xx WHEN THE RUN FAILED (Codex P2 4307534335). This returned the
  // default 200 with `ok: false` in the body, so cron infrastructure and uptime
  // checks keyed on HTTP STATUS recorded a failed recovery run as a success and
  // neither retried nor alerted. 500 matches every other cron route here
  // (appointment-reminders, calendar-reconcile, materialize-recurring-breaks).
  const ok = sweep !== null && health !== null && heartbeat;
  return NextResponse.json(
    { ok, sweep, heartbeat, health, raised },
    { status: ok ? 200 : 500 },
  );
}
