import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { dispatchDeclineOwnerEmail } from "@/lib/waitlist/decline-owner-email";
import { DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS } from "@/lib/waitlist/decline-owner-email-gate";
import { runRetentionForCron } from "@/lib/waitlist/retention-run";

// Backstop for the owner email on a waitlist decline (HON-7 item 4). The send normally happens right after the decline commits; this
// picks up rows that failed, timed out or were abandoned mid-send. With the flag off it does nothing. It returns counts only.
// 60 seconds is the most a Hobby serverless function may run. The sweep spends at most 25 of them on batches (see
// DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS) so a row started inside the budget still finishes. Next requires a literal here, so a test pins that it
// equals the constant the budget was derived from.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // 0326: the scheduled erase of overdue answers runs here too, ALWAYS (whatever the email flag says: erasure is a duty, not a feature). It runs
  // beside the email sweep, not after it, so the two stay inside the 60 s cap together. It reports counts only and raises the failed-run alert itself.
  // A sweep that throws must not cut the erase short: wait for both, then surface the sweep's failure exactly as before.
  const [retention, sweep] = await Promise.all([
    runRetentionForCron(),
    dispatchDeclineOwnerEmail({ admin: createAdminClient() }).then(
      (summary) => ({ summary }),
      (error: unknown) => ({ error }),
    ),
  ]);
  if ("error" in sweep) throw sweep.error;
  return NextResponse.json({ ok: true, ...sweep.summary, retention });
}
