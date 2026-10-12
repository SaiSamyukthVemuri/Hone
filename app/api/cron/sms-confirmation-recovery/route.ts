import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { generateCancellationToken } from "@/lib/booking/tokens";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { confirmationRecoveryEnabled, recoverOwedConfirmations } from "@/lib/sms/confirmation-recovery";

// D5 (WILLOW-ROUTING-CANDIDATE-01, #824): deliver OWED booking confirmations
// for studios routed through their own sender (lib/sms/confirmation-recovery.ts).
//
// NOT SCHEDULED. It is in no vercel.json entry and no external scheduler job.
// Disabled unless SMS_CONFIRMATION_RECOVERY=on, and then only for studios
// listed in SMS_STUDIO_ROUTING_STUDIO_IDS; disabled, it answers without
// creating a database client. Scheduling it (every 15 minutes, beside
// appointment-reminders) is a cutover step with its own approval.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!confirmationRecoveryEnabled()) {
    return NextResponse.json({ ok: true, ran: false, reason: "disabled" });
  }
  let origin: string;
  try {
    origin = getRequiredAppOrigin();
  } catch {
    // No manage link can be minted: send nothing rather than a confirmation
    // without one. Nothing was read or claimed.
    return NextResponse.json({ ok: false, ran: false, reason: "app_origin_unset" }, { status: 500 });
  }
  const { createAdminClient } = await import("@/lib/supabase/admin-server");
  const run = await recoverOwedConfirmations({
    admin: createAdminClient(),
    nowMs: Date.now(),
    manageUrlFor: (appointmentId, startsAt) => {
      try {
        const token = generateCancellationToken(appointmentId, startsAt);
        return token ? `${origin}/manage/${token}` : null;
      } catch {
        return null;
      }
    },
  });
  console.log(JSON.stringify({ event: "sms_confirmation_recovery_run", ...run, timestamp: new Date().toISOString() }));
  return NextResponse.json({ ok: true, ...run });
}
