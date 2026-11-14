import type { SupabaseClient } from "@supabase/supabase-js";

// People who said none of the offered times suit them, and are waiting for the owner to return them.
//
// DERIVED, NEVER STORED, and it reads no text. Declining (0192) closes the invitation and releases the
// entry in one function that stamps the SAME instant on both rows (`invitations.declined_at` and
// `entries.released_at`, one `v_now`). An entry that is `released` and whose invitation was declined at
// exactly its own released instant was released BY the decline; one that was set aside by the owner
// has no such invitation, and one declined in an earlier cycle and set aside later does not match
// (the instants differ). "Return to waitlist" (requeue, 0200) puts the same row back to `waiting`:
// id and joined_at are immutable (0188), so the person keeps their original place.

export type DeclinedAttention =
  | { kind: "unknown" }
  | { kind: "ok"; total: number; shown: Array<{ id: string; name: string }>; ids: ReadonlySet<string> };

export const DECLINED_SHOW_LIMIT = 20;
// A safety cap on released entries read, and a chunk size that keeps each id list a short URL.
// Exceeding the cap is reported as unknown rather than silently truncated.
const RELEASED_CAP = 1000;
const CHUNK = 100;

export async function loadDeclinedAttention(db: SupabaseClient, studioId: string): Promise<DeclinedAttention> {
  try {
    const released: {
      data: Array<{ id: string; name: string; released_at: string | null }> | null;
      count?: number | null;
      error: unknown;
    } = await db
      .from("new_client_waitlist_entries")
      .select("id,name,released_at", { count: "exact" })
      .eq("studio_id", studioId)
      .eq("status", "released")
      .order("joined_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(RELEASED_CAP + 1);
    if (released.error || !released.data || released.data.length > RELEASED_CAP) return { kind: "unknown" };
    if (typeof released.count !== "number" || released.count > RELEASED_CAP || released.count > released.data.length) {
      return { kind: "unknown" };
    }
    if (released.data.length === 0) return { kind: "ok", total: 0, shown: [], ids: new Set() };

    const releasedAt = new Map<string, number>();
    for (const r of released.data) {
      if (r.released_at) releasedAt.set(r.id, new Date(r.released_at).getTime());
    }
    const declined = new Set<string>();
    const ids = released.data.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const inv: { data: Array<{ entry_id: string; declined_at: string | null }> | null; error: unknown } = await db
        .from("new_client_waitlist_invitations")
        .select("entry_id,declined_at")
        .eq("studio_id", studioId)
        .in("entry_id", ids.slice(i, i + CHUNK))
        .not("declined_at", "is", null);
      if (inv.error || !inv.data) return { kind: "unknown" };
      for (const row of inv.data) {
        const at = row.declined_at ? new Date(row.declined_at).getTime() : NaN;
        if (Number.isFinite(at) && releasedAt.get(row.entry_id) === at) declined.add(row.entry_id);
      }
    }
    const stuck = released.data.filter((r) => declined.has(r.id));
    return {
      kind: "ok",
      total: stuck.length,
      shown: stuck.slice(0, DECLINED_SHOW_LIMIT).map((r) => ({ id: r.id, name: r.name })),
      ids: declined,
    };
  } catch {
    return { kind: "unknown" };
  }
}
