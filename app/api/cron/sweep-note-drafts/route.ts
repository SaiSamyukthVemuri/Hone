import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { safeLog } from "@/lib/logging/safe-log";

// HON-130 retention sweep for autosaved note drafts. Calls the service_role-only sweep_client_note_drafts() command, which
// deletes live drafts past retention and cleared rows older than a day, and returns a COUNT. It never reads or returns draft
// text and never touches the clinical or budget tables. CRON_SECRET bearer, like the other cron routes. Logs carry the count only.
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await createAdminClient().rpc("sweep_client_note_drafts");
  if (error) {
    safeLog.error(JSON.stringify({ event: "note_draft_sweep_failed", timestamp: new Date().toISOString() }));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const removed = typeof data === "number" ? data : 0;
  safeLog.info?.(JSON.stringify({ event: "note_draft_sweep", removed, timestamp: new Date().toISOString() }));
  return NextResponse.json({ ok: true, removed });
}
