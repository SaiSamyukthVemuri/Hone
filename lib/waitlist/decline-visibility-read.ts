import type { SupabaseClient } from "@supabase/supabase-js";
import { DECLINE_READ_PAGE, type DeclineRecords, type EntryFacts } from "@/lib/waitlist/decline-visibility";

// The owner's own session reads (RLS decides; nothing here uses the service role). Reads ids, times and (for the section only) names and statuses.
// Contact details are NOT read here: they come only from the existing contact read, for the rows shown. Nothing is logged but a code.

/** Every declined invitation of the studio. Trusted only when the exact count equals the rows returned (the Data API cuts a response at 1000 rows). */
export async function loadDeclineRecords(db: SupabaseClient, studioId: string): Promise<DeclineRecords> {
  try {
    const r = await db
      .from("new_client_waitlist_invitations")
      .select("id,entry_id,declined_at", { count: "exact" })
      .eq("studio_id", studioId)
      .not("declined_at", "is", null)
      .order("declined_at", { ascending: false })
      .limit(DECLINE_READ_PAGE);
    if (r.error || !Array.isArray(r.data) || typeof r.count !== "number" || r.count !== r.data.length) return { kind: "unknown" };
    return { kind: "ok", rows: r.data as Array<{ id: string; entry_id: string; declined_at: string }> };
  } catch {
    return { kind: "unknown" };
  }
}

const CHUNK = 100;

/** Name and state for exactly the entries shown. Null when unreadable (the rows then say so). */
export async function loadDeclinedEntryFacts(db: SupabaseClient, studioId: string, entryIds: readonly string[]): Promise<Map<string, EntryFacts> | null> {
  const out = new Map<string, EntryFacts>();
  try {
    for (let i = 0; i < entryIds.length; i += CHUNK) {
      const r = await db
        .from("new_client_waitlist_entries")
        .select("id,name,status")
        .eq("studio_id", studioId)
        .in("id", entryIds.slice(i, i + CHUNK));
      if (r.error || !Array.isArray(r.data)) return null;
      for (const e of r.data as Array<{ id: string; name: string; status: string }>) out.set(e.id, { name: e.name, status: e.status });
    }
    return out;
  } catch {
    return null;
  }
}
