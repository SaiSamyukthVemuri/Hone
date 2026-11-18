// The session-scoped READ of invitation facts. SERVER ONLY, OWNER ONLY: called from owner-gated pages after their owner check, through
// the owner's own session (RLS policy new_client_waitlist_invitations_owner_select). Client components import the pure module only.
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { historyFromRows, type InvitationHistory } from "@/lib/waitlist/invitation-history";

// The API returns at most 1,000 rows per request and does NOT say when it cut a result short, so one query can look complete when it is not (the
// Released page lists up to 100 entries and each can have several invitations). Read in pages ordered by id until a SHORT page arrives; if the
// bound is reached first, fail CLOSED (unknown) rather than show a truncated history as if it were whole.
export const HISTORY_PAGE = 1000;
export const HISTORY_MAX_PAGES = 10;

export async function loadInvitationHistory(studioId: string, entryIds: readonly string[]): Promise<InvitationHistory> {
  if (entryIds.length === 0) return { kind: "ok", byEntry: new Map() };
  try {
    const supabase = await createClient();
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const { data, error } = await supabase
        .from("new_client_waitlist_invitations")
        .select("id,entry_id,issued_at,expires_at,redeemed_at,expired_at,released_at,declined_at")
        .eq("studio_id", studioId)
        .in("entry_id", [...entryIds])
        .order("id", { ascending: true })
        .range(page * HISTORY_PAGE, (page + 1) * HISTORY_PAGE - 1);
      if (error || !Array.isArray(data)) return { kind: "unknown" };
      rows.push(...(data as Array<Record<string, unknown>>));
      if (data.length < HISTORY_PAGE) return { kind: "ok", byEntry: historyFromRows(rows) };
    }
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}
