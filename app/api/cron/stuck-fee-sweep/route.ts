import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { sweepStuckFeeAttempts } from "@/lib/billing/stuck-fee-sweep";

// Detects a manual fee attempt stuck in pending_stripe and raises the existing critical ops alert once per attempt.
// NON-MUTATING: it never changes an attempt and never calls Stripe (see lib/billing/stuck-fee-sweep.ts). It returns counts only.
// CRON_SECRET bearer, same as the other cron routes.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const summary = await sweepStuckFeeAttempts({ admin: createAdminClient() });
  // Non-200 when detection itself failed (its read failed, or an alert could not be recorded), so the cron run shows as failed.
  const healthy = !summary.read_failed && summary.alert_failed === 0 && !summary.truncated;
  return NextResponse.json({ ok: healthy, ...summary }, { status: healthy ? 200 : 500 });
}
