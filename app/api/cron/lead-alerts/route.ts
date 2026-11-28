import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { sweepPlatformLeadAlerts } from "@/lib/platform-leads/alert-delivery";

// ---------------------------------------------------------------------------
// /api/cron/lead-alerts (LEAD-ALERT-01, #826)
// ---------------------------------------------------------------------------
//
// The RECOVERY path for operator lead alerts. The normal path sends each alert
// right after its lead is saved; this sweep picks up whatever that did not
// finish: an alert scheduled for a retry, one whose worker died mid-attempt
// (its lease expired), or one that was blocked by configuration that has since
// been fixed. It also retires alerts past their 72-hour window as visible
// failures. One alert at a time, bounded per run.
//
// It never creates or touches a lead, and it never alerts on a lead saved
// before migration 0213: only alerts that exist are ever sent.
//
// Requires `Authorization: Bearer $CRON_SECRET`. The response carries counts
// only: no ids, addresses or lead details.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const summary = await sweepPlatformLeadAlerts();
  return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
}
