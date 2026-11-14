import type { SupabaseClient } from "@supabase/supabase-js";

// Entries whose invitation was used but whose booking did not complete.
//
// DERIVED, NEVER STORED. After the redeem commits and the appointment does not,
// the entry stays `invited` with a redeemed invitation and no conversion. That
// state survives a reload and needs no table, so the owner's list is a pure
// function of facts the page already reads. It cannot say WHY the booking
// failed (a taken time and a lost response look the same here), so the copy
// built on it must not claim a reason.

// ---------------------------------------------------------------------------
// The dedicated, COMPLETE read. The page's paged section rows are not used: a
// count that silently misses people is worse than none.
// ---------------------------------------------------------------------------

export type NeedsAttention =
  | { kind: "unknown" }
  | { kind: "ok"; total: number; shown: Array<{ id: string; name: string }> };

export const ATTENTION_SHOW_LIMIT = 20;
// Invited entries are bounded by the admission allowance; this is a safety cap,
// and exceeding it is reported as unknown rather than silently truncated.
const INVITED_CAP = 1000;

export async function loadNeedsAttention(db: SupabaseClient, studioId: string): Promise<NeedsAttention> {
  try {
    // An EXACT count rides on the same request. The server's own row ceiling
    // (PostgREST max_rows) can cut the response below INVITED_CAP + 1 rows, so
    // the length of the data alone cannot show that rows were left out.
    const invited: { data: Array<{ id: string; name: string }> | null; count?: number | null; error: unknown } = await db
      .from("new_client_waitlist_entries")
      .select("id,name", { count: "exact" })
      .eq("studio_id", studioId)
      .eq("status", "invited")
      .order("joined_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(INVITED_CAP + 1);
    if (invited.error || !invited.data || invited.data.length > INVITED_CAP) return { kind: "unknown" };
    // No count, or more rows than were returned: the list is not complete.
    if (typeof invited.count !== "number" || invited.count > INVITED_CAP || invited.count > invited.data.length) {
      return { kind: "unknown" };
    }
    if (invited.data.length === 0) return { kind: "ok", total: 0, shown: [] };
    const ids = invited.data.map((r) => r.id);
    const redeemed: { data: Array<{ entry_id: string }> | null; error: unknown } = await db
      .from("new_client_waitlist_invitations")
      .select("entry_id")
      .eq("studio_id", studioId)
      .in("entry_id", ids)
      .not("redeemed_at", "is", null);
    if (redeemed.error || !redeemed.data) return { kind: "unknown" };
    const spent = new Set(redeemed.data.map((r) => r.entry_id));
    const stuck = invited.data.filter((r) => spent.has(r.id));
    return {
      kind: "ok",
      total: stuck.length,
      shown: stuck.slice(0, ATTENTION_SHOW_LIMIT).map((r) => ({ id: r.id, name: r.name })),
    };
  } catch {
    return { kind: "unknown" };
  }
}
