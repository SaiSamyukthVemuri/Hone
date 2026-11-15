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
  return NextResponse.json({ ok: !summary.read_failed, ...summary });
}
