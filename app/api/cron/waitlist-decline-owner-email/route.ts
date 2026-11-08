import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { dispatchDeclineOwnerEmail } from "@/lib/waitlist/decline-owner-email";

// Backstop for the owner email on a waitlist decline (HON-7 item 4). The send normally happens right after the decline commits; this
// picks up rows that failed, timed out or were abandoned mid-send. With the flag off it does nothing. It returns counts only.
export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const summary = await dispatchDeclineOwnerEmail({ admin: createAdminClient() });
  return NextResponse.json({ ok: true, ...summary });
}
