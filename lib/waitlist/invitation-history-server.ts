// The session-scoped READ of invitation facts. SERVER ONLY, OWNER ONLY: called from owner-gated pages after their owner check, through
// the owner's own session (RLS policy new_client_waitlist_invitations_owner_select). Client components import the pure module only.
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { historyFromRows, type InvitationHistory } from "@/lib/waitlist/invitation-history";

export async function loadInvitationHistory(studioId: string, entryIds: readonly string[]): Promise<InvitationHistory> {
  if (entryIds.length === 0) return { kind: "ok", byEntry: new Map() };
  try {
    const { data, error } = await (await createClient())
      .from("new_client_waitlist_invitations")
      .select("id,entry_id,issued_at,expires_at,redeemed_at,expired_at,released_at,declined_at")
      .eq("studio_id", studioId)
      .in("entry_id", [...entryIds]);
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    return { kind: "ok", byEntry: historyFromRows(data as Array<Record<string, unknown>>) };
  } catch {
    return { kind: "unknown" };
  }
}
